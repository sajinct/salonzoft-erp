-- =============================================================================
-- Salonzoft · Migration 0015 · Online booking & notification queue
-- -----------------------------------------------------------------------------
-- PUBLIC BOOKING (anon). The public page can call exactly five SECURITY
-- DEFINER functions (public_*); it can never read a table. They only expose
-- operational tenants with the online_booking module, branches with
-- online_booking_enabled, and services marked online_bookable — names,
-- durations and prices only. Bookings go through the same engine as the
-- front desk (no double-booking), are rate-limited per mobile and per client
-- IP, find-or-create the customer by normalised mobile WITHOUT ever changing
-- an existing profile, and return a secret manage token (cancel online).
--
-- NOTIFICATIONS. Appointment triggers enqueue confirmations, reminders and
-- cancellations in notification_jobs — only on a channel the customer has
-- consented to (latest consent wins, PDPL). Messages are rendered when they
-- are sent (reschedules are always reflected). A worker (Edge Function with
-- the service role) claims jobs with FOR UPDATE SKIP LOCKED, retries with
-- exponential backoff and gives up after 5 attempts.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Settings
-- ---------------------------------------------------------------------------
alter table public.tenant_settings
  add column online_booking_lead_minutes integer not null default 60 check (online_booking_lead_minutes between 0 and 10080),
  add column online_booking_horizon_days integer not null default 30 check (online_booking_horizon_days between 1 and 365),
  add column online_booking_cancel_hours integer not null default 12 check (online_booking_cancel_hours between 0 and 168),
  add column online_booking_note_en text check (char_length(online_booking_note_en) <= 500),
  add column online_booking_note_ar text check (char_length(online_booking_note_ar) <= 500),
  add column notify_whatsapp boolean not null default false,
  add column notify_sms boolean not null default false,
  add column notify_email boolean not null default false,
  add column reminder_hours_before integer not null default 24 check (reminder_hours_before between 1 and 168);
grant update (online_booking_lead_minutes, online_booking_horizon_days, online_booking_cancel_hours, online_booking_note_en,
              online_booking_note_ar, notify_whatsapp, notify_sms, notify_email, reminder_hours_before)
  on public.tenant_settings to authenticated;

-- Platform-level settings (private schema: not reachable through the API).
create table app.platform_settings (
  key    text primary key,
  value  text not null
);
insert into app.platform_settings (key, value) values ('public_app_url', 'https://erp.salonzoft.com');
revoke all on app.platform_settings from public, anon, authenticated;

create or replace function app.platform_setting(p_key text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select value from app.platform_settings where key = p_key;
$$;

-- Secret token so a customer can see / cancel their own online booking.
alter table public.appointments add column public_token text unique check (char_length(public_token) between 20 and 64);

-- ---------------------------------------------------------------------------
-- 2. Availability: one internal engine, two front doors
-- ---------------------------------------------------------------------------
create or replace function app.availability_slots(
  p_branch_id uuid,
  p_service_ids uuid[],
  p_date date,
  p_employee_id uuid,
  p_step_minutes integer,
  p_exclude_appointment uuid,
  p_not_before timestamptz,
  p_online_only boolean
)
returns table (starts_at timestamptz, employee_id uuid)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_tenant    uuid;
  v_tz        text;
  v_n         integer := coalesce(cardinality(p_service_ids), 0);
  v_found     integer;
  v_total     integer;
  v_bb        integer;
  v_ba        integer;
  v_emp       uuid;
  v_free      tstzmultirange;
  v_day_start timestamptz;
  v_slot      timestamptz;
  v_step      interval;
begin
  select b.tenant_id, b.timezone into v_tenant, v_tz from public.branches b where b.id = p_branch_id and b.is_active;
  if not found then
    return;
  end if;
  if v_n not between 1 and 10 then
    perform app.raise('INVALID_SERVICE', 'Choose between 1 and 10 services');
  end if;
  if p_date is null or p_step_minutes not between 5 and 60 then
    perform app.raise('INVALID_RANGE', 'Choose a date and a step between 5 and 60 minutes');
  end if;

  select count(*), sum(s.duration_minutes),
         max(s.buffer_before_minutes) filter (where u.ord = 1),
         max(s.buffer_after_minutes) filter (where u.ord = v_n)
    into v_found, v_total, v_bb, v_ba
  from unnest(p_service_ids) with ordinality as u(id, ord)
  join public.services s on s.id = u.id
  where s.tenant_id = v_tenant and s.is_active
    and (not p_online_only or s.online_bookable)
    and not exists (select 1 from public.service_prices sp
                    where sp.service_id = s.id and sp.branch_id = p_branch_id and not sp.is_available);
  if v_found <> v_n then
    perform app.raise('INVALID_SERVICE', 'A service is unknown, inactive or not offered at this branch');
  end if;

  v_step := make_interval(mins => p_step_minutes);
  v_day_start := p_date::timestamp at time zone v_tz;

  for v_emp in
    select e.id from public.employees e
    where e.tenant_id = v_tenant and e.is_active and e.is_bookable
      and (p_employee_id is null or e.id = p_employee_id)
      and exists (select 1 from public.employee_branches eb where eb.employee_id = e.id and eb.branch_id = p_branch_id)
      and (select count(distinct es.service_id) from public.employee_services es
           where es.employee_id = e.id and es.service_id = any (p_service_ids))
          = (select count(distinct x) from unnest(p_service_ids) x)
    order by e.sort_order, e.name_en, e.id
  loop
    v_free := app.employee_free_ranges(v_emp, p_branch_id, p_date, p_exclude_appointment);
    continue when isempty(v_free);
    for v_slot in select g from generate_series(v_day_start, v_day_start + interval '1 day' - v_step, v_step) as g loop
      if v_slot >= greatest(now(), coalesce(p_not_before, now()))
         and tstzrange(v_slot - make_interval(mins => v_bb), v_slot + make_interval(mins => v_total + v_ba)) <@ v_free then
        starts_at := v_slot;
        employee_id := v_emp;
        return next;
      end if;
    end loop;
  end loop;
end;
$$;

-- Staff front door (unchanged contract).
create or replace function public.calculate_availability(
  p_branch_id uuid,
  p_service_ids uuid[],
  p_date date,
  p_employee_id uuid default null,
  p_step_minutes integer default 15,
  p_exclude_appointment uuid default null
)
returns table (starts_at timestamptz, employee_id uuid)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform app.require_user();
  if not exists (select 1 from public.branches b where b.id = p_branch_id and b.is_active)
     or not exists (select 1 from app.branch_ids_with_any_permission(array['appointments.view', 'appointments.manage']) x where x = p_branch_id) then
    perform app.forbid('No access to bookings at this branch');
  end if;
  return query
  select s.starts_at, s.employee_id
  from app.availability_slots(p_branch_id, p_service_ids, p_date, p_employee_id, p_step_minutes, p_exclude_appointment, null, false) s;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Public booking (anon)
-- ---------------------------------------------------------------------------
create table public.public_booking_attempts (
  id          bigint generated always as identity primary key,
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  mobile      text,
  client_ip   text,
  created_at  timestamptz not null default now()
);
create index public_booking_attempts_mobile_idx on public.public_booking_attempts (tenant_id, mobile, created_at desc);
create index public_booking_attempts_ip_idx on public.public_booking_attempts (client_ip, created_at desc);
alter table public.public_booking_attempts enable row level security;
revoke all on public.public_booking_attempts from anon, authenticated;
grant all on public.public_booking_attempts to service_role;

-- The tenant behind a public slug, only if it may take online bookings.
create or replace function app.public_tenant(p_slug text)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  select t.id into v_id from public.tenants t where t.slug = lower(btrim(coalesce(p_slug, ''))) and t.status = 'active';
  if v_id is null or not app.tenant_is_operational(v_id) or not app.module_enabled(v_id, 'online_booking')
     or not exists (select 1 from public.branches b where b.tenant_id = v_id and b.is_active and b.online_booking_enabled) then
    perform app.raise('BOOKING_UNAVAILABLE', 'Online booking is not available for this salon');
  end if;
  return v_id;
end;
$$;

-- The client's IP as seen by PostgREST (Cloudflare / proxy headers first).
create or replace function app.request_ip()
returns text
language sql
stable
set search_path = ''
as $$
  select nullif(split_part(coalesce(
           nullif(current_setting('request.headers', true), '')::json ->> 'cf-connecting-ip',
           nullif(current_setting('request.headers', true), '')::json ->> 'x-forwarded-for',
           nullif(current_setting('request.headers', true), '')::json ->> 'x-real-ip', ''), ',', 1), '');
$$;

create or replace function public.public_get_salon(p_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant   uuid := app.public_tenant(p_slug);
  v_settings public.tenant_settings%rowtype;
begin
  select * into v_settings from public.tenant_settings where tenant_id = v_tenant;
  return jsonb_build_object(
    'salon', (select jsonb_build_object('name', t.name, 'name_ar', t.name_ar, 'slug', t.slug) from public.tenants t where t.id = v_tenant),
    'settings', jsonb_build_object('currency_code', v_settings.currency_code, 'currency_decimals', v_settings.currency_decimals,
                                   'timezone', v_settings.timezone, 'default_language', v_settings.default_language,
                                   'lead_minutes', v_settings.online_booking_lead_minutes,
                                   'horizon_days', v_settings.online_booking_horizon_days,
                                   'cancel_hours', v_settings.online_booking_cancel_hours,
                                   'note_en', v_settings.online_booking_note_en, 'note_ar', v_settings.online_booking_note_ar),
    'branches', (select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'name_en', b.name_en, 'name_ar', b.name_ar,
                                                             'address_en', b.address_en, 'address_ar', b.address_ar,
                                                             'city', b.city, 'phone', b.phone, 'timezone', b.timezone)
                                           order by b.is_main desc, b.sort_order, b.name_en), '[]'::jsonb)
                 from public.branches b where b.tenant_id = v_tenant and b.is_active and b.online_booking_enabled),
    'categories', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name_en', c.name_en, 'name_ar', c.name_ar)
                                             order by c.sort_order, c.name_en), '[]'::jsonb)
                   from public.service_categories c where c.tenant_id = v_tenant and c.is_active),
    'services', (select coalesce(jsonb_agg(jsonb_build_object(
                   'id', s.id, 'category_id', s.category_id, 'name_en', s.name_en, 'name_ar', s.name_ar,
                   'description_en', s.description_en, 'description_ar', s.description_ar,
                   'duration_minutes', s.duration_minutes, 'price', s.price, 'price_type', s.price_type, 'audience', s.audience,
                   'unavailable_branch_ids', (select coalesce(jsonb_agg(sp.branch_id), '[]'::jsonb) from public.service_prices sp
                                              where sp.service_id = s.id and not sp.is_available))
                 order by s.sort_order, s.name_en), '[]'::jsonb)
                 from public.services s where s.tenant_id = v_tenant and s.is_active and s.online_bookable),
    'staff', (select coalesce(jsonb_agg(jsonb_build_object(
                'id', e.id, 'name_en', e.name_en, 'name_ar', e.name_ar, 'color', e.color,
                'branch_ids', (select jsonb_agg(eb.branch_id) from public.employee_branches eb where eb.employee_id = e.id),
                'service_ids', (select coalesce(jsonb_agg(es.service_id), '[]'::jsonb) from public.employee_services es where es.employee_id = e.id))
              order by e.sort_order, e.name_en), '[]'::jsonb)
              from public.employees e where e.tenant_id = v_tenant and e.is_active and e.is_bookable
                and exists (select 1 from public.employee_branches eb join public.branches b on b.id = eb.branch_id
                            where eb.employee_id = e.id and b.online_booking_enabled and b.is_active)));
end;
$$;

create or replace function public.public_availability(
  p_slug text, p_branch_id uuid, p_service_ids uuid[], p_date date, p_employee_id uuid default null
)
returns table (starts_at timestamptz, employee_id uuid)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_tenant uuid := app.public_tenant(p_slug);
  v_set    public.tenant_settings%rowtype;
begin
  select * into v_set from public.tenant_settings where tenant_id = v_tenant;
  if not exists (select 1 from public.branches b where b.id = p_branch_id and b.tenant_id = v_tenant
                   and b.is_active and b.online_booking_enabled) then
    perform app.raise('INVALID_BRANCH', 'Unknown branch');
  end if;
  if p_date is null or p_date > (now() at time zone v_set.timezone)::date + v_set.online_booking_horizon_days then
    perform app.raise('INVALID_RANGE', 'That date is too far ahead');
  end if;
  return query
  select s.starts_at, s.employee_id
  from app.availability_slots(p_branch_id, p_service_ids, p_date, p_employee_id, 15, null,
                              now() + make_interval(mins => v_set.online_booking_lead_minutes), true) s;
end;
$$;

-- Book online. Customers are found by normalised mobile (an existing profile
-- is never modified from here) or created. Returns a manage token.
create or replace function public.public_create_booking(
  p_slug text,
  p_branch_id uuid,
  p_service_ids uuid[],
  p_employee_id uuid,
  p_starts_at timestamptz,
  p_first_name text,
  p_last_name text,
  p_mobile text,
  p_email text,
  p_notes text,
  p_consent_reminders boolean,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant   uuid := app.public_tenant(p_slug);
  v_set      public.tenant_settings%rowtype;
  v_mobile   text;
  v_ip       text := app.request_ip();
  v_customer public.customers%rowtype;
  v_id       uuid;
  v_token    text;
  v_end      timestamptz;
  v_items    jsonb;
  v_key      text := nullif(btrim(p_idempotency_key), '');
begin
  select * into v_set from public.tenant_settings where tenant_id = v_tenant;
  if v_key is null or char_length(v_key) > 100 then
    perform app.raise('INVALID_VALUE', 'A booking reference is required');
  end if;
  -- Replay: the same browser retrying gets the same booking back.
  select a.id, a.public_token into v_id, v_token from public.appointments a
  where a.tenant_id = v_tenant and a.source = 'online' and a.created_by is null and a.idempotency_key = v_key;
  if found then
    return jsonb_build_object('appointment_id', v_id, 'token', v_token, 'replayed', true);
  end if;

  if not exists (select 1 from public.branches b where b.id = p_branch_id and b.tenant_id = v_tenant
                   and b.is_active and b.online_booking_enabled) then
    perform app.raise('INVALID_BRANCH', 'Unknown branch');
  end if;
  if char_length(btrim(coalesce(p_first_name, ''))) not between 1 and 80 or char_length(p_last_name) > 80
     or char_length(p_notes) > 500 then
    perform app.raise('INVALID_NAME', 'Enter your name');
  end if;
  v_mobile := app.normalize_mobile(p_mobile, v_set.phone_country_code);
  if v_mobile is null then
    perform app.raise('INVALID_MOBILE', 'Enter your mobile number');
  end if;
  if p_starts_at is null or p_starts_at < now() + make_interval(mins => v_set.online_booking_lead_minutes)
     or p_starts_at > now() + make_interval(days => v_set.online_booking_horizon_days + 1) then
    perform app.raise('APPOINTMENT_IN_PAST', 'Choose a time within the online booking window');
  end if;
  if coalesce(cardinality(p_service_ids), 0) not between 1 and 5
     or exists (select 1 from unnest(p_service_ids) x
                where not exists (select 1 from public.services s where s.id = x and s.tenant_id = v_tenant
                                    and s.is_active and s.online_bookable)) then
    perform app.raise('INVALID_SERVICE', 'Choose between 1 and 5 services offered online');
  end if;

  -- Rate limits: 3 bookings per mobile per day, 10 per client IP per hour.
  if (select count(*) from public.public_booking_attempts r
      where r.tenant_id = v_tenant and r.mobile = v_mobile and r.created_at > now() - interval '1 day') >= 3
     or (v_ip is not null and (select count(*) from public.public_booking_attempts r
                               where r.client_ip = v_ip and r.created_at > now() - interval '1 hour') >= 10) then
    perform app.raise('TOO_MANY_REQUESTS', 'Too many online bookings — please call the salon');
  end if;
  insert into public.public_booking_attempts (tenant_id, mobile, client_ip) values (v_tenant, v_mobile, v_ip);

  select * into v_customer from public.customers c where c.tenant_id = v_tenant and c.mobile = v_mobile;
  if found then
    if v_customer.status = 'blocked' then
      perform app.raise('BOOKING_UNAVAILABLE', 'Please contact the salon to book');
    end if;
  else
    insert into public.customers (tenant_id, first_name, last_name, mobile, email, source, preferred_language)
    values (v_tenant, btrim(p_first_name), nullif(btrim(p_last_name), ''), v_mobile,
            nullif(lower(btrim(p_email)), ''), 'online', v_set.default_language)
    returning * into v_customer;
  end if;
  if coalesce(p_consent_reminders, false) then
    insert into public.customer_consents (tenant_id, customer_id, channel, purpose, granted, source)
    select v_tenant, v_customer.id, ch, 'reminders', true, 'online'
    from unnest(case when v_customer.email is not null then array['whatsapp', 'sms', 'email'] else array['whatsapp', 'sms'] end) ch;
  end if;

  v_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  insert into public.appointments (tenant_id, branch_id, customer_id, starts_at, ends_at, source, notes, created_by,
                                   idempotency_key, public_token)
  values (v_tenant, p_branch_id, v_customer.id, p_starts_at, p_starts_at + interval '1 minute', 'online',
          nullif(btrim(p_notes), ''), null, v_key, v_token)
  returning id into v_id;

  select jsonb_agg(jsonb_build_object('service_id', x, 'employee_id', p_employee_id) order by o)
    into v_items
  from unnest(p_service_ids) with ordinality as u(x, o);
  begin
    v_end := app.book_appointment_lines(v_id, v_tenant, p_branch_id, p_starts_at, v_items);
  exception when exclusion_violation then
    perform app.raise('SLOT_UNAVAILABLE', 'That time was just taken. Choose another slot.');
  end;
  update public.appointments set ends_at = v_end where id = v_id;
  return jsonb_build_object('appointment_id', v_id, 'token', v_token, 'replayed', false, 'starts_at', p_starts_at, 'ends_at', v_end);
end;
$$;

-- The customer's own booking, by its secret token.
create or replace function public.public_get_booking(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_a public.appointments%rowtype;
  v_set public.tenant_settings%rowtype;
begin
  select * into v_a from public.appointments where public_token = p_token and char_length(coalesce(p_token, '')) >= 20;
  if not found then
    perform app.raise('NOT_FOUND', 'Booking not found');
  end if;
  select * into v_set from public.tenant_settings where tenant_id = v_a.tenant_id;
  return jsonb_build_object(
    'status', v_a.status, 'starts_at', v_a.starts_at, 'ends_at', v_a.ends_at,
    'salon', (select jsonb_build_object('name', t.name, 'name_ar', t.name_ar, 'slug', t.slug) from public.tenants t where t.id = v_a.tenant_id),
    'branch', (select jsonb_build_object('name_en', b.name_en, 'name_ar', b.name_ar, 'phone', b.phone, 'address_en', b.address_en,
                                         'address_ar', b.address_ar, 'timezone', b.timezone)
               from public.branches b where b.id = v_a.branch_id),
    'services', (select jsonb_agg(jsonb_build_object('name_en', s.service_name_en, 'name_ar', s.service_name_ar,
                                                    'staff_en', e.name_en, 'staff_ar', e.name_ar) order by s.sort_order)
                 from public.appointment_services s join public.employees e on e.id = s.employee_id
                 where s.appointment_id = v_a.id),
    'can_cancel', v_a.status in ('booked', 'confirmed') and v_a.starts_at > now() + make_interval(hours => v_set.online_booking_cancel_hours),
    'cancel_hours', v_set.online_booking_cancel_hours);
end;
$$;

create or replace function public.public_cancel_booking(p_token text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_a public.appointments%rowtype;
  v_set public.tenant_settings%rowtype;
begin
  select * into v_a from public.appointments where public_token = p_token and char_length(coalesce(p_token, '')) >= 20 for update;
  if not found then
    perform app.raise('NOT_FOUND', 'Booking not found');
  end if;
  select * into v_set from public.tenant_settings where tenant_id = v_a.tenant_id;
  if v_a.status not in ('booked', 'confirmed') or v_a.starts_at <= now() + make_interval(hours => v_set.online_booking_cancel_hours) then
    perform app.raise('CANCEL_TOO_LATE', format('Online cancellation closes %s hours before the appointment — please call the salon', v_set.online_booking_cancel_hours));
  end if;
  update public.appointments set status = 'cancelled', cancelled_at = now(), cancel_reason = 'Cancelled online by the customer'
  where id = v_a.id;
  update public.appointment_services set is_active = false where appointment_id = v_a.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Notifications
-- ---------------------------------------------------------------------------
create table public.notification_templates (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  event       text not null check (event in ('booking_confirmed', 'booking_reminder', 'booking_cancelled')),
  channel     text not null check (channel in ('whatsapp', 'sms', 'email')),
  language    text not null check (language in ('en', 'ar')),
  subject     text check (char_length(subject) <= 200),
  body        text not null check (char_length(btrim(body)) between 5 and 1500),
  is_active   boolean not null default true,
  updated_at  timestamptz not null default now(),
  unique (tenant_id, event, channel, language)
);
create trigger notification_templates_updated_at before update on public.notification_templates for each row execute function app.set_updated_at();

create table public.notification_jobs (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null,
  branch_id            uuid,
  customer_id          uuid not null,
  appointment_id       uuid,
  event                text not null,
  channel              text not null check (channel in ('whatsapp', 'sms', 'email')),
  language             text not null check (language in ('en', 'ar')),
  to_address           text,
  subject              text,
  body                 text,
  status               text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'failed', 'skipped', 'cancelled')),
  scheduled_for        timestamptz not null default now(),
  attempts             integer not null default 0,
  last_error           text check (char_length(last_error) <= 500),
  provider             text,
  provider_message_id  text,
  sent_at              timestamptz,
  dedupe_key           text not null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (tenant_id, dedupe_key),
  foreign key (customer_id, tenant_id) references public.customers (id, tenant_id) on delete cascade,
  foreign key (appointment_id, tenant_id) references public.appointments (id, tenant_id) on delete cascade
);
create index notification_jobs_due_idx on public.notification_jobs (scheduled_for) where status = 'queued';
create index notification_jobs_tenant_idx on public.notification_jobs (tenant_id, created_at desc);
create index notification_jobs_appointment_idx on public.notification_jobs (appointment_id);
create trigger notification_jobs_updated_at before update on public.notification_jobs for each row execute function app.set_updated_at();

alter table public.notification_templates enable row level security;
alter table public.notification_jobs enable row level security;
revoke all on public.notification_templates, public.notification_jobs from anon, authenticated;
grant all on public.notification_templates, public.notification_jobs to service_role;

grant select, delete on public.notification_templates to authenticated;
grant insert (tenant_id, event, channel, language, subject, body, is_active) on public.notification_templates to authenticated;
grant update (subject, body, is_active) on public.notification_templates to authenticated;
create policy notification_templates_select on public.notification_templates for select to authenticated
  using (tenant_id in (select app.tenants_with_permission('notifications.manage')));
create policy notification_templates_insert on public.notification_templates for insert to authenticated
  with check (tenant_id in (select app.tenants_with_permission('notifications.manage')));
create policy notification_templates_update on public.notification_templates for update to authenticated
  using (tenant_id in (select app.tenants_with_permission('notifications.manage')))
  with check (tenant_id in (select app.tenants_with_permission('notifications.manage')));
create policy notification_templates_delete on public.notification_templates for delete to authenticated
  using (tenant_id in (select app.tenants_with_permission('notifications.manage')));

grant select on public.notification_jobs to authenticated;
create policy notification_jobs_select on public.notification_jobs for select to authenticated
  using (tenant_id in (select app.tenants_with_permission('notifications.manage')));

-- Built-in wording, used when the salon hasn't written its own template.
create or replace function app.default_template(p_event text, p_language text)
returns table (subject text, body text)
language sql
immutable
set search_path = ''
as $$
  select t.subject, t.body from (values
    ('booking_confirmed', 'en', 'Your booking at {{salon}}',
     'Hello {{name}}, your appointment at {{salon}} ({{branch}}) is booked for {{date}} at {{time}}: {{services}}. Manage or cancel: {{link}}'),
    ('booking_confirmed', 'ar', 'حجزك لدى {{salon}}',
     'مرحباً {{name}}، تم حجز موعدك لدى {{salon}} ({{branch}}) يوم {{date}} الساعة {{time}}: {{services}}. لإدارة الحجز أو إلغائه: {{link}}'),
    ('booking_reminder', 'en', 'Reminder: {{salon}} {{date}} {{time}}',
     'Hello {{name}}, a reminder of your appointment at {{salon}} ({{branch}}) on {{date}} at {{time}}. See you soon! {{link}}'),
    ('booking_reminder', 'ar', 'تذكير: {{salon}} {{date}} {{time}}',
     'مرحباً {{name}}، نذكّرك بموعدك لدى {{salon}} ({{branch}}) يوم {{date}} الساعة {{time}}. بانتظارك! {{link}}'),
    ('booking_cancelled', 'en', 'Booking cancelled — {{salon}}',
     'Hello {{name}}, your appointment at {{salon}} on {{date}} at {{time}} has been cancelled. To book again: {{book_link}}'),
    ('booking_cancelled', 'ar', 'تم إلغاء الحجز — {{salon}}',
     'مرحباً {{name}}، تم إلغاء موعدك لدى {{salon}} يوم {{date}} الساعة {{time}}. للحجز مجدداً: {{book_link}}')
  ) as t(event, language, subject, body)
  where t.event = p_event and t.language = p_language;
$$;

-- First channel (WhatsApp → SMS → email) that the salon has switched on, the
-- customer has an address for, and the customer has consented to (latest
-- consent record for "reminders" wins).
create or replace function app.notification_channel(p_tenant uuid, p_customer uuid)
returns table (channel text, to_address text)
language sql
stable
security definer
set search_path = ''
as $$
  with s as (select * from public.tenant_settings where tenant_id = p_tenant),
       c as (select * from public.customers where id = p_customer and status <> 'blocked'),
       latest as (select distinct on (cc.channel) cc.channel, cc.granted
                  from public.customer_consents cc
                  where cc.customer_id = p_customer and cc.purpose = 'reminders'
                  order by cc.channel, cc.recorded_at desc, cc.id desc)
  select x.channel, x.addr
  from s, c,
       lateral (values (1, 'whatsapp', s.notify_whatsapp, c.mobile),
                       (2, 'sms', s.notify_sms, c.mobile),
                       (3, 'email', s.notify_email, c.email)) as x(ord, channel, enabled, addr)
  where x.enabled and x.addr is not null
    and exists (select 1 from latest l where l.channel = x.channel and l.granted)
  order by x.ord
  limit 1;
$$;

create or replace function app.enqueue_notification(p_appointment public.appointments, p_event text, p_when timestamptz)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ch   record;
  v_lang text;
begin
  if p_appointment.customer_id is null or not app.module_enabled(p_appointment.tenant_id, 'notifications') then
    return;
  end if;
  select * into v_ch from app.notification_channel(p_appointment.tenant_id, p_appointment.customer_id);
  if v_ch.channel is null then
    return;
  end if;
  select coalesce(c.preferred_language, s.default_language) into v_lang
  from public.customers c join public.tenant_settings s on s.tenant_id = c.tenant_id
  where c.id = p_appointment.customer_id;
  insert into public.notification_jobs (tenant_id, branch_id, customer_id, appointment_id, event, channel, language,
                                        to_address, scheduled_for, dedupe_key)
  values (p_appointment.tenant_id, p_appointment.branch_id, p_appointment.customer_id, p_appointment.id, p_event,
          v_ch.channel, v_lang, v_ch.to_address, p_when,
          format('%s:%s:%s', p_appointment.id, p_event, extract(epoch from p_appointment.starts_at)::bigint))
  on conflict (tenant_id, dedupe_key) do nothing;
end;
$$;

-- Appointment lifecycle → messages.
create or replace function app.appointments_notify()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hours integer;
begin
  select s.reminder_hours_before into v_hours from public.tenant_settings s where s.tenant_id = new.tenant_id;
  if tg_op = 'INSERT' then
    perform app.enqueue_notification(new, 'booking_confirmed', now());
    if new.starts_at - make_interval(hours => v_hours) > now() then
      perform app.enqueue_notification(new, 'booking_reminder', new.starts_at - make_interval(hours => v_hours));
    end if;
    return null;
  end if;

  if new.status in ('cancelled', 'no_show') and old.status not in ('cancelled', 'no_show') then
    update public.notification_jobs set status = 'cancelled'
    where appointment_id = new.id and status = 'queued';
    if new.status = 'cancelled' and new.starts_at > now() then
      perform app.enqueue_notification(new, 'booking_cancelled', now());
    end if;
  elsif new.starts_at is distinct from old.starts_at and new.status in ('booked', 'confirmed') then
    -- Rescheduled: drop pending messages, confirm the new time, new reminder.
    update public.notification_jobs set status = 'cancelled'
    where appointment_id = new.id and status = 'queued';
    perform app.enqueue_notification(new, 'booking_confirmed', now());
    if new.starts_at - make_interval(hours => v_hours) > now() then
      perform app.enqueue_notification(new, 'booking_reminder', new.starts_at - make_interval(hours => v_hours));
    end if;
  end if;
  return null;
end;
$$;
create trigger appointments_notify after insert or update of status, starts_at on public.appointments
  for each row execute function app.appointments_notify();

-- Fill in {{placeholders}} for a job (done when sending).
create or replace function app.render_notification(p_job public.notification_jobs)
returns table (subject text, body text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tpl_subject text;
  v_tpl_body    text;
  v_a           public.appointments%rowtype;
  v_c           public.customers%rowtype;
  v_t           public.tenants%rowtype;
  v_b           public.branches%rowtype;
  v_services    text;
  v_staff       text;
  v_local       timestamp;
  v_url         text := app.platform_setting('public_app_url');
  v_vars        jsonb;
  v_key         text;
begin
  select t.subject, t.body into v_tpl_subject, v_tpl_body from public.notification_templates t
  where t.tenant_id = p_job.tenant_id and t.event = p_job.event and t.channel = p_job.channel
    and t.language = p_job.language and t.is_active;
  if v_tpl_body is null then
    select d.subject, d.body into v_tpl_subject, v_tpl_body from app.default_template(p_job.event, p_job.language) d;
  end if;
  select * into v_a from public.appointments where id = p_job.appointment_id;
  select * into v_c from public.customers where id = p_job.customer_id;
  select * into v_t from public.tenants where id = p_job.tenant_id;
  select * into v_b from public.branches where id = v_a.branch_id;
  select string_agg(case when p_job.language = 'ar' then coalesce(s.service_name_ar, s.service_name_en) else s.service_name_en end, ', ' order by s.sort_order),
         string_agg(distinct case when p_job.language = 'ar' then coalesce(e.name_ar, e.name_en) else e.name_en end, ', ')
    into v_services, v_staff
  from public.appointment_services s join public.employees e on e.id = s.employee_id
  where s.appointment_id = v_a.id;
  v_local := v_a.starts_at at time zone coalesce(v_b.timezone, 'Asia/Muscat');

  v_vars := jsonb_build_object(
    'name', v_c.first_name,
    'salon', case when p_job.language = 'ar' then coalesce(v_t.name_ar, v_t.name) else v_t.name end,
    'branch', case when p_job.language = 'ar' then coalesce(v_b.name_ar, v_b.name_en) else v_b.name_en end,
    'branch_phone', coalesce(v_b.phone, ''),
    'date', to_char(v_local, 'DD/MM/YYYY'),
    'time', to_char(v_local, 'HH24:MI'),
    'services', coalesce(v_services, ''),
    'staff', coalesce(v_staff, ''),
    'link', case when v_a.public_token is not null then v_url || '/book/manage/' || v_a.public_token else '' end,
    'book_link', v_url || '/book/' || v_t.slug);
  for v_key in select jsonb_object_keys(v_vars) loop
    v_tpl_body := replace(v_tpl_body, '{{' || v_key || '}}', v_vars ->> v_key);
    v_tpl_subject := replace(v_tpl_subject, '{{' || v_key || '}}', v_vars ->> v_key);
  end loop;
  subject := v_tpl_subject;
  body := btrim(v_tpl_body);
  return next;
end;
$$;

-- Worker API (service role only) ---------------------------------------------
-- Claim due jobs: lock-free between workers (SKIP LOCKED), render, mark sending.
-- Reminders whose appointment is no longer upcoming are cancelled instead.
create or replace function public.claim_notification_jobs(p_limit integer default 20)
returns setof public.notification_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.notification_jobs%rowtype;
  v_r   record;
begin
  for v_job in
    select * from public.notification_jobs j
    where j.status = 'queued' and j.scheduled_for <= now()
    order by j.scheduled_for
    limit least(greatest(coalesce(p_limit, 20), 1), 100)
    for update skip locked
  loop
    if v_job.event = 'booking_reminder' and not exists (
         select 1 from public.appointments a where a.id = v_job.appointment_id and a.status in ('booked', 'confirmed') and a.starts_at > now()) then
      update public.notification_jobs set status = 'cancelled' where id = v_job.id;
      continue;
    end if;
    select * into v_r from app.render_notification(v_job);
    update public.notification_jobs
    set status = 'sending', attempts = attempts + 1, subject = v_r.subject, body = v_r.body
    where id = v_job.id
    returning * into v_job;
    return next v_job;
  end loop;
end;
$$;

-- Report the outcome. Failures retry with exponential backoff (1, 2, 4, 8 min)
-- and give up after 5 attempts; permanent failures and "skipped" stop at once.
create or replace function public.complete_notification_job(
  p_job_id uuid, p_outcome text, p_provider text default null, p_provider_message_id text default null, p_error text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.notification_jobs%rowtype;
begin
  select * into v_job from public.notification_jobs where id = p_job_id for update;
  if not found or v_job.status <> 'sending' then
    return;
  end if;
  if p_outcome = 'sent' then
    update public.notification_jobs
    set status = 'sent', sent_at = now(), provider = p_provider, provider_message_id = p_provider_message_id, last_error = null
    where id = p_job_id;
  elsif p_outcome = 'skipped' then
    update public.notification_jobs set status = 'skipped', provider = p_provider, last_error = left(p_error, 500) where id = p_job_id;
  elsif p_outcome = 'failed_permanent' or v_job.attempts >= 5 then
    update public.notification_jobs set status = 'failed', provider = p_provider, last_error = left(p_error, 500) where id = p_job_id;
  else
    update public.notification_jobs
    set status = 'queued', provider = p_provider, last_error = left(p_error, 500),
        scheduled_for = now() + make_interval(mins => power(2, v_job.attempts - 1)::integer)
    where id = p_job_id;
  end if;
end;
$$;

-- Preview a template with sample data (salon admins).
create or replace function public.preview_notification(p_tenant uuid, p_body text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_t public.tenants%rowtype;
  v_out text := coalesce(p_body, '');
begin
  perform app.require_permission(p_tenant, 'notifications.manage');
  select * into v_t from public.tenants where id = p_tenant;
  v_out := replace(v_out, '{{name}}', 'Aisha');
  v_out := replace(v_out, '{{salon}}', v_t.name);
  v_out := replace(v_out, '{{branch}}', (select b.name_en from public.branches b where b.tenant_id = p_tenant order by b.is_main desc limit 1));
  v_out := replace(v_out, '{{branch_phone}}', '+968 2400 0000');
  v_out := replace(v_out, '{{date}}', to_char(now() + interval '1 day', 'DD/MM/YYYY'));
  v_out := replace(v_out, '{{time}}', '10:30');
  v_out := replace(v_out, '{{services}}', 'Haircut, Blow-dry');
  v_out := replace(v_out, '{{staff}}', 'Reena');
  v_out := replace(v_out, '{{link}}', app.platform_setting('public_app_url') || '/book/manage/…');
  v_out := replace(v_out, '{{book_link}}', app.platform_setting('public_app_url') || '/book/' || v_t.slug);
  return v_out;
end;
$$;

-- Built-in wording (shown in the template editor as the starting point).
create or replace function public.get_notification_defaults()
returns table (event text, language text, subject text, body text)
language sql
stable
security definer
set search_path = ''
as $$
  select e.event, l.language, d.subject, d.body
  from unnest(array['booking_confirmed', 'booking_reminder', 'booking_cancelled']) as e(event)
  cross join unnest(array['en', 'ar']) as l(language)
  cross join lateral app.default_template(e.event, l.language) d;
$$;

-- ---------------------------------------------------------------------------
-- 5. Execute privileges
-- ---------------------------------------------------------------------------
revoke all on function public.get_notification_defaults() from public, anon;
grant execute on function public.get_notification_defaults() to authenticated, service_role;
revoke all on function
  app.platform_setting(text), app.availability_slots(uuid, uuid[], date, uuid, integer, uuid, timestamptz, boolean),
  app.public_tenant(text), app.request_ip(), app.default_template(text, text),
  app.notification_channel(uuid, uuid), app.enqueue_notification(public.appointments, text, timestamptz),
  app.appointments_notify(), app.render_notification(public.notification_jobs)
from public;

-- Public booking: the ONLY functions anon may call.
revoke all on function
  public.public_get_salon(text),
  public.public_availability(text, uuid, uuid[], date, uuid),
  public.public_create_booking(text, uuid, uuid[], uuid, timestamptz, text, text, text, text, text, boolean, text),
  public.public_get_booking(text),
  public.public_cancel_booking(text)
from public;
grant execute on function
  public.public_get_salon(text),
  public.public_availability(text, uuid, uuid[], date, uuid),
  public.public_create_booking(text, uuid, uuid[], uuid, timestamptz, text, text, text, text, text, boolean, text),
  public.public_get_booking(text),
  public.public_cancel_booking(text)
to anon, authenticated, service_role;

-- Worker: service role only (Edge Function).
revoke all on function
  public.claim_notification_jobs(integer),
  public.complete_notification_job(uuid, text, text, text, text)
from public, anon, authenticated;
grant execute on function
  public.claim_notification_jobs(integer),
  public.complete_notification_job(uuid, text, text, text, text)
to service_role;

revoke all on function public.preview_notification(uuid, text) from public, anon;
grant execute on function public.preview_notification(uuid, text) to authenticated, service_role;

revoke all on function public.calculate_availability(uuid, uuid[], date, uuid, integer, uuid) from public, anon;
grant execute on function public.calculate_availability(uuid, uuid[], date, uuid, integer, uuid) to authenticated, service_role;

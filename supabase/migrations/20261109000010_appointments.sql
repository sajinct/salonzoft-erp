-- =============================================================================
-- Salonzoft · Migration 0010 · Appointments & availability
-- -----------------------------------------------------------------------------
-- * appointments (one visit) → appointment_services (one line per service,
--   each performed by one employee, optionally in one resource).
-- * NO DOUBLE-BOOKING, enforced by the database: an exclusion constraint
--   (btree_gist) forbids two active lines of the same employee — or the same
--   resource — whose blocked time ranges (service time + prep/clean-up
--   buffers) overlap. Booking RPCs additionally lock the employee row so
--   concurrent requests queue instead of racing; a lost race surfaces as
--   SLOT_UNAVAILABLE.
-- * Availability = branch hours (or holiday / special-hours period)
--   ∩ employee shifts − approved leave − existing bookings, computed in the
--   branch timezone with multiranges.
-- * Apps can only READ these tables (RLS). Every write goes through audited
--   SECURITY DEFINER RPCs with explicit permission + branch checks.
-- =============================================================================

create extension if not exists btree_gist with schema extensions;

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------
create table public.appointments (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null,
  branch_id          uuid not null,
  customer_id        uuid,
  status             text not null default 'booked'
                     check (status in ('booked', 'confirmed', 'checked_in', 'in_service', 'completed', 'cancelled', 'no_show')),
  starts_at          timestamptz not null,
  ends_at            timestamptz not null,
  source             text not null default 'front_desk'
                     check (source in ('front_desk', 'phone', 'whatsapp', 'walk_in', 'online')),
  notes              text check (char_length(notes) <= 1000),
  cancel_reason      text check (char_length(cancel_reason) <= 300),
  checked_in_at      timestamptz,
  completed_at       timestamptz,
  cancelled_at       timestamptz,
  created_by         uuid default auth.uid() references auth.users (id) on delete set null,
  idempotency_key    text check (char_length(idempotency_key) <= 100),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint appointments_order check (ends_at > starts_at),
  unique (id, tenant_id),
  unique (tenant_id, created_by, idempotency_key),
  foreign key (branch_id, tenant_id) references public.branches (id, tenant_id) on delete cascade,
  foreign key (customer_id, tenant_id) references public.customers (id, tenant_id)
);
create index appointments_branch_time_idx on public.appointments (branch_id, starts_at);
create index appointments_customer_idx on public.appointments (customer_id, starts_at desc);
create index appointments_tenant_time_idx on public.appointments (tenant_id, starts_at);
create trigger appointments_updated_at before update on public.appointments
  for each row execute function app.set_updated_at();

create table public.appointment_services (
  id                     uuid primary key default gen_random_uuid(),
  tenant_id              uuid not null,
  branch_id              uuid not null,
  appointment_id         uuid not null,
  service_id             uuid not null,
  employee_id            uuid not null,
  resource_id            uuid,
  sort_order             smallint not null default 1,
  starts_at              timestamptz not null,
  ends_at                timestamptz not null,
  -- the employee / resource is unavailable for [blocked_from, blocked_until)
  blocked_from           timestamptz not null,
  blocked_until          timestamptz not null,
  duration_minutes       integer not null,
  -- snapshots at booking time (the invoice snapshots again at checkout)
  service_name_en        text not null,
  service_name_ar        text,
  price                  numeric(12,3) not null check (price >= 0),
  price_type             text not null,
  -- false once the appointment is cancelled / no-show: frees the time slot
  is_active              boolean not null default true,
  created_at             timestamptz not null default now(),
  constraint appointment_services_order check (ends_at > starts_at),
  constraint appointment_services_blocked check (blocked_from <= starts_at and blocked_until >= ends_at),
  foreign key (appointment_id, tenant_id) references public.appointments (id, tenant_id) on delete cascade,
  foreign key (service_id, tenant_id) references public.services (id, tenant_id),
  foreign key (employee_id, tenant_id) references public.employees (id, tenant_id),
  foreign key (resource_id, tenant_id) references public.resources (id, tenant_id),
  foreign key (branch_id, tenant_id) references public.branches (id, tenant_id) on delete cascade,
  constraint appointment_services_no_employee_overlap
    exclude using gist (employee_id with =, tstzrange(blocked_from, blocked_until) with &&) where (is_active),
  constraint appointment_services_no_resource_overlap
    exclude using gist (resource_id with =, tstzrange(blocked_from, blocked_until) with &&) where (is_active and resource_id is not null)
);
create index appointment_services_appointment_idx on public.appointment_services (appointment_id, sort_order);
create index appointment_services_employee_idx on public.appointment_services (employee_id, starts_at);
create index appointment_services_branch_idx on public.appointment_services (branch_id, starts_at);
create index appointment_services_service_idx on public.appointment_services (service_id);
create index appointment_services_tenant_idx on public.appointment_services (tenant_id);

-- ---------------------------------------------------------------------------
-- 2. RLS: read-only for apps
-- ---------------------------------------------------------------------------
create or replace function app.branch_ids_with_any_permission(p_permissions text[])
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select b.id
  from public.branches b
  where b.tenant_id in (select app.tenants_with_any_permission(p_permissions))
    and b.id in (select app.accessible_branch_ids());
$$;

alter table public.appointments enable row level security;
alter table public.appointment_services enable row level security;
revoke all on public.appointments, public.appointment_services from anon, authenticated;
grant all on public.appointments, public.appointment_services to service_role;
grant select on public.appointments, public.appointment_services to authenticated;

-- Lines: whole branch for appointments.view/manage; own lines for appointments.own.
create policy appointment_services_select on public.appointment_services
  for select to authenticated
  using (branch_id in (select app.branch_ids_with_any_permission(array['appointments.view', 'appointments.manage']))
         or (employee_id in (select app.my_employee_ids())
             and tenant_id in (select app.tenants_with_permission('appointments.own'))));

create policy appointments_select on public.appointments
  for select to authenticated
  using (branch_id in (select app.branch_ids_with_any_permission(array['appointments.view', 'appointments.manage']))
         or id in (select s.appointment_id from public.appointment_services s
                   where s.employee_id in (select app.my_employee_ids())
                     and s.tenant_id in (select app.tenants_with_permission('appointments.own'))));

create trigger audit_appointments after insert or update on public.appointments
  for each row execute function app.audit_row();

-- Realtime: the calendar listens for changes (Supabase applies RLS to each
-- subscriber, so events are only delivered to users who may read the row).
do $$
begin
  if exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.appointments, public.appointment_services;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Time helpers (branch timezone, multiranges)
-- ---------------------------------------------------------------------------
-- Opening hours of a branch on a local date: a holiday closes it, a special
-- period (Ramadan…) replaces the weekly hours.
create or replace function app.branch_open_ranges(p_branch uuid, p_date date)
returns tstzmultirange
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tz     text;
  v_dow    smallint := extract(dow from p_date)::smallint;
  v_period public.branch_special_periods%rowtype;
  v_result tstzmultirange;
begin
  select b.timezone into v_tz from public.branches b where b.id = p_branch;
  select * into v_period from public.branch_special_periods p
  where p.branch_id = p_branch and p_date between p.starts_on and p.ends_on
  limit 1;

  if found then
    if v_period.kind = 'closed' then
      return '{}'::tstzmultirange;
    end if;
    select range_agg(tstzrange((p_date + h.opens_at) at time zone v_tz, (p_date + h.closes_at) at time zone v_tz))
      into v_result
    from public.branch_special_hours h
    where h.period_id = v_period.id and h.day_of_week = v_dow;
  else
    select range_agg(tstzrange((p_date + w.opens_at) at time zone v_tz, (p_date + w.closes_at) at time zone v_tz))
      into v_result
    from public.branch_working_hours w
    where w.branch_id = p_branch and w.day_of_week = v_dow;
  end if;
  return coalesce(v_result, '{}'::tstzmultirange);
end;
$$;

-- When the employee can work at the branch on that date (ignoring bookings).
create or replace function app.employee_working_ranges(p_employee uuid, p_branch uuid, p_date date)
returns tstzmultirange
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tz     text;
  v_dow    smallint := extract(dow from p_date)::smallint;
  v_shifts tstzmultirange;
  v_leave  tstzmultirange;
  v_start  timestamptz;
begin
  select b.timezone into v_tz from public.branches b where b.id = p_branch;
  v_start := p_date::timestamp at time zone v_tz;

  select coalesce(range_agg(tstzrange((p_date + s.starts_at) at time zone v_tz, (p_date + s.ends_at) at time zone v_tz)), '{}')
    into v_shifts
  from public.staff_shifts s
  where s.employee_id = p_employee and s.branch_id = p_branch and s.day_of_week = v_dow;

  select coalesce(range_agg(tstzrange(l.starts_at, l.ends_at)), '{}')
    into v_leave
  from public.staff_leaves l
  where l.employee_id = p_employee and l.status = 'approved'
    and l.starts_at < v_start + interval '1 day' and l.ends_at > v_start;

  return (app.branch_open_ranges(p_branch, p_date) * v_shifts) - v_leave;
end;
$$;

-- Working ranges minus existing bookings (optionally ignoring one appointment,
-- e.g. the one being rescheduled).
create or replace function app.employee_free_ranges(p_employee uuid, p_branch uuid, p_date date, p_exclude_appointment uuid default null)
returns tstzmultirange
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tz     text;
  v_start  timestamptz;
  v_booked tstzmultirange;
begin
  select b.timezone into v_tz from public.branches b where b.id = p_branch;
  v_start := p_date::timestamp at time zone v_tz;

  select coalesce(range_agg(tstzrange(a.blocked_from, a.blocked_until)), '{}')
    into v_booked
  from public.appointment_services a
  where a.employee_id = p_employee and a.is_active
    and a.blocked_from < v_start + interval '1 day' and a.blocked_until > v_start
    and (p_exclude_appointment is null or a.appointment_id <> p_exclude_appointment);

  return app.employee_working_ranges(p_employee, p_branch, p_date) - v_booked;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Booking engine (internal)
-- ---------------------------------------------------------------------------
-- Insert the service lines of an appointment back-to-back from p_starts_at.
-- p_items: [{ "service_id": uuid, "employee_id": uuid | null, "price": n? }]
-- employee_id null = first qualified employee who is free (preferring the one
-- doing the previous service). Buffers between consecutive services of the
-- same employee are dropped (one continuous visit). Returns the end time.
create or replace function app.book_appointment_lines(
  p_appointment uuid,
  p_tenant uuid,
  p_branch uuid,
  p_starts_at timestamptz,
  p_items jsonb
)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tz         text;
  v_date       date;
  v_cursor     timestamptz := p_starts_at;
  v_item       jsonb;
  v_ord        integer;
  v_service_id uuid;
  v_emp_req    uuid;
  v_svc        public.services%rowtype;
  v_price      numeric(12,3);
  v_emp        uuid;
  v_cand       uuid;
  v_prev_emp   uuid;
  v_prev_line  uuid;
  v_bb         integer;
  v_start      timestamptz;
  v_end        timestamptz;
  v_range      tstzrange;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 10 then
    perform app.raise('INVALID_ITEMS', 'Book between 1 and 10 services');
  end if;
  select b.timezone into v_tz from public.branches b where b.id = p_branch;
  v_date := (p_starts_at at time zone v_tz)::date;

  for v_item, v_ord in
    select e.value, e.ord::integer from jsonb_array_elements(p_items) with ordinality as e(value, ord)
  loop
    begin
      v_service_id := (v_item ->> 'service_id')::uuid;
      v_emp_req := nullif(v_item ->> 'employee_id', '')::uuid;
      v_price := (v_item ->> 'price')::numeric(12,3);
    exception when others then
      perform app.raise('INVALID_ITEMS', 'Each item needs a service_id and an optional employee_id');
    end;

    select * into v_svc from public.services s
    where s.id = v_service_id and s.tenant_id = p_tenant and s.is_active;
    if not found then
      perform app.raise('INVALID_SERVICE', 'Unknown or inactive service');
    end if;
    if exists (select 1 from public.service_prices sp
               where sp.service_id = v_svc.id and sp.branch_id = p_branch and not sp.is_available) then
      perform app.raise('SERVICE_NOT_OFFERED', format('%s is not offered at this branch', v_svc.name_en));
    end if;
    v_price := coalesce(v_price,
                        (select sp.price from public.service_prices sp where sp.service_id = v_svc.id and sp.branch_id = p_branch),
                        v_svc.price);

    v_start := v_cursor;
    v_end := v_start + make_interval(mins => v_svc.duration_minutes);
    v_emp := null;

    if v_emp_req is not null then
      if not exists (select 1 from public.employees e
                     where e.id = v_emp_req and e.tenant_id = p_tenant and e.is_active and e.is_bookable) then
        perform app.raise('INVALID_EMPLOYEE', 'Unknown, inactive or non-bookable employee');
      end if;
      if not exists (select 1 from public.employee_branches eb where eb.employee_id = v_emp_req and eb.branch_id = p_branch) then
        perform app.raise('EMPLOYEE_NOT_AT_BRANCH', 'This employee does not work at this branch');
      end if;
      if not exists (select 1 from public.employee_services es where es.employee_id = v_emp_req and es.service_id = v_svc.id) then
        perform app.raise('EMPLOYEE_NOT_QUALIFIED', format('This employee does not perform %s', v_svc.name_en));
      end if;
      perform 1 from public.employees where id = v_emp_req for update;  -- serialise bookings per employee
      v_bb := case when v_emp_req = v_prev_emp then 0 else v_svc.buffer_before_minutes end;
      v_range := tstzrange(v_start - make_interval(mins => v_bb), v_end + make_interval(mins => v_svc.buffer_after_minutes));
      if not v_range <@ app.employee_free_ranges(v_emp_req, p_branch, v_date, p_appointment) then
        if v_range <@ app.employee_working_ranges(v_emp_req, p_branch, v_date) then
          perform app.raise('SLOT_UNAVAILABLE', 'This employee is already booked at that time');
        end if;
        perform app.raise('OUTSIDE_WORKING_HOURS', 'Outside the opening hours or the employee''s shift');
      end if;
      v_emp := v_emp_req;
    else
      for v_cand in
        select e.id from public.employees e
        where e.tenant_id = p_tenant and e.is_active and e.is_bookable
          and exists (select 1 from public.employee_branches eb where eb.employee_id = e.id and eb.branch_id = p_branch)
          and exists (select 1 from public.employee_services es where es.employee_id = e.id and es.service_id = v_svc.id)
        order by (e.id = v_prev_emp) desc nulls last, e.sort_order, e.name_en, e.id
      loop
        perform 1 from public.employees where id = v_cand for update;
        v_bb := case when v_cand = v_prev_emp then 0 else v_svc.buffer_before_minutes end;
        v_range := tstzrange(v_start - make_interval(mins => v_bb), v_end + make_interval(mins => v_svc.buffer_after_minutes));
        if v_range <@ app.employee_free_ranges(v_cand, p_branch, v_date, p_appointment) then
          v_emp := v_cand;
          exit;
        end if;
      end loop;
      if v_emp is null then
        perform app.raise('SLOT_UNAVAILABLE', format('No qualified employee is free for %s at that time', v_svc.name_en));
      end if;
    end if;

    -- Same employee continues: the previous service needs no clean-up gap.
    if v_emp = v_prev_emp then
      update public.appointment_services set blocked_until = ends_at where id = v_prev_line;
    end if;

    insert into public.appointment_services
      (tenant_id, branch_id, appointment_id, service_id, employee_id, sort_order, starts_at, ends_at,
       blocked_from, blocked_until, duration_minutes, service_name_en, service_name_ar, price, price_type)
    values
      (p_tenant, p_branch, p_appointment, v_svc.id, v_emp, v_ord, v_start, v_end,
       lower(v_range), upper(v_range), v_svc.duration_minutes, v_svc.name_en, v_svc.name_ar, v_price, v_svc.price_type)
    returning id into v_prev_line;

    v_prev_emp := v_emp;
    v_cursor := v_end;
  end loop;

  return v_cursor;
end;
$$;

-- Status machine ----------------------------------------------------------------
create or replace function app.appointment_transition_allowed(p_from text, p_to text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(case p_from
    when 'booked'     then p_to in ('confirmed', 'checked_in', 'in_service', 'cancelled', 'no_show')
    when 'confirmed'  then p_to in ('checked_in', 'in_service', 'cancelled', 'no_show')
    when 'checked_in' then p_to in ('in_service', 'completed', 'cancelled')
    when 'in_service' then p_to in ('completed')
    else false
  end, false);
$$;

-- ---------------------------------------------------------------------------
-- 5. Public RPCs
-- ---------------------------------------------------------------------------

-- Bookable start times on a local date for one or more consecutive services
-- performed by the same employee. p_employee_id null = any qualified employee.
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
  perform app.require_user();
  select b.tenant_id, b.timezone into v_tenant, v_tz from public.branches b where b.id = p_branch_id and b.is_active;
  if not found or not exists (select 1 from app.branch_ids_with_any_permission(array['appointments.view', 'appointments.manage']) x
                              where x = p_branch_id) then
    perform app.forbid('No access to bookings at this branch');
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
      if v_slot >= now()
         and tstzrange(v_slot - make_interval(mins => v_bb), v_slot + make_interval(mins => v_total + v_ba)) <@ v_free then
        starts_at := v_slot;
        employee_id := v_emp;
        return next;
      end if;
    end loop;
  end loop;
end;
$$;

-- Book an appointment. Idempotent per user + key (safe to retry on timeouts).
-- p_items: [{ "service_id": uuid, "employee_id": uuid | null }, …] in order.
create or replace function public.create_appointment(
  p_tenant uuid,
  p_branch_id uuid,
  p_customer_id uuid,
  p_starts_at timestamptz,
  p_items jsonb,
  p_notes text default null,
  p_source text default 'front_desk',
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := app.require_user();
  v_branch  public.branches%rowtype;
  v_status  text;
  v_id      uuid;
  v_end     timestamptz;
  v_items   jsonb;
begin
  perform app.require_permission(p_tenant, 'appointments.manage');
  select * into v_branch from public.branches b where b.id = p_branch_id and b.tenant_id = p_tenant;
  if not found or not v_branch.is_active or not app.has_branch_access(p_branch_id) then
    perform app.raise('INVALID_BRANCH', 'Unknown or inactive branch');
  end if;

  if p_idempotency_key is not null then
    select a.id into v_id from public.appointments a
    where a.tenant_id = p_tenant and a.created_by = v_uid and a.idempotency_key = p_idempotency_key;
    if found then
      return jsonb_build_object('appointment_id', v_id, 'replayed', true);
    end if;
  end if;

  if p_source not in ('front_desk', 'phone', 'whatsapp', 'walk_in', 'online') then
    perform app.raise('INVALID_SOURCE', 'Unknown booking source');
  end if;
  if char_length(p_notes) > 1000 then
    perform app.raise('INVALID_VALUE', 'Notes are limited to 1000 characters');
  end if;
  if p_customer_id is not null then
    select c.status into v_status from public.customers c where c.id = p_customer_id and c.tenant_id = p_tenant;
    if not found then
      perform app.raise('INVALID_CUSTOMER', 'Unknown customer');
    elsif v_status = 'blocked' then
      perform app.raise('CUSTOMER_BLOCKED', 'This customer is blocked from booking');
    end if;
  end if;
  if p_starts_at is null or p_starts_at < now() - interval '15 minutes' then
    perform app.raise('APPOINTMENT_IN_PAST', 'Choose a time in the future');
  end if;

  -- Clients choose services and employees, never prices.
  if jsonb_typeof(p_items) = 'array' then
    select jsonb_agg(jsonb_build_object('service_id', e -> 'service_id', 'employee_id', e -> 'employee_id') order by o)
      into v_items
    from jsonb_array_elements(p_items) with ordinality as x(e, o);
  end if;

  begin
    insert into public.appointments (tenant_id, branch_id, customer_id, starts_at, ends_at, source, notes, created_by, idempotency_key)
    values (p_tenant, p_branch_id, p_customer_id, p_starts_at, p_starts_at + interval '1 minute', p_source,
            nullif(btrim(p_notes), ''), v_uid, p_idempotency_key)
    returning id into v_id;
  exception when unique_violation then
    -- A concurrent retry with the same key won the race: return its result.
    select a.id into v_id from public.appointments a
    where a.tenant_id = p_tenant and a.created_by = v_uid and a.idempotency_key = p_idempotency_key;
    return jsonb_build_object('appointment_id', v_id, 'replayed', true);
  end;

  begin
    v_end := app.book_appointment_lines(v_id, p_tenant, p_branch_id, p_starts_at, v_items);
  exception when exclusion_violation then
    perform app.raise('SLOT_UNAVAILABLE', 'That time was just taken. Choose another slot.');
  end;

  update public.appointments set ends_at = v_end where id = v_id;
  return jsonb_build_object('appointment_id', v_id, 'replayed', false, 'starts_at', p_starts_at, 'ends_at', v_end);
end;
$$;

-- Move an appointment (all its services) to a new start, optionally to
-- another employee. Prices booked earlier are kept.
create or replace function public.reschedule_appointment(
  p_appointment_id uuid,
  p_starts_at timestamptz,
  p_employee_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_appt  public.appointments%rowtype;
  v_items jsonb;
  v_end   timestamptz;
begin
  perform app.require_user();
  select * into v_appt from public.appointments where id = p_appointment_id for update;
  if not found or not app.has_permission(v_appt.tenant_id, 'appointments.manage')
     or not app.has_branch_access(v_appt.branch_id) then
    perform app.raise('NOT_FOUND', 'Appointment not found');
  end if;
  if v_appt.status not in ('booked', 'confirmed') then
    perform app.raise('INVALID_STATUS_TRANSITION', 'Only booked or confirmed appointments can be moved');
  end if;
  if p_starts_at is null or p_starts_at < now() - interval '15 minutes' then
    perform app.raise('APPOINTMENT_IN_PAST', 'Choose a time in the future');
  end if;

  select jsonb_agg(jsonb_build_object('service_id', s.service_id,
                                      'employee_id', coalesce(p_employee_id, s.employee_id),
                                      'price', s.price) order by s.sort_order)
    into v_items
  from public.appointment_services s where s.appointment_id = p_appointment_id;

  delete from public.appointment_services where appointment_id = p_appointment_id;
  begin
    v_end := app.book_appointment_lines(p_appointment_id, v_appt.tenant_id, v_appt.branch_id, p_starts_at, v_items);
  exception when exclusion_violation then
    perform app.raise('SLOT_UNAVAILABLE', 'That time was just taken. Choose another slot.');
  end;

  update public.appointments set starts_at = p_starts_at, ends_at = v_end where id = p_appointment_id;
  perform app.audit(v_appt.tenant_id, 'appointment.rescheduled', 'appointments', p_appointment_id::text,
                    jsonb_build_object('starts_at', v_appt.starts_at), jsonb_build_object('starts_at', p_starts_at),
                    '{}'::jsonb, v_appt.branch_id);
  return jsonb_build_object('appointment_id', p_appointment_id, 'starts_at', p_starts_at, 'ends_at', v_end);
end;
$$;

-- Confirm, check in, start, complete, cancel or mark no-show.
-- Front desk (appointments.manage) may do any allowed transition; a stylist
-- (appointments.own) may start / complete their own appointments.
create or replace function public.set_appointment_status(p_appointment_id uuid, p_status text, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_appt public.appointments%rowtype;
  v_mgr  boolean;
  v_own  boolean;
begin
  perform app.require_user();
  select * into v_appt from public.appointments where id = p_appointment_id for update;
  if not found then
    perform app.raise('NOT_FOUND', 'Appointment not found');
  end if;
  v_mgr := app.has_permission(v_appt.tenant_id, 'appointments.manage') and app.has_branch_access(v_appt.branch_id);
  v_own := app.has_permission(v_appt.tenant_id, 'appointments.own')
           and exists (select 1 from public.appointment_services s
                       where s.appointment_id = p_appointment_id
                         and s.employee_id in (select app.my_employee_ids()));
  if not v_mgr and not (v_own and p_status in ('in_service', 'completed')) then
    if v_own or app.has_permission(v_appt.tenant_id, 'appointments.view') then
      perform app.forbid('You cannot change this appointment');
    end if;
    perform app.raise('NOT_FOUND', 'Appointment not found');
  end if;
  if not app.appointment_transition_allowed(v_appt.status, p_status) then
    perform app.raise('INVALID_STATUS_TRANSITION', format('Cannot change from %s to %s', v_appt.status, p_status));
  end if;
  if char_length(p_reason) > 300 then
    perform app.raise('INVALID_VALUE', 'Reason is limited to 300 characters');
  end if;

  update public.appointments
  set status = p_status,
      checked_in_at = case when p_status in ('checked_in', 'in_service') then coalesce(checked_in_at, now()) else checked_in_at end,
      completed_at  = case when p_status = 'completed' then now() else completed_at end,
      cancelled_at  = case when p_status in ('cancelled', 'no_show') then now() else cancelled_at end,
      cancel_reason = case when p_status in ('cancelled', 'no_show') then nullif(btrim(p_reason), '') else cancel_reason end
  where id = p_appointment_id;

  if p_status in ('cancelled', 'no_show') then
    update public.appointment_services set is_active = false where appointment_id = p_appointment_id;
  end if;
end;
$$;

-- Change the customer or notes of an appointment.
create or replace function public.update_appointment(p_appointment_id uuid, p_customer_id uuid, p_notes text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_appt   public.appointments%rowtype;
  v_status text;
begin
  perform app.require_user();
  select * into v_appt from public.appointments where id = p_appointment_id for update;
  if not found or not app.has_permission(v_appt.tenant_id, 'appointments.manage')
     or not app.has_branch_access(v_appt.branch_id) then
    perform app.raise('NOT_FOUND', 'Appointment not found');
  end if;
  if p_customer_id is not null and p_customer_id is distinct from v_appt.customer_id then
    select c.status into v_status from public.customers c where c.id = p_customer_id and c.tenant_id = v_appt.tenant_id;
    if not found then
      perform app.raise('INVALID_CUSTOMER', 'Unknown customer');
    elsif v_status = 'blocked' then
      perform app.raise('CUSTOMER_BLOCKED', 'This customer is blocked from booking');
    end if;
  end if;
  if char_length(p_notes) > 1000 then
    perform app.raise('INVALID_VALUE', 'Notes are limited to 1000 characters');
  end if;
  update public.appointments
  set customer_id = p_customer_id, notes = nullif(btrim(p_notes), '')
  where id = p_appointment_id;
end;
$$;

-- Everything the calendar needs for a branch and time window (≤ 31 days):
-- bookable employees, their working ranges (≤ 7 days), and appointments with
-- their lines and customer. Stylists (appointments.own) get only their own.
create or replace function public.get_calendar(p_branch_id uuid, p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_branch   public.branches%rowtype;
  v_all      boolean;
  v_own      boolean;
  v_mine     uuid[];
  v_contacts boolean;
  v_dates    date[];
begin
  perform app.require_user();
  select * into v_branch from public.branches where id = p_branch_id;
  if not found or not app.has_branch_access(p_branch_id) then
    perform app.forbid('No access to this branch');
  end if;
  v_all := exists (select 1 from app.branch_ids_with_any_permission(array['appointments.view', 'appointments.manage']) x
                   where x = p_branch_id);
  v_own := app.has_permission(v_branch.tenant_id, 'appointments.own');
  if not v_all and not v_own then
    perform app.forbid('No access to appointments');
  end if;
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > interval '31 days' then
    perform app.raise('INVALID_RANGE', 'Choose a window of at most 31 days');
  end if;
  v_mine := array(select app.my_employee_ids());
  v_contacts := app.has_permission(v_branch.tenant_id, 'customers.view');

  if p_to - p_from <= interval '7 days' then
    v_dates := array(select d::date from generate_series((p_from at time zone v_branch.timezone)::date,
                                                         ((p_to - interval '1 microsecond') at time zone v_branch.timezone)::date,
                                                         interval '1 day') d);
  else
    v_dates := '{}';
  end if;

  return jsonb_build_object(
    'branch', jsonb_build_object('id', v_branch.id, 'timezone', v_branch.timezone,
                                 'name_en', v_branch.name_en, 'name_ar', v_branch.name_ar),
    'can_manage', app.has_permission(v_branch.tenant_id, 'appointments.manage'),
    'my_employee_ids', to_jsonb(v_mine),
    'open', (select coalesce(jsonb_agg(jsonb_build_array(lower(r), upper(r))), '[]'::jsonb)
             from unnest(v_dates) d, unnest(app.branch_open_ranges(p_branch_id, d)) r),
    'employees', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', e.id, 'name_en', e.name_en, 'name_ar', e.name_ar, 'color', e.color, 'job_title', e.job_title,
               'working', (select coalesce(jsonb_agg(jsonb_build_array(lower(r), upper(r))), '[]'::jsonb)
                           from unnest(v_dates) d, unnest(app.employee_working_ranges(e.id, p_branch_id, d)) r))
             order by e.sort_order, e.name_en), '[]'::jsonb)
      from public.employees e
      where e.tenant_id = v_branch.tenant_id and e.is_active and e.is_bookable
        and exists (select 1 from public.employee_branches eb where eb.employee_id = e.id and eb.branch_id = p_branch_id)
        and (v_all or e.id = any (v_mine))),
    'appointments', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', a.id, 'status', a.status, 'starts_at', a.starts_at, 'ends_at', a.ends_at,
               'source', a.source, 'notes', a.notes, 'cancel_reason', a.cancel_reason,
               'customer', case when c.id is null then null else jsonb_build_object(
                             'id', c.id, 'first_name', c.first_name, 'last_name', c.last_name, 'name_ar', c.name_ar,
                             'mobile', case when v_contacts then c.mobile end) end,
               'lines', (select jsonb_agg(jsonb_build_object(
                                 'id', s.id, 'service_id', s.service_id, 'employee_id', s.employee_id,
                                 'starts_at', s.starts_at, 'ends_at', s.ends_at,
                                 'service_name_en', s.service_name_en, 'service_name_ar', s.service_name_ar,
                                 'price', s.price, 'price_type', s.price_type) order by s.sort_order)
                         from public.appointment_services s
                         where s.appointment_id = a.id and (v_all or s.employee_id = any (v_mine))))
             order by a.starts_at), '[]'::jsonb)
      from public.appointments a
      left join public.customers c on c.id = a.customer_id
      where a.branch_id = p_branch_id
        and a.starts_at < p_to and a.ends_at > p_from
        and (v_all or exists (select 1 from public.appointment_services s
                              where s.appointment_id = a.id and s.employee_id = any (v_mine))))
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Dashboard: today's bookings
-- ---------------------------------------------------------------------------
create or replace function public.get_appointment_stats(p_tenant uuid, p_branch_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tz    text;
  v_start timestamptz;
begin
  perform app.require_user();
  if not exists (select 1 from app.tenants_with_any_permission(array['appointments.view', 'appointments.manage']) x where x = p_tenant) then
    perform app.forbid('No access to appointments');
  end if;
  if p_branch_id is not null and not app.has_branch_access(p_branch_id) then
    perform app.forbid('No access to this branch');
  end if;
  select s.timezone into v_tz from public.tenant_settings s where s.tenant_id = p_tenant;
  v_start := (now() at time zone v_tz)::date::timestamp at time zone v_tz;

  return (
    select jsonb_build_object(
             'today', count(*) filter (where a.status not in ('cancelled', 'no_show')),
             'upcoming', count(*) filter (where a.status in ('booked', 'confirmed') and a.starts_at >= now()),
             'checked_in', count(*) filter (where a.status in ('checked_in', 'in_service')),
             'completed', count(*) filter (where a.status = 'completed'),
             'cancelled', count(*) filter (where a.status in ('cancelled', 'no_show')))
    from public.appointments a
    where a.tenant_id = p_tenant
      and a.starts_at >= v_start and a.starts_at < v_start + interval '1 day'
      and a.branch_id in (select app.branch_ids_with_any_permission(array['appointments.view', 'appointments.manage']))
      and (p_branch_id is null or a.branch_id = p_branch_id));
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Execute privileges
-- ---------------------------------------------------------------------------
revoke all on function
  app.branch_ids_with_any_permission(text[]),
  app.branch_open_ranges(uuid, date),
  app.employee_working_ranges(uuid, uuid, date),
  app.employee_free_ranges(uuid, uuid, date, uuid),
  app.book_appointment_lines(uuid, uuid, uuid, timestamptz, jsonb),
  app.appointment_transition_allowed(text, text)
from public;
-- Only the RLS helper is needed by API roles; the schedule helpers are used
-- by SECURITY DEFINER RPCs only (they would reveal other staff's schedules).
grant execute on function app.branch_ids_with_any_permission(text[]) to authenticated, service_role;

revoke all on function
  public.calculate_availability(uuid, uuid[], date, uuid, integer, uuid),
  public.create_appointment(uuid, uuid, uuid, timestamptz, jsonb, text, text, text),
  public.reschedule_appointment(uuid, timestamptz, uuid),
  public.set_appointment_status(uuid, text, text),
  public.update_appointment(uuid, uuid, text),
  public.get_calendar(uuid, timestamptz, timestamptz),
  public.get_appointment_stats(uuid, uuid)
from public, anon;

grant execute on function
  public.calculate_availability(uuid, uuid[], date, uuid, integer, uuid),
  public.create_appointment(uuid, uuid, uuid, timestamptz, jsonb, text, text, text),
  public.reschedule_appointment(uuid, timestamptz, uuid),
  public.set_appointment_status(uuid, text, text),
  public.update_appointment(uuid, uuid, text),
  public.get_calendar(uuid, timestamptz, timestamptz),
  public.get_appointment_stats(uuid, uuid)
to authenticated, service_role;

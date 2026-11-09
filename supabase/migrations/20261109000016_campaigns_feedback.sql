-- =============================================================================
-- Salonzoft · Migration 0016 · Marketing campaigns & customer feedback
-- -----------------------------------------------------------------------------
-- Both reuse the notification queue (0015): same worker, retries and log.
-- * Campaigns go only to customers with MARKETING consent on the channel
--   (latest consent record wins — separate from reminder consent), count
--   against the plan's monthly message allowance, and always carry a
--   one-tap unsubscribe link that writes a withdrawal into the consent
--   history.
-- * Feedback: when a visit is completed, a request is queued after a delay;
--   the customer rates 1–5 stars once, within 30 days, through a secret link.
-- New anonymous functions (allow-list in 01_schema_security):
--   public_unsubscribe, public_get_feedback, public_submit_feedback.
-- =============================================================================

alter table public.tenant_settings
  add column feedback_enabled boolean not null default false,
  add column feedback_delay_hours integer not null default 2 check (feedback_delay_hours between 0 and 72);
grant update (feedback_enabled, feedback_delay_hours) on public.tenant_settings to authenticated;

alter table public.notification_templates drop constraint notification_templates_event_check;
alter table public.notification_templates add constraint notification_templates_event_check
  check (event in ('booking_confirmed', 'booking_reminder', 'booking_cancelled', 'feedback_request'));

-- ---------------------------------------------------------------------------
-- 1. Campaigns
-- ---------------------------------------------------------------------------
create table public.campaigns (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants (id) on delete cascade,
  name           text not null check (char_length(btrim(name)) between 2 and 120),
  channel        text not null check (channel in ('whatsapp', 'sms', 'email')),
  segment        jsonb not null default '{}'::jsonb check (jsonb_typeof(segment) = 'object'),
  subject_en     text check (char_length(subject_en) <= 200),
  subject_ar     text check (char_length(subject_ar) <= 200),
  body_en        text not null check (char_length(btrim(body_en)) between 5 and 1000),
  body_ar        text check (char_length(body_ar) <= 1000),
  status         text not null default 'draft' check (status in ('draft', 'launched', 'cancelled')),
  scheduled_for  timestamptz,
  launched_at    timestamptz,
  recipients     integer not null default 0,
  created_by     uuid default auth.uid() references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (id, tenant_id)
);
create index campaigns_tenant_idx on public.campaigns (tenant_id, created_at desc);
create trigger campaigns_updated_at before update on public.campaigns for each row execute function app.set_updated_at();

create table public.campaign_recipients (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null,
  campaign_id        uuid not null,
  customer_id        uuid not null,
  job_id             uuid,
  unsubscribe_token  text not null unique,
  created_at         timestamptz not null default now(),
  unique (campaign_id, customer_id),
  foreign key (campaign_id, tenant_id) references public.campaigns (id, tenant_id) on delete cascade,
  foreign key (customer_id, tenant_id) references public.customers (id, tenant_id) on delete cascade
);
create index campaign_recipients_tenant_idx on public.campaign_recipients (tenant_id);
create index campaign_recipients_job_idx on public.campaign_recipients (job_id);

alter table public.notification_jobs add column campaign_id uuid;
alter table public.notification_jobs add constraint notification_jobs_campaign_fk
  foreign key (campaign_id) references public.campaigns (id) on delete cascade;
create index notification_jobs_campaign_idx on public.notification_jobs (campaign_id);

-- ---------------------------------------------------------------------------
-- 2. Feedback
-- ---------------------------------------------------------------------------
create table public.customer_feedback (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null,
  branch_id       uuid not null,
  appointment_id  uuid not null unique,
  customer_id     uuid not null,
  token           text not null unique,
  rating          smallint check (rating between 1 and 5),
  comment         text check (char_length(comment) <= 1000),
  submitted_at    timestamptz,
  expires_at      timestamptz not null default (now() + interval '30 days'),
  created_at      timestamptz not null default now(),
  constraint customer_feedback_submitted check ((submitted_at is null) = (rating is null)),
  foreign key (appointment_id, tenant_id) references public.appointments (id, tenant_id) on delete cascade,
  foreign key (customer_id, tenant_id) references public.customers (id, tenant_id) on delete cascade,
  foreign key (branch_id, tenant_id) references public.branches (id, tenant_id) on delete cascade
);
create index customer_feedback_tenant_idx on public.customer_feedback (tenant_id, submitted_at desc);

-- ---------------------------------------------------------------------------
-- 3. RLS + grants
-- ---------------------------------------------------------------------------
alter table public.campaigns           enable row level security;
alter table public.campaign_recipients enable row level security;
alter table public.customer_feedback   enable row level security;
revoke all on public.campaigns, public.campaign_recipients, public.customer_feedback from anon, authenticated;
grant all on public.campaigns, public.campaign_recipients, public.customer_feedback to service_role;

grant select on public.campaigns to authenticated;
grant insert (tenant_id, name, channel, segment, subject_en, subject_ar, body_en, body_ar, scheduled_for) on public.campaigns to authenticated;
grant update (name, channel, segment, subject_en, subject_ar, body_en, body_ar, scheduled_for) on public.campaigns to authenticated;
grant delete on public.campaigns to authenticated;
create policy campaigns_select on public.campaigns for select to authenticated
  using (tenant_id in (select app.tenants_with_permission('marketing.manage')));
create policy campaigns_insert on public.campaigns for insert to authenticated
  with check (tenant_id in (select app.tenants_with_permission('marketing.manage')) and status = 'draft');
create policy campaigns_update on public.campaigns for update to authenticated
  using (tenant_id in (select app.tenants_with_permission('marketing.manage')) and status = 'draft')
  with check (tenant_id in (select app.tenants_with_permission('marketing.manage')) and status = 'draft');
create policy campaigns_delete on public.campaigns for delete to authenticated
  using (tenant_id in (select app.tenants_with_permission('marketing.manage')) and status = 'draft');

grant select on public.customer_feedback to authenticated;
create policy customer_feedback_select on public.customer_feedback for select to authenticated
  using (tenant_id in (select app.tenants_with_any_permission(array['marketing.manage', 'reports.view', 'customers.view'])));
-- campaign_recipients: no API access (holds unsubscribe tokens).

create trigger audit_campaigns after insert or update on public.campaigns for each row execute function app.audit_row();

-- ---------------------------------------------------------------------------
-- 4. Audience
-- ---------------------------------------------------------------------------
-- Customers matching a segment who may receive marketing on p_channel.
-- Segment keys (all optional): inactive_days, active_days, min_visits,
-- min_spend, tags (any of), gender, home_branch_id, birthday_this_month,
-- members_only.
create or replace function app.campaign_audience(p_tenant uuid, p_segment jsonb, p_channel text)
returns table (customer_id uuid, address text, language text)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_tz text;
  v_default_lang text;
begin
  select s.timezone, s.default_language into v_tz, v_default_lang from public.tenant_settings s where s.tenant_id = p_tenant;
  return query
  with visits as (
    select a.customer_id, max(a.starts_at) as last_visit, count(*) as n
    from public.appointments a
    where a.tenant_id = p_tenant and a.status = 'completed' and a.customer_id is not null
    group by a.customer_id
  ), spend as (
    select i.customer_id, sum(case when i.kind = 'invoice' then i.total else -i.total end) as total
    from public.invoices i
    where i.tenant_id = p_tenant and i.status = 'posted' and i.customer_id is not null
    group by i.customer_id
  ), consent as (
    select distinct on (cc.customer_id) cc.customer_id, cc.granted
    from public.customer_consents cc
    where cc.tenant_id = p_tenant and cc.channel = p_channel and cc.purpose = 'marketing'
    order by cc.customer_id, cc.recorded_at desc, cc.id desc
  )
  select c.id, case when p_channel = 'email' then c.email else c.mobile end, coalesce(c.preferred_language, v_default_lang)
  from public.customers c
  join consent k on k.customer_id = c.id and k.granted
  left join visits v on v.customer_id = c.id
  left join spend s on s.customer_id = c.id
  where c.tenant_id = p_tenant and c.status = 'active'
    and (case when p_channel = 'email' then c.email else c.mobile end) is not null
    and (p_segment ->> 'inactive_days' is null
         or coalesce(v.last_visit, '-infinity') < now() - make_interval(days => (p_segment ->> 'inactive_days')::int))
    and (p_segment ->> 'active_days' is null
         or v.last_visit >= now() - make_interval(days => (p_segment ->> 'active_days')::int))
    and (p_segment ->> 'min_visits' is null or coalesce(v.n, 0) >= (p_segment ->> 'min_visits')::int)
    and (p_segment ->> 'min_spend' is null or coalesce(s.total, 0) >= (p_segment ->> 'min_spend')::numeric)
    and (jsonb_typeof(p_segment -> 'tags') is distinct from 'array' or jsonb_array_length(p_segment -> 'tags') = 0
         or c.tags && array(select lower(jsonb_array_elements_text(p_segment -> 'tags'))))
    and (p_segment ->> 'gender' is null or c.gender = p_segment ->> 'gender')
    and (p_segment ->> 'home_branch_id' is null or c.home_branch_id = (p_segment ->> 'home_branch_id')::uuid)
    and (coalesce((p_segment ->> 'birthday_this_month')::boolean, false) = false
         or extract(month from c.date_of_birth) = extract(month from (now() at time zone v_tz)))
    and (coalesce((p_segment ->> 'members_only')::boolean, false) = false
         or exists (select 1 from public.customer_memberships m
                    where m.customer_id = c.id and m.status = 'active' and now() between m.starts_at and m.ends_at));
end;
$$;

create or replace function public.preview_campaign_audience(p_tenant uuid, p_segment jsonb, p_channel text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform app.require_permission(p_tenant, 'marketing.manage');
  if p_channel not in ('whatsapp', 'sms', 'email') then
    perform app.raise('INVALID_CHANNEL', 'Choose WhatsApp, SMS or email');
  end if;
  begin
    return jsonb_build_object(
      'count', (select count(*) from app.campaign_audience(p_tenant, coalesce(p_segment, '{}'), p_channel)),
      'sample', (select coalesce(jsonb_agg(c.first_name || coalesce(' ' || left(c.last_name, 1) || '.', '')), '[]'::jsonb)
                 from (select a.customer_id from app.campaign_audience(p_tenant, coalesce(p_segment, '{}'), p_channel) a limit 8) x
                 join public.customers c on c.id = x.customer_id),
      'consented', (select count(distinct cc.customer_id) from public.customer_consents cc
                    where cc.tenant_id = p_tenant and cc.channel = p_channel and cc.purpose = 'marketing' and cc.granted));
  exception when invalid_text_representation or numeric_value_out_of_range or datetime_field_overflow then
    perform app.raise('INVALID_SEGMENT', 'Check the audience filters');
  end;
end;
$$;

-- Launch: queue one job per recipient (now or at scheduled_for), counting
-- against the plan's monthly message allowance.
create or replace function public.launch_campaign(p_campaign_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_c       public.campaigns%rowtype;
  v_max     integer;
  v_used    bigint;
  v_period  date;
  v_count   integer;
  v_when    timestamptz;
  v_r       record;
  v_job     uuid;
begin
  perform app.require_user();
  select * into v_c from public.campaigns where id = p_campaign_id for update;
  if not found or not app.is_tenant_member(v_c.tenant_id) then
    perform app.raise('NOT_FOUND', 'Campaign not found');
  end if;
  perform app.require_permission(v_c.tenant_id, 'marketing.manage');
  if v_c.status <> 'draft' then
    perform app.raise('CAMPAIGN_NOT_DRAFT', 'This campaign was already launched');
  end if;
  v_when := greatest(coalesce(v_c.scheduled_for, now()), now());
  if v_when > now() + interval '60 days' then
    perform app.raise('INVALID_RANGE', 'Schedule within the next 60 days');
  end if;

  perform 1 from public.tenants where id = v_c.tenant_id for update;  -- serialise launches per tenant
  select count(*) into v_count from app.campaign_audience(v_c.tenant_id, v_c.segment, v_c.channel);
  if v_count = 0 then
    perform app.raise('EMPTY_AUDIENCE', 'Nobody in this audience has agreed to receive marketing on this channel');
  end if;
  select p.max_monthly_messages into v_max
  from public.tenant_subscriptions s join public.subscription_plans p on p.id = s.plan_id
  where s.tenant_id = v_c.tenant_id and s.status in ('trialing', 'active', 'past_due');
  v_period := date_trunc('month', now())::date;
  select coalesce(u.quantity, 0) into v_used from public.tenant_usage u
  where u.tenant_id = v_c.tenant_id and u.metric = 'messages' and u.period_start = v_period;
  if v_max is not null and coalesce(v_used, 0) + v_count > v_max then
    perform app.raise('PLAN_LIMIT_MESSAGES', format('This would send %s messages; %s of %s are left this month', v_count, greatest(v_max - coalesce(v_used, 0), 0), v_max));
  end if;

  for v_r in select * from app.campaign_audience(v_c.tenant_id, v_c.segment, v_c.channel) loop
    insert into public.notification_jobs (tenant_id, customer_id, campaign_id, event, channel, language, to_address,
                                          scheduled_for, dedupe_key)
    values (v_c.tenant_id, v_r.customer_id, v_c.id, 'campaign', v_c.channel, v_r.language, v_r.address, v_when,
            format('campaign:%s:%s', v_c.id, v_r.customer_id))
    returning id into v_job;
    insert into public.campaign_recipients (tenant_id, campaign_id, customer_id, job_id, unsubscribe_token)
    values (v_c.tenant_id, v_c.id, v_r.customer_id, v_job, replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''));
  end loop;

  insert into public.tenant_usage (tenant_id, metric, period_start, quantity)
  values (v_c.tenant_id, 'messages', v_period, v_count)
  on conflict (tenant_id, metric, period_start) do update set quantity = public.tenant_usage.quantity + excluded.quantity, updated_at = now();
  update public.campaigns set status = 'launched', launched_at = now(), scheduled_for = v_when, recipients = v_count where id = v_c.id;
  return jsonb_build_object('recipients', v_count, 'scheduled_for', v_when);
end;
$$;

-- Stop a launched campaign: messages not yet sent are cancelled.
create or replace function public.cancel_campaign(p_campaign_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_c     public.campaigns%rowtype;
  v_count integer;
begin
  perform app.require_user();
  select * into v_c from public.campaigns where id = p_campaign_id for update;
  if not found or not app.is_tenant_member(v_c.tenant_id) then
    perform app.raise('NOT_FOUND', 'Campaign not found');
  end if;
  perform app.require_permission(v_c.tenant_id, 'marketing.manage');
  if v_c.status <> 'launched' then
    perform app.raise('CAMPAIGN_NOT_LAUNCHED', 'Only launched campaigns can be stopped');
  end if;
  update public.notification_jobs set status = 'cancelled' where campaign_id = p_campaign_id and status = 'queued';
  get diagnostics v_count = row_count;
  update public.campaigns set status = 'cancelled' where id = p_campaign_id;
  return v_count;
end;
$$;

create or replace function public.get_campaign_stats(p_tenant uuid)
returns table (campaign_id uuid, queued integer, sent integer, failed integer, skipped integer, cancelled integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform app.require_permission(p_tenant, 'marketing.manage');
  return query
  select j.campaign_id,
         (count(*) filter (where j.status in ('queued', 'sending')))::integer,
         (count(*) filter (where j.status = 'sent'))::integer,
         (count(*) filter (where j.status = 'failed'))::integer,
         (count(*) filter (where j.status = 'skipped'))::integer,
         (count(*) filter (where j.status = 'cancelled'))::integer
  from public.notification_jobs j
  where j.tenant_id = p_tenant and j.campaign_id is not null
  group by j.campaign_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Templates & rendering (+ feedback request, + campaigns)
-- ---------------------------------------------------------------------------
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
     'مرحباً {{name}}، تم إلغاء موعدك لدى {{salon}} يوم {{date}} الساعة {{time}}. للحجز مجدداً: {{book_link}}'),
    ('feedback_request', 'en', 'How was your visit to {{salon}}?',
     'Hello {{name}}, thank you for visiting {{salon}}! How was it? Rate your visit in 10 seconds: {{feedback_link}}'),
    ('feedback_request', 'ar', 'كيف كانت زيارتك إلى {{salon}}؟',
     'مرحباً {{name}}، شكراً لزيارتك {{salon}}! كيف كانت تجربتك؟ قيّم زيارتك في 10 ثوانٍ: {{feedback_link}}')
  ) as t(event, language, subject, body)
  where t.event = p_event and t.language = p_language;
$$;

create or replace function public.get_notification_defaults()
returns table (event text, language text, subject text, body text)
language sql
stable
security definer
set search_path = ''
as $$
  select e.event, l.language, d.subject, d.body
  from unnest(array['booking_confirmed', 'booking_reminder', 'booking_cancelled', 'feedback_request']) as e(event)
  cross join unnest(array['en', 'ar']) as l(language)
  cross join lateral app.default_template(e.event, l.language) d;
$$;

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
  v_camp        public.campaigns%rowtype;
  v_services    text;
  v_staff       text;
  v_local       timestamp;
  v_url         text := app.platform_setting('public_app_url');
  v_vars        jsonb;
  v_key         text;
  v_unsub       text;
  v_feedback    text;
begin
  select * into v_c from public.customers where id = p_job.customer_id;
  select * into v_t from public.tenants where id = p_job.tenant_id;

  if p_job.event = 'campaign' then
    select * into v_camp from public.campaigns where id = p_job.campaign_id;
    v_tpl_body := case when p_job.language = 'ar' then coalesce(nullif(btrim(v_camp.body_ar), ''), v_camp.body_en) else v_camp.body_en end;
    v_tpl_subject := case when p_job.language = 'ar' then coalesce(v_camp.subject_ar, v_camp.subject_en) else v_camp.subject_en end;
    select v_url || '/unsubscribe/' || r.unsubscribe_token into v_unsub from public.campaign_recipients r where r.job_id = p_job.id;
    -- Every marketing message carries an opt-out.
    if position('{{unsubscribe_link}}' in v_tpl_body) = 0 then
      v_tpl_body := v_tpl_body || E'\n' || case when p_job.language = 'ar' then 'لإيقاف الرسائل: ' else 'Stop messages: ' end || '{{unsubscribe_link}}';
    end if;
  else
    select t.subject, t.body into v_tpl_subject, v_tpl_body from public.notification_templates t
    where t.tenant_id = p_job.tenant_id and t.event = p_job.event and t.channel = p_job.channel
      and t.language = p_job.language and t.is_active;
    if v_tpl_body is null then
      select d.subject, d.body into v_tpl_subject, v_tpl_body from app.default_template(p_job.event, p_job.language) d;
    end if;
    select * into v_a from public.appointments where id = p_job.appointment_id;
    select * into v_b from public.branches where id = v_a.branch_id;
    select string_agg(case when p_job.language = 'ar' then coalesce(s.service_name_ar, s.service_name_en) else s.service_name_en end, ', ' order by s.sort_order),
           string_agg(distinct case when p_job.language = 'ar' then coalesce(e.name_ar, e.name_en) else e.name_en end, ', ')
      into v_services, v_staff
    from public.appointment_services s join public.employees e on e.id = s.employee_id
    where s.appointment_id = v_a.id;
    v_local := v_a.starts_at at time zone coalesce(v_b.timezone, 'Asia/Muscat');
    select v_url || '/feedback/' || f.token into v_feedback from public.customer_feedback f where f.appointment_id = v_a.id;
  end if;

  v_vars := jsonb_build_object(
    'name', v_c.first_name,
    'salon', case when p_job.language = 'ar' then coalesce(v_t.name_ar, v_t.name) else v_t.name end,
    'branch', case when p_job.language = 'ar' then coalesce(v_b.name_ar, v_b.name_en, '') else coalesce(v_b.name_en, '') end,
    'branch_phone', coalesce(v_b.phone, ''),
    'date', coalesce(to_char(v_local, 'DD/MM/YYYY'), ''),
    'time', coalesce(to_char(v_local, 'HH24:MI'), ''),
    'services', coalesce(v_services, ''),
    'staff', coalesce(v_staff, ''),
    'link', case when v_a.public_token is not null then v_url || '/book/manage/' || v_a.public_token else '' end,
    'book_link', v_url || '/book/' || v_t.slug,
    'feedback_link', coalesce(v_feedback, ''),
    'unsubscribe_link', coalesce(v_unsub, ''));
  for v_key in select jsonb_object_keys(v_vars) loop
    v_tpl_body := replace(v_tpl_body, '{{' || v_key || '}}', v_vars ->> v_key);
    v_tpl_subject := replace(v_tpl_subject, '{{' || v_key || '}}', v_vars ->> v_key);
  end loop;
  subject := v_tpl_subject;
  body := btrim(v_tpl_body);
  return next;
end;
$$;

-- Appointment lifecycle → messages (+ feedback request on completion).
create or replace function app.appointments_notify()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_set public.tenant_settings%rowtype;
begin
  select * into v_set from public.tenant_settings s where s.tenant_id = new.tenant_id;
  if tg_op = 'INSERT' then
    perform app.enqueue_notification(new, 'booking_confirmed', now());
    if new.starts_at - make_interval(hours => v_set.reminder_hours_before) > now() then
      perform app.enqueue_notification(new, 'booking_reminder', new.starts_at - make_interval(hours => v_set.reminder_hours_before));
    end if;
    return null;
  end if;

  if new.status in ('cancelled', 'no_show') and old.status not in ('cancelled', 'no_show') then
    update public.notification_jobs set status = 'cancelled'
    where appointment_id = new.id and status = 'queued';
    if new.status = 'cancelled' and new.starts_at > now() then
      perform app.enqueue_notification(new, 'booking_cancelled', now());
    end if;
  elsif new.status = 'completed' and old.status <> 'completed' then
    update public.notification_jobs set status = 'cancelled'
    where appointment_id = new.id and status = 'queued' and event = 'booking_reminder';
    if v_set.feedback_enabled and new.customer_id is not null and app.module_enabled(new.tenant_id, 'marketing')
       and app.module_enabled(new.tenant_id, 'notifications')
       and exists (select 1 from app.notification_channel(new.tenant_id, new.customer_id)) then
      insert into public.customer_feedback (tenant_id, branch_id, appointment_id, customer_id, token)
      values (new.tenant_id, new.branch_id, new.id, new.customer_id, replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
      on conflict (appointment_id) do nothing;
      perform app.enqueue_notification(new, 'feedback_request', now() + make_interval(hours => v_set.feedback_delay_hours));
    end if;
  elsif new.starts_at is distinct from old.starts_at and new.status in ('booked', 'confirmed') then
    update public.notification_jobs set status = 'cancelled'
    where appointment_id = new.id and status = 'queued';
    perform app.enqueue_notification(new, 'booking_confirmed', now());
    if new.starts_at - make_interval(hours => v_set.reminder_hours_before) > now() then
      perform app.enqueue_notification(new, 'booking_reminder', new.starts_at - make_interval(hours => v_set.reminder_hours_before));
    end if;
  end if;
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Public (anon): unsubscribe & feedback
-- ---------------------------------------------------------------------------
create or replace function public.public_unsubscribe(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_r public.campaign_recipients%rowtype;
begin
  select * into v_r from public.campaign_recipients where unsubscribe_token = p_token and char_length(coalesce(p_token, '')) >= 20;
  if not found then
    perform app.raise('NOT_FOUND', 'Link not valid');
  end if;
  -- Withdraw marketing consent on every channel (kept in the consent history).
  insert into public.customer_consents (tenant_id, customer_id, channel, purpose, granted, source)
  select v_r.tenant_id, v_r.customer_id, ch, 'marketing', false, 'customer_request'
  from unnest(array['whatsapp', 'sms', 'email']) ch
  where exists (select 1 from public.customer_consents cc
                where cc.customer_id = v_r.customer_id and cc.channel = ch and cc.purpose = 'marketing')
    and (select cc.granted from public.customer_consents cc
         where cc.customer_id = v_r.customer_id and cc.channel = ch and cc.purpose = 'marketing'
         order by cc.recorded_at desc, cc.id desc limit 1);
  -- Anything still waiting to be sent to them is cancelled.
  update public.notification_jobs set status = 'cancelled'
  where customer_id = v_r.customer_id and campaign_id is not null and status = 'queued';
  return jsonb_build_object('salon', (select coalesce(t.name, '') from public.tenants t where t.id = v_r.tenant_id),
                            'salon_ar', (select t.name_ar from public.tenants t where t.id = v_r.tenant_id));
end;
$$;

create or replace function public.public_get_feedback(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_f public.customer_feedback%rowtype;
begin
  select * into v_f from public.customer_feedback where token = p_token and char_length(coalesce(p_token, '')) >= 20;
  if not found then
    perform app.raise('NOT_FOUND', 'Link not valid');
  end if;
  return jsonb_build_object(
    'submitted', v_f.submitted_at is not null, 'expired', v_f.expires_at <= now(), 'rating', v_f.rating,
    'salon', (select jsonb_build_object('name', t.name, 'name_ar', t.name_ar, 'slug', t.slug) from public.tenants t where t.id = v_f.tenant_id),
    'visit', (select jsonb_build_object('starts_at', a.starts_at, 'timezone', b.timezone,
                                        'branch_en', b.name_en, 'branch_ar', b.name_ar)
              from public.appointments a join public.branches b on b.id = a.branch_id where a.id = v_f.appointment_id),
    'services', (select jsonb_agg(jsonb_build_object('name_en', s.service_name_en, 'name_ar', s.service_name_ar,
                                                    'staff_en', e.name_en, 'staff_ar', e.name_ar) order by s.sort_order)
                 from public.appointment_services s join public.employees e on e.id = s.employee_id
                 where s.appointment_id = v_f.appointment_id));
end;
$$;

create or replace function public.public_submit_feedback(p_token text, p_rating integer, p_comment text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_f public.customer_feedback%rowtype;
begin
  select * into v_f from public.customer_feedback where token = p_token and char_length(coalesce(p_token, '')) >= 20 for update;
  if not found then
    perform app.raise('NOT_FOUND', 'Link not valid');
  end if;
  if v_f.submitted_at is not null then
    perform app.raise('FEEDBACK_ALREADY_SENT', 'Thank you — your feedback was already received');
  end if;
  if v_f.expires_at <= now() then
    perform app.raise('FEEDBACK_EXPIRED', 'This feedback link has expired');
  end if;
  if p_rating is null or p_rating not between 1 and 5 or char_length(p_comment) > 1000 then
    perform app.raise('INVALID_VALUE', 'Choose 1 to 5 stars');
  end if;
  update public.customer_feedback
  set rating = p_rating, comment = nullif(btrim(p_comment), ''), submitted_at = now()
  where id = v_f.id;
end;
$$;

-- Ratings for the salon: overall, per staff member, recent comments.
create or replace function public.get_feedback_summary(p_tenant uuid, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tz text;
  v_start timestamptz;
  v_end timestamptz;
begin
  perform app.require_user();
  if not exists (select 1 from app.tenants_with_any_permission(array['marketing.manage', 'reports.view']) x where x = p_tenant) then
    perform app.forbid('No access to feedback');
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
    perform app.raise('INVALID_RANGE', 'Choose a period of at most one year');
  end if;
  select s.timezone into v_tz from public.tenant_settings s where s.tenant_id = p_tenant;
  v_start := p_from::timestamp at time zone v_tz;
  v_end := (p_to + 1)::timestamp at time zone v_tz;
  return jsonb_build_object(
    'requested', (select count(*) from public.customer_feedback f where f.tenant_id = p_tenant and f.created_at >= v_start and f.created_at < v_end
                    and f.branch_id in (select app.accessible_branch_ids())),
    'responses', (select count(*) from public.customer_feedback f where f.tenant_id = p_tenant and f.submitted_at >= v_start and f.submitted_at < v_end
                    and f.branch_id in (select app.accessible_branch_ids())),
    'average', (select round(avg(f.rating), 2) from public.customer_feedback f where f.tenant_id = p_tenant and f.submitted_at >= v_start and f.submitted_at < v_end
                  and f.branch_id in (select app.accessible_branch_ids())),
    'distribution', (select coalesce(jsonb_object_agg(r.rating, r.n), '{}'::jsonb) from (
                       select f.rating, count(*) n from public.customer_feedback f
                       where f.tenant_id = p_tenant and f.submitted_at >= v_start and f.submitted_at < v_end
                         and f.branch_id in (select app.accessible_branch_ids())
                       group by f.rating) r),
    'staff', (select coalesce(jsonb_agg(jsonb_build_object('employee_id', x.employee_id, 'name_en', x.name_en, 'name_ar', x.name_ar,
                                                          'average', x.avg, 'responses', x.n) order by x.avg desc, x.n desc), '[]'::jsonb)
              from (select e.id as employee_id, e.name_en, e.name_ar, round(avg(f.rating), 2) avg, count(distinct f.id) n
                    from public.customer_feedback f
                    join public.appointment_services s on s.appointment_id = f.appointment_id
                    join public.employees e on e.id = s.employee_id
                    where f.tenant_id = p_tenant and f.submitted_at >= v_start and f.submitted_at < v_end
                      and f.branch_id in (select app.accessible_branch_ids())
                    group by e.id, e.name_en, e.name_ar) x),
    'recent', (select coalesce(jsonb_agg(jsonb_build_object('rating', f.rating, 'comment', f.comment, 'submitted_at', f.submitted_at,
                                                           'customer', c.first_name) order by f.submitted_at desc), '[]'::jsonb)
               from (select * from public.customer_feedback f
                     where f.tenant_id = p_tenant and f.submitted_at >= v_start and f.submitted_at < v_end
                       and f.branch_id in (select app.accessible_branch_ids())
                     order by f.submitted_at desc limit 30) f
               join public.customers c on c.id = f.customer_id));
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Execute privileges
-- ---------------------------------------------------------------------------
revoke all on function app.campaign_audience(uuid, jsonb, text) from public;

revoke all on function
  public.public_unsubscribe(text), public.public_get_feedback(text), public.public_submit_feedback(text, integer, text)
from public;
grant execute on function
  public.public_unsubscribe(text), public.public_get_feedback(text), public.public_submit_feedback(text, integer, text)
to anon, authenticated, service_role;

revoke all on function
  public.preview_campaign_audience(uuid, jsonb, text),
  public.launch_campaign(uuid),
  public.cancel_campaign(uuid),
  public.get_campaign_stats(uuid),
  public.get_feedback_summary(uuid, date, date)
from public, anon;
grant execute on function
  public.preview_campaign_audience(uuid, jsonb, text),
  public.launch_campaign(uuid),
  public.cancel_campaign(uuid),
  public.get_campaign_stats(uuid),
  public.get_feedback_summary(uuid, date, date)
to authenticated, service_role;

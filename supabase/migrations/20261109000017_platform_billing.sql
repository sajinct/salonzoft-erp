-- =============================================================================
-- Salonzoft · Migration 0017 · SaaS commercialisation (Phase 6, part 1)
-- -----------------------------------------------------------------------------
--  * Subscription invoices issued by Salonzoft to salons (gap-free SZ-YYYY-#####
--    numbers, VAT, seller/buyer snapshots). Checkout is provider-agnostic: an
--    invoice is paid by a platform admin recording the payment (bank transfer,
--    cash, card) or, later, by a gateway webhook through the service-role-only
--    billing_apply_gateway_payment().
--  * Plan changes: upgrades are invoiced immediately with a pro-rata credit for
--    the unused paid time; downgrades are scheduled for the period end. A plan
--    never starts if the salon's branches / active staff exceed its limits.
--  * Billing cycle (cron, service role): renewal invoices 7 days before the
--    period ends, past_due after it ends (still operational = grace), suspended
--    after the configured number of days, cancelled at period end on request.
--  * Super-admin console RPCs (admin_*), all gated by platform_admins roles:
--      admin   — everything
--      billing — invoices, payments, plan assignment
--      support — tenant status, trial extensions, module overrides
--    Platform admins still have NO RLS access to tenant tables: every read goes
--    through these audited DEFINER functions.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Settings, counters, audit
-- ---------------------------------------------------------------------------
insert into app.platform_settings (key, value) values
  ('billing_company', 'Salonzoft'),
  ('billing_vat_number', ''),
  ('billing_vat_rate', '5'),
  ('billing_bank_details', ''),
  ('billing_suspend_after_days', '14')
on conflict (key) do nothing;

create table app.platform_counters (
  key    text primary key,
  value  bigint not null
);
revoke all on app.platform_counters from public, anon, authenticated;

create table public.platform_audit_logs (
  id             bigint generated always as identity primary key,
  actor_user_id  uuid references auth.users (id) on delete set null,
  action         text not null check (char_length(action) <= 80),
  tenant_id      uuid references public.tenants (id) on delete set null,
  entity_type    text check (char_length(entity_type) <= 60),
  entity_id      text check (char_length(entity_id) <= 100),
  data           jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);
create index platform_audit_logs_tenant_idx on public.platform_audit_logs (tenant_id, created_at desc);
create index platform_audit_logs_created_idx on public.platform_audit_logs (created_at desc);
alter table public.platform_audit_logs enable row level security;
-- No grants: read through admin RPCs only.

create or replace function app.platform_audit(p_action text, p_tenant uuid, p_entity_type text, p_entity_id text, p_data jsonb default '{}'::jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.platform_audit_logs (actor_user_id, action, tenant_id, entity_type, entity_id, data)
  values (auth.uid(), p_action, p_tenant, p_entity_type, p_entity_id, coalesce(p_data, '{}'::jsonb));
$$;

-- Raise FORBIDDEN unless the caller is a platform admin with one of the roles.
create or replace function app.require_platform_admin(p_roles text[] default array['admin', 'billing', 'support'])
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform app.require_user();
  if not exists (select 1 from public.platform_admins pa where pa.user_id = auth.uid() and pa.role = any (p_roles)) then
    perform app.forbid('Platform administrators only');
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Schema: scheduled downgrades, subscription invoices
-- ---------------------------------------------------------------------------
alter table public.tenant_subscriptions
  add column scheduled_plan_id uuid references public.subscription_plans (id),
  add column scheduled_cycle text check (scheduled_cycle in ('monthly', 'yearly')),
  add constraint tenant_subscriptions_scheduled check ((scheduled_plan_id is null) = (scheduled_cycle is null));

create table public.subscription_invoices (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants (id) on delete cascade,
  number             text not null unique,
  kind               text not null check (kind in ('new', 'renewal', 'change')),
  plan_id            uuid not null references public.subscription_plans (id),
  billing_cycle      text not null check (billing_cycle in ('monthly', 'yearly')),
  currency_code      char(3) not null default 'OMR',
  amount             numeric(12,3) not null check (amount >= 0),            -- list price of the period
  credit             numeric(12,3) not null default 0 check (credit >= 0),  -- pro-rata credit for unused paid time
  subtotal           numeric(12,3) not null check (subtotal >= 0),          -- amount − credit, net of VAT
  vat_rate           numeric(5,2) not null default 0 check (vat_rate between 0 and 100),
  vat_amount         numeric(12,3) not null default 0 check (vat_amount >= 0),
  total              numeric(12,3) not null check (total >= 0),
  status             text not null default 'open' check (status in ('open', 'paid', 'void')),
  issued_at          timestamptz not null default now(),
  due_at             timestamptz not null,
  paid_at            timestamptz,
  payment_method     text check (payment_method in ('bank_transfer', 'card', 'cash', 'gateway', 'other')),
  payment_ref        text check (char_length(payment_ref) <= 120),
  period_start       timestamptz,
  period_end         timestamptz,
  voided_at          timestamptz,
  void_reason        text check (char_length(void_reason) <= 300),
  -- snapshots (the document must not change afterwards)
  seller_name        text not null,
  seller_vat_number  text,
  buyer_name         text not null,
  buyer_legal_name   text,
  buyer_vat_number   text,
  plan_name_en       text not null,
  plan_name_ar       text not null,
  created_by         uuid default auth.uid() references auth.users (id) on delete set null,
  constraint subscription_invoices_totals check (subtotal = amount - credit and total = subtotal + vat_amount),
  constraint subscription_invoices_paid check (status <> 'paid' or (paid_at is not null and payment_method is not null and period_end is not null))
);
create unique index subscription_invoices_one_open_idx on public.subscription_invoices (tenant_id) where status = 'open';
create index subscription_invoices_tenant_idx on public.subscription_invoices (tenant_id, issued_at desc);
create index subscription_invoices_status_idx on public.subscription_invoices (status, issued_at desc);
alter table public.subscription_invoices enable row level security;
grant select on public.subscription_invoices to authenticated;
create policy subscription_invoices_select on public.subscription_invoices
  for select to authenticated
  using (tenant_id in (select app.tenants_with_permission('billing.manage')));

-- ---------------------------------------------------------------------------
-- 3. Internal helpers
-- ---------------------------------------------------------------------------
create or replace function app.plan_price(p_plan uuid, p_cycle text)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select case when p_cycle = 'yearly' then coalesce(p.price_yearly, p.price_monthly * 12) else p.price_monthly end
  from public.subscription_plans p where p.id = p_plan;
$$;

-- Monthly-equivalent value, used for MRR and to tell upgrades from downgrades.
create or replace function app.plan_monthly(p_plan uuid, p_cycle text)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select round(app.plan_price(p_plan, p_cycle) / case when p_cycle = 'yearly' then 12 else 1 end, 3);
$$;

create or replace function app.next_platform_number()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_year text := to_char(now() at time zone 'Asia/Muscat', 'YYYY');
  v_n bigint;
begin
  -- Row lock on the counter serialises issuers; a rollback releases the number.
  insert into app.platform_counters (key, value) values ('subscription_invoice:' || v_year, 1)
  on conflict (key) do update set value = app.platform_counters.value + 1
  returning value into v_n;
  return 'SZ-' || v_year || '-' || lpad(v_n::text, 5, '0');
end;
$$;

-- Plan modules → entitlements. Add-on / override rows are left alone.
create or replace function app.sync_plan_entitlements(p_tenant uuid, p_plan uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.module_entitlements e
  where e.tenant_id = p_tenant and e.source = 'plan'
    and e.module_code not in (select pm.module_code from public.plan_modules pm where pm.plan_id = p_plan);
  insert into public.module_entitlements (tenant_id, module_code, source)
  select p_tenant, pm.module_code, 'plan' from public.plan_modules pm where pm.plan_id = p_plan
  on conflict (tenant_id, module_code) do update
    set is_enabled = true, valid_until = null, updated_at = now()
    where public.module_entitlements.source = 'plan';
end;
$$;

-- The salon's current size must fit the plan's limits.
create or replace function app.assert_plan_fits(p_tenant uuid, p_plan uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_plan public.subscription_plans;
  v_n integer;
begin
  select * into v_plan from public.subscription_plans where id = p_plan;
  if v_plan.max_branches is not null then
    select count(*) into v_n from public.branches b where b.tenant_id = p_tenant;
    if v_n > v_plan.max_branches then
      perform app.raise('PLAN_LIMIT_BRANCHES', format('This plan allows %s branch(es); you have %s', v_plan.max_branches, v_n));
    end if;
  end if;
  if v_plan.max_staff is not null then
    select count(*) into v_n from public.employees e where e.tenant_id = p_tenant and e.is_active;
    if v_n > v_plan.max_staff then
      perform app.raise('PLAN_LIMIT_EMPLOYEES', format('This plan allows %s active employee(s); you have %s', v_plan.max_staff, v_n));
    end if;
  end if;
end;
$$;

-- Issue an invoice (replacing any open one: a salon has at most one to pay).
create or replace function app.create_subscription_invoice(
  p_tenant uuid, p_plan uuid, p_cycle text, p_kind text, p_credit numeric, p_due timestamptz
)
returns public.subscription_invoices
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_plan public.subscription_plans;
  v_rate numeric := coalesce(nullif(app.platform_setting('billing_vat_rate'), '')::numeric, 0);
  v_amount numeric(12,3);
  v_credit numeric(12,3);
  v_sub numeric(12,3);
  v_vat numeric(12,3);
  v_inv public.subscription_invoices;
begin
  perform 1 from public.tenants where id = p_tenant for update;
  select * into v_plan from public.subscription_plans where id = p_plan;
  v_amount := app.plan_price(p_plan, p_cycle);
  v_credit := least(greatest(coalesce(p_credit, 0), 0), v_amount);
  v_sub := v_amount - v_credit;
  v_vat := round(v_sub * v_rate / 100, 3);

  update public.subscription_invoices
  set status = 'void', voided_at = now(), void_reason = 'Replaced by a new invoice'
  where tenant_id = p_tenant and status = 'open';

  insert into public.subscription_invoices
    (tenant_id, number, kind, plan_id, billing_cycle, currency_code, amount, credit, subtotal, vat_rate, vat_amount, total,
     due_at, seller_name, seller_vat_number, buyer_name, buyer_legal_name, buyer_vat_number, plan_name_en, plan_name_ar)
  select p_tenant, app.next_platform_number(), p_kind, p_plan, p_cycle, v_plan.currency_code, v_amount, v_credit, v_sub, v_rate, v_vat,
         v_sub + v_vat, coalesce(p_due, now() + interval '7 days'),
         coalesce(nullif(app.platform_setting('billing_company'), ''), 'Salonzoft'), nullif(app.platform_setting('billing_vat_number'), ''),
         t.name, t.legal_name, case when s.vat_registered then s.vat_number end, v_plan.name_en, v_plan.name_ar
  from public.tenants t
  left join public.tenant_settings s on s.tenant_id = t.id
  where t.id = p_tenant
  returning * into v_inv;

  perform app.audit(p_tenant, 'subscription.invoice_issued', 'subscription_invoices', v_inv.id::text, null, null,
                    jsonb_build_object('number', v_inv.number, 'kind', p_kind, 'plan', v_plan.code, 'cycle', p_cycle, 'total', v_inv.total));
  return v_inv;
end;
$$;

-- Mark an invoice paid and start / extend the subscription period.
create or replace function app.apply_invoice_payment(p_invoice uuid, p_method text, p_ref text, p_paid_at timestamptz)
returns public.subscription_invoices
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inv public.subscription_invoices;
  v_sub public.tenant_subscriptions;
  v_has boolean;
  v_paid timestamptz := coalesce(p_paid_at, now());
  v_step interval;
  v_start timestamptz;
  v_end timestamptz;
begin
  select * into v_inv from public.subscription_invoices where id = p_invoice for update;
  if not found then
    perform app.raise('NOT_FOUND', 'Invoice not found');
  end if;
  if v_inv.status <> 'open' then
    perform app.raise('INVOICE_NOT_OPEN', 'This invoice is already paid or void');
  end if;
  if p_method is null or p_method not in ('bank_transfer', 'card', 'cash', 'gateway', 'other') then
    perform app.raise('INVALID_VALUE', 'Unknown payment method');
  end if;
  if v_paid > now() + interval '1 hour' or v_paid < v_inv.issued_at - interval '30 days' then
    perform app.raise('INVALID_VALUE', 'Payment date is out of range');
  end if;

  perform 1 from public.tenants where id = v_inv.tenant_id for update;
  select * into v_sub from public.tenant_subscriptions
  where tenant_id = v_inv.tenant_id and status in ('trialing', 'active', 'past_due', 'suspended')
  for update;
  v_has := found;

  v_step := case when v_inv.billing_cycle = 'yearly' then interval '1 year' else interval '1 month' end;
  if v_inv.kind = 'renewal' and v_has and v_sub.status <> 'trialing' and v_sub.current_period_end is not null then
    v_start := v_sub.current_period_end;          -- renewals continue the paid period
  elsif v_has and v_sub.status = 'trialing' and v_sub.trial_ends_at > v_paid then
    v_start := v_sub.trial_ends_at;               -- paying during a trial keeps the remaining trial days
  else
    v_start := v_paid;
  end if;
  v_end := v_start + v_step;
  if v_end <= v_paid then                          -- very late renewal: restart from today
    v_start := v_paid;
    v_end := v_paid + v_step;
  end if;

  if v_has then
    update public.tenant_subscriptions
    set plan_id = v_inv.plan_id, billing_cycle = v_inv.billing_cycle, status = 'active',
        current_period_start = v_start, current_period_end = v_end, cancel_at_period_end = false,
        scheduled_plan_id = null, scheduled_cycle = null, external_ref = coalesce(p_ref, external_ref)
    where id = v_sub.id;
  else
    insert into public.tenant_subscriptions (tenant_id, plan_id, status, billing_cycle, current_period_start, current_period_end, external_ref)
    values (v_inv.tenant_id, v_inv.plan_id, 'active', v_inv.billing_cycle, v_start, v_end, p_ref);
  end if;
  perform app.sync_plan_entitlements(v_inv.tenant_id, v_inv.plan_id);

  update public.subscription_invoices
  set status = 'paid', paid_at = v_paid, payment_method = p_method, payment_ref = nullif(btrim(coalesce(p_ref, '')), ''),
      period_start = v_start, period_end = v_end
  where id = v_inv.id
  returning * into v_inv;

  perform app.audit(v_inv.tenant_id, 'subscription.paid', 'subscription_invoices', v_inv.id::text, null, null,
                    jsonb_build_object('number', v_inv.number, 'total', v_inv.total, 'method', p_method,
                                       'period_start', v_start, 'period_end', v_end));
  return v_inv;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Salon-facing billing (billing.manage — kept in degraded mode too)
-- ---------------------------------------------------------------------------
create or replace function public.get_billing_overview(p_tenant uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_sub public.tenant_subscriptions;
begin
  perform app.require_permission(p_tenant, 'billing.manage');
  select * into v_sub from public.tenant_subscriptions s
  where s.tenant_id = p_tenant
  order by (s.status in ('trialing', 'active', 'past_due', 'suspended')) desc, s.created_at desc
  limit 1;

  return jsonb_build_object(
    'subscription', case when v_sub.id is null then null else jsonb_build_object(
        'status', v_sub.status, 'billing_cycle', v_sub.billing_cycle, 'trial_ends_at', v_sub.trial_ends_at,
        'current_period_start', v_sub.current_period_start, 'current_period_end', v_sub.current_period_end,
        'cancel_at_period_end', v_sub.cancel_at_period_end, 'scheduled_cycle', v_sub.scheduled_cycle,
        'plan_code', (select p.code from public.subscription_plans p where p.id = v_sub.plan_id),
        'scheduled_plan_code', (select p.code from public.subscription_plans p where p.id = v_sub.scheduled_plan_id)) end,
    'usage', jsonb_build_object(
        'branches', (select count(*) from public.branches b where b.tenant_id = p_tenant),
        'staff', (select count(*) from public.employees e where e.tenant_id = p_tenant and e.is_active),
        'messages', coalesce((select u.quantity from public.tenant_usage u
                              where u.tenant_id = p_tenant and u.metric = 'messages'
                                and u.period_start = date_trunc('month', now())::date), 0)),
    'plans', (select coalesce(jsonb_agg(jsonb_build_object(
                  'code', p.code, 'name_en', p.name_en, 'name_ar', p.name_ar,
                  'description_en', p.description_en, 'description_ar', p.description_ar, 'currency_code', p.currency_code,
                  'price_monthly', p.price_monthly, 'price_yearly', coalesce(p.price_yearly, p.price_monthly * 12),
                  'max_branches', p.max_branches, 'max_staff', p.max_staff, 'max_monthly_messages', p.max_monthly_messages,
                  'modules', (select coalesce(jsonb_agg(pm.module_code), '[]'::jsonb) from public.plan_modules pm where pm.plan_id = p.id))
                order by p.sort_order), '[]'::jsonb)
              from public.subscription_plans p
              where (p.is_public and p.is_active) or p.id = v_sub.plan_id),
    'invoices', (select coalesce(jsonb_agg(to_jsonb(i) - 'created_by' order by i.issued_at desc), '[]'::jsonb)
                 from (select * from public.subscription_invoices i where i.tenant_id = p_tenant
                       order by i.issued_at desc limit 36) i),
    'payment', jsonb_build_object(
        'company', coalesce(nullif(app.platform_setting('billing_company'), ''), 'Salonzoft'),
        'vat_number', nullif(app.platform_setting('billing_vat_number'), ''),
        'vat_rate', coalesce(nullif(app.platform_setting('billing_vat_rate'), '')::numeric, 0),
        'bank_details', nullif(app.platform_setting('billing_bank_details'), ''))
  );
end;
$$;

-- One invoice for printing: the salon's billing managers or any platform admin.
create or replace function public.get_subscription_invoice(p_invoice uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_inv public.subscription_invoices;
begin
  perform app.require_user();
  select * into v_inv from public.subscription_invoices where id = p_invoice;
  if v_inv.id is null
     or not (app.has_permission(v_inv.tenant_id, 'billing.manage')
             or exists (select 1 from public.platform_admins pa where pa.user_id = auth.uid())) then
    perform app.raise('NOT_FOUND', 'Invoice not found');
  end if;
  return to_jsonb(v_inv) - 'created_by' || jsonb_build_object(
    'bank_details', nullif(app.platform_setting('billing_bank_details'), ''),
    'tenant_slug', (select t.slug from public.tenants t where t.id = v_inv.tenant_id));
end;
$$;

create or replace function public.request_plan_change(p_tenant uuid, p_plan_code text, p_cycle text default 'monthly')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_plan public.subscription_plans;
  v_sub public.tenant_subscriptions;
  v_has boolean;
  v_paid public.subscription_invoices;
  v_credit numeric := 0;
  v_kind text;
  v_inv public.subscription_invoices;
begin
  perform app.require_permission(p_tenant, 'billing.manage');
  if p_cycle is null or p_cycle not in ('monthly', 'yearly') then
    perform app.raise('INVALID_VALUE', 'Billing cycle must be monthly or yearly');
  end if;
  select * into v_plan from public.subscription_plans where code = p_plan_code and is_active and is_public;
  if not found then
    perform app.raise('PLAN_NOT_FOUND', 'Unknown plan');
  end if;

  perform 1 from public.tenants where id = p_tenant for update;
  select * into v_sub from public.tenant_subscriptions
  where tenant_id = p_tenant and status in ('trialing', 'active', 'past_due', 'suspended')
  for update;
  v_has := found;

  if v_has and v_sub.status = 'active' then
    if v_sub.plan_id = v_plan.id and v_sub.billing_cycle = p_cycle then
      perform app.raise('PLAN_UNCHANGED', 'You are already on this plan');
    end if;
    perform app.assert_plan_fits(p_tenant, v_plan.id);

    -- Cheaper (or yearly → monthly on the same plan): switch at the period end, no charge now.
    if app.plan_monthly(v_plan.id, p_cycle) < app.plan_monthly(v_sub.plan_id, v_sub.billing_cycle)
       or (v_plan.id = v_sub.plan_id and p_cycle = 'monthly') then
      update public.tenant_subscriptions set scheduled_plan_id = v_plan.id, scheduled_cycle = p_cycle where id = v_sub.id;
      update public.subscription_invoices set status = 'void', voided_at = now(), void_reason = 'Plan change scheduled'
      where tenant_id = p_tenant and status = 'open' and kind = 'change';
      perform app.audit(p_tenant, 'subscription.change_scheduled', 'tenant_subscriptions', v_sub.id::text, null, null,
                        jsonb_build_object('plan', v_plan.code, 'cycle', p_cycle, 'effective_at', v_sub.current_period_end));
      return jsonb_build_object('scheduled', true, 'effective_at', v_sub.current_period_end);
    end if;

    -- Upgrade: credit the unused part of the period that was actually paid for.
    select * into v_paid from public.subscription_invoices i
    where i.tenant_id = p_tenant and i.status = 'paid' and i.period_end = v_sub.current_period_end
    order by i.paid_at desc limit 1;
    if found and v_sub.current_period_end > now() and v_paid.period_end > v_paid.period_start then
      v_credit := round(v_paid.subtotal * extract(epoch from (v_sub.current_period_end - greatest(now(), v_paid.period_start)))
                        / extract(epoch from (v_paid.period_end - v_paid.period_start)), 3);
    end if;
    v_kind := 'change';
  else
    perform app.assert_plan_fits(p_tenant, v_plan.id);
    v_kind := case
      when v_has and v_sub.status in ('past_due', 'suspended') and v_sub.plan_id = v_plan.id and v_sub.billing_cycle = p_cycle then 'renewal'
      when v_has and v_sub.status <> 'trialing' then 'change'
      else 'new' end;
  end if;

  v_inv := app.create_subscription_invoice(p_tenant, v_plan.id, p_cycle, v_kind, v_credit, now() + interval '7 days');
  return jsonb_build_object('scheduled', false, 'invoice_id', v_inv.id, 'number', v_inv.number, 'total', v_inv.total);
end;
$$;

-- Undo a pending change: void an unpaid upgrade invoice and drop a scheduled downgrade.
create or replace function public.cancel_pending_change(p_tenant uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app.require_permission(p_tenant, 'billing.manage');
  update public.subscription_invoices set status = 'void', voided_at = now(), void_reason = 'Cancelled by the salon'
  where tenant_id = p_tenant and status = 'open' and kind in ('new', 'change');
  update public.tenant_subscriptions set scheduled_plan_id = null, scheduled_cycle = null
  where tenant_id = p_tenant and status in ('trialing', 'active', 'past_due', 'suspended') and scheduled_plan_id is not null;
  perform app.audit(p_tenant, 'subscription.change_cancelled', 'tenants', p_tenant::text);
end;
$$;

-- Stop (or resume) automatic renewal at the end of the paid period.
create or replace function public.set_cancel_at_period_end(p_tenant uuid, p_cancel boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform app.require_permission(p_tenant, 'billing.manage');
  update public.tenant_subscriptions set cancel_at_period_end = coalesce(p_cancel, false)
  where tenant_id = p_tenant and status = 'active'
  returning id into v_id;
  if v_id is null then
    perform app.raise('SUBSCRIPTION_NOT_ACTIVE', 'Only an active paid subscription can be cancelled or resumed');
  end if;
  if p_cancel then
    update public.subscription_invoices set status = 'void', voided_at = now(), void_reason = 'Renewal cancelled'
    where tenant_id = p_tenant and status = 'open' and kind = 'renewal';
  end if;
  perform app.audit(p_tenant, case when p_cancel then 'subscription.cancel_requested' else 'subscription.resumed' end,
                    'tenant_subscriptions', v_id::text);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Billing cycle (pg_cron, service role) and gateway entry point
-- ---------------------------------------------------------------------------
create or replace function public.run_billing_cycle()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.tenant_subscriptions;
  v_inv public.subscription_invoices;
  v_days integer := coalesce(nullif(app.platform_setting('billing_suspend_after_days'), '')::integer, 14);
  v_renewals integer := 0;
  v_past_due integer := 0;
  v_suspended integer := 0;
  v_cancelled integer := 0;
begin
  -- 1. Periods that ended: cancel on request, otherwise past due (grace).
  for r in select * from public.tenant_subscriptions s
           where s.status = 'active' and s.current_period_end <= now()
           for update skip locked loop
    if r.cancel_at_period_end then
      update public.tenant_subscriptions set status = 'cancelled', scheduled_plan_id = null, scheduled_cycle = null where id = r.id;
      update public.subscription_invoices set status = 'void', voided_at = now(), void_reason = 'Subscription cancelled'
      where tenant_id = r.tenant_id and status = 'open';
      perform app.audit(r.tenant_id, 'subscription.cancelled', 'tenant_subscriptions', r.id::text);
      v_cancelled := v_cancelled + 1;
    else
      update public.tenant_subscriptions set status = 'past_due' where id = r.id;
      perform app.audit(r.tenant_id, 'subscription.past_due', 'tenant_subscriptions', r.id::text);
      v_past_due := v_past_due + 1;
    end if;
  end loop;

  -- 2. Renewal invoices from 7 days before the period ends (scheduled downgrades apply here).
  for r in select * from public.tenant_subscriptions s
           where s.status in ('active', 'past_due') and not s.cancel_at_period_end
             and s.current_period_end <= now() + interval '7 days'
             and not exists (select 1 from public.subscription_invoices i where i.tenant_id = s.tenant_id and i.status = 'open')
           for update skip locked loop
    v_inv := app.create_subscription_invoice(r.tenant_id, coalesce(r.scheduled_plan_id, r.plan_id),
                                             coalesce(r.scheduled_cycle, r.billing_cycle), 'renewal', 0, r.current_period_end);
    if v_inv.total = 0 then
      perform app.apply_invoice_payment(v_inv.id, 'other', 'free plan', now());
    end if;
    v_renewals := v_renewals + 1;
  end loop;

  -- 3. Unpaid too long: suspend (owner keeps billing access to pay).
  for r in select * from public.tenant_subscriptions s
           where s.status = 'past_due' and s.current_period_end < now() - make_interval(days => v_days)
           for update skip locked loop
    update public.tenant_subscriptions set status = 'suspended' where id = r.id;
    perform app.audit(r.tenant_id, 'subscription.suspended', 'tenant_subscriptions', r.id::text);
    v_suspended := v_suspended + 1;
  end loop;

  return jsonb_build_object('renewal_invoices', v_renewals, 'past_due', v_past_due, 'suspended', v_suspended, 'cancelled', v_cancelled);
end;
$$;

-- For the future payment-gateway webhook (Edge Function with the service role).
create or replace function public.billing_apply_gateway_payment(p_invoice uuid, p_ref text, p_paid_at timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inv public.subscription_invoices;
begin
  -- Idempotent for webhook retries: the same reference on a paid invoice is a no-op.
  select * into v_inv from public.subscription_invoices where id = p_invoice;
  if found and v_inv.status = 'paid' and v_inv.payment_ref = p_ref then
    return jsonb_build_object('status', 'paid', 'replayed', true);
  end if;
  v_inv := app.apply_invoice_payment(p_invoice, 'gateway', p_ref, p_paid_at);
  return jsonb_build_object('status', v_inv.status, 'replayed', false);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Super-admin console
-- ---------------------------------------------------------------------------
create or replace function public.admin_whoami()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('role', (select pa.role from public.platform_admins pa where pa.user_id = auth.uid()));
$$;

create or replace function public.admin_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_month timestamptz := date_trunc('month', now());
begin
  perform app.require_platform_admin();
  return jsonb_build_object(
    'tenants', (select jsonb_build_object(
        'total', count(*) filter (where t.status <> 'closed'),
        'operational', count(*) filter (where app.tenant_is_operational(t.id)),
        'trialing', count(*) filter (where t.status = 'active' and s.status = 'trialing' and s.trial_ends_at > now()),
        'trial_expired', count(*) filter (where t.status = 'active' and s.status = 'trialing' and s.trial_ends_at <= now()),
        'paying', count(*) filter (where t.status = 'active' and s.status in ('active', 'past_due')),
        'past_due', count(*) filter (where t.status = 'active' and s.status = 'past_due'),
        'suspended', count(*) filter (where t.status = 'suspended' or s.status = 'suspended'),
        'new_30d', count(*) filter (where t.created_at >= now() - interval '30 days'))
      from public.tenants t
      left join public.tenant_subscriptions s on s.tenant_id = t.id and s.status in ('trialing', 'active', 'past_due', 'suspended')),
    'mrr', (select coalesce(sum(app.plan_monthly(s.plan_id, s.billing_cycle)), 0)
            from public.tenant_subscriptions s join public.tenants t on t.id = s.tenant_id
            where s.status in ('active', 'past_due') and t.status = 'active'),
    'collected_month', (select coalesce(sum(i.subtotal), 0) from public.subscription_invoices i
                        where i.status = 'paid' and i.paid_at >= v_month),
    'open_invoices', (select jsonb_build_object('count', count(*), 'total', coalesce(sum(i.total), 0),
                                                'overdue', count(*) filter (where i.due_at < now()))
                      from public.subscription_invoices i where i.status = 'open'),
    'conversion', (select jsonb_build_object(
        'eligible', count(*), 'converted', count(*) filter (where exists (
            select 1 from public.subscription_invoices i where i.tenant_id = t.id and i.status = 'paid')))
      from public.tenants t where t.created_at < now() - interval '14 days' and t.created_at >= now() - interval '180 days'),
    'plans', (select coalesce(jsonb_agg(jsonb_build_object('code', p.code, 'name_en', p.name_en, 'name_ar', p.name_ar,
                                                            'trialing', x.trialing, 'paying', x.paying) order by p.sort_order), '[]'::jsonb)
              from public.subscription_plans p
              cross join lateral (select count(*) filter (where s.status = 'trialing' and s.trial_ends_at > now()) trialing,
                                         count(*) filter (where s.status in ('active', 'past_due')) paying
                                  from public.tenant_subscriptions s join public.tenants t on t.id = s.tenant_id
                                  where s.plan_id = p.id and t.status = 'active') x),
    'months', (select jsonb_agg(jsonb_build_object(
                  'month', to_char(m, 'YYYY-MM'),
                  'signups', (select count(*) from public.tenants t where t.created_at >= m and t.created_at < m + interval '1 month'),
                  'revenue', (select coalesce(sum(i.subtotal), 0) from public.subscription_invoices i
                              where i.status = 'paid' and i.paid_at >= m and i.paid_at < m + interval '1 month')) order by m)
               from generate_series(v_month - interval '11 months', v_month, interval '1 month') m),
    'activity', jsonb_build_object(
        'appointments_30d', (select count(*) from public.appointments a where a.starts_at >= now() - interval '30 days' and a.starts_at < now()),
        'sales_30d', (select coalesce(sum(i.total), 0) from public.invoices i
                      where i.kind = 'invoice' and i.status = 'posted' and i.issued_at >= now() - interval '30 days'),
        'invoices_30d', (select count(*) from public.invoices i
                         where i.kind = 'invoice' and i.status = 'posted' and i.issued_at >= now() - interval '30 days'),
        'messages_month', (select coalesce(sum(u.quantity), 0) from public.tenant_usage u
                           where u.metric = 'messages' and u.period_start = v_month::date)),
    'expiring_trials', (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'slug', t.slug, 'trial_ends_at', s.trial_ends_at)
                                                  order by s.trial_ends_at), '[]'::jsonb)
                        from public.tenants t join public.tenant_subscriptions s on s.tenant_id = t.id
                        where t.status = 'active' and s.status = 'trialing'
                          and s.trial_ends_at > now() and s.trial_ends_at <= now() + interval '7 days'),
    'recent_signups', (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name, 'slug', x.slug, 'created_at', x.created_at)
                                                 order by x.created_at desc), '[]'::jsonb)
                       from (select t.id, t.name, t.slug, t.created_at from public.tenants t order by t.created_at desc limit 8) x)
  );
end;
$$;

create or replace function public.admin_list_tenants(p_search text default null, p_filter text default 'all', p_limit integer default 50, p_offset integer default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_q text := nullif(btrim(coalesce(p_search, '')), '');
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_total integer;
  v_rows jsonb;
begin
  perform app.require_platform_admin();
  if p_filter is null or p_filter not in ('all', 'trialing', 'expired', 'active', 'past_due', 'suspended', 'cancelled', 'tenant_suspended', 'closed') then
    perform app.raise('INVALID_VALUE', 'Unknown filter');
  end if;

  with base as (
    select t.id, t.slug, t.name, t.name_ar, t.status, t.created_at,
           s.status as sub_status, s.billing_cycle, s.trial_ends_at, s.current_period_end, s.cancel_at_period_end,
           p.code as plan_code, p.name_en as plan_name_en, p.name_ar as plan_name_ar,
           case when s.status in ('active', 'past_due') then app.plan_monthly(s.plan_id, s.billing_cycle) else 0 end as mrr,
           (select u.email from public.tenant_memberships m join auth.users u on u.id = m.user_id
            where m.tenant_id = t.id and m.is_owner order by u.email limit 1) as owner_email
    from public.tenants t
    left join lateral (select * from public.tenant_subscriptions s where s.tenant_id = t.id
                       order by (s.status in ('trialing', 'active', 'past_due', 'suspended')) desc, s.created_at desc limit 1) s on true
    left join public.subscription_plans p on p.id = s.plan_id
  ), filtered as (
    select * from base b
    where (v_q is null or b.name ilike '%' || v_q || '%' or b.slug ilike '%' || v_q || '%'
           or coalesce(b.name_ar, '') ilike '%' || v_q || '%' or coalesce(b.owner_email, '') ilike '%' || v_q || '%')
      and case p_filter
            when 'all' then b.status <> 'closed'
            when 'trialing' then b.status = 'active' and b.sub_status = 'trialing' and b.trial_ends_at > now()
            when 'expired' then b.status = 'active' and b.sub_status = 'trialing' and b.trial_ends_at <= now()
            when 'tenant_suspended' then b.status = 'suspended'
            when 'closed' then b.status = 'closed'
            else b.status = 'active' and b.sub_status = p_filter
          end
  )
  select (select count(*) from filtered),
         (select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc), '[]'::jsonb)
          from (select f.*,
                       (select count(*) from public.branches b where b.tenant_id = f.id) as branches,
                       (select count(*) from public.employees e where e.tenant_id = f.id and e.is_active) as staff,
                       (select max(a.created_at) from public.audit_logs a where a.tenant_id = f.id) as last_activity
                from filtered f order by f.created_at desc limit v_limit offset greatest(coalesce(p_offset, 0), 0)) x)
  into v_total, v_rows;

  return jsonb_build_object('total', v_total, 'rows', v_rows);
end;
$$;

create or replace function public.admin_get_tenant(p_tenant uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform app.require_platform_admin();
  if not exists (select 1 from public.tenants where id = p_tenant) then
    perform app.raise('NOT_FOUND', 'Business not found');
  end if;
  return jsonb_build_object(
    'tenant', (select to_jsonb(t) - 'creation_key' - 'created_by' from public.tenants t where t.id = p_tenant),
    'settings', (select jsonb_build_object('default_language', s.default_language, 'timezone', s.timezone,
                                           'vat_registered', s.vat_registered, 'vat_number', s.vat_number, 'currency_code', s.currency_code)
                 from public.tenant_settings s where s.tenant_id = p_tenant),
    'subscription', (select to_jsonb(s) || jsonb_build_object('plan_code', p.code, 'plan_name_en', p.name_en, 'plan_name_ar', p.name_ar,
                                                              'scheduled_plan_code', sp.code, 'operational', app.tenant_is_operational(p_tenant))
                     from public.tenant_subscriptions s
                     join public.subscription_plans p on p.id = s.plan_id
                     left join public.subscription_plans sp on sp.id = s.scheduled_plan_id
                     where s.tenant_id = p_tenant
                     order by (s.status in ('trialing', 'active', 'past_due', 'suspended')) desc, s.created_at desc limit 1),
    'usage', jsonb_build_object(
        'branches', (select count(*) from public.branches b where b.tenant_id = p_tenant),
        'staff', (select count(*) from public.employees e where e.tenant_id = p_tenant and e.is_active),
        'members', (select count(*) from public.tenant_memberships m where m.tenant_id = p_tenant and m.status = 'active'),
        'customers', (select count(*) from public.customers c where c.tenant_id = p_tenant),
        'appointments_30d', (select count(*) from public.appointments a
                             where a.tenant_id = p_tenant and a.starts_at >= now() - interval '30 days' and a.starts_at < now()),
        'sales_30d', (select coalesce(sum(i.total), 0) from public.invoices i
                      where i.tenant_id = p_tenant and i.kind = 'invoice' and i.status = 'posted' and i.issued_at >= now() - interval '30 days'),
        'messages_month', coalesce((select u.quantity from public.tenant_usage u where u.tenant_id = p_tenant and u.metric = 'messages'
                                      and u.period_start = date_trunc('month', now())::date), 0),
        'last_activity', (select max(a.created_at) from public.audit_logs a where a.tenant_id = p_tenant)),
    'modules', (select jsonb_agg(jsonb_build_object('code', m.code, 'name_en', m.name_en, 'name_ar', m.name_ar, 'is_core', m.is_core,
                                                    'enabled', app.module_enabled(p_tenant, m.code), 'source', e.source,
                                                    'is_enabled', e.is_enabled, 'valid_until', e.valid_until) order by m.sort_order)
                from public.modules m
                left join public.module_entitlements e on e.tenant_id = p_tenant and e.module_code = m.code),
    'members', (select coalesce(jsonb_agg(jsonb_build_object('email', u.email, 'full_name', pr.full_name, 'is_owner', m.is_owner,
                                                             'status', m.status, 'job_title', m.job_title)
                                          order by m.is_owner desc, u.email), '[]'::jsonb)
                from public.tenant_memberships m
                join auth.users u on u.id = m.user_id
                left join public.profiles pr on pr.id = m.user_id
                where m.tenant_id = p_tenant),
    'invoices', (select coalesce(jsonb_agg(to_jsonb(i) - 'created_by' order by i.issued_at desc), '[]'::jsonb)
                 from (select * from public.subscription_invoices i where i.tenant_id = p_tenant order by i.issued_at desc limit 50) i),
    'history', (select coalesce(jsonb_agg(jsonb_build_object('action', l.action, 'data', l.data, 'created_at', l.created_at,
                                                             'actor', (select u.email from auth.users u where u.id = l.actor_user_id))
                                          order by l.created_at desc), '[]'::jsonb)
                from (select * from public.platform_audit_logs l where l.tenant_id = p_tenant order by l.created_at desc limit 30) l)
  );
end;
$$;

create or replace function public.admin_set_tenant_status(p_tenant uuid, p_status text, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old text;
begin
  perform app.require_platform_admin(case when p_status = 'closed' then array['admin'] else array['admin', 'support'] end);
  if p_status is null or p_status not in ('active', 'suspended', 'closed') then
    perform app.raise('INVALID_VALUE', 'Status must be active, suspended or closed');
  end if;
  if p_status <> 'active' and char_length(btrim(coalesce(p_reason, ''))) < 3 then
    perform app.raise('REASON_REQUIRED', 'Give a reason');
  end if;
  select status into v_old from public.tenants where id = p_tenant for update;
  if not found then
    perform app.raise('NOT_FOUND', 'Business not found');
  end if;
  update public.tenants set status = p_status where id = p_tenant;
  perform app.platform_audit('tenant.status', p_tenant, 'tenants', p_tenant::text,
                             jsonb_build_object('from', v_old, 'to', p_status, 'reason', p_reason));
end;
$$;

create or replace function public.admin_extend_trial(p_tenant uuid, p_days integer)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sub public.tenant_subscriptions;
  v_end timestamptz;
begin
  perform app.require_platform_admin(array['admin', 'support']);
  if p_days is null or p_days not between 1 and 90 then
    perform app.raise('INVALID_VALUE', 'Extend by 1–90 days');
  end if;
  select * into v_sub from public.tenant_subscriptions
  where tenant_id = p_tenant and status in ('trialing', 'active', 'past_due', 'suspended') for update;
  if not found or v_sub.status <> 'trialing' then
    perform app.raise('SUBSCRIPTION_NOT_TRIAL', 'This business is not on a trial');
  end if;
  v_end := greatest(v_sub.trial_ends_at, now()) + make_interval(days => p_days);
  update public.tenant_subscriptions set trial_ends_at = v_end, current_period_end = v_end where id = v_sub.id;
  perform app.platform_audit('subscription.trial_extended', p_tenant, 'tenant_subscriptions', v_sub.id::text,
                             jsonb_build_object('days', p_days, 'trial_ends_at', v_end));
  return v_end;
end;
$$;

-- Assign a plan directly (custom deals, corrections). Keeps a running trial when no period end is given.
create or replace function public.admin_assign_plan(p_tenant uuid, p_plan_code text, p_cycle text, p_period_end timestamptz default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_plan public.subscription_plans;
  v_sub public.tenant_subscriptions;
  v_has boolean;
begin
  perform app.require_platform_admin(array['admin', 'billing']);
  select * into v_plan from public.subscription_plans where code = p_plan_code;
  if not found then
    perform app.raise('PLAN_NOT_FOUND', 'Unknown plan');
  end if;
  if p_cycle is null or p_cycle not in ('monthly', 'yearly') then
    perform app.raise('INVALID_VALUE', 'Billing cycle must be monthly or yearly');
  end if;
  if p_period_end is not null and p_period_end <= now() then
    perform app.raise('INVALID_VALUE', 'The period must end in the future');
  end if;
  perform 1 from public.tenants where id = p_tenant for update;
  select * into v_sub from public.tenant_subscriptions
  where tenant_id = p_tenant and status in ('trialing', 'active', 'past_due', 'suspended') for update;
  v_has := found;

  if v_has and v_sub.status = 'trialing' and p_period_end is null then
    update public.tenant_subscriptions set plan_id = v_plan.id, billing_cycle = p_cycle where id = v_sub.id;
  elsif p_period_end is null then
    perform app.raise('INVALID_VALUE', 'Give the date the period ends');
  elsif v_has then
    update public.tenant_subscriptions
    set plan_id = v_plan.id, billing_cycle = p_cycle, status = 'active', current_period_start = now(),
        current_period_end = p_period_end, cancel_at_period_end = false, scheduled_plan_id = null, scheduled_cycle = null
    where id = v_sub.id;
  else
    insert into public.tenant_subscriptions (tenant_id, plan_id, status, billing_cycle, current_period_start, current_period_end)
    values (p_tenant, v_plan.id, 'active', p_cycle, now(), p_period_end);
  end if;
  perform app.sync_plan_entitlements(p_tenant, v_plan.id);
  perform app.platform_audit('subscription.plan_assigned', p_tenant, 'tenant_subscriptions', p_tenant::text,
                             jsonb_build_object('plan', v_plan.code, 'cycle', p_cycle, 'period_end', p_period_end));
end;
$$;

-- Module override: true/false forces the module on/off; null returns it to the plan.
create or replace function public.admin_set_module(p_tenant uuid, p_module text, p_enabled boolean, p_valid_until timestamptz default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_plan uuid;
begin
  perform app.require_platform_admin(array['admin', 'support']);
  if not exists (select 1 from public.modules m where m.code = p_module and not m.is_core) then
    perform app.raise('INVALID_VALUE', 'Unknown or core module');
  end if;
  if not exists (select 1 from public.tenants where id = p_tenant) then
    perform app.raise('NOT_FOUND', 'Business not found');
  end if;
  if p_enabled is null then
    delete from public.module_entitlements where tenant_id = p_tenant and module_code = p_module and source <> 'plan';
    select s.plan_id into v_plan from public.tenant_subscriptions s
    where s.tenant_id = p_tenant and s.status in ('trialing', 'active', 'past_due', 'suspended');
    if v_plan is not null then
      perform app.sync_plan_entitlements(p_tenant, v_plan);
    end if;
  else
    insert into public.module_entitlements (tenant_id, module_code, is_enabled, source, valid_until)
    values (p_tenant, p_module, p_enabled, 'override', p_valid_until)
    on conflict (tenant_id, module_code) do update
      set is_enabled = excluded.is_enabled, source = 'override', valid_until = excluded.valid_until, updated_at = now();
  end if;
  perform app.platform_audit('tenant.module', p_tenant, 'module_entitlements', p_module,
                             jsonb_build_object('enabled', p_enabled, 'valid_until', p_valid_until));
end;
$$;

create or replace function public.admin_create_invoice(p_tenant uuid, p_plan_code text, p_cycle text, p_kind text default 'renewal')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_plan public.subscription_plans;
  v_inv public.subscription_invoices;
begin
  perform app.require_platform_admin(array['admin', 'billing']);
  select * into v_plan from public.subscription_plans where code = p_plan_code;
  if not found then
    perform app.raise('PLAN_NOT_FOUND', 'Unknown plan');
  end if;
  if p_cycle is null or p_cycle not in ('monthly', 'yearly') or p_kind is null or p_kind not in ('new', 'renewal', 'change') then
    perform app.raise('INVALID_VALUE', 'Check the billing cycle and invoice kind');
  end if;
  if not exists (select 1 from public.tenants where id = p_tenant) then
    perform app.raise('NOT_FOUND', 'Business not found');
  end if;
  v_inv := app.create_subscription_invoice(p_tenant, v_plan.id, p_cycle, p_kind, 0, now() + interval '7 days');
  perform app.platform_audit('invoice.created', p_tenant, 'subscription_invoices', v_inv.id::text,
                             jsonb_build_object('number', v_inv.number, 'total', v_inv.total));
  return jsonb_build_object('invoice_id', v_inv.id, 'number', v_inv.number, 'total', v_inv.total);
end;
$$;

create or replace function public.admin_record_payment(p_invoice uuid, p_method text, p_ref text default null, p_paid_at timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inv public.subscription_invoices;
begin
  perform app.require_platform_admin(array['admin', 'billing']);
  if p_method = 'gateway' then
    perform app.raise('INVALID_VALUE', 'Gateway payments are recorded by the gateway');
  end if;
  v_inv := app.apply_invoice_payment(p_invoice, p_method, p_ref, p_paid_at);
  perform app.platform_audit('invoice.paid', v_inv.tenant_id, 'subscription_invoices', v_inv.id::text,
                             jsonb_build_object('number', v_inv.number, 'total', v_inv.total, 'method', p_method, 'ref', p_ref));
  return jsonb_build_object('number', v_inv.number, 'period_start', v_inv.period_start, 'period_end', v_inv.period_end);
end;
$$;

create or replace function public.admin_void_invoice(p_invoice uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inv public.subscription_invoices;
begin
  perform app.require_platform_admin(array['admin', 'billing']);
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then
    perform app.raise('REASON_REQUIRED', 'Give a reason');
  end if;
  update public.subscription_invoices set status = 'void', voided_at = now(), void_reason = btrim(p_reason)
  where id = p_invoice and status = 'open'
  returning * into v_inv;
  if v_inv.id is null then
    perform app.raise('INVOICE_NOT_OPEN', 'Only open invoices can be voided');
  end if;
  perform app.platform_audit('invoice.void', v_inv.tenant_id, 'subscription_invoices', v_inv.id::text,
                             jsonb_build_object('number', v_inv.number, 'reason', p_reason));
end;
$$;

create or replace function public.admin_list_invoices(p_status text default null, p_search text default null, p_limit integer default 100, p_offset integer default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_q text := nullif(btrim(coalesce(p_search, '')), '');
begin
  perform app.require_platform_admin();
  if p_status is not null and p_status not in ('open', 'paid', 'void', 'overdue') then
    perform app.raise('INVALID_VALUE', 'Unknown status');
  end if;
  return (
    with f as (
      select i.*, t.name as tenant_name, t.slug as tenant_slug
      from public.subscription_invoices i join public.tenants t on t.id = i.tenant_id
      where (p_status is null or (p_status = 'overdue' and i.status = 'open' and i.due_at < now())
             or (p_status <> 'overdue' and i.status = p_status))
        and (v_q is null or i.number ilike '%' || v_q || '%' or t.name ilike '%' || v_q || '%' or t.slug ilike '%' || v_q || '%')
    )
    select jsonb_build_object(
      'total', (select count(*) from f),
      'rows', (select coalesce(jsonb_agg(to_jsonb(x) - 'created_by' order by x.issued_at desc), '[]'::jsonb)
               from (select * from f order by f.issued_at desc
                     limit least(greatest(coalesce(p_limit, 100), 1), 500) offset greatest(coalesce(p_offset, 0), 0)) x))
  );
end;
$$;

create or replace function public.admin_list_plans()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform app.require_platform_admin();
  return (select coalesce(jsonb_agg(to_jsonb(p) || jsonb_build_object(
              'modules', (select coalesce(jsonb_agg(pm.module_code), '[]'::jsonb) from public.plan_modules pm where pm.plan_id = p.id),
              'subscribers', (select count(*) from public.tenant_subscriptions s
                              where s.plan_id = p.id and s.status in ('trialing', 'active', 'past_due', 'suspended')))
            order by p.sort_order, p.code), '[]'::jsonb)
          from public.subscription_plans p);
end;
$$;

create or replace function public.admin_save_plan(p_plan jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code text := lower(btrim(coalesce(p_plan ->> 'code', '')));
  v_id uuid;
  v_modules text[];
  v_tenant uuid;
begin
  perform app.require_platform_admin(array['admin']);
  if v_code !~ '^[a-z][a-z0-9_]{1,39}$' or char_length(btrim(coalesce(p_plan ->> 'name_en', ''))) < 2
     or char_length(btrim(coalesce(p_plan ->> 'name_ar', ''))) < 2
     or coalesce((p_plan ->> 'price_monthly')::numeric, -1) < 0 then
    perform app.raise('INVALID_VALUE', 'Check the plan code, names and price');
  end if;
  if v_code = 'professional' and not coalesce((p_plan ->> 'is_active')::boolean, true) then
    perform app.raise('TRIAL_PLAN_REQUIRED', 'New businesses start their trial on this plan; it cannot be deactivated');
  end if;
  select coalesce(array_agg(x), '{}') into v_modules from jsonb_array_elements_text(coalesce(p_plan -> 'modules', '[]'::jsonb)) x;
  if exists (select 1 from unnest(v_modules) x where x not in (select m.code from public.modules m)) then
    perform app.raise('INVALID_VALUE', 'Unknown module');
  end if;

  insert into public.subscription_plans
    (code, name_en, name_ar, description_en, description_ar, price_monthly, price_yearly, max_branches, max_staff,
     max_monthly_messages, trial_days, is_public, is_active, sort_order)
  values (v_code, btrim(p_plan ->> 'name_en'), btrim(p_plan ->> 'name_ar'), nullif(btrim(p_plan ->> 'description_en'), ''),
          nullif(btrim(p_plan ->> 'description_ar'), ''), (p_plan ->> 'price_monthly')::numeric, (p_plan ->> 'price_yearly')::numeric,
          (p_plan ->> 'max_branches')::integer, (p_plan ->> 'max_staff')::integer, (p_plan ->> 'max_monthly_messages')::integer,
          coalesce((p_plan ->> 'trial_days')::integer, 14), coalesce((p_plan ->> 'is_public')::boolean, true),
          coalesce((p_plan ->> 'is_active')::boolean, true), coalesce((p_plan ->> 'sort_order')::integer, 100))
  on conflict (code) do update set
    name_en = excluded.name_en, name_ar = excluded.name_ar, description_en = excluded.description_en,
    description_ar = excluded.description_ar, price_monthly = excluded.price_monthly, price_yearly = excluded.price_yearly,
    max_branches = excluded.max_branches, max_staff = excluded.max_staff, max_monthly_messages = excluded.max_monthly_messages,
    trial_days = excluded.trial_days, is_public = excluded.is_public, is_active = excluded.is_active, sort_order = excluded.sort_order
  returning id into v_id;

  delete from public.plan_modules where plan_id = v_id and module_code <> all (v_modules);
  insert into public.plan_modules (plan_id, module_code) select v_id, x from unnest(v_modules) x on conflict do nothing;

  -- Salons on this plan get the new module set straight away.
  for v_tenant in select s.tenant_id from public.tenant_subscriptions s
                  where s.plan_id = v_id and s.status in ('trialing', 'active', 'past_due', 'suspended') loop
    perform app.sync_plan_entitlements(v_tenant, v_id);
  end loop;

  perform app.platform_audit('plan.saved', null, 'subscription_plans', v_code, p_plan);
  return v_id;
exception
  when invalid_text_representation or numeric_value_out_of_range or check_violation then
    perform app.raise('INVALID_VALUE', 'Check the plan values');
end;
$$;

create or replace function public.admin_list_admins()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform app.require_platform_admin();
  return (select coalesce(jsonb_agg(jsonb_build_object('user_id', pa.user_id, 'email', u.email, 'full_name', pr.full_name,
                                                        'role', pa.role, 'created_at', pa.created_at) order by u.email), '[]'::jsonb)
          from public.platform_admins pa
          join auth.users u on u.id = pa.user_id
          left join public.profiles pr on pr.id = pa.user_id);
end;
$$;

-- Add, change or (role = null) remove a platform admin by e-mail.
create or replace function public.admin_set_admin(p_email text, p_role text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
begin
  perform app.require_platform_admin(array['admin']);
  if p_role is not null and p_role not in ('admin', 'billing', 'support') then
    perform app.raise('INVALID_VALUE', 'Role must be admin, billing or support');
  end if;
  select u.id into v_user from auth.users u where lower(u.email) = lower(btrim(coalesce(p_email, '')));
  if v_user is null then
    perform app.raise('USER_NOT_FOUND', 'No account uses this e-mail; ask them to sign up first');
  end if;
  if v_user = auth.uid() then
    perform app.raise('ADMIN_SELF', 'You cannot change your own access');
  end if;
  if p_role is null then
    delete from public.platform_admins where user_id = v_user;
  else
    insert into public.platform_admins (user_id, role) values (v_user, p_role)
    on conflict (user_id) do update set role = excluded.role;
  end if;
  perform app.platform_audit('admin.set', null, 'platform_admins', v_user::text, jsonb_build_object('email', p_email, 'role', p_role));
end;
$$;

create or replace function public.admin_get_settings()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform app.require_platform_admin();
  return (select jsonb_object_agg(s.key, s.value) from app.platform_settings s
          where s.key in ('billing_company', 'billing_vat_number', 'billing_vat_rate', 'billing_bank_details', 'billing_suspend_after_days'));
end;
$$;

create or replace function public.admin_save_settings(p_settings jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text;
  v_value text;
begin
  perform app.require_platform_admin(array['admin']);
  for v_key, v_value in select key, btrim(value) from jsonb_each_text(coalesce(p_settings, '{}'::jsonb)) loop
    if v_key not in ('billing_company', 'billing_vat_number', 'billing_vat_rate', 'billing_bank_details', 'billing_suspend_after_days') then
      perform app.raise('INVALID_VALUE', 'Unknown setting ' || v_key);
    end if;
    if (v_key = 'billing_vat_rate' and (v_value !~ '^\d{1,2}(\.\d{1,2})?$'))
       or (v_key = 'billing_suspend_after_days' and (v_value !~ '^\d{1,2}$' or v_value::integer not between 1 and 90))
       or (v_key = 'billing_company' and char_length(v_value) < 2)
       or char_length(v_value) > 1000 then
      perform app.raise('INVALID_VALUE', 'Check ' || v_key);
    end if;
    insert into app.platform_settings (key, value) values (v_key, v_value)
    on conflict (key) do update set value = excluded.value;
  end loop;
  perform app.platform_audit('settings.saved', null, 'platform_settings', null, p_settings);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Execute privileges
-- ---------------------------------------------------------------------------
revoke all on function
  app.platform_audit(text, uuid, text, text, jsonb),
  app.require_platform_admin(text[]),
  app.plan_price(uuid, text),
  app.plan_monthly(uuid, text),
  app.next_platform_number(),
  app.sync_plan_entitlements(uuid, uuid),
  app.assert_plan_fits(uuid, uuid),
  app.create_subscription_invoice(uuid, uuid, text, text, numeric, timestamptz),
  app.apply_invoice_payment(uuid, text, text, timestamptz)
from public;

-- Worker / webhook entry points: service role only.
revoke all on function public.run_billing_cycle(), public.billing_apply_gateway_payment(uuid, text, timestamptz)
from public, anon, authenticated;
grant execute on function public.run_billing_cycle(), public.billing_apply_gateway_payment(uuid, text, timestamptz) to service_role;

revoke all on function
  public.get_billing_overview(uuid),
  public.get_subscription_invoice(uuid),
  public.request_plan_change(uuid, text, text),
  public.cancel_pending_change(uuid),
  public.set_cancel_at_period_end(uuid, boolean),
  public.admin_whoami(),
  public.admin_overview(),
  public.admin_list_tenants(text, text, integer, integer),
  public.admin_get_tenant(uuid),
  public.admin_set_tenant_status(uuid, text, text),
  public.admin_extend_trial(uuid, integer),
  public.admin_assign_plan(uuid, text, text, timestamptz),
  public.admin_set_module(uuid, text, boolean, timestamptz),
  public.admin_create_invoice(uuid, text, text, text),
  public.admin_record_payment(uuid, text, text, timestamptz),
  public.admin_void_invoice(uuid, text),
  public.admin_list_invoices(text, text, integer, integer),
  public.admin_list_plans(),
  public.admin_save_plan(jsonb),
  public.admin_list_admins(),
  public.admin_set_admin(text, text),
  public.admin_get_settings(),
  public.admin_save_settings(jsonb)
from public, anon;
grant execute on function
  public.get_billing_overview(uuid),
  public.get_subscription_invoice(uuid),
  public.request_plan_change(uuid, text, text),
  public.cancel_pending_change(uuid),
  public.set_cancel_at_period_end(uuid, boolean),
  public.admin_whoami(),
  public.admin_overview(),
  public.admin_list_tenants(text, text, integer, integer),
  public.admin_get_tenant(uuid),
  public.admin_set_tenant_status(uuid, text, text),
  public.admin_extend_trial(uuid, integer),
  public.admin_assign_plan(uuid, text, text, timestamptz),
  public.admin_set_module(uuid, text, boolean, timestamptz),
  public.admin_create_invoice(uuid, text, text, text),
  public.admin_record_payment(uuid, text, text, timestamptz),
  public.admin_void_invoice(uuid, text),
  public.admin_list_invoices(text, text, integer, integer),
  public.admin_list_plans(),
  public.admin_save_plan(jsonb),
  public.admin_list_admins(),
  public.admin_set_admin(text, text),
  public.admin_get_settings(),
  public.admin_save_settings(jsonb)
to authenticated, service_role;

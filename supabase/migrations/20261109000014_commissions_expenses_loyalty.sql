-- =============================================================================
-- Salonzoft · Migration 0014 · Commissions, expenses & petty cash, loyalty
-- -----------------------------------------------------------------------------
-- All three hang off invoice POSTING (like stock in 0013), in the same
-- transaction, so sales, returns and refunds flow into them consistently:
--  * commissions: the most specific active rule per line (employee + item >
--    employee + category > employee + kind > everyone …) on the line's NET
--    amount (excl. VAT, after discounts); credit notes claw back pro rata.
--  * loyalty: points per currency unit of net spend (excluding vouchers);
--    reversed by credit notes (never below zero); redeemed into store credit
--    with a guarded decrement.
--  * expenses: categories, VAT, approval; petty cash paid from the drawer
--    lowers the drawer's expected cash at close.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Settings
-- ---------------------------------------------------------------------------
alter table public.tenant_settings
  add column loyalty_enabled boolean not null default false,
  add column loyalty_points_per_unit numeric(8,3) not null default 1 check (loyalty_points_per_unit >= 0),
  add column loyalty_point_value numeric(12,3) not null default 0.010 check (loyalty_point_value >= 0),
  add column loyalty_min_redeem integer not null default 100 check (loyalty_min_redeem >= 0);
grant update (loyalty_enabled, loyalty_points_per_unit, loyalty_point_value, loyalty_min_redeem)
  on public.tenant_settings to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Commissions
-- ---------------------------------------------------------------------------
create table public.commission_rules (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references public.tenants (id) on delete cascade,
  employee_id          uuid,  -- null = everyone
  item_kind            text not null default 'service' check (item_kind in ('service', 'product', 'any')),
  service_category_id  uuid,
  service_id           uuid,
  product_id           uuid,
  rate_percent         numeric(5,2) not null default 0 check (rate_percent between 0 and 100),
  fixed_amount         numeric(12,3) not null default 0 check (fixed_amount >= 0),
  is_active            boolean not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint commission_rules_service check (service_id is null or item_kind = 'service'),
  constraint commission_rules_category check (service_category_id is null or item_kind = 'service'),
  constraint commission_rules_product check (product_id is null or item_kind = 'product'),
  constraint commission_rules_something check (rate_percent > 0 or fixed_amount > 0),
  foreign key (employee_id, tenant_id) references public.employees (id, tenant_id) on delete cascade,
  foreign key (service_category_id, tenant_id) references public.service_categories (id, tenant_id) on delete cascade,
  foreign key (service_id, tenant_id) references public.services (id, tenant_id) on delete cascade,
  foreign key (product_id, tenant_id) references public.products (id, tenant_id) on delete cascade
);
create index commission_rules_tenant_idx on public.commission_rules (tenant_id, is_active);
create index commission_rules_employee_idx on public.commission_rules (employee_id);
create trigger commission_rules_updated_at before update on public.commission_rules for each row execute function app.set_updated_at();

create table public.commission_payouts (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null,
  employee_id   uuid not null,
  period_to     date not null,
  total_amount  numeric(12,3) not null check (total_amount > 0),
  method        text not null check (method in ('cash', 'bank_transfer', 'payroll', 'other')),
  reference     text check (char_length(reference) <= 100),
  note          text check (char_length(note) <= 300),
  paid_by       uuid default auth.uid() references auth.users (id) on delete set null,
  paid_at       timestamptz not null default now(),
  unique (id, tenant_id),
  foreign key (employee_id, tenant_id) references public.employees (id, tenant_id)
);
create index commission_payouts_employee_idx on public.commission_payouts (employee_id, paid_at desc);
create index commission_payouts_tenant_idx on public.commission_payouts (tenant_id);

create table public.commission_entries (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null,
  branch_id        uuid not null,
  employee_id      uuid not null,
  invoice_id       uuid not null,
  invoice_item_id  uuid not null unique,
  rule_id          uuid references public.commission_rules (id) on delete set null,
  base_amount      numeric(12,3) not null,          -- net line amount (negative on credit notes)
  rate_percent     numeric(5,2) not null,
  amount           numeric(12,3) not null,          -- negative = claw-back
  earned_on        date not null,
  status           text not null default 'pending' check (status in ('pending', 'paid')),
  payout_id        uuid,
  created_at       timestamptz not null default now(),
  constraint commission_entries_paid check ((status = 'paid') = (payout_id is not null)),
  foreign key (employee_id, tenant_id) references public.employees (id, tenant_id),
  foreign key (branch_id, tenant_id) references public.branches (id, tenant_id) on delete cascade,
  foreign key (invoice_id, tenant_id) references public.invoices (id, tenant_id),
  foreign key (payout_id, tenant_id) references public.commission_payouts (id, tenant_id)
);
create index commission_entries_employee_idx on public.commission_entries (employee_id, status, earned_on);
create index commission_entries_tenant_idx on public.commission_entries (tenant_id, earned_on);
create index commission_entries_invoice_idx on public.commission_entries (invoice_id);

-- Best rule for a line: highest specificity wins, newest breaks ties.
create or replace function app.commission_rule_for(p_tenant uuid, p_employee uuid, p_kind text, p_service uuid, p_product uuid)
returns public.commission_rules
language sql
stable
security definer
set search_path = ''
as $$
  select r.*
  from public.commission_rules r
  left join public.services s on s.id = p_service
  where r.tenant_id = p_tenant and r.is_active
    and (r.employee_id is null or r.employee_id = p_employee)
    and (r.item_kind = 'any' or r.item_kind = p_kind)
    and (r.service_id is null or r.service_id = p_service)
    and (r.product_id is null or r.product_id = p_product)
    and (r.service_category_id is null or r.service_category_id = s.category_id)
  order by (r.employee_id is not null)::int * 8
         + (r.service_id is not null or r.product_id is not null)::int * 4
         + (r.service_category_id is not null)::int * 2
         + (r.item_kind <> 'any')::int desc,
           r.created_at desc
  limit 1;
$$;

create or replace function app.invoices_post_commissions()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_line   record;
  v_rule   public.commission_rules%rowtype;
  v_orig   public.commission_entries%rowtype;
  v_qty    numeric;
  v_amount numeric;
  v_day    date;
begin
  select (new.issued_at at time zone s.timezone)::date into v_day from public.tenant_settings s where s.tenant_id = new.tenant_id;
  if new.kind = 'invoice' then
    for v_line in select * from public.invoice_items
                  where invoice_id = new.id and employee_id is not null and kind in ('service', 'product') loop
      v_rule := app.commission_rule_for(new.tenant_id, v_line.employee_id, v_line.kind, v_line.service_id, v_line.product_id);
      continue when v_rule.id is null;
      v_amount := round(v_line.net_amount * v_rule.rate_percent / 100 + v_rule.fixed_amount * v_line.quantity, 3);
      continue when v_amount = 0;
      insert into public.commission_entries (tenant_id, branch_id, employee_id, invoice_id, invoice_item_id, rule_id,
                                             base_amount, rate_percent, amount, earned_on)
      values (new.tenant_id, new.branch_id, v_line.employee_id, new.id, v_line.id, v_rule.id,
              v_line.net_amount, v_rule.rate_percent, v_amount, v_day);
    end loop;
  else
    for v_line in
      select it.*, o.quantity as orig_qty
      from public.invoice_items it join public.invoice_items o on o.id = it.original_item_id
      where it.invoice_id = new.id
    loop
      select * into v_orig from public.commission_entries e where e.invoice_item_id = v_line.original_item_id;
      continue when not found;
      v_qty := v_line.quantity / v_line.orig_qty;
      insert into public.commission_entries (tenant_id, branch_id, employee_id, invoice_id, invoice_item_id, rule_id,
                                             base_amount, rate_percent, amount, earned_on)
      values (new.tenant_id, new.branch_id, v_orig.employee_id, new.id, v_line.id, v_orig.rule_id,
              -v_line.net_amount, v_orig.rate_percent, -round(v_orig.amount * v_qty, 3), v_day);
    end loop;
  end if;
  return null;
end;
$$;
create trigger invoices_post_commissions after update of status on public.invoices
  for each row when (old.status = 'draft' and new.status = 'posted')
  execute function app.invoices_post_commissions();

-- ---------------------------------------------------------------------------
-- 3. Expenses & petty cash
-- ---------------------------------------------------------------------------
create table public.expense_categories (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  name_en     text not null check (char_length(btrim(name_en)) between 2 and 80),
  name_ar     text check (char_length(name_ar) <= 80),
  is_active   boolean not null default true,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  unique (id, tenant_id)
);
create unique index expense_categories_name_idx on public.expense_categories (tenant_id, lower(btrim(name_en)));

create table public.expenses (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null,
  branch_id         uuid not null,
  category_id       uuid not null,
  expense_date      date not null,
  amount            numeric(12,3) not null check (amount > 0),           -- total paid, VAT included
  vat_amount        numeric(12,3) not null default 0 check (vat_amount >= 0),
  description       text not null check (char_length(btrim(description)) between 2 and 300),
  supplier_id       uuid,
  payment_method    text not null check (payment_method in ('cash', 'card', 'bank_transfer', 'other')),
  cash_session_id   uuid,  -- petty cash taken from the till drawer
  reference         text check (char_length(reference) <= 100),
  status            text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  rejection_reason  text check (char_length(rejection_reason) <= 300),
  recorded_by       uuid default auth.uid() references auth.users (id) on delete set null,
  approved_by       uuid references auth.users (id) on delete set null,
  approved_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint expenses_vat check (vat_amount <= amount),
  constraint expenses_drawer_cash check (cash_session_id is null or payment_method = 'cash'),
  foreign key (branch_id, tenant_id) references public.branches (id, tenant_id) on delete cascade,
  foreign key (category_id, tenant_id) references public.expense_categories (id, tenant_id),
  foreign key (supplier_id, tenant_id) references public.suppliers (id, tenant_id),
  foreign key (cash_session_id, tenant_id) references public.cash_sessions (id, tenant_id)
);
create index expenses_tenant_date_idx on public.expenses (tenant_id, expense_date desc);
create index expenses_branch_idx on public.expenses (branch_id, status);
create index expenses_session_idx on public.expenses (cash_session_id);
create trigger expenses_updated_at before update on public.expenses for each row execute function app.set_updated_at();

-- Expected drawer cash now also subtracts petty cash paid from the drawer.
create or replace function public.close_cash_session(p_session_id uuid, p_counted_cash numeric, p_notes text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_s        public.cash_sessions%rowtype;
  v_expected numeric(12,3);
  v_petty    numeric(12,3);
begin
  perform app.require_user();
  select * into v_s from public.cash_sessions where id = p_session_id for update;
  if not found or not app.is_tenant_member(v_s.tenant_id) then
    perform app.raise('NOT_FOUND', 'Cash session not found');
  end if;
  perform app.assert_pos(v_s.tenant_id, v_s.branch_id, 'pos.cash_session');
  if v_s.status <> 'open' then
    perform app.raise('CASH_SESSION_CLOSED', 'This cash session is already closed');
  end if;
  if p_counted_cash is null or p_counted_cash < 0 then
    perform app.raise('INVALID_AMOUNT', 'Enter the counted cash');
  end if;
  select coalesce(sum(e.amount), 0) into v_petty
  from public.expenses e where e.cash_session_id = p_session_id and e.status <> 'rejected';
  select v_s.opening_float
         + coalesce(sum(p.amount) filter (where p.direction = 'in'), 0)
         - coalesce(sum(p.amount) filter (where p.direction = 'out'), 0)
         - v_petty
    into v_expected
  from public.payments p where p.cash_session_id = p_session_id;

  update public.cash_sessions
  set status = 'closed', closed_at = now(), closed_by = auth.uid(),
      counted_cash = round(p_counted_cash, 3), expected_cash = v_expected,
      variance = round(p_counted_cash, 3) - v_expected, notes = nullif(btrim(p_notes), '')
  where id = p_session_id;
  return jsonb_build_object('expected_cash', v_expected, 'counted_cash', round(p_counted_cash, 3),
                            'variance', round(p_counted_cash, 3) - v_expected, 'petty_cash', v_petty);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Loyalty
-- ---------------------------------------------------------------------------
create table public.loyalty_accounts (
  tenant_id        uuid not null,
  customer_id      uuid primary key,
  balance          integer not null default 0 check (balance >= 0),
  lifetime_earned  integer not null default 0 check (lifetime_earned >= 0),
  updated_at       timestamptz not null default now(),
  foreign key (customer_id, tenant_id) references public.customers (id, tenant_id) on delete cascade
);
create index loyalty_accounts_tenant_idx on public.loyalty_accounts (tenant_id);

create table public.loyalty_transactions (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null,
  customer_id  uuid not null,
  points       integer not null check (points <> 0),
  kind         text not null check (kind in ('earn', 'redeem', 'reverse', 'adjust')),
  invoice_id   uuid,
  voucher_id   uuid,
  note         text check (char_length(note) <= 300),
  created_by   uuid default auth.uid() references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  foreign key (customer_id, tenant_id) references public.customers (id, tenant_id) on delete cascade
);
create index loyalty_transactions_customer_idx on public.loyalty_transactions (customer_id, created_at desc);
create index loyalty_transactions_tenant_idx on public.loyalty_transactions (tenant_id);

-- Earn on invoices, reverse on credit notes (never below zero).
create or replace function app.invoices_post_loyalty()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_set     public.tenant_settings%rowtype;
  v_net     numeric;
  v_points  integer;
  v_balance integer;
begin
  if new.customer_id is null then
    return null;
  end if;
  select * into v_set from public.tenant_settings where tenant_id = new.tenant_id;
  if not v_set.loyalty_enabled or v_set.loyalty_points_per_unit = 0 or not app.module_enabled(new.tenant_id, 'loyalty') then
    return null;
  end if;
  select coalesce(sum(net_amount), 0) into v_net from public.invoice_items where invoice_id = new.id and kind <> 'voucher';
  v_points := floor(v_net * v_set.loyalty_points_per_unit)::integer;
  if v_points <= 0 then
    return null;
  end if;

  insert into public.loyalty_accounts (tenant_id, customer_id) values (new.tenant_id, new.customer_id)
  on conflict (customer_id) do nothing;
  if new.kind = 'invoice' then
    update public.loyalty_accounts set balance = balance + v_points, lifetime_earned = lifetime_earned + v_points, updated_at = now()
    where customer_id = new.customer_id;
    insert into public.loyalty_transactions (tenant_id, customer_id, points, kind, invoice_id)
    values (new.tenant_id, new.customer_id, v_points, 'earn', new.id);
  else
    select balance into v_balance from public.loyalty_accounts where customer_id = new.customer_id for update;
    v_points := least(v_points, v_balance);
    if v_points > 0 then
      update public.loyalty_accounts set balance = balance - v_points, updated_at = now() where customer_id = new.customer_id;
      insert into public.loyalty_transactions (tenant_id, customer_id, points, kind, invoice_id)
      values (new.tenant_id, new.customer_id, -v_points, 'reverse', new.id);
    end if;
  end if;
  return null;
end;
$$;
create trigger invoices_post_loyalty after update of status on public.invoices
  for each row when (old.status = 'draft' and new.status = 'posted')
  execute function app.invoices_post_loyalty();

-- ---------------------------------------------------------------------------
-- 5. RLS + grants
-- ---------------------------------------------------------------------------
alter table public.commission_rules      enable row level security;
alter table public.commission_payouts    enable row level security;
alter table public.commission_entries    enable row level security;
alter table public.expense_categories    enable row level security;
alter table public.expenses              enable row level security;
alter table public.loyalty_accounts      enable row level security;
alter table public.loyalty_transactions  enable row level security;

revoke all on public.commission_rules, public.commission_payouts, public.commission_entries, public.expense_categories,
              public.expenses, public.loyalty_accounts, public.loyalty_transactions from anon, authenticated;
grant all on public.commission_rules, public.commission_payouts, public.commission_entries, public.expense_categories,
             public.expenses, public.loyalty_accounts, public.loyalty_transactions to service_role;

-- Commission rules: set up by people who manage staff.
grant select on public.commission_rules to authenticated;
grant insert (tenant_id, employee_id, item_kind, service_category_id, service_id, product_id, rate_percent, fixed_amount, is_active)
  on public.commission_rules to authenticated;
grant update (employee_id, item_kind, service_category_id, service_id, product_id, rate_percent, fixed_amount, is_active)
  on public.commission_rules to authenticated;
grant delete on public.commission_rules to authenticated;
create policy commission_rules_select on public.commission_rules for select to authenticated
  using (tenant_id in (select app.tenants_with_any_permission(array['employees.manage', 'commissions.view', 'finance.view'])));
create policy commission_rules_insert on public.commission_rules for insert to authenticated
  with check (tenant_id in (select app.tenants_with_permission('employees.manage')));
create policy commission_rules_update on public.commission_rules for update to authenticated
  using (tenant_id in (select app.tenants_with_permission('employees.manage')))
  with check (tenant_id in (select app.tenants_with_permission('employees.manage')));
create policy commission_rules_delete on public.commission_rules for delete to authenticated
  using (tenant_id in (select app.tenants_with_permission('employees.manage')));

-- Entries & payouts: read-only; everyone's for commissions.view / finance.view, own for commissions.own.
grant select on public.commission_entries, public.commission_payouts to authenticated;
create policy commission_entries_select on public.commission_entries for select to authenticated
  using (branch_id in (select app.branch_ids_with_any_permission(array['commissions.view', 'finance.view']))
         or (employee_id in (select app.my_employee_ids())
             and tenant_id in (select app.tenants_with_permission('commissions.own'))));
create policy commission_payouts_select on public.commission_payouts for select to authenticated
  using (tenant_id in (select app.tenants_with_any_permission(array['commissions.view', 'finance.view']))
         or (employee_id in (select app.my_employee_ids())
             and tenant_id in (select app.tenants_with_permission('commissions.own'))));

-- Expenses.
grant select on public.expense_categories, public.expenses to authenticated;
grant insert (tenant_id, name_en, name_ar, is_active, sort_order) on public.expense_categories to authenticated;
grant update (name_en, name_ar, is_active, sort_order) on public.expense_categories to authenticated;
create policy expense_categories_select on public.expense_categories for select to authenticated
  using (tenant_id in (select app.tenants_with_any_permission(array['finance.view', 'finance.manage', 'expenses.approve'])));
create policy expense_categories_insert on public.expense_categories for insert to authenticated
  with check (tenant_id in (select app.tenants_with_permission('finance.manage')));
create policy expense_categories_update on public.expense_categories for update to authenticated
  using (tenant_id in (select app.tenants_with_permission('finance.manage')))
  with check (tenant_id in (select app.tenants_with_permission('finance.manage')));
create policy expenses_select on public.expenses for select to authenticated
  using (branch_id in (select app.branch_ids_with_any_permission(array['finance.view', 'finance.manage', 'expenses.approve'])));

-- Loyalty: read by sellers / customer viewers / loyalty managers; written by RPCs.
grant select on public.loyalty_accounts, public.loyalty_transactions to authenticated;
create policy loyalty_accounts_select on public.loyalty_accounts for select to authenticated
  using (tenant_id in (select app.tenants_with_any_permission(array['pos.access', 'customers.view', 'loyalty.manage'])));
create policy loyalty_transactions_select on public.loyalty_transactions for select to authenticated
  using (tenant_id in (select app.tenants_with_any_permission(array['pos.access', 'customers.view', 'loyalty.manage'])));

create trigger audit_commission_rules after insert or update or delete on public.commission_rules for each row execute function app.audit_row();
create trigger audit_commission_payouts after insert on public.commission_payouts for each row execute function app.audit_row();
create trigger audit_expenses after insert or update on public.expenses for each row execute function app.audit_row();
create trigger audit_loyalty_transactions after insert on public.loyalty_transactions for each row execute function app.audit_row();

-- ---------------------------------------------------------------------------
-- 6. RPCs
-- ---------------------------------------------------------------------------
-- Pay out everything pending for an employee up to a date (claw-backs net).
create or replace function public.pay_commissions(
  p_tenant uuid, p_employee_id uuid, p_up_to date, p_method text, p_reference text default null, p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_total numeric(12,3);
  v_id    uuid;
begin
  perform app.require_permission(p_tenant, 'finance.manage');
  perform 1 from public.employees e where e.id = p_employee_id and e.tenant_id = p_tenant for update;
  if not found then
    perform app.raise('INVALID_EMPLOYEE', 'Unknown employee');
  end if;
  if p_method not in ('cash', 'bank_transfer', 'payroll', 'other') then
    perform app.raise('INVALID_PAYMENT_METHOD', 'Unknown payout method');
  end if;
  select coalesce(sum(e.amount), 0) into v_total
  from public.commission_entries e
  where e.employee_id = p_employee_id and e.status = 'pending' and e.earned_on <= p_up_to
    and e.branch_id in (select app.accessible_branch_ids());
  if v_total <= 0 then
    perform app.raise('NOTHING_TO_PAY', 'There is no commission to pay for this period');
  end if;
  insert into public.commission_payouts (tenant_id, employee_id, period_to, total_amount, method, reference, note)
  values (p_tenant, p_employee_id, p_up_to, v_total, p_method, nullif(btrim(p_reference), ''), nullif(btrim(p_note), ''))
  returning id into v_id;
  update public.commission_entries e set status = 'paid', payout_id = v_id
  where e.employee_id = p_employee_id and e.status = 'pending' and e.earned_on <= p_up_to
    and e.branch_id in (select app.accessible_branch_ids());
  return jsonb_build_object('payout_id', v_id, 'total', v_total);
end;
$$;

-- Commission per employee for a period (+ everything still unpaid).
-- commissions.view / finance.view: everyone; commissions.own: yourself.
create or replace function public.get_commission_report(p_tenant uuid, p_from date, p_to date, p_branch_id uuid default null)
returns table (employee_id uuid, name_en text, name_ar text, sales_base numeric, commission numeric, unpaid numeric, lines integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_all boolean;
begin
  perform app.require_user();
  v_all := app.has_permission(p_tenant, 'commissions.view') or app.has_permission(p_tenant, 'finance.view');
  if not v_all and not app.has_permission(p_tenant, 'commissions.own') then
    perform app.forbid('No access to commissions');
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
    perform app.raise('INVALID_RANGE', 'Choose a period of at most one year');
  end if;
  return query
  select e.id, e.name_en, e.name_ar,
         coalesce(sum(c.base_amount) filter (where c.earned_on between p_from and p_to), 0),
         coalesce(sum(c.amount) filter (where c.earned_on between p_from and p_to), 0),
         coalesce(sum(c.amount) filter (where c.status = 'pending'), 0),
         (count(c.id) filter (where c.earned_on between p_from and p_to))::integer
  from public.employees e
  left join public.commission_entries c on c.employee_id = e.id
    and c.branch_id in (select app.accessible_branch_ids())
    and (p_branch_id is null or c.branch_id = p_branch_id)
  where e.tenant_id = p_tenant
    and (v_all or e.id in (select app.my_employee_ids()))
  group by e.id, e.name_en, e.name_ar
  having count(c.id) > 0 or e.is_active
  order by 5 desc, e.name_en;
end;
$$;

-- Record an expense. Approvers' own expenses are approved at once; others
-- wait for expenses.approve. p_from_drawer = petty cash out of the open drawer.
create or replace function public.record_expense(
  p_branch_id uuid,
  p_category_id uuid,
  p_date date,
  p_amount numeric,
  p_vat_amount numeric,
  p_description text,
  p_method text,
  p_from_drawer boolean default false,
  p_supplier_id uuid default null,
  p_reference text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant  uuid;
  v_session uuid;
  v_status  text;
  v_id      uuid;
begin
  perform app.require_user();
  select b.tenant_id into v_tenant from public.branches b where b.id = p_branch_id;
  if not found then
    perform app.raise('INVALID_BRANCH', 'Unknown branch');
  end if;
  perform app.assert_pos(v_tenant, p_branch_id, 'finance.manage');
  if not exists (select 1 from public.expense_categories c where c.id = p_category_id and c.tenant_id = v_tenant and c.is_active) then
    perform app.raise('INVALID_CATEGORY', 'Choose an expense category');
  end if;
  if p_supplier_id is not null and not exists (select 1 from public.suppliers s where s.id = p_supplier_id and s.tenant_id = v_tenant) then
    perform app.raise('INVALID_SUPPLIER', 'Unknown supplier');
  end if;
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 3)
     or coalesce(p_vat_amount, 0) < 0 or coalesce(p_vat_amount, 0) > p_amount then
    perform app.raise('INVALID_AMOUNT', 'Enter the amount (and VAT not larger than it)');
  end if;
  if p_date is null or p_date > current_date + 1 then
    perform app.raise('INVALID_DATE', 'The expense date cannot be in the future');
  end if;
  if p_method not in ('cash', 'card', 'bank_transfer', 'other') or (coalesce(p_from_drawer, false) and p_method <> 'cash') then
    perform app.raise('INVALID_PAYMENT_METHOD', 'Petty cash from the drawer must be cash');
  end if;
  if coalesce(p_from_drawer, false) then
    select s.id into v_session from public.cash_sessions s where s.branch_id = p_branch_id and s.status = 'open';
    if not found then
      perform app.raise('CASH_SESSION_REQUIRED', 'Open the cash drawer to pay from it');
    end if;
  end if;
  v_status := case when app.has_permission(v_tenant, 'expenses.approve') then 'approved' else 'pending' end;
  insert into public.expenses (tenant_id, branch_id, category_id, expense_date, amount, vat_amount, description, supplier_id,
                               payment_method, cash_session_id, reference, status, approved_by, approved_at)
  values (v_tenant, p_branch_id, p_category_id, p_date, p_amount, round(coalesce(p_vat_amount, 0), 3), btrim(p_description),
          p_supplier_id, p_method, v_session, nullif(btrim(p_reference), ''), v_status,
          case when v_status = 'approved' then auth.uid() end, case when v_status = 'approved' then now() end)
  returning id into v_id;
  return jsonb_build_object('expense_id', v_id, 'status', v_status);
end;
$$;

create or replace function public.review_expense(p_expense_id uuid, p_approve boolean, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_e public.expenses%rowtype;
begin
  perform app.require_user();
  select * into v_e from public.expenses where id = p_expense_id for update;
  if not found or not app.is_tenant_member(v_e.tenant_id) then
    perform app.raise('NOT_FOUND', 'Expense not found');
  end if;
  perform app.assert_pos(v_e.tenant_id, v_e.branch_id, 'expenses.approve');
  if v_e.status <> 'pending' then
    perform app.raise('EXPENSE_NOT_PENDING', 'This expense was already reviewed');
  end if;
  if not p_approve and nullif(btrim(p_reason), '') is null then
    perform app.raise('REASON_REQUIRED', 'Give a reason for rejecting');
  end if;
  update public.expenses
  set status = case when p_approve then 'approved' else 'rejected' end,
      approved_by = auth.uid(), approved_at = now(),
      rejection_reason = case when p_approve then null else btrim(p_reason) end
  where id = p_expense_id;
end;
$$;

-- Profit & loss for a period: revenue (excl. VAT and voucher / deposit
-- liabilities) − cost of goods sold − products used − commissions − expenses.
create or replace function public.get_finance_summary(p_tenant uuid, p_from date, p_to date, p_branch_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tz       text;
  v_start    timestamptz;
  v_end      timestamptz;
  v_revenue  numeric;
  v_vat      numeric;
  v_cogs     numeric;
  v_used     numeric;
  v_comm     numeric;
  v_exp      numeric;
  v_exp_vat  numeric;
begin
  perform app.require_user();
  if not (app.has_permission(p_tenant, 'finance.view') or app.has_permission(p_tenant, 'reports.financial')) then
    perform app.forbid('No access to financial reports');
  end if;
  if p_branch_id is not null and not app.has_branch_access(p_branch_id) then
    perform app.forbid('No access to this branch');
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
    perform app.raise('INVALID_RANGE', 'Choose a period of at most one year');
  end if;
  select s.timezone into v_tz from public.tenant_settings s where s.tenant_id = p_tenant;
  v_start := p_from::timestamp at time zone v_tz;
  v_end := (p_to + 1)::timestamp at time zone v_tz;

  select coalesce(sum(case when i.kind = 'invoice' then it.net_amount else -it.net_amount end), 0),
         coalesce(sum(case when i.kind = 'invoice' then it.vat_amount else -it.vat_amount end), 0)
    into v_revenue, v_vat
  from public.invoices i join public.invoice_items it on it.invoice_id = i.id
  where i.tenant_id = p_tenant and i.status = 'posted' and it.kind <> 'voucher'
    and i.issued_at >= v_start and i.issued_at < v_end
    and i.branch_id in (select app.accessible_branch_ids()) and (p_branch_id is null or i.branch_id = p_branch_id);

  select coalesce(-sum(m.quantity * m.unit_cost) filter (where m.reason in ('sale', 'sale_return')), 0),
         coalesce(-sum(m.quantity * m.unit_cost) filter (where m.reason = 'consumption'), 0)
    into v_cogs, v_used
  from public.inventory_movements m
  where m.tenant_id = p_tenant and m.created_at >= v_start and m.created_at < v_end
    and m.branch_id in (select app.accessible_branch_ids()) and (p_branch_id is null or m.branch_id = p_branch_id);

  select coalesce(sum(c.amount), 0) into v_comm
  from public.commission_entries c
  where c.tenant_id = p_tenant and c.earned_on between p_from and p_to
    and c.branch_id in (select app.accessible_branch_ids()) and (p_branch_id is null or c.branch_id = p_branch_id);

  select coalesce(sum(e.amount - e.vat_amount), 0), coalesce(sum(e.vat_amount), 0) into v_exp, v_exp_vat
  from public.expenses e
  where e.tenant_id = p_tenant and e.status = 'approved' and e.expense_date between p_from and p_to
    and e.branch_id in (select app.accessible_branch_ids()) and (p_branch_id is null or e.branch_id = p_branch_id);

  return jsonb_build_object(
    'revenue', v_revenue, 'vat_collected', v_vat,
    'cost_of_goods', round(v_cogs, 3), 'products_used', round(v_used, 3),
    'gross_profit', round(v_revenue - v_cogs - v_used, 3),
    'commissions', v_comm, 'expenses', v_exp, 'vat_paid', v_exp_vat,
    'net_profit', round(v_revenue - v_cogs - v_used - v_comm - v_exp, 3),
    'expenses_by_category', (
      select coalesce(jsonb_agg(jsonb_build_object('category_id', x.category_id, 'name_en', x.name_en, 'name_ar', x.name_ar, 'amount', x.amount)
                                order by x.amount desc), '[]'::jsonb)
      from (select c.id as category_id, c.name_en, c.name_ar, sum(e.amount - e.vat_amount) as amount
            from public.expenses e join public.expense_categories c on c.id = e.category_id
            where e.tenant_id = p_tenant and e.status = 'approved' and e.expense_date between p_from and p_to
              and e.branch_id in (select app.accessible_branch_ids()) and (p_branch_id is null or e.branch_id = p_branch_id)
            group by c.id, c.name_en, c.name_ar) x));
end;
$$;

-- Turn loyalty points into store credit (a voucher usable at checkout).
create or replace function public.redeem_loyalty_points(p_customer_id uuid, p_points integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant  uuid;
  v_set     public.tenant_settings%rowtype;
  v_amount  numeric(12,3);
  v_voucher public.gift_vouchers%rowtype;
begin
  perform app.require_user();
  select c.tenant_id into v_tenant from public.customers c where c.id = p_customer_id;
  if not found or not app.is_tenant_member(v_tenant) then
    perform app.raise('NOT_FOUND', 'Customer not found');
  end if;
  perform app.require_permission(v_tenant, 'pos.access');
  select * into v_set from public.tenant_settings where tenant_id = v_tenant;
  if not v_set.loyalty_enabled or not app.module_enabled(v_tenant, 'loyalty') then
    perform app.raise('LOYALTY_DISABLED', 'Loyalty points are not enabled');
  end if;
  if p_points is null or p_points <= 0 or p_points < v_set.loyalty_min_redeem then
    perform app.raise('INVALID_POINTS', format('Redeem at least %s points', v_set.loyalty_min_redeem));
  end if;
  v_amount := round(p_points * v_set.loyalty_point_value, 3);
  if v_amount <= 0 then
    perform app.raise('INVALID_POINTS', 'Points have no value — set a point value first');
  end if;
  -- Guarded decrement: never below zero, even from two tills at once.
  update public.loyalty_accounts set balance = balance - p_points, updated_at = now()
  where customer_id = p_customer_id and balance >= p_points;
  if not found then
    perform app.raise('INSUFFICIENT_BALANCE', 'Not enough points');
  end if;
  v_voucher := app.issue_voucher(v_tenant, 'store_credit', v_amount, p_customer_id, null, 'Loyalty reward', null, null);
  insert into public.loyalty_transactions (tenant_id, customer_id, points, kind, voucher_id)
  values (v_tenant, p_customer_id, -p_points, 'redeem', v_voucher.id);
  return jsonb_build_object('code', v_voucher.code, 'amount', v_amount, 'voucher_id', v_voucher.id);
end;
$$;

-- Manual correction of a customer's points (loyalty.manage), audited.
create or replace function public.adjust_loyalty_points(p_customer_id uuid, p_points integer, p_note text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant  uuid;
  v_balance integer;
begin
  perform app.require_user();
  select c.tenant_id into v_tenant from public.customers c where c.id = p_customer_id;
  if not found or not app.is_tenant_member(v_tenant) then
    perform app.raise('NOT_FOUND', 'Customer not found');
  end if;
  perform app.require_permission(v_tenant, 'loyalty.manage');
  if p_points is null or p_points = 0 or nullif(btrim(p_note), '') is null then
    perform app.raise('INVALID_POINTS', 'Enter the points and a reason');
  end if;
  insert into public.loyalty_accounts (tenant_id, customer_id) values (v_tenant, p_customer_id) on conflict (customer_id) do nothing;
  update public.loyalty_accounts
  set balance = balance + p_points, lifetime_earned = lifetime_earned + greatest(p_points, 0), updated_at = now()
  where customer_id = p_customer_id and balance + p_points >= 0
  returning balance into v_balance;
  if not found then
    perform app.raise('INSUFFICIENT_BALANCE', 'Points cannot go below zero');
  end if;
  insert into public.loyalty_transactions (tenant_id, customer_id, points, kind, note)
  values (v_tenant, p_customer_id, p_points, 'adjust', btrim(p_note));
  return v_balance;
end;
$$;

-- Wallet: + loyalty points.
create or replace function public.get_customer_wallet(p_customer_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant uuid;
  v_set    public.tenant_settings%rowtype;
begin
  perform app.require_user();
  select c.tenant_id into v_tenant from public.customers c where c.id = p_customer_id;
  if not found or not exists (select 1 from app.tenants_with_any_permission(app.wallet_reader_permissions() || array['customers.view']) x
                              where x = v_tenant) then
    perform app.raise('NOT_FOUND', 'Customer not found');
  end if;
  select * into v_set from public.tenant_settings where tenant_id = v_tenant;
  return jsonb_build_object(
    'packages', (select coalesce(jsonb_agg(jsonb_build_object(
                   'id', cp.id, 'name_en', cp.name_en, 'name_ar', cp.name_ar, 'status', cp.status,
                   'purchased_at', cp.purchased_at, 'expires_at', cp.expires_at,
                   'balances', (select jsonb_agg(jsonb_build_object('service_id', b.service_id, 'service_name_en', s.name_en,
                                                                   'service_name_ar', s.name_ar, 'total', b.total_sessions,
                                                                   'remaining', b.remaining_sessions) order by s.name_en)
                                from public.customer_package_balances b join public.services s on s.id = b.service_id
                                where b.customer_package_id = cp.id))
                 order by cp.purchased_at desc), '[]'::jsonb)
                 from public.customer_packages cp
                 where cp.customer_id = p_customer_id and cp.status = 'active'
                   and (cp.expires_at is null or cp.expires_at > now())),
    'membership', (select jsonb_build_object('name_en', m.name_en, 'name_ar', m.name_ar, 'discount_percent', m.discount_percent,
                                             'ends_at', m.ends_at)
                   from public.customer_memberships m
                   where m.customer_id = p_customer_id and m.status = 'active' and now() between m.starts_at and m.ends_at
                   order by m.discount_percent desc, m.ends_at desc limit 1),
    'vouchers', (select coalesce(jsonb_agg(jsonb_build_object(
                   'id', g.id, 'kind', g.kind, 'balance', g.balance, 'initial_amount', g.initial_amount,
                   'expires_at', g.expires_at, 'appointment_id', g.appointment_id,
                   'code', case when app.has_permission(v_tenant, 'pos.access') then g.code end)
                 order by g.created_at), '[]'::jsonb)
                 from public.gift_vouchers g
                 where g.tenant_id = v_tenant and g.status = 'active' and g.balance > 0
                   and (g.expires_at is null or g.expires_at > now())
                   and (g.customer_id = p_customer_id
                        or g.appointment_id in (select a.id from public.appointments a where a.customer_id = p_customer_id))),
    'loyalty', case when v_set.loyalty_enabled and app.module_enabled(v_tenant, 'loyalty') then jsonb_build_object(
                 'points', coalesce((select la.balance from public.loyalty_accounts la where la.customer_id = p_customer_id), 0),
                 'point_value', v_set.loyalty_point_value,
                 'min_redeem', v_set.loyalty_min_redeem) end);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Execute privileges
-- ---------------------------------------------------------------------------
revoke all on function
  app.commission_rule_for(uuid, uuid, text, uuid, uuid), app.invoices_post_commissions(), app.invoices_post_loyalty()
from public;

revoke all on function
  public.pay_commissions(uuid, uuid, date, text, text, text),
  public.get_commission_report(uuid, date, date, uuid),
  public.record_expense(uuid, uuid, date, numeric, numeric, text, text, boolean, uuid, text),
  public.review_expense(uuid, boolean, text),
  public.get_finance_summary(uuid, date, date, uuid),
  public.redeem_loyalty_points(uuid, integer),
  public.adjust_loyalty_points(uuid, integer, text)
from public, anon;
grant execute on function
  public.pay_commissions(uuid, uuid, date, text, text, text),
  public.get_commission_report(uuid, date, date, uuid),
  public.record_expense(uuid, uuid, date, numeric, numeric, text, text, boolean, uuid, text),
  public.review_expense(uuid, boolean, text),
  public.get_finance_summary(uuid, date, date, uuid),
  public.redeem_loyalty_points(uuid, integer),
  public.adjust_loyalty_points(uuid, integer, text)
to authenticated, service_role;

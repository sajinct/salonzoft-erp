-- =============================================================================
-- Salonzoft · Migration 0011 · POS, invoices, payments, cash sessions, refunds
-- -----------------------------------------------------------------------------
-- * The cart IS a draft invoice. Every change goes through save_invoice_draft:
--   the server prices lines from the catalogue (or the booked appointment),
--   enforces pos.discount for discounts / price overrides and computes VAT per
--   line (3 decimals, half-up), so the client never decides an amount.
-- * finalize_invoice allocates a GAP-FREE number from a locked per-branch,
--   per-year counter in the same transaction, snapshots seller / customer /
--   VAT settings, and posts. Posted invoices are immutable (trigger); the only
--   correction is a credit note (create_credit_note), which can refund money.
-- * Payments: split / partial, cash requires an open cash session at the
--   branch; idempotency keys make retries safe.
-- * Apps can only READ these tables. Every write is a SECURITY DEFINER RPC
--   with explicit permission + branch checks.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------
create table public.cash_sessions (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null,
  branch_id       uuid not null,
  status          text not null default 'open' check (status in ('open', 'closed')),
  opening_float   numeric(12,3) not null default 0 check (opening_float >= 0),
  opened_by       uuid default auth.uid() references auth.users (id) on delete set null,
  opened_at       timestamptz not null default now(),
  expected_cash   numeric(12,3),
  counted_cash    numeric(12,3) check (counted_cash >= 0),
  variance        numeric(12,3),
  closed_by       uuid references auth.users (id) on delete set null,
  closed_at       timestamptz,
  notes           text check (char_length(notes) <= 500),
  unique (id, tenant_id),
  constraint cash_sessions_closed check (status = 'open' or (closed_at is not null and counted_cash is not null)),
  foreign key (branch_id, tenant_id) references public.branches (id, tenant_id) on delete cascade
);
create unique index cash_sessions_one_open_idx on public.cash_sessions (branch_id) where status = 'open';
create index cash_sessions_branch_idx on public.cash_sessions (branch_id, opened_at desc);
create index cash_sessions_tenant_idx on public.cash_sessions (tenant_id);

-- Gap-free counters (internal: no API grants at all).
create table public.invoice_sequences (
  tenant_id    uuid not null,
  branch_id    uuid not null,
  series       text not null check (series in ('invoice', 'credit_note')),
  year         integer not null check (year between 2000 and 2999),
  next_number  integer not null default 1 check (next_number > 0),
  primary key (branch_id, series, year),
  foreign key (branch_id, tenant_id) references public.branches (id, tenant_id) on delete cascade
);
create index invoice_sequences_tenant_idx on public.invoice_sequences (tenant_id);

create table public.invoices (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null,
  branch_id            uuid not null,
  kind                 text not null default 'invoice' check (kind in ('invoice', 'credit_note')),
  status               text not null default 'draft' check (status in ('draft', 'posted', 'void')),
  number               text,
  sequence_no          integer,
  issued_at            timestamptz,
  customer_id          uuid,
  appointment_id       uuid,
  original_invoice_id  uuid,  -- credit note → the invoice it corrects
  currency_code        char(3) not null default 'OMR',
  prices_include_vat   boolean not null default true,
  vat_registered       boolean not null default false,
  vat_number           text,
  -- snapshots taken when posting (the document must never change afterwards)
  seller_name          text,
  seller_name_ar       text,
  seller_legal_name    text,
  branch_name          text,
  branch_name_ar       text,
  branch_address       text,
  branch_phone         text,
  customer_name        text,
  customer_mobile      text,
  footer_en            text,
  footer_ar            text,
  -- amounts (credit notes hold positive amounts; their kind gives the sign)
  discount_total       numeric(12,3) not null default 0,
  subtotal             numeric(12,3) not null default 0,  -- net of VAT, after discounts
  vat_total            numeric(12,3) not null default 0,
  total                numeric(12,3) not null default 0,
  paid_total           numeric(12,3) not null default 0,  -- invoice: money in · credit note: money refunded
  credited_total       numeric(12,3) not null default 0,  -- invoice: sum of its credit notes
  refunded_total       numeric(12,3) not null default 0,  -- invoice: money paid back via its credit notes
  payment_status       text not null default 'unpaid' check (payment_status in ('unpaid', 'partial', 'paid')),
  reason               text check (char_length(reason) <= 300),
  notes                text check (char_length(notes) <= 500),
  created_by           uuid default auth.uid() references auth.users (id) on delete set null,
  posted_by            uuid references auth.users (id) on delete set null,
  idempotency_key      text check (char_length(idempotency_key) <= 100),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (id, tenant_id),
  unique (tenant_id, number),
  unique (tenant_id, created_by, idempotency_key),
  constraint invoices_posted_numbered check (status <> 'posted' or (number is not null and issued_at is not null)),
  constraint invoices_credit_note_link check ((kind = 'credit_note') = (original_invoice_id is not null)),
  foreign key (branch_id, tenant_id) references public.branches (id, tenant_id) on delete cascade,
  foreign key (customer_id, tenant_id) references public.customers (id, tenant_id),
  foreign key (appointment_id, tenant_id) references public.appointments (id, tenant_id),
  foreign key (original_invoice_id, tenant_id) references public.invoices (id, tenant_id)
);
-- One live invoice per appointment.
create unique index invoices_one_per_appointment_idx on public.invoices (appointment_id)
  where kind = 'invoice' and status in ('draft', 'posted');
create index invoices_branch_issued_idx on public.invoices (branch_id, issued_at desc);
create index invoices_tenant_created_idx on public.invoices (tenant_id, created_at desc);
create index invoices_customer_idx on public.invoices (customer_id, issued_at desc);
create index invoices_original_idx on public.invoices (original_invoice_id);
create trigger invoices_updated_at before update on public.invoices
  for each row execute function app.set_updated_at();

create table public.invoice_items (
  id                      uuid primary key default gen_random_uuid(),
  tenant_id               uuid not null,
  invoice_id              uuid not null,
  sort_order              smallint not null default 1,
  kind                    text not null check (kind in ('service', 'custom')),
  service_id              uuid,
  employee_id             uuid,
  appointment_service_id  uuid,
  original_item_id        uuid,  -- credit note line → the invoice line it credits
  description_en          text not null check (char_length(btrim(description_en)) between 1 and 160),
  description_ar          text check (char_length(description_ar) <= 160),
  quantity                numeric(10,3) not null check (quantity > 0 and quantity <= 999),
  list_price              numeric(12,3) not null check (list_price >= 0),
  unit_price              numeric(12,3) not null check (unit_price >= 0),
  discount_amount         numeric(12,3) not null default 0 check (discount_amount >= 0),
  vat_category            text not null default 'standard' check (vat_category in ('standard', 'zero', 'exempt')),
  vat_rate                numeric(5,2) not null default 0 check (vat_rate between 0 and 100),
  net_amount              numeric(12,3) not null default 0,
  vat_amount              numeric(12,3) not null default 0,
  total_amount            numeric(12,3) not null default 0,
  constraint invoice_items_service check ((kind = 'service') = (service_id is not null)),
  foreign key (invoice_id, tenant_id) references public.invoices (id, tenant_id) on delete cascade,
  foreign key (service_id, tenant_id) references public.services (id, tenant_id),
  foreign key (employee_id, tenant_id) references public.employees (id, tenant_id)
);
create index invoice_items_invoice_idx on public.invoice_items (invoice_id, sort_order);
create index invoice_items_service_idx on public.invoice_items (service_id);
create index invoice_items_employee_idx on public.invoice_items (employee_id);
create index invoice_items_original_idx on public.invoice_items (original_item_id);
create index invoice_items_tenant_idx on public.invoice_items (tenant_id);

create table public.payments (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null,
  branch_id        uuid not null,
  invoice_id       uuid not null,
  direction        text not null default 'in' check (direction in ('in', 'out')),
  method           text not null check (method in ('cash', 'card', 'bank_transfer', 'other')),
  amount           numeric(12,3) not null check (amount > 0),
  reference        text check (char_length(reference) <= 100),
  cash_session_id  uuid,
  received_by      uuid default auth.uid() references auth.users (id) on delete set null,
  received_at      timestamptz not null default now(),
  idempotency_key  text check (char_length(idempotency_key) <= 100),
  unique (tenant_id, idempotency_key),
  constraint payments_cash_session check (method <> 'cash' or cash_session_id is not null),
  foreign key (invoice_id, tenant_id) references public.invoices (id, tenant_id) on delete cascade,
  foreign key (branch_id, tenant_id) references public.branches (id, tenant_id) on delete cascade,
  foreign key (cash_session_id, tenant_id) references public.cash_sessions (id, tenant_id)
);
create index payments_invoice_idx on public.payments (invoice_id);
create index payments_session_idx on public.payments (cash_session_id);
create index payments_branch_time_idx on public.payments (branch_id, received_at desc);
create index payments_tenant_idx on public.payments (tenant_id);

-- ---------------------------------------------------------------------------
-- 2. Immutability of posted documents
-- ---------------------------------------------------------------------------
create or replace function app.invoices_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_mutable text[] := array['paid_total', 'credited_total', 'refunded_total', 'payment_status', 'updated_at'];
begin
  if tg_op = 'DELETE' then
    if old.status = 'posted' then
      perform app.raise('INVOICE_POSTED_IMMUTABLE', 'Posted invoices cannot be deleted');
    end if;
    return old;
  end if;
  if old.status in ('posted', 'void') and (to_jsonb(old) - v_mutable) is distinct from (to_jsonb(new) - v_mutable) then
    perform app.raise('INVOICE_POSTED_IMMUTABLE', 'Posted invoices cannot be changed — issue a credit note');
  end if;
  return new;
end;
$$;
create trigger invoices_guard before update or delete on public.invoices
  for each row execute function app.invoices_guard();

create or replace function app.invoice_items_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_status text;
begin
  select i.status into v_status from public.invoices i where i.id = coalesce(new.invoice_id, old.invoice_id);
  -- (no row = the invoice itself is being deleted by a cascade)
  if v_status is not null and v_status <> 'draft' then
    perform app.raise('INVOICE_POSTED_IMMUTABLE', 'Lines of a posted invoice cannot be changed');
  end if;
  return coalesce(new, old);
end;
$$;
create trigger invoice_items_guard before insert or update or delete on public.invoice_items
  for each row execute function app.invoice_items_guard();

create or replace function app.payments_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and not exists (select 1 from public.invoices i where i.id = old.invoice_id) then
    return old;  -- cascade from a deleted (draft) invoice
  end if;
  perform app.raise('PAYMENT_IMMUTABLE', 'Payments cannot be changed — record a refund instead');
  return null;
end;
$$;
create trigger payments_immutable before update or delete on public.payments
  for each row execute function app.payments_immutable();

-- ---------------------------------------------------------------------------
-- 3. RLS: read-only for apps
-- ---------------------------------------------------------------------------
alter table public.cash_sessions      enable row level security;
alter table public.invoice_sequences  enable row level security;
alter table public.invoices           enable row level security;
alter table public.invoice_items      enable row level security;
alter table public.payments           enable row level security;

revoke all on public.cash_sessions, public.invoice_sequences, public.invoices, public.invoice_items, public.payments
  from anon, authenticated;
grant all on public.cash_sessions, public.invoice_sequences, public.invoices, public.invoice_items, public.payments
  to service_role;
grant select on public.cash_sessions, public.invoices, public.invoice_items, public.payments to authenticated;

create or replace function app.sales_reader_permissions()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['pos.access', 'pos.refund', 'pos.cash_session', 'finance.view', 'reports.financial']::text[];
$$;

create policy invoices_select on public.invoices
  for select to authenticated
  using (branch_id in (select app.branch_ids_with_any_permission(app.sales_reader_permissions())));
create policy invoice_items_select on public.invoice_items
  for select to authenticated
  using (invoice_id in (select i.id from public.invoices i));
create policy payments_select on public.payments
  for select to authenticated
  using (branch_id in (select app.branch_ids_with_any_permission(app.sales_reader_permissions())));
create policy cash_sessions_select on public.cash_sessions
  for select to authenticated
  using (branch_id in (select app.branch_ids_with_any_permission(app.sales_reader_permissions())));
-- invoice_sequences: no policy, no grant — internal only.

create trigger audit_invoices after insert or update on public.invoices
  for each row execute function app.audit_row();
create trigger audit_payments after insert on public.payments
  for each row execute function app.audit_row();
create trigger audit_cash_sessions after insert or update on public.cash_sessions
  for each row execute function app.audit_row();

-- ---------------------------------------------------------------------------
-- 4. Money helpers
-- ---------------------------------------------------------------------------
-- VAT rate for a line: 0 when the business is not VAT-registered or the
-- service is zero-rated / exempt; otherwise the tenant's standard rate.
create or replace function app.vat_rate_for(p_tenant uuid, p_category text)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select case when s.vat_registered and p_category = 'standard' then s.default_vat_rate else 0 end
  from public.tenant_settings s where s.tenant_id = p_tenant;
$$;

-- Line amounts, 3 decimals, half-up (numeric round). Inclusive prices carry
-- VAT inside: vat = gross × rate / (100 + rate).
create or replace function app.line_amounts(
  p_quantity numeric, p_unit_price numeric, p_discount numeric, p_rate numeric, p_inclusive boolean,
  out net_amount numeric, out vat_amount numeric, out total_amount numeric
)
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_gross numeric := round(p_quantity * p_unit_price, 3) - coalesce(p_discount, 0);
begin
  if p_inclusive then
    vat_amount := round(v_gross * p_rate / (100 + p_rate), 3);
    net_amount := v_gross - vat_amount;
    total_amount := v_gross;
  else
    net_amount := v_gross;
    vat_amount := round(v_gross * p_rate / 100, 3);
    total_amount := v_gross + vat_amount;
  end if;
end;
$$;

-- Recompute every line and the header of a DRAFT from its snapshots.
create or replace function app.recalc_invoice(p_invoice uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inv public.invoices%rowtype;
begin
  select * into v_inv from public.invoices where id = p_invoice;
  update public.invoice_items it
  set net_amount = a.net_amount, vat_amount = a.vat_amount, total_amount = a.total_amount
  from public.invoice_items src
  cross join lateral app.line_amounts(src.quantity, src.unit_price, src.discount_amount, src.vat_rate, v_inv.prices_include_vat) a
  where it.id = src.id and src.invoice_id = p_invoice;

  update public.invoices i
  set discount_total = coalesce(t.discount, 0), subtotal = coalesce(t.net, 0),
      vat_total = coalesce(t.vat, 0), total = coalesce(t.total, 0)
  from (select sum(discount_amount) discount, sum(net_amount) net, sum(vat_amount) vat, sum(total_amount) total
        from public.invoice_items where invoice_id = p_invoice) t
  where i.id = p_invoice;
end;
$$;

-- Outstanding amount of an invoice (≤ 0 = settled).
create or replace function app.invoice_balance(p_invoice public.invoices)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select p_invoice.total - p_invoice.credited_total - p_invoice.paid_total + p_invoice.refunded_total;
$$;

create or replace function app.refresh_payment_status(p_invoice uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inv public.invoices%rowtype;
  v_due numeric;
begin
  select * into v_inv from public.invoices where id = p_invoice;
  v_due := app.invoice_balance(v_inv);
  update public.invoices
  set payment_status = case when v_due <= 0 then 'paid' when v_inv.paid_total > 0 then 'partial' else 'unpaid' end
  where id = p_invoice;
end;
$$;

-- Next gap-free number: locks the counter row until the transaction ends, so
-- a rollback returns the number and concurrent checkouts queue.
create or replace function app.next_document_number(p_tenant uuid, p_branch uuid, p_series text, p_issued timestamptz)
returns table (number text, sequence_no integer)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_tz     text;
  v_year   integer;
  v_seq    integer;
  v_prefix text;
  v_code   text;
begin
  select s.timezone, s.invoice_prefix into v_tz, v_prefix from public.tenant_settings s where s.tenant_id = p_tenant;
  select b.code into v_code from public.branches b where b.id = p_branch;
  v_year := extract(year from (p_issued at time zone v_tz))::integer;

  insert into public.invoice_sequences (tenant_id, branch_id, series, year)
  values (p_tenant, p_branch, p_series, v_year)
  on conflict (branch_id, series, year) do nothing;

  update public.invoice_sequences q
  set next_number = q.next_number + 1
  where q.branch_id = p_branch and q.series = p_series and q.year = v_year
  returning q.next_number - 1 into v_seq;

  number := format('%s-%s-%s-%s', case when p_series = 'credit_note' then 'CN' else v_prefix end,
                   v_code, v_year, lpad(v_seq::text, 6, '0'));
  sequence_no := v_seq;
  return next;
end;
$$;

-- Caller may sell at this branch?
create or replace function app.assert_pos(p_tenant uuid, p_branch uuid, p_permission text default 'pos.access')
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app.require_permission(p_tenant, p_permission);
  if not app.has_branch_access(p_branch) then
    perform app.forbid('No access to this branch');
  end if;
end;
$$;

-- Lock an invoice the caller may work on; NOT_FOUND hides other tenants.
create or replace function app.lock_invoice(p_invoice uuid, p_permission text default 'pos.access')
returns public.invoices
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inv public.invoices%rowtype;
begin
  perform app.require_user();
  select * into v_inv from public.invoices where id = p_invoice for update;
  if not found or not app.is_tenant_member(v_inv.tenant_id) then
    perform app.raise('NOT_FOUND', 'Invoice not found');
  end if;
  perform app.assert_pos(v_inv.tenant_id, v_inv.branch_id, p_permission);
  return v_inv;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Cash sessions
-- ---------------------------------------------------------------------------
create or replace function public.open_cash_session(p_branch_id uuid, p_opening_float numeric)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant uuid;
  v_id     uuid;
begin
  perform app.require_user();
  select b.tenant_id into v_tenant from public.branches b where b.id = p_branch_id;
  if not found then
    perform app.raise('INVALID_BRANCH', 'Unknown branch');
  end if;
  perform app.assert_pos(v_tenant, p_branch_id, 'pos.cash_session');
  if p_opening_float is null or p_opening_float < 0 then
    perform app.raise('INVALID_AMOUNT', 'Opening float must be zero or more');
  end if;
  begin
    insert into public.cash_sessions (tenant_id, branch_id, opening_float)
    values (v_tenant, p_branch_id, round(p_opening_float, 3))
    returning id into v_id;
  exception when unique_violation then
    perform app.raise('CASH_SESSION_ALREADY_OPEN', 'A cash session is already open at this branch');
  end;
  return v_id;
end;
$$;

-- Expected cash = float + cash received − cash refunded during the session.
create or replace function public.close_cash_session(p_session_id uuid, p_counted_cash numeric, p_notes text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_s        public.cash_sessions%rowtype;
  v_expected numeric(12,3);
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
  select v_s.opening_float
         + coalesce(sum(p.amount) filter (where p.direction = 'in'), 0)
         - coalesce(sum(p.amount) filter (where p.direction = 'out'), 0)
    into v_expected
  from public.payments p where p.cash_session_id = p_session_id;

  update public.cash_sessions
  set status = 'closed', closed_at = now(), closed_by = auth.uid(),
      counted_cash = round(p_counted_cash, 3), expected_cash = v_expected,
      variance = round(p_counted_cash, 3) - v_expected, notes = nullif(btrim(p_notes), '')
  where id = p_session_id;
  return jsonb_build_object('expected_cash', v_expected, 'counted_cash', round(p_counted_cash, 3),
                            'variance', round(p_counted_cash, 3) - v_expected);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Invoices
-- ---------------------------------------------------------------------------
-- Start a sale (or reopen the live invoice of an appointment). With an
-- appointment, its customer and booked services/prices become the lines.
create or replace function public.create_invoice_draft(
  p_tenant uuid,
  p_branch_id uuid,
  p_customer_id uuid default null,
  p_appointment_id uuid default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid      uuid := app.require_user();
  v_settings public.tenant_settings%rowtype;
  v_appt     public.appointments%rowtype;
  v_customer uuid := p_customer_id;
  v_id       uuid;
begin
  perform app.assert_pos(p_tenant, p_branch_id);
  if not exists (select 1 from public.branches b where b.id = p_branch_id and b.tenant_id = p_tenant and b.is_active) then
    perform app.raise('INVALID_BRANCH', 'Unknown or inactive branch');
  end if;

  if p_idempotency_key is not null then
    select i.id into v_id from public.invoices i
    where i.tenant_id = p_tenant and i.created_by = v_uid and i.idempotency_key = p_idempotency_key;
    if found then
      return jsonb_build_object('invoice_id', v_id, 'existing', true);
    end if;
  end if;

  if p_appointment_id is not null then
    select * into v_appt from public.appointments a
    where a.id = p_appointment_id and a.tenant_id = p_tenant and a.branch_id = p_branch_id for update;
    if not found then
      perform app.raise('NOT_FOUND', 'Appointment not found');
    end if;
    if v_appt.status in ('cancelled', 'no_show') then
      perform app.raise('APPOINTMENT_NOT_BILLABLE', 'Cancelled or no-show appointments cannot be billed');
    end if;
    select i.id into v_id from public.invoices i
    where i.appointment_id = p_appointment_id and i.kind = 'invoice' and i.status in ('draft', 'posted');
    if found then
      return jsonb_build_object('invoice_id', v_id, 'existing', true);
    end if;
    v_customer := coalesce(p_customer_id, v_appt.customer_id);
  end if;

  if v_customer is not null and not exists (select 1 from public.customers c where c.id = v_customer and c.tenant_id = p_tenant) then
    perform app.raise('INVALID_CUSTOMER', 'Unknown customer');
  end if;

  select * into v_settings from public.tenant_settings s where s.tenant_id = p_tenant;
  insert into public.invoices (tenant_id, branch_id, customer_id, appointment_id, currency_code,
                               prices_include_vat, vat_registered, created_by, idempotency_key)
  values (p_tenant, p_branch_id, v_customer, p_appointment_id, v_settings.currency_code,
          v_settings.prices_include_vat, v_settings.vat_registered, v_uid, p_idempotency_key)
  returning id into v_id;

  if p_appointment_id is not null then
    insert into public.invoice_items (tenant_id, invoice_id, sort_order, kind, service_id, employee_id, appointment_service_id,
                                      description_en, description_ar, quantity, list_price, unit_price, vat_category, vat_rate)
    select p_tenant, v_id, s.sort_order, 'service', s.service_id, s.employee_id, s.id,
           s.service_name_en, s.service_name_ar, 1, s.price, s.price, sv.vat_category,
           app.vat_rate_for(p_tenant, sv.vat_category)
    from public.appointment_services s
    join public.services sv on sv.id = s.service_id
    where s.appointment_id = p_appointment_id and s.is_active
    order by s.sort_order;
    perform app.recalc_invoice(v_id);
  end if;

  return jsonb_build_object('invoice_id', v_id, 'existing', false);
end;
$$;

-- Replace the lines (and customer / notes) of a draft. Server-side pricing:
--   service line: price = booked price (from an appointment line) or the
--     catalogue price (branch override first). Charging less than that —
--     or more, for a fixed-price service — needs pos.discount.
--   custom line: free description + price (audited).
--   any discount needs pos.discount and can't exceed the line amount.
-- p_items: [{ kind, service_id?, employee_id?, appointment_service_id?,
--             description?, quantity, unit_price?, discount_amount?, vat_category? }]
create or replace function public.save_invoice_draft(
  p_invoice_id uuid,
  p_customer_id uuid,
  p_items jsonb,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inv       public.invoices%rowtype;
  v_can_disc  boolean;
  v_item      jsonb;
  v_ord       integer;
  v_kind      text;
  v_qty       numeric;
  v_unit      numeric;
  v_disc      numeric;
  v_list      numeric;
  v_svc       public.services%rowtype;
  v_aps       public.appointment_services%rowtype;
  v_emp       uuid;
  v_aps_id    uuid;
  v_desc      text;
  v_desc_ar   text;
  v_vatcat    text;
begin
  v_inv := app.lock_invoice(p_invoice_id);
  if v_inv.status <> 'draft' or v_inv.kind <> 'invoice' then
    perform app.raise('INVOICE_NOT_DRAFT', 'Only draft invoices can be edited');
  end if;
  v_can_disc := app.has_permission(v_inv.tenant_id, 'pos.discount');
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 100 then
    perform app.raise('INVALID_ITEMS', 'Provide up to 100 lines');
  end if;
  if p_customer_id is not null and not exists (select 1 from public.customers c where c.id = p_customer_id and c.tenant_id = v_inv.tenant_id) then
    perform app.raise('INVALID_CUSTOMER', 'Unknown customer');
  end if;
  if char_length(p_notes) > 500 then
    perform app.raise('INVALID_VALUE', 'Notes are limited to 500 characters');
  end if;

  delete from public.invoice_items where invoice_id = p_invoice_id;

  for v_item, v_ord in select e.value, e.ord::integer from jsonb_array_elements(p_items) with ordinality as e(value, ord)
  loop
    begin
      v_kind := coalesce(v_item ->> 'kind', case when v_item ? 'service_id' then 'service' else 'custom' end);
      v_qty := coalesce((v_item ->> 'quantity')::numeric, 1);
      v_unit := (v_item ->> 'unit_price')::numeric;
      v_disc := coalesce((v_item ->> 'discount_amount')::numeric, 0);
      v_emp := nullif(v_item ->> 'employee_id', '')::uuid;
      v_aps_id := nullif(v_item ->> 'appointment_service_id', '')::uuid;
    exception when others then
      perform app.raise('INVALID_ITEMS', format('Line %s has an invalid number or id', v_ord));
    end;
    if v_qty <= 0 or v_qty > 999 or v_qty <> round(v_qty, 3) then
      perform app.raise('INVALID_QUANTITY', format('Line %s: quantity must be between 0.001 and 999', v_ord));
    end if;
    if v_unit < 0 or v_disc < 0 or v_unit <> round(v_unit, 3) or v_disc <> round(v_disc, 3) then
      perform app.raise('INVALID_PRICE', format('Line %s: amounts must be positive with up to 3 decimals', v_ord));
    end if;
    if v_emp is not null and not exists (select 1 from public.employees e where e.id = v_emp and e.tenant_id = v_inv.tenant_id) then
      perform app.raise('INVALID_EMPLOYEE', 'Unknown employee');
    end if;

    if v_kind = 'service' then
      select * into v_svc from public.services s
      where s.id = (v_item ->> 'service_id')::uuid and s.tenant_id = v_inv.tenant_id;
      if not found then
        perform app.raise('INVALID_SERVICE', format('Line %s: unknown service', v_ord));
      end if;
      v_aps := null;
      if v_aps_id is not null then
        select * into v_aps from public.appointment_services a
        where a.id = v_aps_id and a.appointment_id = v_inv.appointment_id and a.service_id = v_svc.id;
        if not found then
          v_aps_id := null;
        end if;
      end if;
      v_list := coalesce(v_aps.price,
                         (select sp.price from public.service_prices sp where sp.service_id = v_svc.id and sp.branch_id = v_inv.branch_id),
                         v_svc.price);
      v_unit := coalesce(v_unit, v_list);
      if not v_can_disc and (v_unit < v_list or (v_svc.price_type = 'fixed' and v_unit <> v_list)) then
        if v_svc.price_type <> 'variable' then
          perform app.raise('PRICE_OVERRIDE_FORBIDDEN', format('Changing the price of %s needs discount permission', v_svc.name_en));
        end if;
      end if;
      v_desc := v_svc.name_en;
      v_desc_ar := v_svc.name_ar;
      v_vatcat := v_svc.vat_category;
    elsif v_kind = 'custom' then
      v_desc := nullif(btrim(v_item ->> 'description'), '');
      if v_desc is null or v_unit is null then
        perform app.raise('INVALID_ITEMS', format('Line %s: a custom line needs a description and a price', v_ord));
      end if;
      v_desc_ar := null;
      v_list := v_unit;
      v_vatcat := coalesce(v_item ->> 'vat_category', 'standard');
      if v_vatcat not in ('standard', 'zero', 'exempt') then
        perform app.raise('INVALID_ITEMS', 'Unknown VAT category');
      end if;
      v_aps_id := null;
    else
      perform app.raise('INVALID_ITEMS', format('Line %s: unknown line type', v_ord));
    end if;

    if v_disc > 0 and not v_can_disc then
      perform app.raise('DISCOUNT_FORBIDDEN', 'Discounts need discount permission');
    end if;
    if v_disc > round(v_qty * v_unit, 3) then
      perform app.raise('INVALID_DISCOUNT', format('Line %s: the discount is larger than the line', v_ord));
    end if;

    insert into public.invoice_items (tenant_id, invoice_id, sort_order, kind, service_id, employee_id, appointment_service_id,
                                      description_en, description_ar, quantity, list_price, unit_price, discount_amount,
                                      vat_category, vat_rate)
    values (v_inv.tenant_id, p_invoice_id, v_ord, v_kind, case when v_kind = 'service' then v_svc.id end, v_emp, v_aps_id,
            left(v_desc, 160), left(v_desc_ar, 160), v_qty, v_list, v_unit, v_disc,
            v_vatcat, app.vat_rate_for(v_inv.tenant_id, v_vatcat));
  end loop;

  update public.invoices set customer_id = p_customer_id, notes = nullif(btrim(p_notes), '') where id = p_invoice_id;
  perform app.recalc_invoice(p_invoice_id);
  return public.get_invoice(p_invoice_id);
end;
$$;

-- Post a draft: re-check VAT settings, allocate the gap-free number, freeze
-- snapshots, and complete the linked appointment. Idempotent.
create or replace function public.finalize_invoice(p_invoice_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inv      public.invoices%rowtype;
  v_settings public.tenant_settings%rowtype;
  v_tenant   public.tenants%rowtype;
  v_branch   public.branches%rowtype;
  v_cust     public.customers%rowtype;
  v_num      record;
  v_now      timestamptz := now();
begin
  v_inv := app.lock_invoice(p_invoice_id);
  if v_inv.status = 'posted' then
    return public.get_invoice(p_invoice_id);
  end if;
  if v_inv.status <> 'draft' or v_inv.kind <> 'invoice' then
    perform app.raise('INVOICE_NOT_DRAFT', 'Only draft invoices can be finalised');
  end if;
  if not exists (select 1 from public.invoice_items where invoice_id = p_invoice_id) then
    perform app.raise('EMPTY_INVOICE', 'Add at least one line');
  end if;

  select * into v_settings from public.tenant_settings where tenant_id = v_inv.tenant_id;
  select * into v_tenant from public.tenants where id = v_inv.tenant_id;
  select * into v_branch from public.branches where id = v_inv.branch_id;
  select * into v_cust from public.customers where id = v_inv.customer_id;

  -- Current VAT settings apply to the posted document.
  update public.invoices set prices_include_vat = v_settings.prices_include_vat, vat_registered = v_settings.vat_registered
  where id = p_invoice_id;
  update public.invoice_items set vat_rate = app.vat_rate_for(v_inv.tenant_id, vat_category) where invoice_id = p_invoice_id;
  perform app.recalc_invoice(p_invoice_id);

  select * into v_num from app.next_document_number(v_inv.tenant_id, v_inv.branch_id, 'invoice', v_now);

  update public.invoices
  set status = 'posted', number = v_num.number, sequence_no = v_num.sequence_no, issued_at = v_now, posted_by = auth.uid(),
      vat_number = case when v_settings.vat_registered then v_settings.vat_number end,
      seller_name = v_tenant.name, seller_name_ar = v_tenant.name_ar, seller_legal_name = v_tenant.legal_name,
      branch_name = v_branch.name_en, branch_name_ar = v_branch.name_ar,
      branch_address = concat_ws(', ', v_branch.address_en, v_branch.city), branch_phone = v_branch.phone,
      customer_name = nullif(btrim(concat_ws(' ', v_cust.first_name, v_cust.last_name)), ''), customer_mobile = v_cust.mobile,
      footer_en = v_settings.receipt_footer_en, footer_ar = v_settings.receipt_footer_ar
  where id = p_invoice_id;
  perform app.refresh_payment_status(p_invoice_id);

  if v_inv.appointment_id is not null then
    update public.appointments
    set status = 'completed', completed_at = coalesce(completed_at, v_now), checked_in_at = coalesce(checked_in_at, v_now)
    where id = v_inv.appointment_id and status in ('booked', 'confirmed', 'checked_in', 'in_service');
  end if;

  return public.get_invoice(p_invoice_id);
end;
$$;

-- Discard a draft (no number was used, so nothing is lost).
create or replace function public.void_invoice_draft(p_invoice_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inv public.invoices%rowtype;
begin
  v_inv := app.lock_invoice(p_invoice_id);
  if v_inv.status <> 'draft' then
    perform app.raise('INVOICE_NOT_DRAFT', 'Only drafts can be discarded — issue a credit note for posted invoices');
  end if;
  update public.invoices set status = 'void' where id = p_invoice_id;
end;
$$;

-- Take a payment (split / partial: call once per method). Cash needs an open
-- cash session at the branch. Idempotent per key.
create or replace function public.record_payment(
  p_invoice_id uuid,
  p_method text,
  p_amount numeric,
  p_reference text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inv     public.invoices%rowtype;
  v_session uuid;
  v_id      uuid;
begin
  v_inv := app.lock_invoice(p_invoice_id);
  if p_idempotency_key is not null then
    select p.id into v_id from public.payments p where p.tenant_id = v_inv.tenant_id and p.idempotency_key = p_idempotency_key;
    if found then
      select * into v_inv from public.invoices where id = p_invoice_id;
      return jsonb_build_object('payment_id', v_id, 'replayed', true, 'balance_due', app.invoice_balance(v_inv),
                                'payment_status', v_inv.payment_status);
    end if;
  end if;
  if v_inv.status <> 'posted' or v_inv.kind <> 'invoice' then
    perform app.raise('INVOICE_NOT_POSTED', 'Finalise the invoice before taking payment');
  end if;
  if p_method not in ('cash', 'card', 'bank_transfer', 'other') then
    perform app.raise('INVALID_PAYMENT_METHOD', 'Unknown payment method');
  end if;
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 3) then
    perform app.raise('INVALID_AMOUNT', 'Enter a positive amount with up to 3 decimals');
  end if;
  if p_amount > app.invoice_balance(v_inv) then
    perform app.raise('OVERPAYMENT', format('Only %s is due', app.invoice_balance(v_inv)));
  end if;
  if p_method = 'cash' then
    select s.id into v_session from public.cash_sessions s where s.branch_id = v_inv.branch_id and s.status = 'open';
    if not found then
      perform app.raise('CASH_SESSION_REQUIRED', 'Open the cash drawer before taking cash');
    end if;
  end if;

  insert into public.payments (tenant_id, branch_id, invoice_id, direction, method, amount, reference, cash_session_id, idempotency_key)
  values (v_inv.tenant_id, v_inv.branch_id, p_invoice_id, 'in', p_method, p_amount, nullif(btrim(p_reference), ''), v_session, p_idempotency_key)
  returning id into v_id;

  update public.invoices set paid_total = paid_total + p_amount where id = p_invoice_id;
  perform app.refresh_payment_status(p_invoice_id);
  select * into v_inv from public.invoices where id = p_invoice_id;
  return jsonb_build_object('payment_id', v_id, 'replayed', false, 'balance_due', app.invoice_balance(v_inv),
                            'payment_status', v_inv.payment_status);
end;
$$;

-- Credit (part of) a posted invoice. p_items: [{ "item_id": uuid, "quantity": n }]
-- or null for everything not yet credited. Money already paid beyond what is
-- still owed is refunded with p_refund_method (cash needs an open session).
create or replace function public.create_credit_note(
  p_invoice_id uuid,
  p_items jsonb,
  p_reason text,
  p_refund_method text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := app.require_user();
  v_inv     public.invoices%rowtype;
  v_cn      public.invoices%rowtype;
  v_id      uuid;
  v_num     record;
  v_line    record;
  v_qty     numeric;
  v_ord     integer := 0;
  v_refund  numeric(12,3) := 0;
  v_session uuid;
  v_now     timestamptz := now();
begin
  v_inv := app.lock_invoice(p_invoice_id, 'pos.refund');
  if p_idempotency_key is not null then
    select i.id into v_id from public.invoices i
    where i.tenant_id = v_inv.tenant_id and i.created_by = v_uid and i.idempotency_key = p_idempotency_key;
    if found then
      return jsonb_build_object('credit_note_id', v_id, 'replayed', true);
    end if;
  end if;
  if v_inv.status <> 'posted' or v_inv.kind <> 'invoice' then
    perform app.raise('INVOICE_NOT_POSTED', 'Only posted invoices can be credited');
  end if;
  if nullif(btrim(p_reason), '') is null then
    perform app.raise('CREDIT_REASON_REQUIRED', 'Give a reason for the credit note');
  end if;
  if p_refund_method is not null and p_refund_method not in ('cash', 'card', 'bank_transfer', 'other') then
    perform app.raise('INVALID_PAYMENT_METHOD', 'Unknown refund method');
  end if;

  insert into public.invoices (tenant_id, branch_id, kind, original_invoice_id, customer_id, currency_code,
                               prices_include_vat, vat_registered, reason, created_by, idempotency_key)
  values (v_inv.tenant_id, v_inv.branch_id, 'credit_note', v_inv.id, v_inv.customer_id, v_inv.currency_code,
          v_inv.prices_include_vat, v_inv.vat_registered, btrim(p_reason), v_uid, p_idempotency_key)
  returning id into v_id;

  -- Remaining creditable quantity per original line (posted credit notes only).
  for v_line in
    select it.*, it.quantity - coalesce((select sum(c.quantity) from public.invoice_items c
                                         join public.invoices n on n.id = c.invoice_id
                                         where c.original_item_id = it.id and n.status = 'posted'), 0) as remaining
    from public.invoice_items it where it.invoice_id = p_invoice_id order by it.sort_order
  loop
    if p_items is null then
      v_qty := v_line.remaining;
    else
      begin
        select (e ->> 'quantity')::numeric into v_qty
        from jsonb_array_elements(p_items) e where (e ->> 'item_id')::uuid = v_line.id;
      exception when others then
        perform app.raise('INVALID_ITEMS', 'Each line needs an item_id and a quantity');
      end;
    end if;
    continue when v_qty is null or v_qty = 0;
    if v_qty < 0 or v_qty > v_line.remaining then
      perform app.raise('CREDIT_EXCEEDS_INVOICE', format('Only %s of "%s" can still be credited', v_line.remaining, v_line.description_en));
    end if;
    v_ord := v_ord + 1;
    insert into public.invoice_items (tenant_id, invoice_id, sort_order, kind, service_id, employee_id, original_item_id,
                                      description_en, description_ar, quantity, list_price, unit_price, discount_amount,
                                      vat_category, vat_rate)
    values (v_inv.tenant_id, v_id, v_ord, v_line.kind, v_line.service_id, v_line.employee_id, v_line.id,
            v_line.description_en, v_line.description_ar, v_qty, v_line.list_price, v_line.unit_price,
            round(v_line.discount_amount * v_qty / v_line.quantity, 3), v_line.vat_category, v_line.vat_rate);
  end loop;
  if v_ord = 0 then
    perform app.raise('EMPTY_INVOICE', 'Nothing left to credit on this invoice');
  end if;
  if p_items is not null and exists (
       select 1 from jsonb_array_elements(p_items) e
       where not exists (select 1 from public.invoice_items it where it.invoice_id = p_invoice_id and it.id = (e ->> 'item_id')::uuid)) then
    perform app.raise('INVALID_ITEMS', 'A line does not belong to this invoice');
  end if;

  perform app.recalc_invoice(v_id);
  select * into v_num from app.next_document_number(v_inv.tenant_id, v_inv.branch_id, 'credit_note', v_now);
  update public.invoices
  set status = 'posted', number = v_num.number, sequence_no = v_num.sequence_no, issued_at = v_now, posted_by = v_uid,
      vat_number = v_inv.vat_number, seller_name = v_inv.seller_name, seller_name_ar = v_inv.seller_name_ar,
      seller_legal_name = v_inv.seller_legal_name, branch_name = v_inv.branch_name, branch_name_ar = v_inv.branch_name_ar,
      branch_address = v_inv.branch_address, branch_phone = v_inv.branch_phone,
      customer_name = v_inv.customer_name, customer_mobile = v_inv.customer_mobile,
      footer_en = v_inv.footer_en, footer_ar = v_inv.footer_ar
  where id = v_id
  returning * into v_cn;

  update public.invoices set credited_total = credited_total + v_cn.total where id = p_invoice_id
  returning * into v_inv;

  -- Refund what was paid beyond the (reduced) amount still owed.
  v_refund := least(v_cn.total, greatest(0, -app.invoice_balance(v_inv)));
  if v_refund > 0 then
    if p_refund_method is null then
      perform app.raise('REFUND_METHOD_REQUIRED', format('%s must be refunded — choose how', v_refund));
    end if;
    if p_refund_method = 'cash' then
      select s.id into v_session from public.cash_sessions s where s.branch_id = v_inv.branch_id and s.status = 'open';
      if not found then
        perform app.raise('CASH_SESSION_REQUIRED', 'Open the cash drawer before refunding cash');
      end if;
    end if;
    insert into public.payments (tenant_id, branch_id, invoice_id, direction, method, amount, cash_session_id)
    values (v_inv.tenant_id, v_inv.branch_id, v_id, 'out', p_refund_method, v_refund, v_session);
    update public.invoices set paid_total = v_refund where id = v_id;
    update public.invoices set refunded_total = refunded_total + v_refund where id = p_invoice_id;
  end if;
  perform app.refresh_payment_status(p_invoice_id);
  update public.invoices set payment_status = 'paid' where id = v_id;

  return jsonb_build_object('credit_note_id', v_id, 'replayed', false, 'number', v_cn.number,
                            'total', v_cn.total, 'refunded', v_refund);
end;
$$;

-- Full document for screen / print: header, lines, payments, credit notes.
create or replace function public.get_invoice(p_invoice_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_inv public.invoices%rowtype;
begin
  perform app.require_user();
  select * into v_inv from public.invoices where id = p_invoice_id;
  if not found or not exists (select 1 from app.branch_ids_with_any_permission(app.sales_reader_permissions()) x
                              where x = v_inv.branch_id) then
    perform app.raise('NOT_FOUND', 'Invoice not found');
  end if;
  return to_jsonb(v_inv) - 'idempotency_key'
    || jsonb_build_object(
         'balance_due', app.invoice_balance(v_inv),
         'items', (select coalesce(jsonb_agg(to_jsonb(it) order by it.sort_order), '[]'::jsonb)
                   from public.invoice_items it where it.invoice_id = p_invoice_id),
         'payments', (select coalesce(jsonb_agg(to_jsonb(p) - 'idempotency_key' order by p.received_at), '[]'::jsonb)
                      from public.payments p
                      where p.invoice_id = p_invoice_id
                         or p.invoice_id in (select c.id from public.invoices c where c.original_invoice_id = p_invoice_id)),
         'credit_notes', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'number', c.number, 'issued_at', c.issued_at,
                                                                      'total', c.total, 'reason', c.reason) order by c.issued_at), '[]'::jsonb)
                          from public.invoices c where c.original_invoice_id = p_invoice_id and c.status = 'posted'),
         'original', (select jsonb_build_object('id', o.id, 'number', o.number)
                      from public.invoices o where o.id = v_inv.original_invoice_id));
end;
$$;

-- Sales of a day / period for the dashboard and the drawer.
create or replace function public.get_sales_summary(p_tenant uuid, p_branch_id uuid default null, p_from timestamptz default null, p_to timestamptz default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tz   text;
  v_from timestamptz;
  v_to   timestamptz;
begin
  perform app.require_user();
  if not exists (select 1 from app.tenants_with_any_permission(app.sales_reader_permissions()) x where x = p_tenant) then
    perform app.forbid('No access to sales');
  end if;
  if p_branch_id is not null and not app.has_branch_access(p_branch_id) then
    perform app.forbid('No access to this branch');
  end if;
  select s.timezone into v_tz from public.tenant_settings s where s.tenant_id = p_tenant;
  v_from := coalesce(p_from, (now() at time zone v_tz)::date::timestamp at time zone v_tz);
  v_to := coalesce(p_to, v_from + interval '1 day');
  if v_to <= v_from or v_to - v_from > interval '366 days' then
    perform app.raise('INVALID_RANGE', 'Choose a period of at most one year');
  end if;

  return jsonb_build_object(
    'from', v_from, 'to', v_to,
    'invoices', (select count(*) from public.invoices i
                 where i.tenant_id = p_tenant and i.kind = 'invoice' and i.status = 'posted'
                   and i.issued_at >= v_from and i.issued_at < v_to
                   and i.branch_id in (select app.branch_ids_with_any_permission(app.sales_reader_permissions()))
                   and (p_branch_id is null or i.branch_id = p_branch_id)),
    'gross_sales', (select coalesce(sum(case when i.kind = 'invoice' then i.total else -i.total end), 0) from public.invoices i
                    where i.tenant_id = p_tenant and i.status = 'posted'
                      and i.issued_at >= v_from and i.issued_at < v_to
                      and i.branch_id in (select app.branch_ids_with_any_permission(app.sales_reader_permissions()))
                      and (p_branch_id is null or i.branch_id = p_branch_id)),
    'vat', (select coalesce(sum(case when i.kind = 'invoice' then i.vat_total else -i.vat_total end), 0) from public.invoices i
            where i.tenant_id = p_tenant and i.status = 'posted'
              and i.issued_at >= v_from and i.issued_at < v_to
              and i.branch_id in (select app.branch_ids_with_any_permission(app.sales_reader_permissions()))
              and (p_branch_id is null or i.branch_id = p_branch_id)),
    'by_method', (select coalesce(jsonb_object_agg(m.method, m.amount), '{}'::jsonb) from (
                    select p.method, sum(case when p.direction = 'in' then p.amount else -p.amount end) amount
                    from public.payments p
                    where p.tenant_id = p_tenant and p.received_at >= v_from and p.received_at < v_to
                      and p.branch_id in (select app.branch_ids_with_any_permission(app.sales_reader_permissions()))
                      and (p_branch_id is null or p.branch_id = p_branch_id)
                    group by p.method) m),
    'outstanding', (select coalesce(sum(app.invoice_balance(i)), 0) from public.invoices i
                    where i.tenant_id = p_tenant and i.kind = 'invoice' and i.status = 'posted' and i.payment_status <> 'paid'
                      and i.branch_id in (select app.branch_ids_with_any_permission(app.sales_reader_permissions()))
                      and (p_branch_id is null or i.branch_id = p_branch_id)));
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Execute privileges
-- ---------------------------------------------------------------------------
revoke all on function
  app.invoices_guard(), app.invoice_items_guard(), app.payments_immutable(),
  app.sales_reader_permissions(), app.vat_rate_for(uuid, text),
  app.line_amounts(numeric, numeric, numeric, numeric, boolean),
  app.recalc_invoice(uuid), app.invoice_balance(public.invoices), app.refresh_payment_status(uuid),
  app.next_document_number(uuid, uuid, text, timestamptz),
  app.assert_pos(uuid, uuid, text), app.lock_invoice(uuid, text)
from public;
grant execute on function app.sales_reader_permissions(), app.line_amounts(numeric, numeric, numeric, numeric, boolean)
  to authenticated, service_role;

revoke all on function
  public.open_cash_session(uuid, numeric),
  public.close_cash_session(uuid, numeric, text),
  public.create_invoice_draft(uuid, uuid, uuid, uuid, text),
  public.save_invoice_draft(uuid, uuid, jsonb, text),
  public.finalize_invoice(uuid),
  public.void_invoice_draft(uuid),
  public.record_payment(uuid, text, numeric, text, text),
  public.create_credit_note(uuid, jsonb, text, text, text),
  public.get_invoice(uuid),
  public.get_sales_summary(uuid, uuid, timestamptz, timestamptz)
from public, anon;

grant execute on function
  public.open_cash_session(uuid, numeric),
  public.close_cash_session(uuid, numeric, text),
  public.create_invoice_draft(uuid, uuid, uuid, uuid, text),
  public.save_invoice_draft(uuid, uuid, jsonb, text),
  public.finalize_invoice(uuid),
  public.void_invoice_draft(uuid),
  public.record_payment(uuid, text, numeric, text, text),
  public.create_credit_note(uuid, jsonb, text, text, text),
  public.get_invoice(uuid),
  public.get_sales_summary(uuid, uuid, timestamptz, timestamptz)
to authenticated, service_role;

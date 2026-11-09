-- =============================================================================
-- Salonzoft · Migration 0012 · Packages, memberships, gift vouchers, deposits
-- -----------------------------------------------------------------------------
-- Everything is sold and redeemed through the POS invoice engine (0011):
--  * invoice lines gain kinds: package, membership, voucher;
--  * a service line can REDEEM a session from a customer's package;
--  * a payment can use a gift voucher / store credit (method 'voucher').
-- Balances are protected by guarded decrements in the posting transaction
-- (`… set remaining = remaining - n where remaining >= n returning …`): a
-- zero-row update means INSUFFICIENT_BALANCE, so two tills redeeming the
-- same package or voucher at once can never overdraw it.
-- Deposits = store credit (a voucher) linked to an appointment, offered at
-- checkout. Credit notes reverse redemptions, void unused vouchers and cancel
-- unused packages / memberships, and can refund as store credit.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Catalogue: packages & memberships
-- ---------------------------------------------------------------------------
create table public.packages (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants (id) on delete cascade,
  name_en         text not null check (char_length(btrim(name_en)) between 2 and 120),
  name_ar         text check (char_length(name_ar) <= 120),
  description_en  text check (char_length(description_en) <= 500),
  price           numeric(12,3) not null check (price >= 0),
  validity_days   integer check (validity_days between 1 and 3650),  -- null = never expires
  vat_category    text not null default 'standard' check (vat_category in ('standard', 'zero', 'exempt')),
  is_active       boolean not null default true,
  sort_order      integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (id, tenant_id)
);
create index packages_tenant_idx on public.packages (tenant_id, is_active, sort_order);
create trigger packages_updated_at before update on public.packages for each row execute function app.set_updated_at();

create table public.package_items (
  tenant_id   uuid not null,
  package_id  uuid not null,
  service_id  uuid not null,
  sessions    integer not null check (sessions between 1 and 500),
  primary key (package_id, service_id),
  foreign key (package_id, tenant_id) references public.packages (id, tenant_id) on delete cascade,
  foreign key (service_id, tenant_id) references public.services (id, tenant_id)
);
create index package_items_tenant_idx on public.package_items (tenant_id);
create index package_items_service_idx on public.package_items (service_id);

create table public.memberships (
  id                         uuid primary key default gen_random_uuid(),
  tenant_id                  uuid not null references public.tenants (id) on delete cascade,
  name_en                    text not null check (char_length(btrim(name_en)) between 2 and 120),
  name_ar                    text check (char_length(name_ar) <= 120),
  price                      numeric(12,3) not null check (price >= 0),
  duration_days              integer not null check (duration_days between 1 and 3650),
  service_discount_percent   numeric(5,2) not null default 0 check (service_discount_percent between 0 and 100),
  vat_category               text not null default 'standard' check (vat_category in ('standard', 'zero', 'exempt')),
  is_active                  boolean not null default true,
  sort_order                 integer not null default 0,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  unique (id, tenant_id)
);
create index memberships_tenant_idx on public.memberships (tenant_id, is_active, sort_order);
create trigger memberships_updated_at before update on public.memberships for each row execute function app.set_updated_at();

-- ---------------------------------------------------------------------------
-- 2. Customer holdings
-- ---------------------------------------------------------------------------
create table public.customer_packages (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null,
  customer_id       uuid not null,
  package_id        uuid not null,
  name_en           text not null,
  name_ar           text,
  invoice_id        uuid,
  invoice_item_id   uuid,
  status            text not null default 'active' check (status in ('active', 'exhausted', 'cancelled')),
  purchased_at      timestamptz not null default now(),
  expires_at        timestamptz,
  created_at        timestamptz not null default now(),
  unique (id, tenant_id),
  foreign key (customer_id, tenant_id) references public.customers (id, tenant_id),
  foreign key (package_id, tenant_id) references public.packages (id, tenant_id),
  foreign key (invoice_id, tenant_id) references public.invoices (id, tenant_id)
);
create index customer_packages_customer_idx on public.customer_packages (customer_id, status);
create index customer_packages_item_idx on public.customer_packages (invoice_item_id);
create index customer_packages_tenant_idx on public.customer_packages (tenant_id);

create table public.customer_package_balances (
  tenant_id            uuid not null,
  customer_package_id  uuid not null,
  service_id           uuid not null,
  total_sessions       integer not null check (total_sessions > 0),
  remaining_sessions   integer not null check (remaining_sessions >= 0),
  primary key (customer_package_id, service_id),
  constraint customer_package_balances_bounds check (remaining_sessions <= total_sessions),
  foreign key (customer_package_id, tenant_id) references public.customer_packages (id, tenant_id) on delete cascade,
  foreign key (service_id, tenant_id) references public.services (id, tenant_id)
);
create index customer_package_balances_tenant_idx on public.customer_package_balances (tenant_id);

create table public.package_redemptions (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null,
  customer_package_id  uuid not null,
  service_id           uuid not null,
  quantity             integer not null check (quantity > 0),
  invoice_id           uuid not null,
  invoice_item_id      uuid not null,
  reversed_at          timestamptz,
  redeemed_by          uuid default auth.uid() references auth.users (id) on delete set null,
  redeemed_at          timestamptz not null default now(),
  foreign key (customer_package_id, tenant_id) references public.customer_packages (id, tenant_id) on delete cascade,
  foreign key (invoice_id, tenant_id) references public.invoices (id, tenant_id)
);
create index package_redemptions_package_idx on public.package_redemptions (customer_package_id);
create index package_redemptions_item_idx on public.package_redemptions (invoice_item_id);
create index package_redemptions_tenant_idx on public.package_redemptions (tenant_id);

create table public.customer_memberships (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null,
  customer_id      uuid not null,
  membership_id    uuid not null,
  name_en          text not null,
  name_ar          text,
  discount_percent numeric(5,2) not null,
  invoice_id       uuid,
  invoice_item_id  uuid,
  status           text not null default 'active' check (status in ('active', 'cancelled')),
  starts_at        timestamptz not null default now(),
  ends_at          timestamptz not null,
  created_at       timestamptz not null default now(),
  constraint customer_memberships_order check (ends_at > starts_at),
  foreign key (customer_id, tenant_id) references public.customers (id, tenant_id),
  foreign key (membership_id, tenant_id) references public.memberships (id, tenant_id),
  foreign key (invoice_id, tenant_id) references public.invoices (id, tenant_id)
);
create index customer_memberships_customer_idx on public.customer_memberships (customer_id, ends_at desc);
create index customer_memberships_item_idx on public.customer_memberships (invoice_item_id);
create index customer_memberships_tenant_idx on public.customer_memberships (tenant_id);

-- Gift vouchers, store credit and deposits share one instrument.
create table public.gift_vouchers (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null,
  code               text not null check (code ~ '^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$'),
  kind               text not null default 'gift' check (kind in ('gift', 'store_credit', 'deposit')),
  initial_amount     numeric(12,3) not null check (initial_amount > 0),
  balance            numeric(12,3) not null check (balance >= 0),
  customer_id        uuid,
  appointment_id     uuid,
  recipient_name     text check (char_length(recipient_name) <= 120),
  invoice_id         uuid,  -- sold on (gift / deposit) or issued by (store credit from a credit note)
  invoice_item_id    uuid,
  status             text not null default 'active' check (status in ('active', 'void')),
  expires_at         timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint gift_vouchers_bounds check (balance <= initial_amount),
  unique (tenant_id, code),
  unique (id, tenant_id),
  foreign key (customer_id, tenant_id) references public.customers (id, tenant_id),
  foreign key (appointment_id, tenant_id) references public.appointments (id, tenant_id) on delete set null (appointment_id),
  foreign key (invoice_id, tenant_id) references public.invoices (id, tenant_id)
);
create index gift_vouchers_customer_idx on public.gift_vouchers (customer_id, status);
create index gift_vouchers_appointment_idx on public.gift_vouchers (appointment_id);
create index gift_vouchers_item_idx on public.gift_vouchers (invoice_item_id);
create trigger gift_vouchers_updated_at before update on public.gift_vouchers for each row execute function app.set_updated_at();

create table public.voucher_transactions (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  voucher_id  uuid not null,
  kind        text not null check (kind in ('issue', 'redeem', 'refund', 'void')),
  amount      numeric(12,3) not null check (amount >= 0),
  invoice_id  uuid,
  payment_id  uuid,
  created_by  uuid default auth.uid() references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  foreign key (voucher_id, tenant_id) references public.gift_vouchers (id, tenant_id) on delete cascade
);
create index voucher_transactions_voucher_idx on public.voucher_transactions (voucher_id, created_at);
create index voucher_transactions_tenant_idx on public.voucher_transactions (tenant_id);

-- ---------------------------------------------------------------------------
-- 3. Extend invoice lines and payments
-- ---------------------------------------------------------------------------
alter table public.invoice_items drop constraint invoice_items_kind_check;
alter table public.invoice_items add constraint invoice_items_kind_check
  check (kind in ('service', 'custom', 'package', 'membership', 'voucher'));
alter table public.invoice_items
  add column package_id uuid,
  add column membership_id uuid,
  add column customer_package_id uuid,      -- service line paid with a package session
  add column member_discount_percent numeric(5,2),
  add column deposit_appointment_id uuid,   -- voucher line sold as a booking deposit
  add constraint invoice_items_package_fk foreign key (package_id, tenant_id) references public.packages (id, tenant_id),
  add constraint invoice_items_membership_fk foreign key (membership_id, tenant_id) references public.memberships (id, tenant_id),
  add constraint invoice_items_customer_package_fk foreign key (customer_package_id, tenant_id) references public.customer_packages (id, tenant_id),
  add constraint invoice_items_package_line check ((kind = 'package') = (package_id is not null)),
  add constraint invoice_items_membership_line check ((kind = 'membership') = (membership_id is not null)),
  add constraint invoice_items_redemption_service check (customer_package_id is null or kind = 'service');
create index invoice_items_customer_package_idx on public.invoice_items (customer_package_id);

alter table public.payments drop constraint payments_method_check;
alter table public.payments add constraint payments_method_check
  check (method in ('cash', 'card', 'bank_transfer', 'voucher', 'other'));
alter table public.payments
  add column voucher_id uuid,
  add constraint payments_voucher_fk foreign key (voucher_id, tenant_id) references public.gift_vouchers (id, tenant_id),
  add constraint payments_voucher_link check ((method = 'voucher') = (voucher_id is not null));
create index payments_voucher_idx on public.payments (voucher_id);

-- ---------------------------------------------------------------------------
-- 4. RLS + grants
-- ---------------------------------------------------------------------------
alter table public.packages                  enable row level security;
alter table public.package_items             enable row level security;
alter table public.memberships               enable row level security;
alter table public.customer_packages         enable row level security;
alter table public.customer_package_balances enable row level security;
alter table public.package_redemptions       enable row level security;
alter table public.customer_memberships      enable row level security;
alter table public.gift_vouchers             enable row level security;
alter table public.voucher_transactions      enable row level security;

revoke all on public.packages, public.package_items, public.memberships, public.customer_packages,
              public.customer_package_balances, public.package_redemptions, public.customer_memberships,
              public.gift_vouchers, public.voucher_transactions from anon, authenticated;
grant all on public.packages, public.package_items, public.memberships, public.customer_packages,
             public.customer_package_balances, public.package_redemptions, public.customer_memberships,
             public.gift_vouchers, public.voucher_transactions to service_role;

create or replace function app.wallet_reader_permissions()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['pos.access', 'packages.view', 'packages.manage', 'finance.view', 'reports.financial']::text[];
$$;

-- Catalogue: read by sellers, managed with packages.manage.
grant select on public.packages, public.package_items, public.memberships to authenticated;
grant insert (tenant_id, name_en, name_ar, description_en, price, validity_days, vat_category, is_active, sort_order) on public.packages to authenticated;
grant update (name_en, name_ar, description_en, price, validity_days, vat_category, is_active, sort_order) on public.packages to authenticated;
grant insert (tenant_id, name_en, name_ar, price, duration_days, service_discount_percent, vat_category, is_active, sort_order) on public.memberships to authenticated;
grant update (name_en, name_ar, price, duration_days, service_discount_percent, vat_category, is_active, sort_order) on public.memberships to authenticated;

create policy packages_select on public.packages for select to authenticated
  using (tenant_id in (select app.tenants_with_any_permission(app.wallet_reader_permissions())));
create policy packages_insert on public.packages for insert to authenticated
  with check (tenant_id in (select app.tenants_with_permission('packages.manage')));
create policy packages_update on public.packages for update to authenticated
  using (tenant_id in (select app.tenants_with_permission('packages.manage')))
  with check (tenant_id in (select app.tenants_with_permission('packages.manage')));
create policy package_items_select on public.package_items for select to authenticated
  using (tenant_id in (select app.tenants_with_any_permission(app.wallet_reader_permissions())));
create policy memberships_select on public.memberships for select to authenticated
  using (tenant_id in (select app.tenants_with_any_permission(app.wallet_reader_permissions())));
create policy memberships_insert on public.memberships for insert to authenticated
  with check (tenant_id in (select app.tenants_with_permission('packages.manage')));
create policy memberships_update on public.memberships for update to authenticated
  using (tenant_id in (select app.tenants_with_permission('packages.manage')))
  with check (tenant_id in (select app.tenants_with_permission('packages.manage')));

-- Holdings: read-only (writes only through POS RPCs). Voucher codes are bearer
-- secrets: only sellers / package managers / finance can see them.
grant select on public.customer_packages, public.customer_package_balances, public.package_redemptions,
                public.customer_memberships, public.gift_vouchers, public.voucher_transactions to authenticated;
create policy customer_packages_select on public.customer_packages for select to authenticated
  using (tenant_id in (select app.tenants_with_any_permission(app.wallet_reader_permissions())));
create policy customer_package_balances_select on public.customer_package_balances for select to authenticated
  using (tenant_id in (select app.tenants_with_any_permission(app.wallet_reader_permissions())));
create policy package_redemptions_select on public.package_redemptions for select to authenticated
  using (tenant_id in (select app.tenants_with_any_permission(app.wallet_reader_permissions())));
create policy customer_memberships_select on public.customer_memberships for select to authenticated
  using (tenant_id in (select app.tenants_with_any_permission(app.wallet_reader_permissions())));
create policy gift_vouchers_select on public.gift_vouchers for select to authenticated
  using (tenant_id in (select app.tenants_with_any_permission(app.wallet_reader_permissions())));
create policy voucher_transactions_select on public.voucher_transactions for select to authenticated
  using (tenant_id in (select app.tenants_with_any_permission(app.wallet_reader_permissions())));

create trigger audit_packages after insert or update on public.packages for each row execute function app.audit_row();
create trigger audit_memberships after insert or update on public.memberships for each row execute function app.audit_row();
create trigger audit_gift_vouchers after insert or update on public.gift_vouchers for each row execute function app.audit_row();
create trigger audit_customer_packages after insert or update on public.customer_packages for each row execute function app.audit_row();

-- ---------------------------------------------------------------------------
-- 5. Helpers
-- ---------------------------------------------------------------------------
-- 12 random characters from a 32-letter alphabet without look-alikes (0/O, 1/I).
create or replace function app.new_voucher_code()
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_bytes    bytea := decode(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'hex');
  v_out      text := '';
  i          integer;
begin
  for i in 0..11 loop
    v_out := v_out || substr(v_alphabet, (get_byte(v_bytes, i) % 32) + 1, 1);
  end loop;
  return substr(v_out, 1, 4) || '-' || substr(v_out, 5, 4) || '-' || substr(v_out, 9, 4);
end;
$$;

create or replace function app.normalize_voucher_code(p_code text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when char_length(c) = 12 then substr(c, 1, 4) || '-' || substr(c, 5, 4) || '-' || substr(c, 9, 4) else c end
  from (select upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g')) as c) x;
$$;

create or replace function app.issue_voucher(
  p_tenant uuid, p_kind text, p_amount numeric, p_customer uuid, p_appointment uuid,
  p_recipient text, p_invoice uuid, p_invoice_item uuid, p_days integer default 365
)
returns public.gift_vouchers
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.gift_vouchers%rowtype;
begin
  loop
    begin
      insert into public.gift_vouchers (tenant_id, code, kind, initial_amount, balance, customer_id, appointment_id,
                                        recipient_name, invoice_id, invoice_item_id, expires_at)
      values (p_tenant, app.new_voucher_code(), p_kind, p_amount, p_amount, p_customer, p_appointment,
              nullif(btrim(p_recipient), ''), p_invoice, p_invoice_item, now() + make_interval(days => p_days))
      returning * into v_row;
      exit;
    exception when unique_violation then
      -- astronomically rare code collision: try another code
    end;
  end loop;
  insert into public.voucher_transactions (tenant_id, voucher_id, kind, amount, invoice_id)
  values (p_tenant, v_row.id, 'issue', p_amount, p_invoice);
  return v_row;
end;
$$;

-- Active membership discount of a customer right now (0 if none).
create or replace function app.member_discount(p_customer uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(max(m.discount_percent), 0)
  from public.customer_memberships m
  where m.customer_id = p_customer and m.status = 'active' and now() between m.starts_at and m.ends_at;
$$;

-- ---------------------------------------------------------------------------
-- 6. POS RPCs, redefined with the new line kinds
-- ---------------------------------------------------------------------------
-- Line kinds in p_items:
--   service    { service_id, employee_id?, appointment_service_id?, quantity?, unit_price?, discount_amount?, customer_package_id? }
--              customer_package_id = pay with a package session (price 0)
--              members get their membership discount automatically
--   package    { package_id, quantity? }        (needs a customer)
--   membership { membership_id }                (needs a customer)
--   voucher    { unit_price, description?, appointment_id? }   gift voucher / booking deposit
--   custom     { description, unit_price, quantity?, discount_amount?, vat_category? }
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
  v_inv        public.invoices%rowtype;
  v_can_disc   boolean;
  v_member_pct numeric := 0;
  v_item       jsonb;
  v_ord        integer;
  v_kind       text;
  v_qty        numeric;
  v_unit       numeric;
  v_disc       numeric;
  v_disc_given boolean;
  v_list       numeric;
  v_svc        public.services%rowtype;
  v_pkg        public.packages%rowtype;
  v_mem        public.memberships%rowtype;
  v_aps        public.appointment_services%rowtype;
  v_emp        uuid;
  v_aps_id     uuid;
  v_cpkg       uuid;
  v_dep_appt   uuid;
  v_desc       text;
  v_desc_ar    text;
  v_vatcat     text;
  v_pct        numeric;
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
  if p_customer_id is not null then
    v_member_pct := app.member_discount(p_customer_id);
  end if;

  delete from public.invoice_items where invoice_id = p_invoice_id;

  for v_item, v_ord in select e.value, e.ord::integer from jsonb_array_elements(p_items) with ordinality as e(value, ord)
  loop
    begin
      v_kind := coalesce(v_item ->> 'kind',
                         case when v_item ? 'service_id' then 'service' when v_item ? 'package_id' then 'package'
                              when v_item ? 'membership_id' then 'membership' else 'custom' end);
      v_qty := coalesce((v_item ->> 'quantity')::numeric, 1);
      v_unit := (v_item ->> 'unit_price')::numeric;
      v_disc_given := coalesce((v_item ->> 'discount_amount')::numeric, 0) > 0;
      v_disc := coalesce((v_item ->> 'discount_amount')::numeric, 0);
      v_emp := nullif(v_item ->> 'employee_id', '')::uuid;
      v_aps_id := nullif(v_item ->> 'appointment_service_id', '')::uuid;
      v_cpkg := nullif(v_item ->> 'customer_package_id', '')::uuid;
      v_dep_appt := nullif(v_item ->> 'appointment_id', '')::uuid;
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
    v_pct := null;

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
      if v_cpkg is not null then
        -- Paid with a package session: the customer's own, active, unexpired
        -- package with enough sessions left (counting other lines of this cart).
        if p_customer_id is null or not exists (
             select 1 from public.customer_packages cp
             join public.customer_package_balances b on b.customer_package_id = cp.id and b.service_id = v_svc.id
             where cp.id = v_cpkg and cp.customer_id = p_customer_id and cp.status = 'active'
               and (cp.expires_at is null or cp.expires_at > now())
               and b.remaining_sessions >= v_qty + coalesce((
                     select sum(o.quantity) from public.invoice_items o
                     where o.invoice_id = p_invoice_id and o.customer_package_id = v_cpkg and o.service_id = v_svc.id), 0)) then
          perform app.raise('INSUFFICIENT_BALANCE', format('No %s sessions left in that package', v_svc.name_en));
        end if;
        if v_qty <> trunc(v_qty) then
          perform app.raise('INVALID_QUANTITY', 'Package sessions are whole numbers');
        end if;
        v_unit := 0;
        v_disc := 0;
      else
        v_unit := coalesce(v_unit, v_list);
        if not v_can_disc and v_svc.price_type <> 'variable'
           and (v_unit < v_list or (v_svc.price_type = 'fixed' and v_unit <> v_list)) then
          perform app.raise('PRICE_OVERRIDE_FORBIDDEN', format('Changing the price of %s needs discount permission', v_svc.name_en));
        end if;
        if not v_disc_given and v_member_pct > 0 then
          v_pct := v_member_pct;  -- membership discount: policy, no permission needed
          v_disc := round(round(v_qty * v_unit, 3) * v_member_pct / 100, 3);
        end if;
      end if;
      v_desc := v_svc.name_en;
      v_desc_ar := v_svc.name_ar;
      v_vatcat := v_svc.vat_category;
    elsif v_kind = 'package' then
      select * into v_pkg from public.packages p
      where p.id = (v_item ->> 'package_id')::uuid and p.tenant_id = v_inv.tenant_id and p.is_active;
      if not found then
        perform app.raise('INVALID_PACKAGE', format('Line %s: unknown or inactive package', v_ord));
      end if;
      if v_qty <> trunc(v_qty) or v_qty > 10 then
        perform app.raise('INVALID_QUANTITY', 'Sell between 1 and 10 packages per line');
      end if;
      v_list := v_pkg.price;
      v_unit := coalesce(v_unit, v_list);
      if not v_can_disc and v_unit <> v_list then
        perform app.raise('PRICE_OVERRIDE_FORBIDDEN', 'Changing a package price needs discount permission');
      end if;
      v_desc := v_pkg.name_en;
      v_desc_ar := v_pkg.name_ar;
      v_vatcat := v_pkg.vat_category;
      v_aps_id := null;
      v_cpkg := null;
    elsif v_kind = 'membership' then
      select * into v_mem from public.memberships m
      where m.id = (v_item ->> 'membership_id')::uuid and m.tenant_id = v_inv.tenant_id and m.is_active;
      if not found then
        perform app.raise('INVALID_MEMBERSHIP', format('Line %s: unknown or inactive membership', v_ord));
      end if;
      v_qty := 1;
      v_list := v_mem.price;
      v_unit := coalesce(v_unit, v_list);
      if not v_can_disc and v_unit <> v_list then
        perform app.raise('PRICE_OVERRIDE_FORBIDDEN', 'Changing a membership price needs discount permission');
      end if;
      v_desc := v_mem.name_en;
      v_desc_ar := v_mem.name_ar;
      v_vatcat := v_mem.vat_category;
      v_aps_id := null;
      v_cpkg := null;
    elsif v_kind = 'voucher' then
      -- Multi-purpose voucher / deposit: VAT is charged when it is spent, not when sold.
      if v_unit is null or v_unit <= 0 then
        perform app.raise('INVALID_PRICE', 'Enter the voucher amount');
      end if;
      if v_dep_appt is not null and not exists (select 1 from public.appointments a
                                                where a.id = v_dep_appt and a.tenant_id = v_inv.tenant_id
                                                  and a.status not in ('cancelled', 'no_show', 'completed')) then
        perform app.raise('INVALID_APPOINTMENT', 'Deposits can only be taken for upcoming appointments');
      end if;
      v_qty := 1;
      v_list := v_unit;
      v_desc := coalesce(nullif(btrim(v_item ->> 'description'), ''),
                         case when v_dep_appt is not null then 'Booking deposit' else 'Gift voucher' end);
      v_desc_ar := case when v_dep_appt is not null then 'عربون حجز' else 'قسيمة هدية' end;
      v_vatcat := 'exempt';
      v_aps_id := null;
      v_cpkg := null;
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
      v_cpkg := null;
    else
      perform app.raise('INVALID_ITEMS', format('Line %s: unknown line type', v_ord));
    end if;

    if v_disc_given and not v_can_disc then
      perform app.raise('DISCOUNT_FORBIDDEN', 'Discounts need discount permission');
    end if;
    if v_kind = 'voucher' and v_disc > 0 then
      perform app.raise('INVALID_DISCOUNT', 'Vouchers cannot be discounted');
    end if;
    if v_disc > round(v_qty * v_unit, 3) then
      perform app.raise('INVALID_DISCOUNT', format('Line %s: the discount is larger than the line', v_ord));
    end if;

    insert into public.invoice_items (tenant_id, invoice_id, sort_order, kind, service_id, employee_id, appointment_service_id,
                                      package_id, membership_id, customer_package_id, member_discount_percent, deposit_appointment_id,
                                      description_en, description_ar, quantity, list_price, unit_price, discount_amount,
                                      vat_category, vat_rate)
    values (v_inv.tenant_id, p_invoice_id, v_ord, v_kind, case when v_kind = 'service' then v_svc.id end,
            case when v_kind = 'service' then v_emp end, v_aps_id,
            case when v_kind = 'package' then v_pkg.id end, case when v_kind = 'membership' then v_mem.id end,
            v_cpkg, v_pct, case when v_kind = 'voucher' then v_dep_appt end,
            left(v_desc, 160), left(v_desc_ar, 160), v_qty, v_list, v_unit, v_disc,
            v_vatcat, app.vat_rate_for(v_inv.tenant_id, v_vatcat));
  end loop;

  update public.invoices set customer_id = p_customer_id, notes = nullif(btrim(p_notes), '') where id = p_invoice_id;
  perform app.recalc_invoice(p_invoice_id);
  return public.get_invoice(p_invoice_id);
end;
$$;

-- Post a draft; then, in the same transaction: redeem package sessions
-- (guarded), issue packages / memberships / vouchers that were sold.
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
  v_line     record;
  v_pkg      public.packages%rowtype;
  v_mem      public.memberships%rowtype;
  v_cp       uuid;
  v_appt     public.appointments%rowtype;
  v_now      timestamptz := now();
  i          integer;
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
  if v_inv.customer_id is null and exists (select 1 from public.invoice_items
                                           where invoice_id = p_invoice_id
                                             and (kind in ('package', 'membership') or customer_package_id is not null)) then
    perform app.raise('CUSTOMER_REQUIRED', 'Choose the customer for packages and memberships');
  end if;

  select * into v_settings from public.tenant_settings where tenant_id = v_inv.tenant_id;
  select * into v_tenant from public.tenants where id = v_inv.tenant_id;
  select * into v_branch from public.branches where id = v_inv.branch_id;
  select * into v_cust from public.customers where id = v_inv.customer_id;

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

  for v_line in select * from public.invoice_items where invoice_id = p_invoice_id order by sort_order loop
    if v_line.customer_package_id is not null then
      -- Guarded decrement: never below zero, even with two tills at once.
      update public.customer_package_balances b
      set remaining_sessions = b.remaining_sessions - v_line.quantity::integer
      from public.customer_packages cp
      where b.customer_package_id = v_line.customer_package_id and b.service_id = v_line.service_id
        and cp.id = b.customer_package_id and cp.customer_id = v_inv.customer_id and cp.status = 'active'
        and (cp.expires_at is null or cp.expires_at > v_now)
        and b.remaining_sessions >= v_line.quantity::integer;
      if not found then
        perform app.raise('INSUFFICIENT_BALANCE', format('No %s sessions left in that package', v_line.description_en));
      end if;
      insert into public.package_redemptions (tenant_id, customer_package_id, service_id, quantity, invoice_id, invoice_item_id)
      values (v_inv.tenant_id, v_line.customer_package_id, v_line.service_id, v_line.quantity::integer, p_invoice_id, v_line.id);
      update public.customer_packages cp set status = 'exhausted'
      where cp.id = v_line.customer_package_id
        and not exists (select 1 from public.customer_package_balances b where b.customer_package_id = cp.id and b.remaining_sessions > 0);
    elsif v_line.kind = 'package' then
      select * into v_pkg from public.packages where id = v_line.package_id;
      for i in 1..v_line.quantity::integer loop
        insert into public.customer_packages (tenant_id, customer_id, package_id, name_en, name_ar, invoice_id, invoice_item_id,
                                              purchased_at, expires_at)
        values (v_inv.tenant_id, v_inv.customer_id, v_pkg.id, v_pkg.name_en, v_pkg.name_ar, p_invoice_id, v_line.id, v_now,
                case when v_pkg.validity_days is not null then v_now + make_interval(days => v_pkg.validity_days) end)
        returning id into v_cp;
        insert into public.customer_package_balances (tenant_id, customer_package_id, service_id, total_sessions, remaining_sessions)
        select v_inv.tenant_id, v_cp, pi.service_id, pi.sessions, pi.sessions
        from public.package_items pi where pi.package_id = v_pkg.id;
      end loop;
    elsif v_line.kind = 'membership' then
      select * into v_mem from public.memberships where id = v_line.membership_id;
      insert into public.customer_memberships (tenant_id, customer_id, membership_id, name_en, name_ar, discount_percent,
                                               invoice_id, invoice_item_id, starts_at, ends_at)
      values (v_inv.tenant_id, v_inv.customer_id, v_mem.id, v_mem.name_en, v_mem.name_ar, v_mem.service_discount_percent,
              p_invoice_id, v_line.id, v_now, v_now + make_interval(days => v_mem.duration_days));
    elsif v_line.kind = 'voucher' then
      perform app.issue_voucher(v_inv.tenant_id,
                                case when v_line.deposit_appointment_id is not null then 'deposit' else 'gift' end,
                                v_line.total_amount, v_inv.customer_id, v_line.deposit_appointment_id,
                                null, p_invoice_id, v_line.id);
    end if;
  end loop;

  perform app.refresh_payment_status(p_invoice_id);

  if v_inv.appointment_id is not null then
    update public.appointments
    set status = 'completed', completed_at = coalesce(completed_at, v_now), checked_in_at = coalesce(checked_in_at, v_now)
    where id = v_inv.appointment_id and status in ('booked', 'confirmed', 'checked_in', 'in_service');
  end if;

  return public.get_invoice(p_invoice_id);
end;
$$;

-- Payments: + method 'voucher' (p_reference = voucher code), guarded balance.
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
  v_voucher public.gift_vouchers%rowtype;
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
  if p_method not in ('cash', 'card', 'bank_transfer', 'voucher', 'other') then
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
  elsif p_method = 'voucher' then
    -- Guarded decrement on the voucher balance (row lock + condition).
    update public.gift_vouchers g
    set balance = g.balance - p_amount
    where g.tenant_id = v_inv.tenant_id and g.code = app.normalize_voucher_code(p_reference)
      and g.status = 'active' and (g.expires_at is null or g.expires_at > now())
      and g.balance >= p_amount
      and g.invoice_id is distinct from p_invoice_id
    returning * into v_voucher;
    if not found then
      if exists (select 1 from public.gift_vouchers g where g.tenant_id = v_inv.tenant_id
                   and g.code = app.normalize_voucher_code(p_reference) and g.status = 'active'
                   and (g.expires_at is null or g.expires_at > now()) and g.invoice_id is distinct from p_invoice_id) then
        perform app.raise('INSUFFICIENT_BALANCE', 'The voucher balance is too low');
      end if;
      perform app.raise('INVALID_VOUCHER', 'Unknown, used up or expired voucher');
    end if;
  end if;

  insert into public.payments (tenant_id, branch_id, invoice_id, direction, method, amount, reference, cash_session_id,
                               voucher_id, idempotency_key)
  values (v_inv.tenant_id, v_inv.branch_id, p_invoice_id, 'in', p_method, p_amount,
          case when p_method = 'voucher' then v_voucher.code else nullif(btrim(p_reference), '') end,
          v_session, v_voucher.id, p_idempotency_key)
  returning id into v_id;
  if p_method = 'voucher' then
    insert into public.voucher_transactions (tenant_id, voucher_id, kind, amount, invoice_id, payment_id)
    values (v_inv.tenant_id, v_voucher.id, 'redeem', p_amount, p_invoice_id, v_id);
  end if;

  update public.invoices set paid_total = paid_total + p_amount where id = p_invoice_id;
  perform app.refresh_payment_status(p_invoice_id);
  select * into v_inv from public.invoices where id = p_invoice_id;
  return jsonb_build_object('payment_id', v_id, 'replayed', false, 'balance_due', app.invoice_balance(v_inv),
                            'payment_status', v_inv.payment_status, 'voucher_balance', v_voucher.balance);
end;
$$;

-- Credit notes: + reverse package redemptions, refuse to credit used
-- packages / vouchers, cancel memberships, refund as store credit ('voucher').
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
  v_credit  public.gift_vouchers%rowtype;
  v_cancel  integer;
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
  if p_refund_method is not null and p_refund_method not in ('cash', 'card', 'bank_transfer', 'voucher', 'other') then
    perform app.raise('INVALID_PAYMENT_METHOD', 'Unknown refund method');
  end if;

  insert into public.invoices (tenant_id, branch_id, kind, original_invoice_id, customer_id, currency_code,
                               prices_include_vat, vat_registered, reason, created_by, idempotency_key)
  values (v_inv.tenant_id, v_inv.branch_id, 'credit_note', v_inv.id, v_inv.customer_id, v_inv.currency_code,
          v_inv.prices_include_vat, v_inv.vat_registered, btrim(p_reason), v_uid, p_idempotency_key)
  returning id into v_id;

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

    -- Side effects of crediting this line.
    if v_line.customer_package_id is not null then
      -- Give the package sessions back.
      update public.customer_package_balances
      set remaining_sessions = remaining_sessions + v_qty::integer
      where customer_package_id = v_line.customer_package_id and service_id = v_line.service_id;
      update public.package_redemptions set reversed_at = v_now
      where invoice_item_id = v_line.id and reversed_at is null;
      update public.customer_packages set status = 'active' where id = v_line.customer_package_id and status = 'exhausted';
    elsif v_line.kind = 'package' then
      -- Only unused packages can be returned.
      with unused as (
        select cp.id from public.customer_packages cp
        where cp.invoice_item_id = v_line.id and cp.status = 'active'
          and not exists (select 1 from public.package_redemptions r where r.customer_package_id = cp.id and r.reversed_at is null)
        order by cp.created_at
        limit v_qty::integer
      )
      update public.customer_packages cp set status = 'cancelled' from unused where cp.id = unused.id;
      get diagnostics v_cancel = row_count;
      if v_cancel < v_qty::integer then
        perform app.raise('PACKAGE_IN_USE', 'Sessions of this package were already used — credit only unused packages');
      end if;
    elsif v_line.kind = 'membership' then
      update public.customer_memberships set status = 'cancelled' where invoice_item_id = v_line.id and status = 'active';
    elsif v_line.kind = 'voucher' then
      update public.gift_vouchers g set status = 'void', balance = 0
      where g.invoice_item_id = v_line.id and g.status = 'active' and g.balance = g.initial_amount
      returning * into v_credit;
      if not found then
        perform app.raise('VOUCHER_IN_USE', 'This voucher was already (partly) used and cannot be credited');
      end if;
      insert into public.voucher_transactions (tenant_id, voucher_id, kind, amount, invoice_id)
      values (v_inv.tenant_id, v_credit.id, 'void', v_credit.initial_amount, v_id);
      v_credit := null;
    end if;

    v_ord := v_ord + 1;
    insert into public.invoice_items (tenant_id, invoice_id, sort_order, kind, service_id, employee_id, original_item_id,
                                      package_id, membership_id, customer_package_id, member_discount_percent,
                                      description_en, description_ar, quantity, list_price, unit_price, discount_amount,
                                      vat_category, vat_rate)
    values (v_inv.tenant_id, v_id, v_ord, v_line.kind, v_line.service_id, v_line.employee_id, v_line.id,
            v_line.package_id, v_line.membership_id, v_line.customer_package_id, v_line.member_discount_percent,
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
    elsif p_refund_method = 'voucher' then
      v_credit := app.issue_voucher(v_inv.tenant_id, 'store_credit', v_refund, v_inv.customer_id, null, null, v_id, null);
    end if;
    insert into public.payments (tenant_id, branch_id, invoice_id, direction, method, amount, cash_session_id, voucher_id, reference)
    values (v_inv.tenant_id, v_inv.branch_id, v_id, 'out', p_refund_method, v_refund, v_session, v_credit.id, v_credit.code);
    update public.invoices set paid_total = v_refund where id = v_id;
    update public.invoices set refunded_total = refunded_total + v_refund where id = p_invoice_id;
  end if;
  perform app.refresh_payment_status(p_invoice_id);
  update public.invoices set payment_status = 'paid' where id = v_id;

  return jsonb_build_object('credit_note_id', v_id, 'replayed', false, 'number', v_cn.number,
                            'total', v_cn.total, 'refunded', v_refund, 'store_credit_code', v_credit.code);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Wallet & catalogue RPCs
-- ---------------------------------------------------------------------------
-- What a customer holds: packages with balances, membership, vouchers
-- (incl. deposits for their appointments).
create or replace function public.get_customer_wallet(p_customer_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant uuid;
begin
  perform app.require_user();
  select c.tenant_id into v_tenant from public.customers c where c.id = p_customer_id;
  if not found or not exists (select 1 from app.tenants_with_any_permission(app.wallet_reader_permissions() || array['customers.view']) x
                              where x = v_tenant) then
    perform app.raise('NOT_FOUND', 'Customer not found');
  end if;
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
                   -- codes only for people who can take payments with them
                   'code', case when app.has_permission(v_tenant, 'pos.access') then g.code end)
                 order by g.created_at), '[]'::jsonb)
                 from public.gift_vouchers g
                 where g.tenant_id = v_tenant and g.status = 'active' and g.balance > 0
                   and (g.expires_at is null or g.expires_at > now())
                   and (g.customer_id = p_customer_id
                        or g.appointment_id in (select a.id from public.appointments a where a.customer_id = p_customer_id))));
end;
$$;

-- Check a voucher code at the till.
create or replace function public.lookup_voucher(p_tenant uuid, p_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_g public.gift_vouchers%rowtype;
begin
  perform app.require_permission(p_tenant, 'pos.access');
  select * into v_g from public.gift_vouchers g where g.tenant_id = p_tenant and g.code = app.normalize_voucher_code(p_code);
  if not found then
    perform app.raise('INVALID_VOUCHER', 'Unknown voucher');
  end if;
  return jsonb_build_object('code', v_g.code, 'kind', v_g.kind, 'balance', v_g.balance, 'initial_amount', v_g.initial_amount,
                            'status', case when v_g.status = 'void' then 'void'
                                           when v_g.expires_at is not null and v_g.expires_at <= now() then 'expired'
                                           when v_g.balance = 0 then 'used' else 'active' end,
                            'expires_at', v_g.expires_at);
end;
$$;

-- Replace the services of a package atomically. p_items: [{ service_id, sessions }]
create or replace function public.set_package_items(p_package_id uuid, p_items jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant uuid;
begin
  perform app.require_user();
  select p.tenant_id into v_tenant from public.packages p where p.id = p_package_id;
  if not found or not app.is_tenant_member(v_tenant) then
    perform app.raise('NOT_FOUND', 'Package not found');
  end if;
  perform app.require_permission(v_tenant, 'packages.manage');
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 50 then
    perform app.raise('INVALID_ITEMS', 'A package needs between 1 and 50 services');
  end if;
  begin
    if exists (select 1 from jsonb_array_elements(p_items) e
               where (e ->> 'sessions')::integer not between 1 and 500
                  or not exists (select 1 from public.services s where s.id = (e ->> 'service_id')::uuid and s.tenant_id = v_tenant)) then
      perform app.raise('INVALID_ITEMS', 'Each service must exist and have 1–500 sessions');
    end if;
  exception when invalid_text_representation or numeric_value_out_of_range then
    perform app.raise('INVALID_ITEMS', 'Each line needs a service_id and a number of sessions');
  end;
  delete from public.package_items where package_id = p_package_id;
  insert into public.package_items (tenant_id, package_id, service_id, sessions)
  select v_tenant, p_package_id, (e ->> 'service_id')::uuid, sum((e ->> 'sessions')::integer)
  from jsonb_array_elements(p_items) e
  group by (e ->> 'service_id')::uuid;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Execute privileges
-- ---------------------------------------------------------------------------
revoke all on function
  app.wallet_reader_permissions(), app.new_voucher_code(), app.normalize_voucher_code(text),
  app.issue_voucher(uuid, text, numeric, uuid, uuid, text, uuid, uuid, integer), app.member_discount(uuid)
from public;
grant execute on function app.wallet_reader_permissions() to authenticated, service_role;

revoke all on function
  public.get_customer_wallet(uuid),
  public.lookup_voucher(uuid, text),
  public.set_package_items(uuid, jsonb)
from public, anon;
grant execute on function
  public.get_customer_wallet(uuid),
  public.lookup_voucher(uuid, text),
  public.set_package_items(uuid, jsonb)
to authenticated, service_role;

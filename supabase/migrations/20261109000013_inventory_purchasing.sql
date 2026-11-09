-- =============================================================================
-- Salonzoft · Migration 0013 · Inventory, purchasing, retail & consumables
-- -----------------------------------------------------------------------------
-- * products: retail items, salon consumables, or both.
-- * inventory_movements: APPEND-ONLY ledger (signed quantity, unit cost,
--   reason, source document). inventory_balances (quantity + weighted average
--   cost per branch) is maintained in the same transaction under a row lock
--   by app.stock_move — the only writer. Stock can't go negative unless the
--   tenant allows it; salon consumption never blocks a checkout (a shortfall
--   shows as negative stock to correct with a count).
-- * Purchasing: suppliers, purchase orders (gap-free PO numbers), partial
--   receipts that move stock in and update the average cost.
-- * POS: invoice line kind 'product'. Stock moves are attached by a trigger
--   when an invoice / credit note is POSTED, so they share its transaction:
--   a stock error rolls back the whole checkout (and its number).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Settings
-- ---------------------------------------------------------------------------
alter table public.tenant_settings add column allow_negative_stock boolean not null default false;
grant update (allow_negative_stock) on public.tenant_settings to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Catalogue
-- ---------------------------------------------------------------------------
create table public.products (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants (id) on delete cascade,
  sku             text check (sku ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$'),
  barcode         text check (barcode ~ '^[0-9A-Za-z-]{4,40}$'),
  name_en         text not null check (char_length(btrim(name_en)) between 2 and 120),
  name_ar         text check (char_length(name_ar) <= 120),
  brand           text check (char_length(brand) <= 80),
  kind            text not null default 'retail' check (kind in ('retail', 'consumable', 'both')),
  unit            text not null default 'pcs' check (unit in ('pcs', 'ml', 'g', 'l', 'kg', 'box', 'set')),
  sale_price      numeric(12,3) not null default 0 check (sale_price >= 0),
  cost_price      numeric(12,3) not null default 0 check (cost_price >= 0),  -- default / last purchase cost
  vat_category    text not null default 'standard' check (vat_category in ('standard', 'zero', 'exempt')),
  reorder_level   numeric(14,3) not null default 0 check (reorder_level >= 0),
  track_stock     boolean not null default true,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (id, tenant_id)
);
create unique index products_sku_idx on public.products (tenant_id, lower(sku)) where sku is not null;
create unique index products_barcode_idx on public.products (tenant_id, barcode) where barcode is not null;
create index products_tenant_idx on public.products (tenant_id, is_active, name_en);
create trigger products_updated_at before update on public.products for each row execute function app.set_updated_at();

-- How much of a product a service uses (e.g. 30 ml colour per root touch-up).
create table public.service_product_usage (
  tenant_id   uuid not null,
  service_id  uuid not null,
  product_id  uuid not null,
  quantity    numeric(14,3) not null check (quantity > 0),
  primary key (service_id, product_id),
  foreign key (service_id, tenant_id) references public.services (id, tenant_id) on delete cascade,
  foreign key (product_id, tenant_id) references public.products (id, tenant_id) on delete cascade
);
create index service_product_usage_product_idx on public.service_product_usage (product_id);
create index service_product_usage_tenant_idx on public.service_product_usage (tenant_id);

create table public.suppliers (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants (id) on delete cascade,
  name          text not null check (char_length(btrim(name)) between 2 and 120),
  contact_name  text check (char_length(contact_name) <= 120),
  phone         text check (phone ~ '^\+?[0-9]{6,15}$'),
  email         text check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  vat_number    text check (vat_number ~ '^[A-Z0-9]{5,20}$'),
  notes         text check (char_length(notes) <= 500),
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (id, tenant_id)
);
create index suppliers_tenant_idx on public.suppliers (tenant_id, is_active, name);
create trigger suppliers_updated_at before update on public.suppliers for each row execute function app.set_updated_at();

-- ---------------------------------------------------------------------------
-- 3. Stock
-- ---------------------------------------------------------------------------
create table public.inventory_balances (
  tenant_id   uuid not null,
  branch_id   uuid not null,
  product_id  uuid not null,
  quantity    numeric(14,3) not null default 0,
  avg_cost    numeric(14,4) not null default 0 check (avg_cost >= 0),
  updated_at  timestamptz not null default now(),
  primary key (branch_id, product_id),
  foreign key (branch_id, tenant_id) references public.branches (id, tenant_id) on delete cascade,
  foreign key (product_id, tenant_id) references public.products (id, tenant_id) on delete cascade
);
create index inventory_balances_product_idx on public.inventory_balances (product_id);
create index inventory_balances_tenant_idx on public.inventory_balances (tenant_id);

create table public.inventory_movements (
  id             bigint generated always as identity primary key,
  tenant_id      uuid not null,
  branch_id      uuid not null,
  product_id     uuid not null,
  quantity       numeric(14,3) not null check (quantity <> 0),  -- + in, − out
  unit_cost      numeric(14,4) not null check (unit_cost >= 0),
  reason         text not null check (reason in ('opening', 'purchase', 'sale', 'sale_return', 'consumption',
                                                 'adjustment', 'transfer_out', 'transfer_in')),
  source_type    text check (source_type in ('invoice', 'credit_note', 'purchase_receipt', 'adjustment', 'transfer')),
  source_id      uuid,
  source_line_id uuid,
  balance_after  numeric(14,3) not null,
  note           text check (char_length(note) <= 300),
  created_by     uuid default auth.uid() references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  foreign key (branch_id, tenant_id) references public.branches (id, tenant_id) on delete cascade,
  foreign key (product_id, tenant_id) references public.products (id, tenant_id) on delete cascade
);
create index inventory_movements_product_idx on public.inventory_movements (product_id, branch_id, created_at desc);
create index inventory_movements_source_idx on public.inventory_movements (source_type, source_id);
create index inventory_movements_tenant_idx on public.inventory_movements (tenant_id, created_at desc);

create or replace function app.inventory_movements_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and not exists (select 1 from public.products p where p.id = old.product_id) then
    return old;  -- cascade from a deleted tenant / product
  end if;
  perform app.raise('MOVEMENT_IMMUTABLE', 'Stock movements cannot be changed — post a correcting movement');
  return null;
end;
$$;
create trigger inventory_movements_immutable before update or delete on public.inventory_movements
  for each row execute function app.inventory_movements_immutable();

-- ---------------------------------------------------------------------------
-- 4. Purchasing
-- ---------------------------------------------------------------------------
alter table public.invoice_sequences drop constraint invoice_sequences_series_check;
alter table public.invoice_sequences add constraint invoice_sequences_series_check
  check (series in ('invoice', 'credit_note', 'purchase_order'));

create table public.purchase_orders (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null,
  branch_id     uuid not null,
  supplier_id   uuid not null,
  number        text,
  status        text not null default 'draft'
                check (status in ('draft', 'ordered', 'partially_received', 'received', 'cancelled')),
  ordered_at    timestamptz,
  expected_on   date,
  notes         text check (char_length(notes) <= 500),
  total_cost    numeric(14,3) not null default 0,
  created_by    uuid default auth.uid() references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (id, tenant_id),
  unique (tenant_id, number),
  constraint purchase_orders_numbered check (status = 'draft' or status = 'cancelled' or number is not null),
  foreign key (branch_id, tenant_id) references public.branches (id, tenant_id) on delete cascade,
  foreign key (supplier_id, tenant_id) references public.suppliers (id, tenant_id)
);
create index purchase_orders_tenant_idx on public.purchase_orders (tenant_id, created_at desc);
create index purchase_orders_supplier_idx on public.purchase_orders (supplier_id);
create index purchase_orders_branch_idx on public.purchase_orders (branch_id, status);
create trigger purchase_orders_updated_at before update on public.purchase_orders for each row execute function app.set_updated_at();

create table public.purchase_order_items (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null,
  purchase_order_id  uuid not null,
  product_id         uuid not null,
  sort_order         smallint not null default 1,
  quantity           numeric(14,3) not null check (quantity > 0),
  unit_cost          numeric(12,3) not null check (unit_cost >= 0),
  received_quantity  numeric(14,3) not null default 0 check (received_quantity >= 0),
  constraint purchase_order_items_received check (received_quantity <= quantity),
  foreign key (purchase_order_id, tenant_id) references public.purchase_orders (id, tenant_id) on delete cascade,
  foreign key (product_id, tenant_id) references public.products (id, tenant_id)
);
create index purchase_order_items_po_idx on public.purchase_order_items (purchase_order_id, sort_order);
create index purchase_order_items_product_idx on public.purchase_order_items (product_id);
create index purchase_order_items_tenant_idx on public.purchase_order_items (tenant_id);

create table public.purchase_receipts (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null,
  branch_id          uuid not null,
  purchase_order_id  uuid not null,
  supplier_reference text check (char_length(supplier_reference) <= 80),  -- supplier invoice / delivery note
  note               text check (char_length(note) <= 300),
  total_cost         numeric(14,3) not null default 0,
  idempotency_key    text check (char_length(idempotency_key) <= 100),
  received_by        uuid default auth.uid() references auth.users (id) on delete set null,
  received_at        timestamptz not null default now(),
  unique (tenant_id, idempotency_key),
  foreign key (purchase_order_id, tenant_id) references public.purchase_orders (id, tenant_id) on delete cascade,
  foreign key (branch_id, tenant_id) references public.branches (id, tenant_id) on delete cascade
);
create index purchase_receipts_po_idx on public.purchase_receipts (purchase_order_id);
create index purchase_receipts_tenant_idx on public.purchase_receipts (tenant_id);

-- ---------------------------------------------------------------------------
-- 5. POS: product lines
-- ---------------------------------------------------------------------------
alter table public.invoice_items drop constraint invoice_items_kind_check;
alter table public.invoice_items add constraint invoice_items_kind_check
  check (kind in ('service', 'custom', 'package', 'membership', 'voucher', 'product'));
alter table public.invoice_items
  add column product_id uuid,
  add constraint invoice_items_product_fk foreign key (product_id, tenant_id) references public.products (id, tenant_id),
  add constraint invoice_items_product_line check ((kind = 'product') = (product_id is not null));
create index invoice_items_product_idx on public.invoice_items (product_id);

-- ---------------------------------------------------------------------------
-- 6. RLS + grants
-- ---------------------------------------------------------------------------
alter table public.products               enable row level security;
alter table public.service_product_usage  enable row level security;
alter table public.suppliers              enable row level security;
alter table public.inventory_balances     enable row level security;
alter table public.inventory_movements    enable row level security;
alter table public.purchase_orders        enable row level security;
alter table public.purchase_order_items   enable row level security;
alter table public.purchase_receipts      enable row level security;

revoke all on public.products, public.service_product_usage, public.suppliers, public.inventory_balances,
              public.inventory_movements, public.purchase_orders, public.purchase_order_items, public.purchase_receipts
  from anon, authenticated;
grant all on public.products, public.service_product_usage, public.suppliers, public.inventory_balances,
             public.inventory_movements, public.purchase_orders, public.purchase_order_items, public.purchase_receipts
  to service_role;

create or replace function app.stock_reader_permissions()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['inventory.view', 'inventory.manage', 'purchases.manage', 'pos.access', 'reports.financial']::text[];
$$;

-- Products: sellers and stock people read; inventory.manage writes.
grant select on public.products, public.service_product_usage to authenticated;
grant insert (tenant_id, sku, barcode, name_en, name_ar, brand, kind, unit, sale_price, cost_price, vat_category,
              reorder_level, track_stock, is_active) on public.products to authenticated;
grant update (sku, barcode, name_en, name_ar, brand, kind, unit, sale_price, cost_price, vat_category,
              reorder_level, track_stock, is_active) on public.products to authenticated;
create policy products_select on public.products for select to authenticated
  using (tenant_id in (select app.tenants_with_any_permission(app.stock_reader_permissions())));
create policy products_insert on public.products for insert to authenticated
  with check (tenant_id in (select app.tenants_with_permission('inventory.manage')));
create policy products_update on public.products for update to authenticated
  using (tenant_id in (select app.tenants_with_permission('inventory.manage')))
  with check (tenant_id in (select app.tenants_with_permission('inventory.manage')));
create policy service_product_usage_select on public.service_product_usage for select to authenticated
  using (tenant_id in (select app.tenants_with_any_permission(app.stock_reader_permissions() || array['services.manage'])));

-- Suppliers: purchasing.
grant select on public.suppliers to authenticated;
grant insert (tenant_id, name, contact_name, phone, email, vat_number, notes, is_active) on public.suppliers to authenticated;
grant update (name, contact_name, phone, email, vat_number, notes, is_active) on public.suppliers to authenticated;
create policy suppliers_select on public.suppliers for select to authenticated
  using (tenant_id in (select app.tenants_with_any_permission(array['purchases.manage', 'inventory.view', 'inventory.manage', 'finance.view'])));
create policy suppliers_insert on public.suppliers for insert to authenticated
  with check (tenant_id in (select app.tenants_with_permission('purchases.manage')));
create policy suppliers_update on public.suppliers for update to authenticated
  using (tenant_id in (select app.tenants_with_permission('purchases.manage')))
  with check (tenant_id in (select app.tenants_with_permission('purchases.manage')));

-- Stock and purchase documents: read-only (writes through RPCs), branch-scoped.
grant select on public.inventory_balances, public.inventory_movements, public.purchase_orders,
                public.purchase_order_items, public.purchase_receipts to authenticated;
create policy inventory_balances_select on public.inventory_balances for select to authenticated
  using (branch_id in (select app.branch_ids_with_any_permission(app.stock_reader_permissions())));
create policy inventory_movements_select on public.inventory_movements for select to authenticated
  using (branch_id in (select app.branch_ids_with_any_permission(array['inventory.view', 'inventory.manage', 'purchases.manage', 'reports.financial'])));
create policy purchase_orders_select on public.purchase_orders for select to authenticated
  using (branch_id in (select app.branch_ids_with_any_permission(array['purchases.manage', 'inventory.view', 'inventory.manage', 'finance.view'])));
create policy purchase_order_items_select on public.purchase_order_items for select to authenticated
  using (purchase_order_id in (select po.id from public.purchase_orders po));
create policy purchase_receipts_select on public.purchase_receipts for select to authenticated
  using (purchase_order_id in (select po.id from public.purchase_orders po));

create trigger audit_products after insert or update on public.products for each row execute function app.audit_row();
create trigger audit_suppliers after insert or update on public.suppliers for each row execute function app.audit_row();
create trigger audit_purchase_orders after insert or update on public.purchase_orders for each row execute function app.audit_row();

-- ---------------------------------------------------------------------------
-- 7. The stock engine
-- ---------------------------------------------------------------------------
-- The ONLY writer of inventory_balances. Locks the balance row, enforces the
-- non-negative rule (unless allowed), keeps a weighted average cost on
-- receipts, and appends the movement. Returns the movement's unit cost.
create or replace function app.stock_move(
  p_tenant uuid,
  p_branch uuid,
  p_product uuid,
  p_quantity numeric,
  p_reason text,
  p_source_type text,
  p_source_id uuid,
  p_source_line uuid default null,
  p_unit_cost numeric default null,   -- for stock coming in; null = current average
  p_force_allow_negative boolean default false,
  p_note text default null
)
returns numeric
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_product public.products%rowtype;
  v_bal     public.inventory_balances%rowtype;
  v_allow   boolean;
  v_cost    numeric;
  v_new_qty numeric;
  v_new_avg numeric;
begin
  select * into v_product from public.products where id = p_product and tenant_id = p_tenant;
  if not found then
    perform app.raise('INVALID_PRODUCT', 'Unknown product');
  end if;
  if not v_product.track_stock or p_quantity = 0 then
    return coalesce(p_unit_cost, v_product.cost_price);
  end if;

  insert into public.inventory_balances (tenant_id, branch_id, product_id, avg_cost)
  values (p_tenant, p_branch, p_product, v_product.cost_price)
  on conflict (branch_id, product_id) do nothing;
  select * into v_bal from public.inventory_balances where branch_id = p_branch and product_id = p_product for update;

  v_new_qty := v_bal.quantity + p_quantity;
  if p_quantity < 0 and v_new_qty < 0 then
    select s.allow_negative_stock into v_allow from public.tenant_settings s where s.tenant_id = p_tenant;
    if not (v_allow or p_force_allow_negative) then
      perform app.raise('INSUFFICIENT_STOCK',
                        format('Only %s %s of %s in stock', trim_scale(v_bal.quantity), v_product.unit, v_product.name_en));
    end if;
  end if;

  if p_quantity > 0 and p_unit_cost is not null then
    v_cost := p_unit_cost;
    -- Weighted average over what is physically there (negative stock counts as zero).
    v_new_avg := case when v_bal.quantity <= 0 then p_unit_cost
                      else (v_bal.quantity * v_bal.avg_cost + p_quantity * p_unit_cost) / v_new_qty end;
  else
    v_cost := v_bal.avg_cost;
    v_new_avg := v_bal.avg_cost;
  end if;

  update public.inventory_balances
  set quantity = v_new_qty, avg_cost = round(v_new_avg, 4), updated_at = now()
  where branch_id = p_branch and product_id = p_product;

  insert into public.inventory_movements (tenant_id, branch_id, product_id, quantity, unit_cost, reason, source_type,
                                          source_id, source_line_id, balance_after, note)
  values (p_tenant, p_branch, p_product, p_quantity, round(v_cost, 4), p_reason, p_source_type,
          p_source_id, p_source_line, v_new_qty, nullif(btrim(p_note), ''));
  return v_cost;
end;
$$;

-- Stock effects of posting an invoice or a credit note (same transaction).
--   invoice:     product lines leave stock (sale; blocked if not enough),
--                services consume their products (never blocks).
--   credit note: product lines come back at the cost they left with.
create or replace function app.invoices_post_stock()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_line record;
  v_cost numeric;
begin
  if new.kind = 'invoice' then
    for v_line in select * from public.invoice_items where invoice_id = new.id and kind = 'product' order by sort_order loop
      perform app.stock_move(new.tenant_id, new.branch_id, v_line.product_id, -v_line.quantity, 'sale',
                             'invoice', new.id, v_line.id);
    end loop;
    for v_line in
      select it.id, u.product_id, u.quantity * it.quantity as qty
      from public.invoice_items it
      join public.service_product_usage u on u.service_id = it.service_id
      where it.invoice_id = new.id and it.kind = 'service'
    loop
      perform app.stock_move(new.tenant_id, new.branch_id, v_line.product_id, -v_line.qty, 'consumption',
                             'invoice', new.id, v_line.id, null, true);
    end loop;
  else
    for v_line in
      select it.*, o.id as original_line
      from public.invoice_items it join public.invoice_items o on o.id = it.original_item_id
      where it.invoice_id = new.id and it.kind = 'product'
    loop
      select m.unit_cost into v_cost from public.inventory_movements m
      where m.source_line_id = v_line.original_line and m.reason = 'sale' order by m.id limit 1;
      perform app.stock_move(new.tenant_id, new.branch_id, v_line.product_id, v_line.quantity, 'sale_return',
                             'credit_note', new.id, v_line.id, v_cost);
    end loop;
  end if;
  return null;
end;
$$;
create trigger invoices_post_stock after update of status on public.invoices
  for each row when (old.status = 'draft' and new.status = 'posted')
  execute function app.invoices_post_stock();

-- ---------------------------------------------------------------------------
-- 8. POS cart pricing: + product lines
-- ---------------------------------------------------------------------------
-- Same as migration 0012 plus kind 'product' { product_id, quantity?, unit_price?, discount_amount? }.
-- Stock is checked here (friendly early error) and enforced when posting.
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
  v_allow_neg  boolean;
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
  v_prod       public.products%rowtype;
  v_aps        public.appointment_services%rowtype;
  v_emp        uuid;
  v_aps_id     uuid;
  v_cpkg       uuid;
  v_dep_appt   uuid;
  v_desc       text;
  v_desc_ar    text;
  v_vatcat     text;
  v_pct        numeric;
  v_stock      numeric;
begin
  v_inv := app.lock_invoice(p_invoice_id);
  if v_inv.status <> 'draft' or v_inv.kind <> 'invoice' then
    perform app.raise('INVOICE_NOT_DRAFT', 'Only draft invoices can be edited');
  end if;
  v_can_disc := app.has_permission(v_inv.tenant_id, 'pos.discount');
  select s.allow_negative_stock into v_allow_neg from public.tenant_settings s where s.tenant_id = v_inv.tenant_id;
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
                              when v_item ? 'membership_id' then 'membership' when v_item ? 'product_id' then 'product'
                              else 'custom' end);
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
          v_pct := v_member_pct;
          v_disc := round(round(v_qty * v_unit, 3) * v_member_pct / 100, 3);
        end if;
      end if;
      v_desc := v_svc.name_en;
      v_desc_ar := v_svc.name_ar;
      v_vatcat := v_svc.vat_category;
    elsif v_kind = 'product' then
      select * into v_prod from public.products p
      where p.id = (v_item ->> 'product_id')::uuid and p.tenant_id = v_inv.tenant_id and p.is_active and p.kind in ('retail', 'both');
      if not found then
        perform app.raise('INVALID_PRODUCT', format('Line %s: unknown product or not for sale', v_ord));
      end if;
      if v_prod.track_stock and not coalesce(v_allow_neg, false) then
        select coalesce(b.quantity, 0) into v_stock from public.inventory_balances b
        where b.branch_id = v_inv.branch_id and b.product_id = v_prod.id;
        if coalesce(v_stock, 0) < v_qty + coalesce((select sum(o.quantity) from public.invoice_items o
                                                    where o.invoice_id = p_invoice_id and o.product_id = v_prod.id), 0) then
          perform app.raise('INSUFFICIENT_STOCK', format('Only %s of %s in stock', trim_scale(coalesce(v_stock, 0)), v_prod.name_en));
        end if;
      end if;
      v_list := v_prod.sale_price;
      v_unit := coalesce(v_unit, v_list);
      if not v_can_disc and v_unit <> v_list then
        perform app.raise('PRICE_OVERRIDE_FORBIDDEN', format('Changing the price of %s needs discount permission', v_prod.name_en));
      end if;
      v_desc := v_prod.name_en;
      v_desc_ar := v_prod.name_ar;
      v_vatcat := v_prod.vat_category;
      v_aps_id := null;
      v_cpkg := null;
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

    insert into public.invoice_items (tenant_id, invoice_id, sort_order, kind, service_id, product_id, employee_id,
                                      appointment_service_id, package_id, membership_id, customer_package_id,
                                      member_discount_percent, deposit_appointment_id,
                                      description_en, description_ar, quantity, list_price, unit_price, discount_amount,
                                      vat_category, vat_rate)
    values (v_inv.tenant_id, p_invoice_id, v_ord, v_kind, case when v_kind = 'service' then v_svc.id end,
            case when v_kind = 'product' then v_prod.id end,
            case when v_kind in ('service', 'product') then v_emp end, v_aps_id,
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

-- Credit notes copy the line kind; carry product_id across too.
create or replace function app.credit_note_product_link()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.original_item_id is not null and new.kind = 'product' and new.product_id is null then
    select o.product_id into new.product_id from public.invoice_items o where o.id = new.original_item_id;
  end if;
  return new;
end;
$$;
create trigger invoice_items_credit_product before insert on public.invoice_items
  for each row execute function app.credit_note_product_link();

-- ---------------------------------------------------------------------------
-- 9. Document numbers: + purchase orders
-- ---------------------------------------------------------------------------
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

  number := format('%s-%s-%s-%s',
                   case p_series when 'credit_note' then 'CN' when 'purchase_order' then 'PO' else v_prefix end,
                   v_code, v_year, lpad(v_seq::text, 6, '0'));
  sequence_no := v_seq;
  return next;
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. RPCs
-- ---------------------------------------------------------------------------
-- Stock count / correction. p_items: [{ product_id, counted?: n, delta?: n, unit_cost?: n }]
--   counted → set the quantity to what was counted; delta → add / remove.
--   A positive correction may carry a unit cost (opening stock).
create or replace function public.adjust_stock(p_branch_id uuid, p_items jsonb, p_note text default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant  uuid;
  v_item    jsonb;
  v_product uuid;
  v_current numeric;
  v_delta   numeric;
  v_cost    numeric;
  v_doc     uuid := gen_random_uuid();
  v_count   integer := 0;
  v_reason  text;
begin
  perform app.require_user();
  select b.tenant_id into v_tenant from public.branches b where b.id = p_branch_id;
  if not found then
    perform app.raise('INVALID_BRANCH', 'Unknown branch');
  end if;
  perform app.assert_pos(v_tenant, p_branch_id, 'inventory.manage');
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 500 then
    perform app.raise('INVALID_ITEMS', 'Provide between 1 and 500 products');
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    begin
      v_product := (v_item ->> 'product_id')::uuid;
      v_cost := (v_item ->> 'unit_cost')::numeric;
      select coalesce(b.quantity, 0) into v_current from public.inventory_balances b
      where b.branch_id = p_branch_id and b.product_id = v_product;
      v_current := coalesce(v_current, 0);
      if v_item ? 'counted' then
        v_delta := (v_item ->> 'counted')::numeric - v_current;
        if (v_item ->> 'counted')::numeric < 0 then
          perform app.raise('INVALID_QUANTITY', 'Counted quantity cannot be negative');
        end if;
      else
        v_delta := (v_item ->> 'delta')::numeric;
      end if;
    exception when invalid_text_representation or numeric_value_out_of_range then
      perform app.raise('INVALID_ITEMS', 'Each line needs a product_id and a counted quantity or a delta');
    end;
    if v_delta is null or v_cost < 0 then
      perform app.raise('INVALID_ITEMS', 'Each line needs a product_id and a counted quantity or a delta');
    end if;
    continue when v_delta = 0;
    v_reason := case when v_current = 0 and not exists (select 1 from public.inventory_movements m
                                                         where m.branch_id = p_branch_id and m.product_id = v_product)
                     then 'opening' else 'adjustment' end;
    perform app.stock_move(v_tenant, p_branch_id, v_product, v_delta, v_reason, 'adjustment', v_doc, null,
                           case when v_delta > 0 then v_cost end, false, p_note);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- Move stock between two branches the caller can access (at the source's average cost).
create or replace function public.transfer_stock(p_from_branch uuid, p_to_branch uuid, p_items jsonb, p_note text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant uuid;
  v_item   jsonb;
  v_qty    numeric;
  v_cost   numeric;
  v_doc    uuid := gen_random_uuid();
begin
  perform app.require_user();
  select b.tenant_id into v_tenant from public.branches b where b.id = p_from_branch;
  if not found or not exists (select 1 from public.branches b where b.id = p_to_branch and b.tenant_id = v_tenant)
     or p_from_branch = p_to_branch then
    perform app.raise('INVALID_BRANCH', 'Choose two different branches of the business');
  end if;
  perform app.assert_pos(v_tenant, p_from_branch, 'inventory.manage');
  perform app.assert_pos(v_tenant, p_to_branch, 'inventory.manage');
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 200 then
    perform app.raise('INVALID_ITEMS', 'Provide between 1 and 200 products');
  end if;
  for v_item in select * from jsonb_array_elements(p_items) loop
    begin
      v_qty := (v_item ->> 'quantity')::numeric;
    exception when others then
      perform app.raise('INVALID_ITEMS', 'Each line needs a product_id and a quantity');
    end;
    if v_qty is null or v_qty <= 0 then
      perform app.raise('INVALID_QUANTITY', 'Quantities must be positive');
    end if;
    v_cost := app.stock_move(v_tenant, p_from_branch, (v_item ->> 'product_id')::uuid, -v_qty, 'transfer_out', 'transfer', v_doc, null, null, false, p_note);
    perform app.stock_move(v_tenant, p_to_branch, (v_item ->> 'product_id')::uuid, v_qty, 'transfer_in', 'transfer', v_doc, null, v_cost, false, p_note);
  end loop;
  return v_doc;
end;
$$;

-- Products a service uses. p_items: [{ product_id, quantity }]
create or replace function public.set_service_product_usage(p_service_id uuid, p_items jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant uuid;
begin
  perform app.require_user();
  select s.tenant_id into v_tenant from public.services s where s.id = p_service_id;
  if not found or not app.is_tenant_member(v_tenant) then
    perform app.raise('NOT_FOUND', 'Service not found');
  end if;
  if not (app.has_permission(v_tenant, 'inventory.manage') or app.has_permission(v_tenant, 'services.manage')) then
    perform app.forbid('Managing product use needs inventory or services permission');
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 30 then
    perform app.raise('INVALID_ITEMS', 'Provide up to 30 products');
  end if;
  begin
    if exists (select 1 from jsonb_array_elements(p_items) e
               where (e ->> 'quantity')::numeric <= 0
                  or not exists (select 1 from public.products p where p.id = (e ->> 'product_id')::uuid
                                   and p.tenant_id = v_tenant and p.kind in ('consumable', 'both'))) then
      perform app.raise('INVALID_ITEMS', 'Each product must be a consumable of this business with a positive quantity');
    end if;
  exception when invalid_text_representation or numeric_value_out_of_range then
    perform app.raise('INVALID_ITEMS', 'Each line needs a product_id and a quantity');
  end;
  delete from public.service_product_usage where service_id = p_service_id;
  insert into public.service_product_usage (tenant_id, service_id, product_id, quantity)
  select v_tenant, p_service_id, (e ->> 'product_id')::uuid, sum(round((e ->> 'quantity')::numeric, 3))
  from jsonb_array_elements(p_items) e group by (e ->> 'product_id')::uuid;
end;
$$;

-- Create or update a DRAFT purchase order. p_items: [{ product_id, quantity, unit_cost }]
create or replace function public.save_purchase_order(
  p_tenant uuid,
  p_branch_id uuid,
  p_order_id uuid,
  p_supplier_id uuid,
  p_items jsonb,
  p_expected_on date default null,
  p_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id  uuid := p_order_id;
  v_po  public.purchase_orders%rowtype;
begin
  perform app.assert_pos(p_tenant, p_branch_id, 'purchases.manage');
  if not exists (select 1 from public.branches b where b.id = p_branch_id and b.tenant_id = p_tenant) then
    perform app.raise('INVALID_BRANCH', 'Unknown branch');
  end if;
  if not exists (select 1 from public.suppliers s where s.id = p_supplier_id and s.tenant_id = p_tenant and s.is_active) then
    perform app.raise('INVALID_SUPPLIER', 'Choose an active supplier');
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 200 then
    perform app.raise('INVALID_ITEMS', 'An order needs between 1 and 200 lines');
  end if;
  begin
    if exists (select 1 from jsonb_array_elements(p_items) e
               where (e ->> 'quantity')::numeric <= 0 or (e ->> 'unit_cost')::numeric < 0
                  or (e ->> 'unit_cost')::numeric <> round((e ->> 'unit_cost')::numeric, 3)
                  or not exists (select 1 from public.products p where p.id = (e ->> 'product_id')::uuid and p.tenant_id = p_tenant)) then
      perform app.raise('INVALID_ITEMS', 'Each line needs a product of this business, a positive quantity and a cost');
    end if;
  exception when invalid_text_representation or numeric_value_out_of_range or null_value_not_allowed then
    perform app.raise('INVALID_ITEMS', 'Each line needs a product_id, a quantity and a unit_cost');
  end;

  if v_id is null then
    insert into public.purchase_orders (tenant_id, branch_id, supplier_id, expected_on, notes)
    values (p_tenant, p_branch_id, p_supplier_id, p_expected_on, nullif(btrim(p_notes), ''))
    returning id into v_id;
  else
    select * into v_po from public.purchase_orders where id = v_id and tenant_id = p_tenant for update;
    if not found then
      perform app.raise('NOT_FOUND', 'Purchase order not found');
    end if;
    if v_po.status <> 'draft' then
      perform app.raise('PURCHASE_ORDER_LOCKED', 'Only draft orders can be edited');
    end if;
    update public.purchase_orders
    set branch_id = p_branch_id, supplier_id = p_supplier_id, expected_on = p_expected_on, notes = nullif(btrim(p_notes), '')
    where id = v_id;
    delete from public.purchase_order_items where purchase_order_id = v_id;
  end if;

  insert into public.purchase_order_items (tenant_id, purchase_order_id, product_id, sort_order, quantity, unit_cost)
  select p_tenant, v_id, (e.value ->> 'product_id')::uuid, e.ord, round((e.value ->> 'quantity')::numeric, 3),
         (e.value ->> 'unit_cost')::numeric
  from jsonb_array_elements(p_items) with ordinality as e(value, ord);

  update public.purchase_orders po
  set total_cost = (select coalesce(sum(round(i.quantity * i.unit_cost, 3)), 0) from public.purchase_order_items i where i.purchase_order_id = v_id)
  where po.id = v_id;
  return v_id;
end;
$$;

-- Send a draft order: it gets its PO number and becomes read-only.
create or replace function public.submit_purchase_order(p_order_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_po  public.purchase_orders%rowtype;
  v_num record;
begin
  perform app.require_user();
  select * into v_po from public.purchase_orders where id = p_order_id for update;
  if not found or not app.is_tenant_member(v_po.tenant_id) then
    perform app.raise('NOT_FOUND', 'Purchase order not found');
  end if;
  perform app.assert_pos(v_po.tenant_id, v_po.branch_id, 'purchases.manage');
  if v_po.status <> 'draft' then
    return v_po.number;
  end if;
  select * into v_num from app.next_document_number(v_po.tenant_id, v_po.branch_id, 'purchase_order', now());
  update public.purchase_orders set status = 'ordered', number = v_num.number, ordered_at = now() where id = p_order_id;
  return v_num.number;
end;
$$;

create or replace function public.cancel_purchase_order(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_po public.purchase_orders%rowtype;
begin
  perform app.require_user();
  select * into v_po from public.purchase_orders where id = p_order_id for update;
  if not found or not app.is_tenant_member(v_po.tenant_id) then
    perform app.raise('NOT_FOUND', 'Purchase order not found');
  end if;
  perform app.assert_pos(v_po.tenant_id, v_po.branch_id, 'purchases.manage');
  if v_po.status not in ('draft', 'ordered') then
    perform app.raise('PURCHASE_ORDER_LOCKED', 'Orders with received goods cannot be cancelled');
  end if;
  update public.purchase_orders set status = 'cancelled' where id = p_order_id;
end;
$$;

-- Receive goods (all or part). p_lines: [{ item_id, quantity, unit_cost? }]
-- Stock comes in at the actual cost and updates the average cost.
create or replace function public.receive_purchase_order(
  p_order_id uuid,
  p_lines jsonb,
  p_supplier_reference text default null,
  p_note text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_po      public.purchase_orders%rowtype;
  v_receipt uuid;
  v_line    jsonb;
  v_item    public.purchase_order_items%rowtype;
  v_qty     numeric;
  v_cost    numeric;
  v_total   numeric := 0;
begin
  perform app.require_user();
  select * into v_po from public.purchase_orders where id = p_order_id for update;
  if not found or not app.is_tenant_member(v_po.tenant_id) then
    perform app.raise('NOT_FOUND', 'Purchase order not found');
  end if;
  perform app.assert_pos(v_po.tenant_id, v_po.branch_id, 'purchases.manage');
  if p_idempotency_key is not null then
    select r.id into v_receipt from public.purchase_receipts r where r.tenant_id = v_po.tenant_id and r.idempotency_key = p_idempotency_key;
    if found then
      return jsonb_build_object('receipt_id', v_receipt, 'replayed', true, 'status', v_po.status);
    end if;
  end if;
  if v_po.status not in ('ordered', 'partially_received') then
    perform app.raise('PURCHASE_ORDER_LOCKED', 'Send the order before receiving goods');
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    perform app.raise('INVALID_ITEMS', 'Enter what was received');
  end if;

  insert into public.purchase_receipts (tenant_id, branch_id, purchase_order_id, supplier_reference, note, idempotency_key)
  values (v_po.tenant_id, v_po.branch_id, p_order_id, nullif(btrim(p_supplier_reference), ''), nullif(btrim(p_note), ''), p_idempotency_key)
  returning id into v_receipt;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    begin
      select * into v_item from public.purchase_order_items i
      where i.id = (v_line ->> 'item_id')::uuid and i.purchase_order_id = p_order_id for update;
      v_qty := (v_line ->> 'quantity')::numeric;
      v_cost := coalesce((v_line ->> 'unit_cost')::numeric, v_item.unit_cost);
    exception when invalid_text_representation or numeric_value_out_of_range then
      perform app.raise('INVALID_ITEMS', 'Each line needs an item_id and a quantity');
    end;
    if v_item.id is null then
      perform app.raise('INVALID_ITEMS', 'A line does not belong to this order');
    end if;
    continue when v_qty is null or v_qty = 0;
    if v_qty < 0 or v_cost < 0 then
      perform app.raise('INVALID_QUANTITY', 'Quantities and costs must be positive');
    end if;
    if v_item.received_quantity + v_qty > v_item.quantity then
      perform app.raise('OVER_RECEIPT', format('Only %s more can be received on this line', trim_scale(v_item.quantity - v_item.received_quantity)));
    end if;
    perform app.stock_move(v_po.tenant_id, v_po.branch_id, v_item.product_id, v_qty, 'purchase', 'purchase_receipt',
                           v_receipt, v_item.id, v_cost);
    update public.purchase_order_items set received_quantity = received_quantity + v_qty where id = v_item.id;
    update public.products set cost_price = round(v_cost, 3) where id = v_item.product_id;
    v_total := v_total + round(v_qty * v_cost, 3);
    v_item := null;
  end loop;

  update public.purchase_receipts set total_cost = v_total where id = v_receipt;
  update public.purchase_orders po
  set status = case when exists (select 1 from public.purchase_order_items i where i.purchase_order_id = po.id and i.received_quantity < i.quantity)
                    then 'partially_received' else 'received' end
  where po.id = p_order_id
  returning * into v_po;
  return jsonb_build_object('receipt_id', v_receipt, 'replayed', false, 'status', v_po.status, 'total_cost', v_total);
end;
$$;

-- Stock list of a branch with value and low-stock flag.
create or replace function public.get_stock(p_branch_id uuid)
returns table (
  product_id uuid, name_en text, name_ar text, sku text, brand text, kind text, unit text,
  quantity numeric, avg_cost numeric, stock_value numeric, reorder_level numeric, low boolean, sale_price numeric
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_tenant uuid;
begin
  perform app.require_user();
  select b.tenant_id into v_tenant from public.branches b where b.id = p_branch_id;
  if not found or not exists (select 1 from app.branch_ids_with_any_permission(app.stock_reader_permissions()) x where x = p_branch_id) then
    perform app.forbid('No access to stock at this branch');
  end if;
  return query
  select p.id, p.name_en, p.name_ar, p.sku, p.brand, p.kind, p.unit,
         coalesce(b.quantity, 0), coalesce(b.avg_cost, p.cost_price),
         round(greatest(coalesce(b.quantity, 0), 0) * coalesce(b.avg_cost, p.cost_price), 3),
         p.reorder_level, p.track_stock and coalesce(b.quantity, 0) <= p.reorder_level, p.sale_price
  from public.products p
  left join public.inventory_balances b on b.product_id = p.id and b.branch_id = p_branch_id
  where p.tenant_id = v_tenant and p.is_active
  order by (p.track_stock and coalesce(b.quantity, 0) <= p.reorder_level) desc, p.name_en;
end;
$$;

-- ---------------------------------------------------------------------------
-- 11. Execute privileges
-- ---------------------------------------------------------------------------
revoke all on function
  app.inventory_movements_immutable(), app.stock_reader_permissions(),
  app.stock_move(uuid, uuid, uuid, numeric, text, text, uuid, uuid, numeric, boolean, text),
  app.invoices_post_stock(), app.credit_note_product_link()
from public;
grant execute on function app.stock_reader_permissions() to authenticated, service_role;

revoke all on function
  public.adjust_stock(uuid, jsonb, text),
  public.transfer_stock(uuid, uuid, jsonb, text),
  public.set_service_product_usage(uuid, jsonb),
  public.save_purchase_order(uuid, uuid, uuid, uuid, jsonb, date, text),
  public.submit_purchase_order(uuid),
  public.cancel_purchase_order(uuid),
  public.receive_purchase_order(uuid, jsonb, text, text, text),
  public.get_stock(uuid)
from public, anon;
grant execute on function
  public.adjust_stock(uuid, jsonb, text),
  public.transfer_stock(uuid, uuid, jsonb, text),
  public.set_service_product_usage(uuid, jsonb),
  public.save_purchase_order(uuid, uuid, uuid, uuid, jsonb, date, text),
  public.submit_purchase_order(uuid),
  public.cancel_purchase_order(uuid),
  public.receive_purchase_order(uuid, jsonb, text, text, text),
  public.get_stock(uuid)
to authenticated, service_role;

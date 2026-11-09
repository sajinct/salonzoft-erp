-- =============================================================================
-- Salonzoft · Migration 0008 · Services, resources, employees & schedules
-- -----------------------------------------------------------------------------
-- Phase 2 (part 1). Same conventions as Phase 1:
--  * tenant_id NOT NULL everywhere, composite (id, tenant_id) foreign keys so a
--    child row can never point at another tenant's parent,
--  * RLS on every table, explicit column-scoped grants,
--  * validation in CHECK constraints / triggers so direct table writes and the
--    convenience RPCs enforce exactly the same rules.
--
-- Who can read what:
--  * services / categories / prices: anyone who books, sells or manages
--    services (services.*, appointments.*, pos.access, online_booking.manage).
--  * employees and their schedules: employees.*, attendance.manage,
--    appointments.view|manage, pos.access — plus each employee's own record.
--  * branch-scoped rows (prices, resources, shifts, employee↔branch) are
--    written only for branches the caller can access.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Authorization helpers
-- ---------------------------------------------------------------------------
-- Tenants in which the caller holds ANY of the given permissions.
create or replace function app.tenants_with_any_permission(p_permissions text[])
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select t.tenant_id
  from app.my_tenant_ids() as t(tenant_id)
  where exists (select 1 from app.permissions_for(t.tenant_id) x where x = any (p_permissions));
$$;

-- Permission sets shared by several policies (kept in one place).
create or replace function app.service_reader_permissions()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['services.view', 'services.manage', 'appointments.view', 'appointments.manage',
               'appointments.own', 'pos.access', 'online_booking.manage']::text[];
$$;

create or replace function app.employee_reader_permissions()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['employees.view', 'employees.manage', 'attendance.manage', 'appointments.view',
               'appointments.manage', 'pos.access']::text[];
$$;

-- Generic row audit: also strip free-text bodies / derived search columns and
-- identify link rows by their employee / service / customer keys.
create or replace function app.audit_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_strip text[] := array['token_hash', 'updated_at', 'search_text', 'body'];
  v_old jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) - v_strip end;
  v_new jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) - v_strip end;
  v_row jsonb := coalesce(v_new, v_old);
  v_tenant uuid;
  v_entity_id text;
begin
  if tg_op = 'UPDATE' and v_old = v_new then
    return null;  -- nothing meaningful changed
  end if;

  v_tenant := case when tg_table_name = 'tenants' then (v_row ->> 'id')::uuid
                   else (v_row ->> 'tenant_id')::uuid end;
  v_entity_id := coalesce(v_row ->> 'id',
                          concat_ws(':', v_row ->> 'membership_id', v_row ->> 'employee_id',
                                         v_row ->> 'service_id', v_row ->> 'customer_id',
                                         v_row ->> 'role_id', v_row ->> 'branch_id',
                                         v_row ->> 'permission_code', v_row ->> 'module_code',
                                         v_row ->> 'tenant_id'));

  insert into public.audit_logs
    (tenant_id, branch_id, actor_user_id, action, entity_type, entity_id, old_data, new_data)
  values
    (v_tenant,
     case when tg_table_name = 'branches' then (v_row ->> 'id')::uuid else (v_row ->> 'branch_id')::uuid end,
     auth.uid(),
     lower(tg_op),
     tg_table_name,
     v_entity_id,
     v_old,
     v_new);
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Service catalogue
-- ---------------------------------------------------------------------------
create table public.service_categories (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  name_en     text not null check (char_length(btrim(name_en)) between 2 and 80),
  name_ar     text check (char_length(name_ar) <= 80),
  sort_order  integer not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (id, tenant_id)
);
create unique index service_categories_name_idx on public.service_categories (tenant_id, lower(btrim(name_en)));
create trigger service_categories_updated_at before update on public.service_categories
  for each row execute function app.set_updated_at();

create table public.services (
  id                     uuid primary key default gen_random_uuid(),
  tenant_id              uuid not null references public.tenants (id) on delete cascade,
  category_id            uuid,
  code                   text check (code ~ '^[A-Z0-9][A-Z0-9-]{0,19}$'),
  name_en                text not null check (char_length(btrim(name_en)) between 2 and 120),
  name_ar                text check (char_length(name_ar) <= 120),
  description_en         text check (char_length(description_en) <= 1000),
  description_ar         text check (char_length(description_ar) <= 1000),
  duration_minutes       integer not null default 30 check (duration_minutes between 5 and 720),
  buffer_before_minutes  integer not null default 0 check (buffer_before_minutes between 0 and 120),
  buffer_after_minutes   integer not null default 0 check (buffer_after_minutes between 0 and 120),
  price                  numeric(12,3) not null default 0 check (price >= 0),
  -- fixed = charge `price`; from = `price` is the minimum; variable = priced at the till.
  price_type             text not null default 'fixed' check (price_type in ('fixed', 'from', 'variable')),
  vat_category           text not null default 'standard' check (vat_category in ('standard', 'zero', 'exempt')),
  audience               text not null default 'all' check (audience in ('all', 'female', 'male')),
  online_bookable        boolean not null default true,
  color                  text check (color ~ '^#[0-9A-Fa-f]{6}$'),
  is_active              boolean not null default true,
  sort_order             integer not null default 0,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (id, tenant_id),
  foreign key (category_id, tenant_id) references public.service_categories (id, tenant_id)
);
create unique index services_code_idx on public.services (tenant_id, code) where code is not null;
create index services_category_idx on public.services (category_id);
create index services_tenant_active_idx on public.services (tenant_id, is_active, sort_order);
create trigger services_updated_at before update on public.services
  for each row execute function app.set_updated_at();

-- Branch-level overrides: a different price, or "not offered at this branch".
create table public.service_prices (
  tenant_id     uuid not null,
  service_id    uuid not null,
  branch_id     uuid not null,
  price         numeric(12,3) check (price >= 0),  -- null = use the service price
  is_available  boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (service_id, branch_id),
  foreign key (service_id, tenant_id) references public.services (id, tenant_id) on delete cascade,
  foreign key (branch_id, tenant_id) references public.branches (id, tenant_id) on delete cascade
);
create index service_prices_branch_idx on public.service_prices (branch_id);
create index service_prices_tenant_idx on public.service_prices (tenant_id);
create trigger service_prices_updated_at before update on public.service_prices
  for each row execute function app.set_updated_at();

-- Rooms, chairs, beds and equipment that a booking can occupy (Phase 2 part 2
-- links them to services and appointments).
create table public.resources (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  branch_id   uuid not null,
  name_en     text not null check (char_length(btrim(name_en)) between 1 and 80),
  name_ar     text check (char_length(name_ar) <= 80),
  kind        text not null default 'room' check (kind in ('room', 'chair', 'bed', 'equipment', 'other')),
  capacity    integer not null default 1 check (capacity between 1 and 50),
  is_active   boolean not null default true,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (id, tenant_id),
  foreign key (branch_id, tenant_id) references public.branches (id, tenant_id) on delete cascade
);
create index resources_branch_idx on public.resources (branch_id, sort_order);
create index resources_tenant_idx on public.resources (tenant_id);
create trigger resources_updated_at before update on public.resources
  for each row execute function app.set_updated_at();

-- ---------------------------------------------------------------------------
-- 3. Employees
-- ---------------------------------------------------------------------------
-- An employee is a person who performs services. They may or may not have a
-- Salonzoft login (membership_id). Access rights always come from the
-- membership's roles — never from the employee row.
create table public.employees (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants (id) on delete cascade,
  membership_id  uuid,
  code           text check (code ~ '^[A-Z0-9][A-Z0-9-]{0,19}$'),
  name_en        text not null check (char_length(btrim(name_en)) between 2 and 80),
  name_ar        text check (char_length(name_ar) <= 80),
  job_title      text check (char_length(job_title) <= 80),
  phone          text check (phone ~ '^\+?[0-9]{6,15}$'),
  email          text check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  gender         text check (gender in ('female', 'male')),
  color          text check (color ~ '^#[0-9A-Fa-f]{6}$'),
  is_bookable    boolean not null default true,
  is_active      boolean not null default true,
  hired_on       date,
  sort_order     integer not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (id, tenant_id),
  foreign key (membership_id, tenant_id) references public.tenant_memberships (id, tenant_id)
    on delete set null (membership_id)
);
create unique index employees_membership_idx on public.employees (membership_id) where membership_id is not null;
create unique index employees_code_idx on public.employees (tenant_id, code) where code is not null;
create index employees_tenant_active_idx on public.employees (tenant_id, is_active, sort_order);
create trigger employees_updated_at before update on public.employees
  for each row execute function app.set_updated_at();

-- The caller's own employee record(s) (staff portal, "my schedule").
create or replace function app.my_employee_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select e.id
  from public.employees e
  join public.tenant_memberships m on m.id = e.membership_id
  join public.tenants t on t.id = m.tenant_id
  where m.user_id = auth.uid()
    and m.status = 'active'
    and t.status <> 'closed';
$$;

create table public.employee_branches (
  tenant_id    uuid not null,
  employee_id  uuid not null,
  branch_id    uuid not null,
  created_at   timestamptz not null default now(),
  primary key (employee_id, branch_id),
  foreign key (employee_id, tenant_id) references public.employees (id, tenant_id) on delete cascade,
  foreign key (branch_id, tenant_id) references public.branches (id, tenant_id) on delete cascade
);
create index employee_branches_branch_idx on public.employee_branches (branch_id);
create index employee_branches_tenant_idx on public.employee_branches (tenant_id);

create table public.employee_services (
  tenant_id    uuid not null,
  employee_id  uuid not null,
  service_id   uuid not null,
  created_at   timestamptz not null default now(),
  primary key (employee_id, service_id),
  foreign key (employee_id, tenant_id) references public.employees (id, tenant_id) on delete cascade,
  foreign key (service_id, tenant_id) references public.services (id, tenant_id) on delete cascade
);
create index employee_services_service_idx on public.employee_services (service_id);
create index employee_services_tenant_idx on public.employee_services (tenant_id);

-- Weekly recurring shifts. Several rows per day = split shift. A shift can
-- only exist at a branch the employee is assigned to (FK to employee_branches),
-- so removing the assignment removes its shifts.
create table public.staff_shifts (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null,
  employee_id  uuid not null,
  branch_id    uuid not null,
  day_of_week  smallint not null check (day_of_week between 0 and 6),  -- 0 = Sunday
  starts_at    time not null,
  ends_at      time not null,  -- '24:00' allowed for midnight
  created_at   timestamptz not null default now(),
  constraint staff_shifts_order check (ends_at > starts_at),
  foreign key (employee_id, tenant_id) references public.employees (id, tenant_id) on delete cascade,
  foreign key (employee_id, branch_id) references public.employee_branches (employee_id, branch_id) on delete cascade
);
create index staff_shifts_employee_idx on public.staff_shifts (employee_id, day_of_week);
create index staff_shifts_branch_idx on public.staff_shifts (branch_id, day_of_week);
create index staff_shifts_tenant_idx on public.staff_shifts (tenant_id);

-- An employee can't be in two places at once: no overlapping shifts on the
-- same weekday, across all branches. Serialised per employee by a row lock.
create or replace function app.staff_shifts_no_overlap()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform 1 from public.employees where id = new.employee_id for update;
  if exists (select 1 from public.staff_shifts s
             where s.employee_id = new.employee_id
               and s.day_of_week = new.day_of_week
               and s.id <> new.id
               and s.starts_at < new.ends_at
               and new.starts_at < s.ends_at) then
    perform app.raise('OVERLAPPING_SHIFTS', 'This shift overlaps another shift of the same employee');
  end if;
  return new;
end;
$$;
create trigger staff_shifts_no_overlap before insert or update on public.staff_shifts
  for each row execute function app.staff_shifts_no_overlap();

create table public.staff_leaves (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null,
  employee_id  uuid not null,
  leave_type   text not null default 'annual' check (leave_type in ('annual', 'sick', 'unpaid', 'other')),
  starts_at    timestamptz not null,
  ends_at      timestamptz not null,
  status       text not null default 'approved' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  reason       text check (char_length(reason) <= 300),
  created_by   uuid default auth.uid() references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint staff_leaves_order check (ends_at > starts_at),
  constraint staff_leaves_max_length check (ends_at - starts_at <= interval '366 days'),
  foreign key (employee_id, tenant_id) references public.employees (id, tenant_id) on delete cascade
);
create index staff_leaves_employee_idx on public.staff_leaves (employee_id, starts_at);
create index staff_leaves_tenant_idx on public.staff_leaves (tenant_id, starts_at);
create trigger staff_leaves_updated_at before update on public.staff_leaves
  for each row execute function app.set_updated_at();

-- Plan limit: active employees count against the plan's staff allowance.
create or replace function app.enforce_employee_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_max integer;
  v_count integer;
begin
  if not new.is_active or (tg_op = 'UPDATE' and old.is_active) then
    return new;
  end if;
  perform 1 from public.tenants where id = new.tenant_id for update;

  select p.max_staff into v_max
  from public.tenant_subscriptions s
  join public.subscription_plans p on p.id = s.plan_id
  where s.tenant_id = new.tenant_id
    and s.status in ('trialing', 'active', 'past_due', 'suspended');

  if v_max is null then
    return new;
  end if;

  select count(*) into v_count
  from public.employees e
  where e.tenant_id = new.tenant_id and e.is_active and e.id <> new.id;
  if v_count >= v_max then
    perform app.raise('PLAN_LIMIT_EMPLOYEES',
                      format('Your plan allows %s active employee(s). Upgrade to add more.', v_max));
  end if;
  return new;
end;
$$;
create trigger employees_enforce_limit before insert or update of is_active on public.employees
  for each row execute function app.enforce_employee_limit();

-- ---------------------------------------------------------------------------
-- 4. Branch special periods: public holidays, closures, Ramadan / Eid hours
-- ---------------------------------------------------------------------------
-- kind = closed         → branch closed for the whole date range
-- kind = special_hours  → branch_special_hours replace the weekly hours
create table public.branch_special_periods (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  branch_id   uuid not null,
  kind        text not null check (kind in ('closed', 'special_hours')),
  name_en     text not null check (char_length(btrim(name_en)) between 2 and 80),
  name_ar     text check (char_length(name_ar) <= 80),
  starts_on   date not null,
  ends_on     date not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint branch_special_periods_order check (ends_on >= starts_on),
  constraint branch_special_periods_max_length check (ends_on - starts_on <= 366),
  unique (id, branch_id, tenant_id),
  foreign key (branch_id, tenant_id) references public.branches (id, tenant_id) on delete cascade
);
create index branch_special_periods_branch_idx on public.branch_special_periods (branch_id, starts_on);
create index branch_special_periods_tenant_idx on public.branch_special_periods (tenant_id);
create trigger branch_special_periods_updated_at before update on public.branch_special_periods
  for each row execute function app.set_updated_at();

-- Periods of one branch must not overlap (otherwise "which hours apply?" is ambiguous).
create or replace function app.branch_special_periods_no_overlap()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform 1 from public.branches where id = new.branch_id for update;
  if exists (select 1 from public.branch_special_periods p
             where p.branch_id = new.branch_id
               and p.id <> new.id
               and p.starts_on <= new.ends_on
               and new.starts_on <= p.ends_on) then
    perform app.raise('OVERLAPPING_SPECIAL_PERIODS', 'This period overlaps another holiday or special-hours period');
  end if;
  return new;
end;
$$;
create trigger branch_special_periods_no_overlap before insert or update on public.branch_special_periods
  for each row execute function app.branch_special_periods_no_overlap();

create table public.branch_special_hours (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null,
  branch_id    uuid not null,
  period_id    uuid not null,
  day_of_week  smallint not null check (day_of_week between 0 and 6),
  opens_at     time not null,
  closes_at    time not null,
  created_at   timestamptz not null default now(),
  constraint branch_special_hours_order check (closes_at > opens_at),
  foreign key (period_id, branch_id, tenant_id)
    references public.branch_special_periods (id, branch_id, tenant_id) on delete cascade
);
create index branch_special_hours_period_idx on public.branch_special_hours (period_id, day_of_week);
create index branch_special_hours_tenant_idx on public.branch_special_hours (tenant_id);

-- ---------------------------------------------------------------------------
-- 5. RLS + grants
-- ---------------------------------------------------------------------------
alter table public.service_categories      enable row level security;
alter table public.services                enable row level security;
alter table public.service_prices          enable row level security;
alter table public.resources               enable row level security;
alter table public.employees               enable row level security;
alter table public.employee_branches       enable row level security;
alter table public.employee_services       enable row level security;
alter table public.staff_shifts            enable row level security;
alter table public.staff_leaves            enable row level security;
alter table public.branch_special_periods  enable row level security;
alter table public.branch_special_hours    enable row level security;

revoke all on public.service_categories, public.services, public.service_prices, public.resources,
              public.employees, public.employee_branches, public.employee_services, public.staff_shifts,
              public.staff_leaves, public.branch_special_periods, public.branch_special_hours
  from anon, authenticated;
grant all on public.service_categories, public.services, public.service_prices, public.resources,
             public.employees, public.employee_branches, public.employee_services, public.staff_shifts,
             public.staff_leaves, public.branch_special_periods, public.branch_special_hours
  to service_role;

-- Service categories --------------------------------------------------------------
grant select, delete on public.service_categories to authenticated;
grant insert (tenant_id, name_en, name_ar, sort_order, is_active) on public.service_categories to authenticated;
grant update (name_en, name_ar, sort_order, is_active) on public.service_categories to authenticated;

create policy service_categories_select on public.service_categories
  for select to authenticated
  using (tenant_id in (select app.tenants_with_any_permission(app.service_reader_permissions())));
create policy service_categories_insert on public.service_categories
  for insert to authenticated
  with check (tenant_id in (select app.tenants_with_permission('services.manage')));
create policy service_categories_update on public.service_categories
  for update to authenticated
  using (tenant_id in (select app.tenants_with_permission('services.manage')))
  with check (tenant_id in (select app.tenants_with_permission('services.manage')));
create policy service_categories_delete on public.service_categories
  for delete to authenticated
  using (tenant_id in (select app.tenants_with_permission('services.manage')));

-- Services (no delete: deactivate instead, invoices will reference them) ---------
grant select on public.services to authenticated;
grant insert (tenant_id, category_id, code, name_en, name_ar, description_en, description_ar,
              duration_minutes, buffer_before_minutes, buffer_after_minutes, price, price_type,
              vat_category, audience, online_bookable, color, is_active, sort_order)
  on public.services to authenticated;
grant update (category_id, code, name_en, name_ar, description_en, description_ar,
              duration_minutes, buffer_before_minutes, buffer_after_minutes, price, price_type,
              vat_category, audience, online_bookable, color, is_active, sort_order)
  on public.services to authenticated;

create policy services_select on public.services
  for select to authenticated
  using (tenant_id in (select app.tenants_with_any_permission(app.service_reader_permissions())));
create policy services_insert on public.services
  for insert to authenticated
  with check (tenant_id in (select app.tenants_with_permission('services.manage')));
create policy services_update on public.services
  for update to authenticated
  using (tenant_id in (select app.tenants_with_permission('services.manage')))
  with check (tenant_id in (select app.tenants_with_permission('services.manage')));

-- Branch prices (branch-scoped writes) --------------------------------------------
grant select, delete on public.service_prices to authenticated;
grant insert (tenant_id, service_id, branch_id, price, is_available) on public.service_prices to authenticated;
grant update (price, is_available) on public.service_prices to authenticated;

create policy service_prices_select on public.service_prices
  for select to authenticated
  using (tenant_id in (select app.tenants_with_any_permission(app.service_reader_permissions())));
create policy service_prices_insert on public.service_prices
  for insert to authenticated
  with check (tenant_id in (select app.tenants_with_permission('services.manage'))
              and branch_id in (select app.accessible_branch_ids()));
create policy service_prices_update on public.service_prices
  for update to authenticated
  using (tenant_id in (select app.tenants_with_permission('services.manage'))
         and branch_id in (select app.accessible_branch_ids()))
  with check (tenant_id in (select app.tenants_with_permission('services.manage'))
              and branch_id in (select app.accessible_branch_ids()));
create policy service_prices_delete on public.service_prices
  for delete to authenticated
  using (tenant_id in (select app.tenants_with_permission('services.manage'))
         and branch_id in (select app.accessible_branch_ids()));

-- Resources (branch-scoped) -------------------------------------------------------
grant select, delete on public.resources to authenticated;
grant insert (tenant_id, branch_id, name_en, name_ar, kind, capacity, is_active, sort_order)
  on public.resources to authenticated;
grant update (name_en, name_ar, kind, capacity, is_active, sort_order) on public.resources to authenticated;

create policy resources_select on public.resources
  for select to authenticated
  using (tenant_id in (select app.tenants_with_any_permission(app.service_reader_permissions()))
         and branch_id in (select app.accessible_branch_ids()));
create policy resources_insert on public.resources
  for insert to authenticated
  with check (tenant_id in (select app.tenants_with_permission('services.manage'))
              and branch_id in (select app.accessible_branch_ids()));
create policy resources_update on public.resources
  for update to authenticated
  using (tenant_id in (select app.tenants_with_permission('services.manage'))
         and branch_id in (select app.accessible_branch_ids()))
  with check (tenant_id in (select app.tenants_with_permission('services.manage'))
              and branch_id in (select app.accessible_branch_ids()));
create policy resources_delete on public.resources
  for delete to authenticated
  using (tenant_id in (select app.tenants_with_permission('services.manage'))
         and branch_id in (select app.accessible_branch_ids()));

-- Employees (no delete: deactivate) -----------------------------------------------
grant select on public.employees to authenticated;
grant insert (tenant_id, membership_id, code, name_en, name_ar, job_title, phone, email, gender,
              color, is_bookable, is_active, hired_on, sort_order)
  on public.employees to authenticated;
grant update (membership_id, code, name_en, name_ar, job_title, phone, email, gender,
              color, is_bookable, is_active, hired_on, sort_order)
  on public.employees to authenticated;

create policy employees_select on public.employees
  for select to authenticated
  using (tenant_id in (select app.tenants_with_any_permission(app.employee_reader_permissions()))
         or id in (select app.my_employee_ids()));
create policy employees_insert on public.employees
  for insert to authenticated
  with check (tenant_id in (select app.tenants_with_permission('employees.manage')));
create policy employees_update on public.employees
  for update to authenticated
  using (tenant_id in (select app.tenants_with_permission('employees.manage')))
  with check (tenant_id in (select app.tenants_with_permission('employees.manage')));

-- Employee ↔ branch (branch-scoped writes) ----------------------------------------
grant select, delete on public.employee_branches to authenticated;
grant insert (tenant_id, employee_id, branch_id) on public.employee_branches to authenticated;

create policy employee_branches_select on public.employee_branches
  for select to authenticated
  using (tenant_id in (select app.tenants_with_any_permission(app.employee_reader_permissions()))
         or employee_id in (select app.my_employee_ids()));
create policy employee_branches_insert on public.employee_branches
  for insert to authenticated
  with check (tenant_id in (select app.tenants_with_permission('employees.manage'))
              and branch_id in (select app.accessible_branch_ids()));
create policy employee_branches_delete on public.employee_branches
  for delete to authenticated
  using (tenant_id in (select app.tenants_with_permission('employees.manage'))
         and branch_id in (select app.accessible_branch_ids()));

-- Employee ↔ service (skills) -----------------------------------------------------
grant select, delete on public.employee_services to authenticated;
grant insert (tenant_id, employee_id, service_id) on public.employee_services to authenticated;

create policy employee_services_select on public.employee_services
  for select to authenticated
  using (tenant_id in (select app.tenants_with_any_permission(app.employee_reader_permissions()))
         or employee_id in (select app.my_employee_ids()));
create policy employee_services_insert on public.employee_services
  for insert to authenticated
  with check (tenant_id in (select app.tenants_with_permission('employees.manage')));
create policy employee_services_delete on public.employee_services
  for delete to authenticated
  using (tenant_id in (select app.tenants_with_permission('employees.manage')));

-- Shifts (branch-scoped writes) ---------------------------------------------------
grant select, delete on public.staff_shifts to authenticated;
grant insert (tenant_id, employee_id, branch_id, day_of_week, starts_at, ends_at) on public.staff_shifts to authenticated;

create policy staff_shifts_select on public.staff_shifts
  for select to authenticated
  using (tenant_id in (select app.tenants_with_any_permission(app.employee_reader_permissions()))
         or employee_id in (select app.my_employee_ids()));
create policy staff_shifts_insert on public.staff_shifts
  for insert to authenticated
  with check (tenant_id in (select app.tenants_with_permission('employees.manage'))
              and branch_id in (select app.accessible_branch_ids()));
create policy staff_shifts_delete on public.staff_shifts
  for delete to authenticated
  using (tenant_id in (select app.tenants_with_permission('employees.manage'))
         and branch_id in (select app.accessible_branch_ids()));

-- Leave ---------------------------------------------------------------------------
grant select, delete on public.staff_leaves to authenticated;
grant insert (tenant_id, employee_id, leave_type, starts_at, ends_at, status, reason) on public.staff_leaves to authenticated;
grant update (leave_type, starts_at, ends_at, status, reason) on public.staff_leaves to authenticated;

create policy staff_leaves_select on public.staff_leaves
  for select to authenticated
  using (tenant_id in (select app.tenants_with_any_permission(array['employees.view', 'employees.manage',
                         'attendance.manage', 'appointments.view', 'appointments.manage']))
         or employee_id in (select app.my_employee_ids()));
create policy staff_leaves_insert on public.staff_leaves
  for insert to authenticated
  with check (tenant_id in (select app.tenants_with_permission('attendance.manage')));
create policy staff_leaves_update on public.staff_leaves
  for update to authenticated
  using (tenant_id in (select app.tenants_with_permission('attendance.manage')))
  with check (tenant_id in (select app.tenants_with_permission('attendance.manage')));
create policy staff_leaves_delete on public.staff_leaves
  for delete to authenticated
  using (tenant_id in (select app.tenants_with_permission('attendance.manage')));

-- Special periods (mirror branch_working_hours) ----------------------------------
grant select, delete on public.branch_special_periods to authenticated;
grant insert (tenant_id, branch_id, kind, name_en, name_ar, starts_on, ends_on) on public.branch_special_periods to authenticated;
grant update (kind, name_en, name_ar, starts_on, ends_on) on public.branch_special_periods to authenticated;

create policy branch_special_periods_select on public.branch_special_periods
  for select to authenticated
  using (branch_id in (select app.accessible_branch_ids())
         or tenant_id in (select app.tenants_with_permission('branches.manage')));
create policy branch_special_periods_insert on public.branch_special_periods
  for insert to authenticated
  with check (tenant_id in (select app.tenants_with_permission('branches.manage')));
create policy branch_special_periods_update on public.branch_special_periods
  for update to authenticated
  using (tenant_id in (select app.tenants_with_permission('branches.manage')))
  with check (tenant_id in (select app.tenants_with_permission('branches.manage')));
create policy branch_special_periods_delete on public.branch_special_periods
  for delete to authenticated
  using (tenant_id in (select app.tenants_with_permission('branches.manage')));

grant select, delete on public.branch_special_hours to authenticated;
grant insert (tenant_id, branch_id, period_id, day_of_week, opens_at, closes_at) on public.branch_special_hours to authenticated;

create policy branch_special_hours_select on public.branch_special_hours
  for select to authenticated
  using (branch_id in (select app.accessible_branch_ids())
         or tenant_id in (select app.tenants_with_permission('branches.manage')));
create policy branch_special_hours_insert on public.branch_special_hours
  for insert to authenticated
  with check (tenant_id in (select app.tenants_with_permission('branches.manage')));
create policy branch_special_hours_delete on public.branch_special_hours
  for delete to authenticated
  using (tenant_id in (select app.tenants_with_permission('branches.manage')));

-- ---------------------------------------------------------------------------
-- 6. Audit trails
-- ---------------------------------------------------------------------------
create trigger audit_service_categories after insert or update or delete on public.service_categories
  for each row execute function app.audit_row();
create trigger audit_services after insert or update or delete on public.services
  for each row execute function app.audit_row();
create trigger audit_service_prices after insert or update or delete on public.service_prices
  for each row execute function app.audit_row();
create trigger audit_resources after insert or update or delete on public.resources
  for each row execute function app.audit_row();
create trigger audit_employees after insert or update or delete on public.employees
  for each row execute function app.audit_row();
create trigger audit_employee_branches after insert or delete on public.employee_branches
  for each row execute function app.audit_row();
create trigger audit_employee_services after insert or delete on public.employee_services
  for each row execute function app.audit_row();
create trigger audit_staff_leaves after insert or update or delete on public.staff_leaves
  for each row execute function app.audit_row();
create trigger audit_branch_special_periods after insert or update or delete on public.branch_special_periods
  for each row execute function app.audit_row();

-- ---------------------------------------------------------------------------
-- 7. RPCs (SECURITY INVOKER: RLS and the triggers above govern every write)
-- ---------------------------------------------------------------------------

-- Replace a service's branch overrides atomically.
-- p_prices: [{ "branch_id": uuid, "price": 12.5 | null, "is_available": true }, …]
-- Only rows of branches the caller can access are replaced.
create or replace function public.set_service_branch_prices(p_service_id uuid, p_prices jsonb)
returns setof public.service_prices
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_tenant uuid;
  v_rows   jsonb;
begin
  perform app.require_user();
  select s.tenant_id into v_tenant from public.services s where s.id = p_service_id;
  if not found then
    perform app.raise('NOT_FOUND', 'Service not found');
  end if;
  perform app.require_permission(v_tenant, 'services.manage');

  if p_prices is null or jsonb_typeof(p_prices) <> 'array' or jsonb_array_length(p_prices) > 200 then
    perform app.raise('INVALID_PRICE', 'Provide a list of branch prices');
  end if;

  begin
    select coalesce(jsonb_agg(jsonb_build_object(
             'branch_id', (e ->> 'branch_id')::uuid,
             'price', (e ->> 'price')::numeric(12,3),
             'is_available', coalesce((e ->> 'is_available')::boolean, true))), '[]'::jsonb)
      into v_rows
    from jsonb_array_elements(p_prices) e;
  exception when others then
    perform app.raise('INVALID_PRICE', 'Prices must be numbers with up to 3 decimals');
  end;

  if exists (select 1 from jsonb_to_recordset(v_rows) as r(branch_id uuid, price numeric, is_available boolean)
             where r.branch_id is null or r.price < 0) then
    perform app.raise('INVALID_PRICE', 'Each row needs a branch and a non-negative price');
  end if;
  if exists (select 1 from jsonb_to_recordset(v_rows) as r(branch_id uuid, price numeric, is_available boolean)
             where not exists (select 1 from public.branches b where b.id = r.branch_id and b.tenant_id = v_tenant)) then
    perform app.raise('INVALID_BRANCH', 'Unknown branch');
  end if;
  if exists (select 1 from jsonb_to_recordset(v_rows) as r(branch_id uuid, price numeric, is_available boolean)
             where not app.has_branch_access(r.branch_id)) then
    perform app.raise('BRANCH_ESCALATION_FORBIDDEN', 'No access to one of the branches', '42501');
  end if;
  if (select count(*) <> count(distinct r.branch_id)
      from jsonb_to_recordset(v_rows) as r(branch_id uuid, price numeric, is_available boolean)) then
    perform app.raise('INVALID_PRICE', 'Each branch can appear only once');
  end if;

  delete from public.service_prices sp
  where sp.service_id = p_service_id and sp.branch_id in (select app.accessible_branch_ids());

  insert into public.service_prices (tenant_id, service_id, branch_id, price, is_available)
  select v_tenant, p_service_id, r.branch_id, r.price, r.is_available
  from jsonb_to_recordset(v_rows) as r(branch_id uuid, price numeric, is_available boolean)
  -- a row that changes nothing is not stored
  where r.price is not null or not r.is_available;

  return query select * from public.service_prices sp where sp.service_id = p_service_id;
end;
$$;

-- Set an employee's branches and skills in one transaction. Branches the
-- caller cannot access are left untouched (RLS) and cannot be added.
create or replace function public.set_employee_assignments(
  p_employee_id uuid,
  p_branch_ids uuid[],
  p_service_ids uuid[]
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_tenant   uuid;
  v_branches uuid[] := coalesce(p_branch_ids, '{}');
  v_services uuid[] := coalesce(p_service_ids, '{}');
begin
  perform app.require_user();
  select e.tenant_id into v_tenant from public.employees e where e.id = p_employee_id;
  if not found then
    perform app.raise('NOT_FOUND', 'Employee not found');
  end if;
  perform app.require_permission(v_tenant, 'employees.manage');

  if exists (select 1 from unnest(v_branches) x
             where not exists (select 1 from public.branches b where b.id = x and b.tenant_id = v_tenant)) then
    perform app.raise('INVALID_BRANCH', 'Unknown branch');
  end if;
  if exists (select 1 from unnest(v_branches) x where not app.has_branch_access(x)) then
    perform app.raise('BRANCH_ESCALATION_FORBIDDEN', 'No access to one of the branches', '42501');
  end if;
  if exists (select 1 from unnest(v_services) x
             where not exists (select 1 from public.services s where s.id = x and s.tenant_id = v_tenant)) then
    perform app.raise('INVALID_SERVICE', 'Unknown service');
  end if;

  delete from public.employee_branches eb
  where eb.employee_id = p_employee_id
    and eb.branch_id in (select app.accessible_branch_ids())
    and eb.branch_id <> all (v_branches);
  insert into public.employee_branches (tenant_id, employee_id, branch_id)
  select distinct v_tenant, p_employee_id, x from unnest(v_branches) x
  on conflict do nothing;

  delete from public.employee_services es
  where es.employee_id = p_employee_id and es.service_id <> all (v_services);
  insert into public.employee_services (tenant_id, employee_id, service_id)
  select distinct v_tenant, p_employee_id, x from unnest(v_services) x
  on conflict do nothing;
end;
$$;

-- Replace an employee's weekly shifts (at branches the caller can access).
-- p_shifts: [{ "branch_id": uuid, "day_of_week": 0-6, "starts_at": "09:00", "ends_at": "17:00" }, …]
create or replace function public.set_employee_shifts(p_employee_id uuid, p_shifts jsonb)
returns setof public.staff_shifts
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_tenant uuid;
  v_rows   jsonb;
begin
  perform app.require_user();
  select e.tenant_id into v_tenant from public.employees e where e.id = p_employee_id;
  if not found then
    perform app.raise('NOT_FOUND', 'Employee not found');
  end if;
  perform app.require_permission(v_tenant, 'employees.manage');

  if p_shifts is null or jsonb_typeof(p_shifts) <> 'array' or jsonb_array_length(p_shifts) > 56 then
    perform app.raise('INVALID_SHIFTS', 'Provide up to 56 shifts');
  end if;

  begin
    select coalesce(jsonb_agg(jsonb_build_object(
             'idx', e.ord,
             'branch_id', (e.value ->> 'branch_id')::uuid,
             'day_of_week', (e.value ->> 'day_of_week')::smallint,
             'starts_at', (e.value ->> 'starts_at')::time,
             'ends_at', (e.value ->> 'ends_at')::time)), '[]'::jsonb)
      into v_rows
    from jsonb_array_elements(p_shifts) with ordinality as e(value, ord);
  exception when others then
    perform app.raise('INVALID_SHIFTS', 'Times must be HH:MM and days 0–6');
  end;

  if exists (select 1 from jsonb_to_recordset(v_rows)
               as s(idx int, branch_id uuid, day_of_week smallint, starts_at time, ends_at time)
             where s.branch_id is null or s.day_of_week is null or s.day_of_week not between 0 and 6
                or s.starts_at is null or s.ends_at is null or s.ends_at <= s.starts_at) then
    perform app.raise('INVALID_SHIFTS', 'Each shift needs a branch, a day and an end after its start');
  end if;
  if exists (select 1 from jsonb_to_recordset(v_rows)
               as s(idx int, branch_id uuid, day_of_week smallint, starts_at time, ends_at time)
             where not exists (select 1 from public.employee_branches eb
                               where eb.employee_id = p_employee_id and eb.branch_id = s.branch_id)) then
    perform app.raise('SHIFT_BRANCH_NOT_ASSIGNED', 'Assign the employee to the branch before adding shifts there');
  end if;
  if exists (select 1
             from jsonb_to_recordset(v_rows) as a(idx int, branch_id uuid, day_of_week smallint, starts_at time, ends_at time)
             join jsonb_to_recordset(v_rows) as b(idx int, branch_id uuid, day_of_week smallint, starts_at time, ends_at time)
               on a.day_of_week = b.day_of_week and a.idx < b.idx
              and a.starts_at < b.ends_at and b.starts_at < a.ends_at) then
    perform app.raise('OVERLAPPING_SHIFTS', 'Two shifts on the same day overlap');
  end if;

  delete from public.staff_shifts ss
  where ss.employee_id = p_employee_id and ss.branch_id in (select app.accessible_branch_ids());

  insert into public.staff_shifts (tenant_id, employee_id, branch_id, day_of_week, starts_at, ends_at)
  select v_tenant, p_employee_id, s.branch_id, s.day_of_week, s.starts_at, s.ends_at
  from jsonb_to_recordset(v_rows) as s(idx int, branch_id uuid, day_of_week smallint, starts_at time, ends_at time)
  order by s.day_of_week, s.starts_at;

  return query
  select * from public.staff_shifts ss
  where ss.employee_id = p_employee_id
  order by ss.day_of_week, ss.starts_at;
end;
$$;

-- Create or update a holiday / special-hours period with its hours atomically.
-- p_hours (special_hours only): [{ "day_of_week": 0-6, "opens_at": "10:00", "closes_at": "14:00" }, …]
create or replace function public.save_branch_special_period(
  p_branch_id uuid,
  p_period_id uuid,
  p_kind text,
  p_name_en text,
  p_name_ar text,
  p_starts_on date,
  p_ends_on date,
  p_hours jsonb default '[]'::jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_tenant uuid;
  v_id     uuid := p_period_id;
  v_rows   jsonb;
begin
  perform app.require_user();
  select b.tenant_id into v_tenant from public.branches b where b.id = p_branch_id;
  if not found then
    perform app.raise('NOT_FOUND', 'Branch not found');
  end if;
  perform app.require_permission(v_tenant, 'branches.manage');

  if p_kind not in ('closed', 'special_hours') then
    perform app.raise('INVALID_PERIOD', 'Kind must be closed or special_hours');
  end if;
  if p_starts_on is null or p_ends_on is null or p_ends_on < p_starts_on then
    perform app.raise('INVALID_PERIOD', 'The end date must be on or after the start date');
  end if;
  if p_hours is null or jsonb_typeof(p_hours) <> 'array' or jsonb_array_length(p_hours) > 28 then
    perform app.raise('INVALID_WORKING_HOURS', 'Provide up to 28 time ranges');
  end if;
  if p_kind = 'closed' and jsonb_array_length(p_hours) > 0 then
    perform app.raise('INVALID_PERIOD', 'A closure has no opening hours');
  end if;
  if p_kind = 'special_hours' and jsonb_array_length(p_hours) = 0 then
    perform app.raise('INVALID_PERIOD', 'Add at least one opening time, or mark the period as closed');
  end if;

  begin
    select coalesce(jsonb_agg(jsonb_build_object(
             'idx', e.ord,
             'day_of_week', (e.value ->> 'day_of_week')::smallint,
             'opens_at', (e.value ->> 'opens_at')::time,
             'closes_at', (e.value ->> 'closes_at')::time)), '[]'::jsonb)
      into v_rows
    from jsonb_array_elements(p_hours) with ordinality as e(value, ord);
  exception when others then
    perform app.raise('INVALID_WORKING_HOURS', 'Times must be HH:MM and days 0–6');
  end;
  if exists (select 1 from jsonb_to_recordset(v_rows) as h(idx int, day_of_week smallint, opens_at time, closes_at time)
             where h.day_of_week is null or h.day_of_week not between 0 and 6
                or h.opens_at is null or h.closes_at is null or h.closes_at <= h.opens_at) then
    perform app.raise('INVALID_WORKING_HOURS', 'Each range needs a day and a closing time after opening');
  end if;
  if exists (select 1
             from jsonb_to_recordset(v_rows) as a(idx int, day_of_week smallint, opens_at time, closes_at time)
             join jsonb_to_recordset(v_rows) as b(idx int, day_of_week smallint, opens_at time, closes_at time)
               on a.day_of_week = b.day_of_week and a.idx < b.idx
              and a.opens_at < b.closes_at and b.opens_at < a.closes_at) then
    perform app.raise('OVERLAPPING_WORKING_HOURS', 'Time ranges on the same day overlap');
  end if;

  if v_id is null then
    insert into public.branch_special_periods (tenant_id, branch_id, kind, name_en, name_ar, starts_on, ends_on)
    values (v_tenant, p_branch_id, p_kind, btrim(p_name_en), nullif(btrim(p_name_ar), ''), p_starts_on, p_ends_on)
    returning id into v_id;
  else
    update public.branch_special_periods p
    set kind = p_kind, name_en = btrim(p_name_en), name_ar = nullif(btrim(p_name_ar), ''),
        starts_on = p_starts_on, ends_on = p_ends_on
    where p.id = v_id and p.branch_id = p_branch_id;
    if not found then
      perform app.raise('NOT_FOUND', 'Period not found');
    end if;
    delete from public.branch_special_hours h where h.period_id = v_id;
  end if;

  insert into public.branch_special_hours (tenant_id, branch_id, period_id, day_of_week, opens_at, closes_at)
  select v_tenant, p_branch_id, v_id, h.day_of_week, h.opens_at, h.closes_at
  from jsonb_to_recordset(v_rows) as h(idx int, day_of_week smallint, opens_at time, closes_at time)
  order by h.day_of_week, h.opens_at;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Execute privileges
-- ---------------------------------------------------------------------------
revoke all on function
  app.tenants_with_any_permission(text[]),
  app.service_reader_permissions(),
  app.employee_reader_permissions(),
  app.my_employee_ids(),
  app.staff_shifts_no_overlap(),
  app.enforce_employee_limit(),
  app.branch_special_periods_no_overlap()
from public;

grant execute on function
  app.tenants_with_any_permission(text[]),
  app.service_reader_permissions(),
  app.employee_reader_permissions(),
  app.my_employee_ids()
to authenticated, service_role;

revoke all on function
  public.set_service_branch_prices(uuid, jsonb),
  public.set_employee_assignments(uuid, uuid[], uuid[]),
  public.set_employee_shifts(uuid, jsonb),
  public.save_branch_special_period(uuid, uuid, text, text, text, date, date, jsonb)
from public, anon;

grant execute on function
  public.set_service_branch_prices(uuid, jsonb),
  public.set_employee_assignments(uuid, uuid[], uuid[]),
  public.set_employee_shifts(uuid, jsonb),
  public.save_branch_special_period(uuid, uuid, text, text, text, date, date, jsonb)
to authenticated, service_role;

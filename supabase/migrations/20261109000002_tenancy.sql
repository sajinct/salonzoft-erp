-- =============================================================================
-- Salonzoft · Migration 0002 · Multi-tenant core
-- -----------------------------------------------------------------------------
-- Every business-owned row carries tenant_id NOT NULL. Child rows reference
-- their parent with COMPOSITE foreign keys (parent_id, tenant_id) so the
-- database itself guarantees a child can never point at another tenant's row.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Tenants
-- ---------------------------------------------------------------------------
create table public.tenants (
  id             uuid primary key default gen_random_uuid(),
  slug           text not null unique
                 check (slug ~ '^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$' and slug !~ '--'),
  name           text not null check (char_length(btrim(name)) between 2 and 120),
  name_ar        text check (char_length(name_ar) <= 120),
  legal_name     text check (char_length(legal_name) <= 200),
  business_type  text not null default 'unisex_salon'
                 check (business_type in ('barbershop', 'beauty_salon', 'unisex_salon',
                                          'nail_studio', 'makeup_studio', 'spa', 'multi_concept')),
  country_code   char(2) not null default 'OM',
  status         text not null default 'active' check (status in ('active', 'suspended', 'closed')),
  created_by     uuid references auth.users (id) on delete set null,
  creation_key   text check (char_length(creation_key) <= 100),  -- idempotency key for create_tenant
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (created_by, creation_key)
);
create index tenants_created_by_idx on public.tenants (created_by);
create trigger tenants_updated_at before update on public.tenants
  for each row execute function app.set_updated_at();

-- ---------------------------------------------------------------------------
-- Tenant settings (Oman defaults)
-- ---------------------------------------------------------------------------
create table public.tenant_settings (
  tenant_id            uuid primary key references public.tenants (id) on delete cascade,
  default_language     text not null default 'en' check (default_language in ('en', 'ar')),
  currency_code        char(3) not null default 'OMR' check (currency_code ~ '^[A-Z]{3}$'),
  currency_decimals    smallint not null default 3 check (currency_decimals between 0 and 3),
  timezone             text not null default 'Asia/Muscat',
  phone_country_code   text not null default '+968' check (phone_country_code ~ '^\+[0-9]{1,4}$'),
  -- ISO-like day numbers matching extract(dow): 0 = Sunday … 6 = Saturday.
  weekend_days         smallint[] not null default '{5,6}'
                       check (weekend_days <@ '{0,1,2,3,4,5,6}'::smallint[]),
  week_starts_on       smallint not null default 0 check (week_starts_on between 0 and 6),
  show_hijri_dates     boolean not null default false,
  vat_registered       boolean not null default false,
  vat_number           text check (vat_number ~ '^[A-Z0-9]{5,20}$'),
  default_vat_rate     numeric(5,2) not null default 5.00 check (default_vat_rate between 0 and 100),
  prices_include_vat   boolean not null default true,
  invoice_prefix       text not null default 'INV' check (invoice_prefix ~ '^[A-Z0-9-]{1,10}$'),
  receipt_footer_en    text check (char_length(receipt_footer_en) <= 500),
  receipt_footer_ar    text check (char_length(receipt_footer_ar) <= 500),
  logo_path            text check (char_length(logo_path) <= 512),
  updated_at           timestamptz not null default now(),
  constraint tenant_settings_vat_number_required check (not vat_registered or vat_number is not null)
);
create trigger tenant_settings_updated_at before update on public.tenant_settings
  for each row execute function app.set_updated_at();

create or replace function app.tenant_settings_validate()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform app.assert_valid_timezone(new.timezone);
  return new;
end;
$$;
create trigger tenant_settings_validate before insert or update of timezone on public.tenant_settings
  for each row execute function app.tenant_settings_validate();

-- ---------------------------------------------------------------------------
-- Subscriptions, entitlements, usage
-- ---------------------------------------------------------------------------
create table public.tenant_subscriptions (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenants (id) on delete cascade,
  plan_id               uuid not null references public.subscription_plans (id),
  status                text not null
                        check (status in ('trialing', 'active', 'past_due', 'suspended', 'cancelled', 'expired')),
  billing_cycle         text not null default 'monthly' check (billing_cycle in ('monthly', 'yearly')),
  trial_ends_at         timestamptz,
  current_period_start  timestamptz not null default now(),
  current_period_end    timestamptz,
  cancel_at_period_end  boolean not null default false,
  external_ref          text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint tenant_subscriptions_trial_end check (status <> 'trialing' or trial_ends_at is not null)
);
-- At most one "current" subscription per tenant.
create unique index tenant_subscriptions_one_current_idx
  on public.tenant_subscriptions (tenant_id)
  where status in ('trialing', 'active', 'past_due', 'suspended');
create index tenant_subscriptions_plan_idx on public.tenant_subscriptions (plan_id);
create trigger tenant_subscriptions_updated_at before update on public.tenant_subscriptions
  for each row execute function app.set_updated_at();

create table public.module_entitlements (
  tenant_id    uuid not null references public.tenants (id) on delete cascade,
  module_code  text not null references public.modules (code),
  is_enabled   boolean not null default true,
  source       text not null default 'plan' check (source in ('plan', 'addon', 'override')),
  valid_until  timestamptz,
  updated_at   timestamptz not null default now(),
  primary key (tenant_id, module_code)
);
create index module_entitlements_module_idx on public.module_entitlements (module_code);
create trigger module_entitlements_updated_at before update on public.module_entitlements
  for each row execute function app.set_updated_at();

create table public.tenant_usage (
  tenant_id     uuid not null references public.tenants (id) on delete cascade,
  metric        text not null check (metric ~ '^[a-z][a-z_]{1,39}$'),
  period_start  date not null,
  quantity      bigint not null default 0 check (quantity >= 0),
  updated_at    timestamptz not null default now(),
  primary key (tenant_id, metric, period_start)
);

-- ---------------------------------------------------------------------------
-- Roles (per tenant, copied from templates and editable)
-- ---------------------------------------------------------------------------
create table public.roles (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants (id) on delete cascade,
  code           text not null check (code ~ '^[a-z][a-z0-9_]{1,39}$'),
  name_en        text not null check (char_length(btrim(name_en)) between 2 and 60),
  name_ar        text check (char_length(name_ar) <= 60),
  description    text check (char_length(description) <= 300),
  is_system      boolean not null default false,
  template_code  text references public.role_templates (code) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (tenant_id, code),
  unique (id, tenant_id)
);
create trigger roles_updated_at before update on public.roles
  for each row execute function app.set_updated_at();

create table public.role_permissions (
  tenant_id        uuid not null,
  role_id          uuid not null,
  permission_code  text not null references public.permissions (code) on delete cascade,
  created_at       timestamptz not null default now(),
  primary key (role_id, permission_code),
  foreign key (role_id, tenant_id) references public.roles (id, tenant_id) on delete cascade
);
create index role_permissions_tenant_idx on public.role_permissions (tenant_id);
create index role_permissions_permission_idx on public.role_permissions (permission_code);

-- ---------------------------------------------------------------------------
-- Memberships (auth user ⇄ tenant)
-- ---------------------------------------------------------------------------
create table public.tenant_memberships (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants (id) on delete cascade,
  user_id       uuid not null references auth.users (id) on delete cascade,
  status        text not null default 'active' check (status in ('active', 'suspended')),
  is_owner      boolean not null default false,
  all_branches  boolean not null default false,
  job_title     text check (char_length(job_title) <= 80),
  invited_by    uuid references auth.users (id) on delete set null,
  joined_at     timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (tenant_id, user_id),
  unique (id, tenant_id),
  constraint tenant_memberships_owner_active check (not is_owner or status = 'active')
);
create unique index tenant_memberships_one_owner_idx on public.tenant_memberships (tenant_id) where is_owner;
create index tenant_memberships_user_idx on public.tenant_memberships (user_id) where status = 'active';
create trigger tenant_memberships_updated_at before update on public.tenant_memberships
  for each row execute function app.set_updated_at();

create table public.user_roles (
  tenant_id      uuid not null,
  membership_id  uuid not null,
  role_id        uuid not null,
  created_at     timestamptz not null default now(),
  primary key (membership_id, role_id),
  foreign key (membership_id, tenant_id) references public.tenant_memberships (id, tenant_id) on delete cascade,
  foreign key (role_id, tenant_id) references public.roles (id, tenant_id) on delete cascade
);
create index user_roles_role_idx on public.user_roles (role_id);
create index user_roles_tenant_idx on public.user_roles (tenant_id);

-- ---------------------------------------------------------------------------
-- Branches
-- ---------------------------------------------------------------------------
create table public.branches (
  id                      uuid primary key default gen_random_uuid(),
  tenant_id               uuid not null references public.tenants (id) on delete cascade,
  code                    text not null check (code ~ '^[A-Z0-9][A-Z0-9-]{0,11}$'),
  name_en                 text not null check (char_length(btrim(name_en)) between 2 and 120),
  name_ar                 text check (char_length(name_ar) <= 120),
  phone                   text check (phone ~ '^\+?[0-9]{6,15}$'),
  email                   text check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  address_en              text check (char_length(address_en) <= 300),
  address_ar              text check (char_length(address_ar) <= 300),
  city                    text check (char_length(city) <= 80),
  governorate             text check (char_length(governorate) <= 80),
  timezone                text not null default 'Asia/Muscat',
  latitude                numeric(9,6) check (latitude between -90 and 90),
  longitude               numeric(9,6) check (longitude between -180 and 180),
  is_active               boolean not null default true,
  is_main                 boolean not null default false,
  online_booking_enabled  boolean not null default false,
  sort_order              integer not null default 0,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (tenant_id, code),
  unique (id, tenant_id)
);
create unique index branches_one_main_idx on public.branches (tenant_id) where is_main;
create trigger branches_updated_at before update on public.branches
  for each row execute function app.set_updated_at();

create or replace function app.branches_validate()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform app.assert_valid_timezone(new.timezone);
  return new;
end;
$$;
create trigger branches_validate before insert or update of timezone on public.branches
  for each row execute function app.branches_validate();

-- Weekly opening hours. Several rows per day = split hours (e.g. Friday after prayers).
create table public.branch_working_hours (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null,
  branch_id    uuid not null,
  day_of_week  smallint not null check (day_of_week between 0 and 6),  -- 0 = Sunday
  opens_at     time not null,
  closes_at    time not null,  -- '24:00' allowed for midnight
  created_at   timestamptz not null default now(),
  constraint branch_working_hours_order check (closes_at > opens_at),
  foreign key (branch_id, tenant_id) references public.branches (id, tenant_id) on delete cascade
);
create index branch_working_hours_branch_idx on public.branch_working_hours (branch_id, day_of_week);
create index branch_working_hours_tenant_idx on public.branch_working_hours (tenant_id);

create table public.user_branch_access (
  tenant_id      uuid not null,
  membership_id  uuid not null,
  branch_id      uuid not null,
  created_at     timestamptz not null default now(),
  primary key (membership_id, branch_id),
  foreign key (membership_id, tenant_id) references public.tenant_memberships (id, tenant_id) on delete cascade,
  foreign key (branch_id, tenant_id) references public.branches (id, tenant_id) on delete cascade
);
create index user_branch_access_branch_idx on public.user_branch_access (branch_id);
create index user_branch_access_tenant_idx on public.user_branch_access (tenant_id);

-- ---------------------------------------------------------------------------
-- Invitations (token stored only as SHA-256 hash)
-- ---------------------------------------------------------------------------
create table public.tenant_invitations (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants (id) on delete cascade,
  email         text not null check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  token_hash    text not null unique,
  role_ids      uuid[] not null default '{}',
  branch_ids    uuid[] not null default '{}',
  all_branches  boolean not null default false,
  status        text not null default 'pending' check (status in ('pending', 'accepted', 'revoked', 'expired')),
  expires_at    timestamptz not null default (now() + interval '7 days'),
  invited_by    uuid references auth.users (id) on delete set null,
  accepted_by   uuid references auth.users (id) on delete set null,
  accepted_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index tenant_invitations_one_pending_idx
  on public.tenant_invitations (tenant_id, email) where status = 'pending';
create trigger tenant_invitations_updated_at before update on public.tenant_invitations
  for each row execute function app.set_updated_at();

-- ---------------------------------------------------------------------------
-- Audit log (append-only)
-- ---------------------------------------------------------------------------
create table public.audit_logs (
  id             bigint generated always as identity primary key,
  tenant_id      uuid references public.tenants (id),  -- null = platform-level event
  branch_id      uuid,
  actor_user_id  uuid,
  action         text not null check (char_length(action) <= 80),
  entity_type    text not null check (char_length(entity_type) <= 80),
  entity_id      text,
  old_data       jsonb,
  new_data       jsonb,
  metadata       jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);
create index audit_logs_tenant_created_idx on public.audit_logs (tenant_id, created_at desc);
create index audit_logs_entity_idx on public.audit_logs (tenant_id, entity_type, entity_id);

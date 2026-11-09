-- =============================================================================
-- Salonzoft · Migration 0001 · Foundation
-- -----------------------------------------------------------------------------
-- * Least-privilege defaults (nothing in `public` is reachable by anon /
--   authenticated unless a later migration grants it explicitly).
-- * Private `app` schema for helpers (NOT exposed through the Data API).
-- * Platform catalogues: modules, permissions, subscription plans, role
--   templates. These are reference data required in every environment, so
--   they live in migrations rather than seed.sql.
-- * User profiles (1:1 with auth.users).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Least-privilege default privileges
-- Supabase grants ALL on new public objects to anon/authenticated by default.
-- We revoke that so every table / function must be granted deliberately.
-- ---------------------------------------------------------------------------
alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated, public;

-- ---------------------------------------------------------------------------
-- 2. Private helper schema
-- ---------------------------------------------------------------------------
create schema if not exists app;
revoke all on schema app from public;
grant usage on schema app to authenticated, service_role;
alter default privileges in schema app revoke all on functions from public;

comment on schema app is
  'Salonzoft private helpers (authorization, auditing, triggers). Not exposed via PostgREST.';

-- updated_at maintenance -------------------------------------------------------
create or replace function app.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Structured business errors ---------------------------------------------------
-- Errors surface through PostgREST as { code, message, details, hint }.
--   message = stable machine-readable error code (e.g. TENANT_SLUG_TAKEN)
--   details = human readable English explanation
--   code    = P0001 (business rule) | 42501 (authorization) | 28000 (auth)
-- The Angular client maps `message` to a translated string.
create or replace function app.raise(p_code text, p_detail text default null, p_sqlstate text default 'P0001')
returns void
language plpgsql
set search_path = ''
as $$
begin
  raise exception using
    errcode = p_sqlstate,
    message = p_code,
    detail  = coalesce(p_detail, p_code);
end;
$$;

create or replace function app.forbid(p_detail text default 'You do not have permission to perform this action')
returns void
language plpgsql
set search_path = ''
as $$
begin
  perform app.raise('FORBIDDEN', p_detail, '42501');
end;
$$;

create or replace function app.require_user()
returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    perform app.raise('NOT_AUTHENTICATED', 'Sign in required', '28000');
  end if;
  return v_uid;
end;
$$;

-- Timezone validation (used by triggers; pg_timezone_names is not immutable so
-- it cannot live in a CHECK constraint).
create or replace function app.assert_valid_timezone(p_tz text)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_tz is null or not exists (select 1 from pg_catalog.pg_timezone_names where name = p_tz) then
    perform app.raise('INVALID_TIMEZONE', format('Unknown timezone: %s', p_tz));
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Platform catalogues
-- ---------------------------------------------------------------------------
create table public.modules (
  code        text primary key check (code ~ '^[a-z][a-z_]{1,39}$'),
  name_en     text not null,
  name_ar     text not null,
  is_core     boolean not null default false,  -- always entitled
  sort_order  integer not null default 0
);
comment on table public.modules is 'Product modules that can be entitled per subscription plan.';

create table public.permissions (
  code         text primary key check (code ~ '^[a-z][a-z_]*\.[a-z][a-z_]*$'),
  module_code  text not null references public.modules (code),
  name_en      text not null,
  name_ar      text not null,
  sort_order   integer not null default 0
);
create index permissions_module_idx on public.permissions (module_code);
comment on table public.permissions is 'Fine-grained permission catalogue (module.action).';

create table public.subscription_plans (
  id                    uuid primary key default gen_random_uuid(),
  code                  text not null unique check (code ~ '^[a-z][a-z0-9_]{1,39}$'),
  name_en               text not null,
  name_ar               text not null,
  description_en        text,
  description_ar        text,
  currency_code         char(3) not null default 'OMR',
  price_monthly         numeric(12,3) not null default 0 check (price_monthly >= 0),
  price_yearly          numeric(12,3) check (price_yearly >= 0),
  max_branches          integer check (max_branches > 0),          -- null = unlimited
  max_staff             integer check (max_staff > 0),             -- null = unlimited
  max_monthly_messages  integer check (max_monthly_messages >= 0), -- null = unlimited
  trial_days            integer not null default 14 check (trial_days >= 0),
  is_public             boolean not null default true,
  is_active             boolean not null default true,
  sort_order            integer not null default 0,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create trigger subscription_plans_updated_at before update on public.subscription_plans
  for each row execute function app.set_updated_at();

create table public.plan_modules (
  plan_id      uuid not null references public.subscription_plans (id) on delete cascade,
  module_code  text not null references public.modules (code),
  primary key (plan_id, module_code)
);

create table public.role_templates (
  code            text primary key check (code ~ '^[a-z][a-z0-9_]{1,39}$'),
  name_en         text not null,
  name_ar         text not null,
  description_en  text,
  description_ar  text,
  sort_order      integer not null default 0
);

create table public.role_template_permissions (
  role_code        text not null references public.role_templates (code) on delete cascade,
  permission_code  text not null references public.permissions (code) on delete cascade,
  primary key (role_code, permission_code)
);

-- Platform (Salonzoft staff) administrators — managed only by service role.
create table public.platform_admins (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  role        text not null default 'admin' check (role in ('admin', 'support', 'billing')),
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 4. Reference data
-- ---------------------------------------------------------------------------
insert into public.modules (code, name_en, name_ar, is_core, sort_order) values
  ('dashboard',      'Dashboard',              'لوحة التحكم',           true,  10),
  ('settings',       'Settings',               'الإعدادات',              true,  20),
  ('team',           'Team & Roles',           'الفريق والأدوار',        true,  30),
  ('appointments',   'Appointments',           'المواعيد',               false, 40),
  ('customers',      'Customers',              'العملاء',                false, 50),
  ('services',       'Services & Pricing',     'الخدمات والأسعار',       false, 60),
  ('pos',            'POS & Billing',          'نقاط البيع والفوترة',    false, 70),
  ('packages',       'Packages & Memberships', 'الباقات والعضويات',      false, 80),
  ('employees',      'Employees',              'الموظفون',               false, 90),
  ('inventory',      'Inventory',              'المخزون',                false, 100),
  ('purchases',      'Purchasing',             'المشتريات',              false, 110),
  ('finance',        'Expenses & Finance',     'المصروفات والمالية',     false, 120),
  ('loyalty',        'Loyalty',                'برنامج الولاء',          false, 130),
  ('marketing',      'Marketing',              'التسويق',                false, 140),
  ('notifications',  'WhatsApp, SMS & Email',  'واتساب والرسائل والبريد', false, 150),
  ('reports',        'Reports',                'التقارير',               false, 160),
  ('online_booking', 'Online Booking',         'الحجز الإلكتروني',       false, 170),
  ('multi_branch',   'Multi-Branch',           'تعدد الفروع',            false, 180);

insert into public.permissions (code, module_code, name_en, name_ar, sort_order) values
  ('dashboard.view',          'dashboard',      'View dashboard',                 'عرض لوحة التحكم',            10),
  ('settings.view',           'settings',       'View business settings',         'عرض إعدادات النشاط',          20),
  ('settings.manage',         'settings',       'Manage business settings',       'إدارة إعدادات النشاط',        21),
  ('branches.manage',         'settings',       'Manage branches',                'إدارة الفروع',               22),
  ('billing.manage',          'settings',       'Manage subscription & billing',  'إدارة الاشتراك والفوترة',     23),
  ('audit.view',              'settings',       'View audit log',                 'عرض سجل التدقيق',            24),
  ('team.view',               'team',           'View team members',              'عرض أعضاء الفريق',            30),
  ('team.manage',             'team',           'Invite & manage team members',   'دعوة وإدارة أعضاء الفريق',    31),
  ('roles.manage',            'team',           'Manage roles & permissions',     'إدارة الأدوار والصلاحيات',    32),
  ('appointments.view',       'appointments',   'View appointments',              'عرض المواعيد',               40),
  ('appointments.manage',     'appointments',   'Create & manage appointments',   'إنشاء وإدارة المواعيد',       41),
  ('appointments.own',        'appointments',   'View own appointments',          'عرض المواعيد الخاصة',         42),
  ('customers.view',          'customers',      'View customers',                 'عرض العملاء',                50),
  ('customers.manage',        'customers',      'Create & edit customers',        'إضافة وتعديل العملاء',        51),
  ('customers.export',        'customers',      'Export customer data',           'تصدير بيانات العملاء',        52),
  ('customers.sensitive',     'customers',      'View sensitive customer data',   'عرض بيانات العملاء الحساسة',  53),
  ('services.view',           'services',       'View services & prices',         'عرض الخدمات والأسعار',        60),
  ('services.manage',         'services',       'Manage services & prices',       'إدارة الخدمات والأسعار',      61),
  ('pos.access',              'pos',            'Use POS & create invoices',      'استخدام نقاط البيع',          70),
  ('pos.discount',            'pos',            'Apply manual discounts',         'تطبيق خصومات يدوية',         71),
  ('pos.refund',              'pos',            'Issue refunds & credit notes',   'إصدار المرتجعات والإشعارات الدائنة', 72),
  ('pos.cash_session',        'pos',            'Open & close cash sessions',     'فتح وإغلاق جلسات الصندوق',   73),
  ('packages.view',           'packages',       'View packages & memberships',    'عرض الباقات والعضويات',       80),
  ('packages.manage',         'packages',       'Manage packages & memberships',  'إدارة الباقات والعضويات',     81),
  ('employees.view',          'employees',      'View employees',                 'عرض الموظفين',               90),
  ('employees.manage',        'employees',      'Manage employees & schedules',   'إدارة الموظفين والجداول',     91),
  ('attendance.manage',       'employees',      'Manage attendance & leave',      'إدارة الحضور والإجازات',      92),
  ('commissions.view',        'employees',      'View all commissions',           'عرض جميع العمولات',           93),
  ('commissions.own',         'employees',      'View own commissions',           'عرض العمولات الخاصة',         94),
  ('inventory.view',          'inventory',      'View inventory',                 'عرض المخزون',                100),
  ('inventory.manage',        'inventory',      'Adjust & transfer stock',        'تعديل ونقل المخزون',          101),
  ('purchases.manage',        'purchases',      'Manage suppliers & purchases',   'إدارة الموردين والمشتريات',   110),
  ('finance.view',            'finance',        'View finance',                   'عرض المالية',                120),
  ('finance.manage',          'finance',        'Record expenses & cash',         'تسجيل المصروفات والنقد',      121),
  ('expenses.approve',        'finance',        'Approve expenses',               'اعتماد المصروفات',            122),
  ('loyalty.manage',          'loyalty',        'Manage loyalty programme',       'إدارة برنامج الولاء',         130),
  ('marketing.manage',        'marketing',      'Manage campaigns & coupons',     'إدارة الحملات والقسائم',      140),
  ('notifications.manage',    'notifications',  'Manage templates & messaging',   'إدارة القوالب والرسائل',      150),
  ('reports.view',            'reports',        'View operational reports',       'عرض التقارير التشغيلية',      160),
  ('reports.financial',       'reports',        'View financial reports',         'عرض التقارير المالية',        161),
  ('online_booking.manage',   'online_booking', 'Manage online booking page',     'إدارة صفحة الحجز الإلكتروني', 170);

insert into public.subscription_plans
  (code, name_en, name_ar, description_en, description_ar, price_monthly, price_yearly,
   max_branches, max_staff, max_monthly_messages, trial_days, sort_order)
values
  ('starter', 'Starter', 'الأساسية',
   'Single-branch salons getting started', 'للصالونات ذات الفرع الواحد',
   15.000, 150.000, 1, 5, 500, 14, 10),
  ('professional', 'Professional', 'الاحترافية',
   'Growing salons and spas', 'للصالونات والمنتجعات المتنامية',
   35.000, 350.000, 3, 25, 3000, 14, 20),
  ('enterprise', 'Enterprise', 'المؤسسات',
   'Multi-branch beauty groups', 'لمجموعات التجميل متعددة الفروع',
   75.000, 750.000, null, null, null, 14, 30);

-- Starter: everything except multi-branch, purchasing, marketing automation.
insert into public.plan_modules (plan_id, module_code)
select p.id, m.code
from public.subscription_plans p
cross join public.modules m
where p.code = 'starter'
  and m.code not in ('multi_branch', 'purchases', 'marketing', 'loyalty');

insert into public.plan_modules (plan_id, module_code)
select p.id, m.code
from public.subscription_plans p
cross join public.modules m
where p.code in ('professional', 'enterprise');

insert into public.role_templates (code, name_en, name_ar, description_en, description_ar, sort_order) values
  ('manager',      'Manager',       'مدير',        'Runs day-to-day operations of assigned branches', 'يدير العمليات اليومية للفروع المسندة', 10),
  ('receptionist', 'Receptionist',  'موظف استقبال', 'Bookings, customers and front desk',               'الحجوزات والعملاء والاستقبال',         20),
  ('cashier',      'Cashier',       'أمين صندوق',   'POS, payments and cash sessions',                  'نقاط البيع والمدفوعات والصندوق',       30),
  ('stylist',      'Stylist / Therapist', 'مصفف / أخصائي', 'Own schedule, appointments and commissions', 'الجدول والمواعيد والعمولات الخاصة',    40),
  ('accountant',   'Accountant',    'محاسب',        'Finance, expenses and financial reports',          'المالية والمصروفات والتقارير المالية', 50);

insert into public.role_template_permissions (role_code, permission_code)
select 'manager', code from public.permissions
where code not in ('billing.manage', 'roles.manage', 'settings.manage', 'branches.manage', 'audit.view');

insert into public.role_template_permissions (role_code, permission_code) values
  ('receptionist', 'dashboard.view'),
  ('receptionist', 'appointments.view'),
  ('receptionist', 'appointments.manage'),
  ('receptionist', 'customers.view'),
  ('receptionist', 'customers.manage'),
  ('receptionist', 'services.view'),
  ('receptionist', 'packages.view'),
  ('receptionist', 'employees.view'),
  ('receptionist', 'pos.access'),
  ('cashier', 'dashboard.view'),
  ('cashier', 'appointments.view'),
  ('cashier', 'customers.view'),
  ('cashier', 'services.view'),
  ('cashier', 'packages.view'),
  ('cashier', 'pos.access'),
  ('cashier', 'pos.cash_session'),
  ('stylist', 'appointments.own'),
  ('stylist', 'commissions.own'),
  ('stylist', 'services.view'),
  ('accountant', 'dashboard.view'),
  ('accountant', 'settings.view'),
  ('accountant', 'finance.view'),
  ('accountant', 'finance.manage'),
  ('accountant', 'expenses.approve'),
  ('accountant', 'purchases.manage'),
  ('accountant', 'inventory.view'),
  ('accountant', 'reports.view'),
  ('accountant', 'reports.financial'),
  ('accountant', 'commissions.view');

-- ---------------------------------------------------------------------------
-- 5. Profiles (1:1 with auth.users)
-- ---------------------------------------------------------------------------
create table public.profiles (
  id                  uuid primary key references auth.users (id) on delete cascade,
  full_name           text check (char_length(full_name) <= 120),
  phone               text check (phone ~ '^\+?[0-9]{6,15}$'),
  preferred_language  text not null default 'en' check (preferred_language in ('en', 'ar')),
  avatar_path         text check (char_length(avatar_path) <= 512),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create trigger profiles_updated_at before update on public.profiles
  for each row execute function app.set_updated_at();

-- Create a profile for every new auth user. user_metadata is client-controlled,
-- so only harmless display fields are copied and they are sanitised.
create or replace function app.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lang text := new.raw_user_meta_data ->> 'preferred_language';
begin
  insert into public.profiles (id, full_name, preferred_language)
  values (
    new.id,
    left(nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''), 120),
    case when v_lang in ('en', 'ar') then v_lang else 'en' end
  )
  on conflict (id) do nothing;
  return new;
end;
$$;
revoke all on function app.handle_new_user() from public;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function app.handle_new_user();

-- =============================================================================
-- Salonzoft · Migration 0004 · Row Level Security + least-privilege grants
-- -----------------------------------------------------------------------------
-- Rules:
--  * RLS is enabled on EVERY table in `public`.
--  * Grants are explicit and column-scoped where updates are allowed, so a
--    client can never move a row to another tenant (tenant_id is never
--    updatable) or flip privileged flags (is_owner, is_system, status…).
--  * Writes to membership / role assignment / invitation / subscription
--    tables happen ONLY through audited RPC functions (migration 0006).
-- =============================================================================

-- Enable RLS everywhere -----------------------------------------------------------
alter table public.modules                    enable row level security;
alter table public.permissions                enable row level security;
alter table public.subscription_plans         enable row level security;
alter table public.plan_modules               enable row level security;
alter table public.role_templates             enable row level security;
alter table public.role_template_permissions  enable row level security;
alter table public.platform_admins            enable row level security;
alter table public.profiles                   enable row level security;
alter table public.tenants                    enable row level security;
alter table public.tenant_settings            enable row level security;
alter table public.tenant_subscriptions       enable row level security;
alter table public.module_entitlements        enable row level security;
alter table public.tenant_usage               enable row level security;
alter table public.roles                      enable row level security;
alter table public.role_permissions           enable row level security;
alter table public.tenant_memberships         enable row level security;
alter table public.user_roles                 enable row level security;
alter table public.branches                   enable row level security;
alter table public.branch_working_hours       enable row level security;
alter table public.user_branch_access         enable row level security;
alter table public.tenant_invitations         enable row level security;
alter table public.audit_logs                 enable row level security;

-- Start from zero ---------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
grant usage on schema public to anon, authenticated;

-- service_role (Edge Functions with elevated credentials) bypasses RLS but
-- still needs table privileges.
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

-- ---------------------------------------------------------------------------
-- Catalogues (non-sensitive reference data)
-- ---------------------------------------------------------------------------
grant select on public.modules, public.permissions, public.role_templates,
                public.role_template_permissions, public.plan_modules to authenticated;
grant select on public.subscription_plans to anon, authenticated;

create policy modules_read on public.modules for select to authenticated using (true);
create policy permissions_read on public.permissions for select to authenticated using (true);
create policy role_templates_read on public.role_templates for select to authenticated using (true);
create policy role_template_permissions_read on public.role_template_permissions for select to authenticated using (true);
create policy plan_modules_read on public.plan_modules for select to authenticated using (true);
create policy subscription_plans_read_public on public.subscription_plans
  for select to anon, authenticated
  using (is_public and is_active);
create policy subscription_plans_read_own on public.subscription_plans
  for select to authenticated
  using (id in (select s.plan_id from public.tenant_subscriptions s
                where s.tenant_id in (select app.my_tenant_ids())));

-- ---------------------------------------------------------------------------
-- Platform admins: a user may only learn whether *they* are an admin.
-- ---------------------------------------------------------------------------
grant select on public.platform_admins to authenticated;
create policy platform_admins_self on public.platform_admins
  for select to authenticated
  using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- Profiles
-- ---------------------------------------------------------------------------
grant select on public.profiles to authenticated;
grant update (full_name, phone, preferred_language, avatar_path) on public.profiles to authenticated;

create policy profiles_select on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) or id in (select app.visible_user_ids()));

create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- Tenants & settings
-- ---------------------------------------------------------------------------
grant select on public.tenants to authenticated;
grant update (name, name_ar, legal_name, business_type) on public.tenants to authenticated;

create policy tenants_select_member on public.tenants
  for select to authenticated
  using (id in (select app.my_tenant_ids()));

create policy tenants_update_settings on public.tenants
  for update to authenticated
  using (id in (select app.tenants_with_permission('settings.manage')))
  with check (id in (select app.tenants_with_permission('settings.manage')));

grant select on public.tenant_settings to authenticated;
grant update (default_language, currency_decimals, timezone, phone_country_code, weekend_days,
              week_starts_on, show_hijri_dates, vat_registered, vat_number, default_vat_rate,
              prices_include_vat, invoice_prefix, receipt_footer_en, receipt_footer_ar, logo_path)
  on public.tenant_settings to authenticated;

create policy tenant_settings_select_member on public.tenant_settings
  for select to authenticated
  using (tenant_id in (select app.my_tenant_ids()));

create policy tenant_settings_update on public.tenant_settings
  for update to authenticated
  using (tenant_id in (select app.tenants_with_permission('settings.manage')))
  with check (tenant_id in (select app.tenants_with_permission('settings.manage')));

-- ---------------------------------------------------------------------------
-- Subscription state: read-only for members; written by platform / webhooks.
-- ---------------------------------------------------------------------------
grant select on public.tenant_subscriptions, public.module_entitlements, public.tenant_usage to authenticated;

create policy tenant_subscriptions_select on public.tenant_subscriptions
  for select to authenticated
  using (tenant_id in (select app.my_tenant_ids()));

create policy module_entitlements_select on public.module_entitlements
  for select to authenticated
  using (tenant_id in (select app.my_tenant_ids()));

create policy tenant_usage_select on public.tenant_usage
  for select to authenticated
  using (tenant_id in (select app.tenants_with_permission('billing.manage')));

-- ---------------------------------------------------------------------------
-- Roles & role permissions
-- ---------------------------------------------------------------------------
grant select, delete on public.roles to authenticated;
grant insert (tenant_id, code, name_en, name_ar, description) on public.roles to authenticated;
grant update (name_en, name_ar, description) on public.roles to authenticated;

create policy roles_select_member on public.roles
  for select to authenticated
  using (tenant_id in (select app.my_tenant_ids()));

create policy roles_insert on public.roles
  for insert to authenticated
  with check (tenant_id in (select app.tenants_with_permission('roles.manage')) and not is_system);

create policy roles_update on public.roles
  for update to authenticated
  using (tenant_id in (select app.tenants_with_permission('roles.manage')))
  with check (tenant_id in (select app.tenants_with_permission('roles.manage')));

create policy roles_delete on public.roles
  for delete to authenticated
  using (tenant_id in (select app.tenants_with_permission('roles.manage')) and not is_system);

grant select, delete on public.role_permissions to authenticated;
grant insert (tenant_id, role_id, permission_code) on public.role_permissions to authenticated;

create policy role_permissions_select_member on public.role_permissions
  for select to authenticated
  using (tenant_id in (select app.my_tenant_ids()));

-- Anti-escalation: you can only grant a permission you hold yourself.
create policy role_permissions_insert on public.role_permissions
  for insert to authenticated
  with check (tenant_id in (select app.tenants_with_permission('roles.manage'))
              and app.has_permission(tenant_id, permission_code));

create policy role_permissions_delete on public.role_permissions
  for delete to authenticated
  using (tenant_id in (select app.tenants_with_permission('roles.manage'))
         and app.has_permission(tenant_id, permission_code));

-- ---------------------------------------------------------------------------
-- Memberships, role assignments, branch access: read via RLS, write via RPC.
-- ---------------------------------------------------------------------------
grant select on public.tenant_memberships, public.user_roles, public.user_branch_access to authenticated;

create policy tenant_memberships_select on public.tenant_memberships
  for select to authenticated
  using (user_id = (select auth.uid())
         or tenant_id in (select app.tenants_with_permission('team.view')));

create policy user_roles_select on public.user_roles
  for select to authenticated
  using (membership_id in (select m.id from public.tenant_memberships m where m.user_id = (select auth.uid()))
         or tenant_id in (select app.tenants_with_permission('team.view')));

create policy user_branch_access_select on public.user_branch_access
  for select to authenticated
  using (membership_id in (select m.id from public.tenant_memberships m where m.user_id = (select auth.uid()))
         or tenant_id in (select app.tenants_with_permission('team.view')));

-- ---------------------------------------------------------------------------
-- Branches & working hours
-- ---------------------------------------------------------------------------
grant select on public.branches to authenticated;
grant insert (tenant_id, code, name_en, name_ar, phone, email, address_en, address_ar, city,
              governorate, timezone, latitude, longitude, is_active, online_booking_enabled, sort_order)
  on public.branches to authenticated;
grant update (code, name_en, name_ar, phone, email, address_en, address_ar, city,
              governorate, timezone, latitude, longitude, is_active, is_main, online_booking_enabled, sort_order)
  on public.branches to authenticated;

create policy branches_select on public.branches
  for select to authenticated
  using (id in (select app.accessible_branch_ids())
         or tenant_id in (select app.tenants_with_permission('branches.manage')));

create policy branches_insert on public.branches
  for insert to authenticated
  with check (tenant_id in (select app.tenants_with_permission('branches.manage')));

create policy branches_update on public.branches
  for update to authenticated
  using (tenant_id in (select app.tenants_with_permission('branches.manage')))
  with check (tenant_id in (select app.tenants_with_permission('branches.manage')));

grant select, delete on public.branch_working_hours to authenticated;
grant insert (tenant_id, branch_id, day_of_week, opens_at, closes_at) on public.branch_working_hours to authenticated;

create policy branch_working_hours_select on public.branch_working_hours
  for select to authenticated
  using (branch_id in (select app.accessible_branch_ids())
         or tenant_id in (select app.tenants_with_permission('branches.manage')));

create policy branch_working_hours_insert on public.branch_working_hours
  for insert to authenticated
  with check (tenant_id in (select app.tenants_with_permission('branches.manage')));

create policy branch_working_hours_delete on public.branch_working_hours
  for delete to authenticated
  using (tenant_id in (select app.tenants_with_permission('branches.manage')));

-- ---------------------------------------------------------------------------
-- Invitations: token_hash is never readable by API roles.
-- ---------------------------------------------------------------------------
grant select (id, tenant_id, email, role_ids, branch_ids, all_branches, status, expires_at,
              invited_by, accepted_by, accepted_at, created_at, updated_at)
  on public.tenant_invitations to authenticated;

create policy tenant_invitations_select on public.tenant_invitations
  for select to authenticated
  using (tenant_id in (select app.tenants_with_permission('team.manage')));

-- ---------------------------------------------------------------------------
-- Audit log: read-only, permission-gated; nobody can write directly.
-- ---------------------------------------------------------------------------
grant select on public.audit_logs to authenticated;
create policy audit_logs_select on public.audit_logs
  for select to authenticated
  using (tenant_id in (select app.tenants_with_permission('audit.view')));

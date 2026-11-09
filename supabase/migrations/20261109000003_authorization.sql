-- =============================================================================
-- Salonzoft · Migration 0003 · Authorization helpers
-- -----------------------------------------------------------------------------
-- Centralised, server-validated authorization. Nothing here trusts JWT
-- user_metadata, client-supplied tenant ids, roles or subscription status:
-- every answer is derived from tenant_memberships / user_roles /
-- role_permissions / module_entitlements / tenant_subscriptions.
--
-- The helpers are SECURITY DEFINER so they can read the membership tables
-- without recursing through those tables' own RLS policies. They:
--   * live in the private `app` schema (not callable through PostgREST),
--   * pin search_path = '' and fully qualify every object,
--   * only ever answer questions about auth.uid() (the caller).
--
-- RLS policies use the set-returning variants inside `IN (SELECT …)` so
-- Postgres evaluates them once per statement (InitPlan) instead of per row.
-- =============================================================================

-- Is the tenant allowed to operate (active tenant + live subscription)?
create or replace function app.tenant_is_operational(p_tenant uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.tenants t
    join public.tenant_subscriptions s on s.tenant_id = t.id
    where t.id = p_tenant
      and t.status = 'active'
      and s.status in ('trialing', 'active', 'past_due')
      and (s.status <> 'trialing' or s.trial_ends_at > now())
  );
$$;

-- Is the module entitled for the tenant? Core modules are always entitled.
create or replace function app.module_enabled(p_tenant uuid, p_module text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.modules m where m.code = p_module and m.is_core)
      or exists (
        select 1
        from public.module_entitlements e
        where e.tenant_id = p_tenant
          and e.module_code = p_module
          and e.is_enabled
          and (e.valid_until is null or e.valid_until > now())
      );
$$;

-- Permissions an owner keeps while the tenant is not operational
-- (expired trial / suspended), so they can see status and fix billing.
create or replace function app.degraded_owner_permissions()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['dashboard.view', 'settings.view', 'billing.manage', 'team.view']::text[];
$$;

-- Tenants where the caller has an active membership (tenant not closed).
create or replace function app.my_tenant_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.tenant_id
  from public.tenant_memberships m
  join public.tenants t on t.id = m.tenant_id
  where m.user_id = auth.uid()
    and m.status = 'active'
    and t.status <> 'closed';
$$;

create or replace function app.is_tenant_member(p_tenant uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from app.my_tenant_ids() x where x = p_tenant);
$$;

-- Effective permission codes of the caller in a tenant.
create or replace function app.permissions_for(p_tenant uuid)
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
  with mem as (
    select m.id, m.is_owner
    from public.tenant_memberships m
    join public.tenants t on t.id = m.tenant_id
    where m.tenant_id = p_tenant
      and m.user_id = auth.uid()
      and m.status = 'active'
      and t.status <> 'closed'
  ),
  operational as (
    select app.tenant_is_operational(p_tenant) as ok
  ),
  granted as (
    -- owners hold every permission
    select p.code
    from public.permissions p, mem
    where mem.is_owner
    union
    select rp.permission_code
    from mem
    join public.user_roles ur on ur.membership_id = mem.id
    join public.role_permissions rp on rp.role_id = ur.role_id
  )
  select g.code
  from granted g
  join public.permissions p on p.code = g.code
  cross join operational o
  cross join mem
  where (o.ok and app.module_enabled(p_tenant, p.module_code))
     or (not o.ok and mem.is_owner and g.code = any (app.degraded_owner_permissions()));
$$;

create or replace function app.has_permission(p_tenant uuid, p_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from app.permissions_for(p_tenant) x where x = p_permission);
$$;

-- Tenants in which the caller holds a permission (for RLS InitPlans).
create or replace function app.tenants_with_permission(p_permission text)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select t.tenant_id
  from app.my_tenant_ids() as t(tenant_id)
  where app.has_permission(t.tenant_id, p_permission);
$$;

-- Branches the caller may access (owner / all_branches ⇒ every branch).
create or replace function app.accessible_branch_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select b.id
  from public.tenant_memberships m
  join public.tenants t on t.id = m.tenant_id
  join public.branches b on b.tenant_id = m.tenant_id
  where m.user_id = auth.uid()
    and m.status = 'active'
    and t.status <> 'closed'
    and (m.is_owner or m.all_branches)
  union
  select uba.branch_id
  from public.tenant_memberships m
  join public.tenants t on t.id = m.tenant_id
  join public.user_branch_access uba on uba.membership_id = m.id
  where m.user_id = auth.uid()
    and m.status = 'active'
    and t.status <> 'closed';
$$;

create or replace function app.has_branch_access(p_branch uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from app.accessible_branch_ids() x where x = p_branch);
$$;

-- Branches where the caller holds `p_permission` AND has branch access.
-- Branch-scoped business tables (appointments, invoices, stock…) use this.
create or replace function app.branch_ids_with_permission(p_permission text)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select b.id
  from public.branches b
  where b.tenant_id in (select app.tenants_with_permission(p_permission))
    and b.id in (select app.accessible_branch_ids());
$$;

-- Users that share a tenant with the caller where the caller can view the team.
create or replace function app.visible_user_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.user_id
  from public.tenant_memberships m
  where m.tenant_id in (select app.tenants_with_permission('team.view'));
$$;

create or replace function app.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.platform_admins pa where pa.user_id = auth.uid());
$$;

-- Raise FORBIDDEN unless the caller holds the permission.
create or replace function app.require_permission(p_tenant uuid, p_permission text)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  perform app.require_user();
  if p_tenant is null or not app.has_permission(p_tenant, p_permission) then
    perform app.forbid(format('Missing permission %s', p_permission));
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Audit helper (append-only). SECURITY DEFINER because audit_logs has no
-- write grants for API roles.
-- ---------------------------------------------------------------------------
create or replace function app.audit(
  p_tenant uuid,
  p_action text,
  p_entity_type text,
  p_entity_id text,
  p_old jsonb default null,
  p_new jsonb default null,
  p_metadata jsonb default '{}'::jsonb,
  p_branch uuid default null
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.audit_logs
    (tenant_id, branch_id, actor_user_id, action, entity_type, entity_id, old_data, new_data, metadata)
  values
    (p_tenant, p_branch, auth.uid(), p_action, p_entity_type, p_entity_id, p_old, p_new,
     coalesce(p_metadata, '{}'::jsonb));
$$;

-- Generic row-level audit trigger. Sensitive columns are stripped.
create or replace function app.audit_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) - 'token_hash' - 'updated_at' end;
  v_new jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) - 'token_hash' - 'updated_at' end;
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
                          concat_ws(':', v_row ->> 'membership_id', v_row ->> 'role_id',
                                         v_row ->> 'branch_id', v_row ->> 'permission_code',
                                         v_row ->> 'module_code', v_row ->> 'tenant_id'));

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
-- Execute privileges: helpers are needed by `authenticated` for RLS
-- evaluation. They only ever describe the caller, so this is safe, and the
-- `app` schema is not exposed through the Data API.
-- ---------------------------------------------------------------------------
revoke all on all functions in schema app from public;

grant execute on function
  app.tenant_is_operational(uuid),
  app.module_enabled(uuid, text),
  app.degraded_owner_permissions(),
  app.my_tenant_ids(),
  app.is_tenant_member(uuid),
  app.permissions_for(uuid),
  app.has_permission(uuid, text),
  app.tenants_with_permission(text),
  app.accessible_branch_ids(),
  app.has_branch_access(uuid),
  app.branch_ids_with_permission(text),
  app.visible_user_ids(),
  app.is_platform_admin(),
  app.require_permission(uuid, text),
  app.require_user(),
  app.raise(text, text, text),
  app.forbid(text),
  app.assert_valid_timezone(text),
  app.set_updated_at(),
  app.tenant_settings_validate(),
  app.branches_validate()
to authenticated, service_role;

-- app.audit is only callable from other SECURITY DEFINER functions (owner).
grant execute on function app.audit(uuid, text, text, text, jsonb, jsonb, jsonb, uuid) to service_role;

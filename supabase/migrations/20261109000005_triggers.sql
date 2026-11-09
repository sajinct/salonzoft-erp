-- =============================================================================
-- Salonzoft · Migration 0005 · Audit trails & plan limits
-- =============================================================================

-- Row-level audit on security-relevant tables ------------------------------------
create trigger audit_tenants              after insert or update or delete on public.tenants
  for each row execute function app.audit_row();
create trigger audit_tenant_settings      after insert or update or delete on public.tenant_settings
  for each row execute function app.audit_row();
create trigger audit_tenant_subscriptions after insert or update or delete on public.tenant_subscriptions
  for each row execute function app.audit_row();
create trigger audit_module_entitlements  after insert or update or delete on public.module_entitlements
  for each row execute function app.audit_row();
create trigger audit_roles                after insert or update or delete on public.roles
  for each row execute function app.audit_row();
create trigger audit_role_permissions     after insert or delete on public.role_permissions
  for each row execute function app.audit_row();
create trigger audit_tenant_memberships   after insert or update or delete on public.tenant_memberships
  for each row execute function app.audit_row();
create trigger audit_user_roles           after insert or delete on public.user_roles
  for each row execute function app.audit_row();
create trigger audit_user_branch_access   after insert or delete on public.user_branch_access
  for each row execute function app.audit_row();
create trigger audit_branches             after insert or update or delete on public.branches
  for each row execute function app.audit_row();
create trigger audit_tenant_invitations   after insert or update on public.tenant_invitations
  for each row execute function app.audit_row();

-- Audit log is append-only even for the table owner's API roles ------------------
create or replace function app.audit_logs_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform app.raise('AUDIT_LOG_IMMUTABLE', 'Audit log entries cannot be modified or deleted');
  return null;
end;
$$;
create trigger audit_logs_no_update before update or delete on public.audit_logs
  for each row execute function app.audit_logs_immutable();

-- Plan limit: branches -------------------------------------------------------------
-- Serialised per tenant by locking the tenant row, so two concurrent inserts
-- cannot both slip under the limit.
create or replace function app.enforce_branch_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_max integer;
  v_count integer;
begin
  perform 1 from public.tenants where id = new.tenant_id for update;

  select p.max_branches into v_max
  from public.tenant_subscriptions s
  join public.subscription_plans p on p.id = s.plan_id
  where s.tenant_id = new.tenant_id
    and s.status in ('trialing', 'active', 'past_due', 'suspended');

  if v_max is null then
    return new;  -- unlimited (or no subscription yet during provisioning)
  end if;

  select count(*) into v_count from public.branches where tenant_id = new.tenant_id;
  if v_count >= v_max then
    perform app.raise('PLAN_LIMIT_BRANCHES',
                      format('Your plan allows %s branch(es). Upgrade to add more.', v_max));
  end if;
  return new;
end;
$$;
create trigger branches_enforce_limit before insert on public.branches
  for each row execute function app.enforce_branch_limit();

-- Exactly one main branch: promoting one demotes the others ------------------------
create or replace function app.branches_single_main()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.is_main then
    update public.branches set is_main = false
    where tenant_id = new.tenant_id and id <> new.id and is_main;
  end if;
  return new;
end;
$$;
create trigger branches_single_main before insert or update of is_main on public.branches
  for each row when (new.is_main) execute function app.branches_single_main();

-- Staff (seat) count helper used by invitation functions -------------------------
create or replace function app.assert_staff_capacity(p_tenant uuid, p_extra integer default 1)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_max integer;
  v_used integer;
begin
  select p.max_staff into v_max
  from public.tenant_subscriptions s
  join public.subscription_plans p on p.id = s.plan_id
  where s.tenant_id = p_tenant
    and s.status in ('trialing', 'active', 'past_due', 'suspended');

  if v_max is null then
    return;
  end if;

  select (select count(*) from public.tenant_memberships m
          where m.tenant_id = p_tenant and m.status = 'active')
       + (select count(*) from public.tenant_invitations i
          where i.tenant_id = p_tenant and i.status = 'pending' and i.expires_at > now())
    into v_used;

  if v_used + p_extra > v_max then
    perform app.raise('PLAN_LIMIT_STAFF',
                      format('Your plan allows %s team member(s). Upgrade to add more.', v_max));
  end if;
end;
$$;

revoke all on function app.audit_logs_immutable(), app.enforce_branch_limit(),
                       app.branches_single_main(), app.assert_staff_capacity(uuid, integer) from public;

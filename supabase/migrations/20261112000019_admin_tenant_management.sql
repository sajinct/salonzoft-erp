-- =============================================================================
-- Salonzoft · Migration 0019 · Super-admin: add and manage businesses and users
-- -----------------------------------------------------------------------------
--  * admin_create_tenant: a platform admin provisions a business for an owner.
--    If the owner's e-mail already has an account the membership is created
--    straight away; otherwise a one-time OWNER invitation link is returned
--    (tenant_invitations.make_owner) and the business has no owner until it is
--    accepted.
--  * admin_update_tenant: name, Arabic name, legal name, type, booking address.
--  * Users of a business: admin_add_member (direct for existing accounts,
--    invitation link otherwise), admin_update_member (roles / branches / job
--    title), admin_set_member_status, admin_transfer_ownership,
--    admin_revoke_invitation.
--  * admin_get_tenant now also returns the roles, branches, member access and
--    pending invitations the console needs.
--  Roles: admin + support, except ownership transfer (admin only). Platform
--  admins still have NO RLS access to tenant tables; everything is audited in
--  platform_audit_logs.
-- =============================================================================

alter table public.tenant_invitations
  add column make_owner boolean not null default false;

-- ---------------------------------------------------------------------------
-- 1. Internal helpers
-- ---------------------------------------------------------------------------
create or replace function app.assert_tenant_slug(p_slug text)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_slug is null or p_slug !~ '^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$' or p_slug ~ '--' then
    perform app.raise('INVALID_SLUG', 'Use 3–48 lowercase letters, digits or single hyphens');
  end if;
  if p_slug = any (array['admin', 'api', 'app', 'auth', 'book', 'booking', 'dashboard', 'help',
                         'login', 'mail', 'salonzoft', 'signup', 'static', 'status', 'support', 'www']) then
    perform app.raise('SLUG_RESERVED', 'This address is reserved');
  end if;
end;
$$;

-- Roles and branches handed out by a platform admin must belong to the business.
create or replace function app.assert_tenant_access_refs(p_tenant uuid, p_role_ids uuid[], p_all_branches boolean, p_branch_ids uuid[])
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_roles uuid[] := coalesce(array(select distinct x from unnest(p_role_ids) x where x is not null), '{}');
  v_branches uuid[] := coalesce(array(select distinct x from unnest(p_branch_ids) x where x is not null), '{}');
begin
  if (select count(*) from public.roles r where r.tenant_id = p_tenant and r.id = any (v_roles)) <> cardinality(v_roles) then
    perform app.raise('INVALID_ROLE', 'One or more roles do not belong to this business');
  end if;
  if not coalesce(p_all_branches, false) then
    if cardinality(v_branches) = 0 then
      perform app.raise('BRANCH_REQUIRED', 'Select at least one branch');
    end if;
    if (select count(*) from public.branches b where b.tenant_id = p_tenant and b.id = any (v_branches)) <> cardinality(v_branches) then
      perform app.raise('INVALID_BRANCH', 'One or more branches do not belong to this business');
    end if;
  end if;
end;
$$;

-- Add a person to a business: a membership when the e-mail has an account,
-- otherwise an invitation (the plaintext token is returned exactly once).
create or replace function app.admin_attach_member(
  p_tenant uuid, p_email text, p_role_ids uuid[], p_all_branches boolean, p_branch_ids uuid[], p_job_title text, p_owner boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_owner boolean := coalesce(p_owner, false);
  v_all boolean := v_owner or coalesce(p_all_branches, false);
  v_roles uuid[] := case when v_owner then '{}'::uuid[]
                         else coalesce(array(select distinct x from unnest(p_role_ids) x where x is not null), '{}') end;
  v_branches uuid[] := case when v_all then '{}'::uuid[]
                            else coalesce(array(select distinct x from unnest(p_branch_ids) x where x is not null), '{}') end;
  v_job text := nullif(btrim(coalesce(p_job_title, '')), '');
  v_user uuid;
  v_mem public.tenant_memberships;
  v_token text;
  v_inv uuid;
  v_expiry timestamptz;
begin
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or char_length(v_email) > 254 then
    perform app.raise('INVALID_EMAIL', 'Enter a valid email address');
  end if;
  if char_length(v_job) > 80 then
    perform app.raise('INVALID_JOB_TITLE', 'Job title is too long');
  end if;

  perform 1 from public.tenants where id = p_tenant for update;
  if not found then
    perform app.raise('NOT_FOUND', 'Business not found');
  end if;
  if v_owner and exists (select 1 from public.tenant_memberships m where m.tenant_id = p_tenant and m.is_owner) then
    perform app.raise('OWNER_EXISTS', 'This business already has an owner; transfer the ownership instead');
  end if;
  if not v_owner then
    perform app.assert_tenant_access_refs(p_tenant, v_roles, v_all, v_branches);
  end if;

  select u.id into v_user from auth.users u where lower(u.email) = v_email;
  if v_user is not null and exists (select 1 from public.tenant_memberships m where m.tenant_id = p_tenant and m.user_id = v_user) then
    perform app.raise('MEMBER_ALREADY_EXISTS', 'This person is already a member');
  end if;

  update public.tenant_invitations set status = 'revoked'
  where tenant_id = p_tenant and email = v_email and status = 'pending';
  perform app.assert_staff_capacity(p_tenant, 1);

  if v_user is not null then
    insert into public.tenant_memberships (tenant_id, user_id, status, is_owner, all_branches, job_title, invited_by)
    values (p_tenant, v_user, 'active', v_owner, v_all, coalesce(v_job, case when v_owner then 'Owner' end), auth.uid())
    returning * into v_mem;
    if not v_owner then
      perform app.apply_member_access(v_mem, v_roles, v_all, v_branches);
    end if;
    return jsonb_build_object('added', true, 'membership_id', v_mem.id, 'email', v_email, 'invitation', null);
  end if;

  v_token := app.new_token();
  insert into public.tenant_invitations (tenant_id, email, token_hash, role_ids, branch_ids, all_branches, make_owner, invited_by)
  values (p_tenant, v_email, app.hash_token(v_token), v_roles, v_branches, v_all, v_owner, auth.uid())
  returning id, expires_at into v_inv, v_expiry;
  return jsonb_build_object('added', false, 'membership_id', null, 'email', v_email,
                            'invitation', jsonb_build_object('invitation_id', v_inv, 'token', v_token, 'email', v_email, 'expires_at', v_expiry));
end;
$$;

revoke all on function
  app.assert_tenant_slug(text),
  app.assert_tenant_access_refs(uuid, uuid[], boolean, uuid[]),
  app.admin_attach_member(uuid, text, uuid[], boolean, uuid[], text, boolean)
from public;

-- ---------------------------------------------------------------------------
-- 2. accept_invitation: an owner invitation makes the accepting user the owner
--    (only while the business still has none).
-- ---------------------------------------------------------------------------
create or replace function public.accept_invitation(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := app.require_user();
  v_inv   public.tenant_invitations%rowtype;
  v_user  record;
  v_mem   public.tenant_memberships%rowtype;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    perform app.raise('INVITATION_INVALID', 'This invitation link is not valid');
  end if;

  select * into v_inv
  from public.tenant_invitations
  where token_hash = app.hash_token(p_token)
  for update;

  if not found or v_inv.status <> 'pending' then
    perform app.raise('INVITATION_INVALID', 'This invitation link is not valid or was already used');
  end if;
  if v_inv.expires_at <= now() then
    perform app.raise('INVITATION_EXPIRED', 'This invitation has expired. Ask for a new one.');
  end if;

  select u.email, u.email_confirmed_at into v_user from auth.users u where u.id = v_uid;
  if v_user.email_confirmed_at is null then
    perform app.raise('EMAIL_NOT_CONFIRMED', 'Confirm your email address first');
  end if;
  if lower(v_user.email) <> v_inv.email then
    perform app.raise('INVITATION_EMAIL_MISMATCH', 'This invitation was sent to a different email address');
  end if;

  perform 1 from public.tenants where id = v_inv.tenant_id and status = 'active' for update;
  if not found then
    perform app.raise('TENANT_UNAVAILABLE', 'This business is not currently active');
  end if;

  select * into v_mem
  from public.tenant_memberships
  where tenant_id = v_inv.tenant_id and user_id = v_uid
  for update;

  if found then
    if v_mem.status <> 'active' then
      update public.tenant_memberships set status = 'active' where id = v_mem.id
      returning * into v_mem;
    end if;
  else
    perform app.assert_staff_capacity(v_inv.tenant_id, 0);  -- this invitation already holds a seat
    insert into public.tenant_memberships (tenant_id, user_id, status, invited_by)
    values (v_inv.tenant_id, v_uid, 'active', v_inv.invited_by)
    returning * into v_mem;
  end if;

  if v_inv.make_owner and not v_mem.is_owner
     and not exists (select 1 from public.tenant_memberships m where m.tenant_id = v_inv.tenant_id and m.is_owner) then
    update public.tenant_memberships
    set is_owner = true, all_branches = true, job_title = coalesce(job_title, 'Owner')
    where id = v_mem.id
    returning * into v_mem;
  end if;

  if not v_mem.is_owner then
    perform app.apply_member_access(v_mem, v_inv.role_ids, v_inv.all_branches, v_inv.branch_ids);
  end if;

  update public.tenant_invitations
  set status = 'accepted', accepted_by = v_uid, accepted_at = now()
  where id = v_inv.id;

  return jsonb_build_object('tenant_id', v_inv.tenant_id, 'membership_id', v_mem.id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Businesses
-- ---------------------------------------------------------------------------
create or replace function public.admin_create_tenant(
  p_name text,
  p_slug text,
  p_owner_email text,
  p_business_type text default 'unisex_salon',
  p_default_language text default 'en',
  p_plan_code text default 'professional',
  p_branch_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name   text := btrim(p_name);
  v_slug   text := lower(btrim(p_slug));
  v_lang   text := coalesce(p_default_language, 'en');
  v_type   text := coalesce(p_business_type, 'unisex_salon');
  v_plan   public.subscription_plans%rowtype;
  v_tenant uuid;
  v_branch uuid;
  v_owner  jsonb;
begin
  perform app.require_platform_admin(array['admin', 'support']);

  if v_name is null or char_length(v_name) not between 2 and 120 then
    perform app.raise('INVALID_NAME', 'Business name must be 2–120 characters');
  end if;
  perform app.assert_tenant_slug(v_slug);
  if v_lang not in ('en', 'ar') then
    perform app.raise('INVALID_LANGUAGE', 'Language must be en or ar');
  end if;
  if v_type not in ('barbershop', 'beauty_salon', 'unisex_salon', 'nail_studio', 'makeup_studio', 'spa', 'multi_concept') then
    perform app.raise('INVALID_BUSINESS_TYPE', 'Unknown business type');
  end if;
  if lower(btrim(coalesce(p_owner_email, ''))) !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    perform app.raise('INVALID_EMAIL', 'Enter a valid email address');
  end if;
  if exists (select 1 from public.tenants t where t.slug = v_slug) then
    perform app.raise('TENANT_SLUG_TAKEN', 'This booking address is already taken');
  end if;
  select * into v_plan from public.subscription_plans where code = coalesce(p_plan_code, 'professional') and is_active;
  if not found then
    perform app.raise('PLAN_NOT_FOUND', 'Unknown plan');
  end if;

  begin
    insert into public.tenants (slug, name, business_type, created_by)
    values (v_slug, v_name, v_type, auth.uid())
    returning id into v_tenant;
  exception when unique_violation then
    perform app.raise('TENANT_SLUG_TAKEN', 'This booking address is already taken');
  end;

  insert into public.tenant_settings (tenant_id, default_language) values (v_tenant, v_lang);

  insert into public.tenant_subscriptions (tenant_id, plan_id, status, trial_ends_at, current_period_end)
  values (v_tenant, v_plan.id, 'trialing',
          now() + make_interval(days => v_plan.trial_days),
          now() + make_interval(days => v_plan.trial_days));

  insert into public.module_entitlements (tenant_id, module_code, source)
  select v_tenant, pm.module_code, 'plan' from public.plan_modules pm where pm.plan_id = v_plan.id;

  insert into public.roles (tenant_id, code, name_en, name_ar, description, is_system, template_code)
  select v_tenant, rt.code, rt.name_en, rt.name_ar, rt.description_en, true, rt.code
  from public.role_templates rt;

  insert into public.role_permissions (tenant_id, role_id, permission_code)
  select v_tenant, r.id, rtp.permission_code
  from public.roles r
  join public.role_template_permissions rtp on rtp.role_code = r.template_code
  where r.tenant_id = v_tenant;

  insert into public.branches (tenant_id, code, name_en, is_main)
  values (v_tenant, 'MAIN', coalesce(nullif(btrim(p_branch_name), ''), v_name), true)
  returning id into v_branch;

  -- Default hours: Sat–Thu 09:00–22:00, Friday 14:00–22:00 (after Jumu'ah).
  insert into public.branch_working_hours (tenant_id, branch_id, day_of_week, opens_at, closes_at)
  select v_tenant, v_branch, d, case when d = 5 then time '14:00' else time '09:00' end, time '22:00'
  from generate_series(0, 6) as d;

  v_owner := app.admin_attach_member(v_tenant, p_owner_email, '{}', true, '{}', null, true);

  perform app.audit(v_tenant, 'tenant.created', 'tenants', v_tenant::text, null, null,
                    jsonb_build_object('plan', v_plan.code, 'slug', v_slug, 'by', 'platform_admin'));
  perform app.platform_audit('tenant.created', v_tenant, 'tenants', v_tenant::text,
                             jsonb_build_object('slug', v_slug, 'plan', v_plan.code, 'owner', v_owner ->> 'email',
                                                'owner_invited', not (v_owner ->> 'added')::boolean));

  return jsonb_build_object('tenant_id', v_tenant, 'branch_id', v_branch, 'slug', v_slug,
                            'owner_added', (v_owner ->> 'added')::boolean, 'invitation', v_owner -> 'invitation');
end;
$$;

-- Patch of name / name_ar / legal_name / business_type / slug (only the keys present are changed).
create or replace function public.admin_update_tenant(p_tenant uuid, p_patch jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old public.tenants;
  v_name text;
  v_slug text;
  v_type text;
begin
  perform app.require_platform_admin(array['admin', 'support']);
  select * into v_old from public.tenants where id = p_tenant for update;
  if not found then
    perform app.raise('NOT_FOUND', 'Business not found');
  end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object'
     or exists (select 1 from jsonb_object_keys(p_patch) k where k not in ('name', 'name_ar', 'legal_name', 'business_type', 'slug')) then
    perform app.raise('INVALID_VALUE', 'Unknown field');
  end if;

  v_name := case when p_patch ? 'name' then btrim(coalesce(p_patch ->> 'name', '')) else v_old.name end;
  v_slug := case when p_patch ? 'slug' then lower(btrim(coalesce(p_patch ->> 'slug', ''))) else v_old.slug end;
  v_type := case when p_patch ? 'business_type' then p_patch ->> 'business_type' else v_old.business_type end;

  if char_length(v_name) not between 2 and 120 then
    perform app.raise('INVALID_NAME', 'Business name must be 2–120 characters');
  end if;
  if v_type is null or v_type not in ('barbershop', 'beauty_salon', 'unisex_salon', 'nail_studio', 'makeup_studio', 'spa', 'multi_concept') then
    perform app.raise('INVALID_BUSINESS_TYPE', 'Unknown business type');
  end if;
  if char_length(p_patch ->> 'name_ar') > 120 or char_length(p_patch ->> 'legal_name') > 200 then
    perform app.raise('INVALID_VALUE', 'Name is too long');
  end if;
  if v_slug <> v_old.slug then
    perform app.assert_tenant_slug(v_slug);
    if exists (select 1 from public.tenants t where t.slug = v_slug) then
      perform app.raise('TENANT_SLUG_TAKEN', 'This booking address is already taken');
    end if;
  end if;

  begin
    update public.tenants
    set name = v_name, slug = v_slug, business_type = v_type,
        name_ar = case when p_patch ? 'name_ar' then nullif(btrim(coalesce(p_patch ->> 'name_ar', '')), '') else name_ar end,
        legal_name = case when p_patch ? 'legal_name' then nullif(btrim(coalesce(p_patch ->> 'legal_name', '')), '') else legal_name end
    where id = p_tenant;
  exception when unique_violation then
    perform app.raise('TENANT_SLUG_TAKEN', 'This booking address is already taken');
  end;
  perform app.platform_audit('tenant.updated', p_tenant, 'tenants', p_tenant::text, p_patch);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Users of a business
-- ---------------------------------------------------------------------------
create or replace function public.admin_add_member(
  p_tenant uuid,
  p_email text,
  p_role_ids uuid[] default '{}',
  p_all_branches boolean default false,
  p_branch_ids uuid[] default '{}',
  p_job_title text default null,
  p_owner boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_res jsonb;
begin
  perform app.require_platform_admin(case when coalesce(p_owner, false) then array['admin'] else array['admin', 'support'] end);
  v_res := app.admin_attach_member(p_tenant, p_email, p_role_ids, p_all_branches, p_branch_ids, p_job_title, p_owner);
  perform app.platform_audit(case when (v_res ->> 'added')::boolean then 'member.added' else 'member.invited' end,
                             p_tenant, 'tenant_memberships', coalesce(v_res ->> 'membership_id', v_res -> 'invitation' ->> 'invitation_id'),
                             jsonb_build_object('email', v_res ->> 'email', 'owner', coalesce(p_owner, false)));
  return v_res;
end;
$$;

create or replace function public.admin_update_member(
  p_membership_id uuid, p_role_ids uuid[], p_all_branches boolean, p_branch_ids uuid[], p_job_title text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_mem public.tenant_memberships%rowtype;
begin
  perform app.require_platform_admin(array['admin', 'support']);
  select * into v_mem from public.tenant_memberships where id = p_membership_id for update;
  if not found then
    perform app.raise('NOT_FOUND', 'Member not found');
  end if;
  if v_mem.is_owner then
    perform app.raise('OWNER_IMMUTABLE', 'The owner''s access cannot be changed', '42501');
  end if;
  if char_length(p_job_title) > 80 then
    perform app.raise('INVALID_JOB_TITLE', 'Job title is too long');
  end if;
  perform app.assert_tenant_access_refs(v_mem.tenant_id, p_role_ids, p_all_branches, p_branch_ids);
  perform app.apply_member_access(v_mem, p_role_ids, p_all_branches, p_branch_ids);
  update public.tenant_memberships
  set job_title = nullif(btrim(p_job_title), '')
  where id = v_mem.id and job_title is distinct from nullif(btrim(p_job_title), '');
  perform app.platform_audit('member.access', v_mem.tenant_id, 'tenant_memberships', v_mem.id::text,
                             jsonb_build_object('role_ids', p_role_ids, 'all_branches', p_all_branches, 'branch_ids', p_branch_ids));
end;
$$;

create or replace function public.admin_set_member_status(p_membership_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_mem public.tenant_memberships%rowtype;
begin
  perform app.require_platform_admin(array['admin', 'support']);
  if p_status is null or p_status not in ('active', 'suspended') then
    perform app.raise('INVALID_STATUS', 'Status must be active or suspended');
  end if;
  select * into v_mem from public.tenant_memberships where id = p_membership_id for update;
  if not found then
    perform app.raise('NOT_FOUND', 'Member not found');
  end if;
  if v_mem.is_owner then
    perform app.raise('OWNER_IMMUTABLE', 'The owner cannot be suspended', '42501');
  end if;
  if v_mem.status = p_status then
    return;
  end if;
  if p_status = 'active' then
    perform 1 from public.tenants where id = v_mem.tenant_id for update;
    perform app.assert_staff_capacity(v_mem.tenant_id, 1);
  end if;
  update public.tenant_memberships set status = p_status where id = v_mem.id;
  perform app.platform_audit('member.status', v_mem.tenant_id, 'tenant_memberships', v_mem.id::text,
                             jsonb_build_object('from', v_mem.status, 'to', p_status));
end;
$$;

-- Make an active member the owner. The previous owner stays as a member with
-- access to all branches and, if they have no role yet, the Manager role.
create or replace function public.admin_transfer_ownership(p_tenant uuid, p_membership_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_new public.tenant_memberships%rowtype;
  v_old public.tenant_memberships%rowtype;
begin
  perform app.require_platform_admin(array['admin']);
  perform 1 from public.tenants where id = p_tenant for update;
  select * into v_new from public.tenant_memberships where id = p_membership_id and tenant_id = p_tenant for update;
  if not found then
    perform app.raise('NOT_FOUND', 'Member not found');
  end if;
  if v_new.is_owner then
    return;
  end if;
  if v_new.status <> 'active' then
    perform app.raise('MEMBER_NOT_ACTIVE', 'Reactivate this member first');
  end if;

  select * into v_old from public.tenant_memberships where tenant_id = p_tenant and is_owner for update;
  if found then
    update public.tenant_memberships set is_owner = false, all_branches = true where id = v_old.id;
    insert into public.user_roles (tenant_id, membership_id, role_id)
    select p_tenant, v_old.id, r.id from public.roles r
    where r.tenant_id = p_tenant and r.code = 'manager'
      and not exists (select 1 from public.user_roles ur where ur.membership_id = v_old.id)
    on conflict do nothing;
  end if;
  update public.tenant_memberships set is_owner = true, all_branches = true where id = v_new.id;
  delete from public.user_branch_access where membership_id = v_new.id;

  perform app.audit(p_tenant, 'tenant.ownership_transferred', 'tenant_memberships', v_new.id::text, null, null,
                    jsonb_build_object('from', v_old.user_id, 'to', v_new.user_id, 'by', 'platform_admin'));
  perform app.platform_audit('tenant.ownership', p_tenant, 'tenant_memberships', v_new.id::text,
                             jsonb_build_object('from', (select u.email from auth.users u where u.id = v_old.user_id),
                                                'to', (select u.email from auth.users u where u.id = v_new.user_id)));
end;
$$;

create or replace function public.admin_revoke_invitation(p_invitation_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inv public.tenant_invitations%rowtype;
begin
  perform app.require_platform_admin(array['admin', 'support']);
  update public.tenant_invitations set status = 'revoked'
  where id = p_invitation_id and status = 'pending'
  returning * into v_inv;
  if v_inv.id is null then
    perform app.raise('NOT_FOUND', 'Invitation not found');
  end if;
  perform app.platform_audit('member.invitation_revoked', v_inv.tenant_id, 'tenant_invitations', v_inv.id::text,
                             jsonb_build_object('email', v_inv.email));
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. admin_get_tenant: + roles, branches, member access, pending invitations
-- ---------------------------------------------------------------------------
create or replace function public.admin_get_tenant(p_tenant uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform app.require_platform_admin();
  if not exists (select 1 from public.tenants where id = p_tenant) then
    perform app.raise('NOT_FOUND', 'Business not found');
  end if;
  return jsonb_build_object(
    'tenant', (select to_jsonb(t) - 'creation_key' - 'created_by' from public.tenants t where t.id = p_tenant),
    'settings', (select jsonb_build_object('default_language', s.default_language, 'timezone', s.timezone,
                                           'vat_registered', s.vat_registered, 'vat_number', s.vat_number, 'currency_code', s.currency_code)
                 from public.tenant_settings s where s.tenant_id = p_tenant),
    'subscription', (select to_jsonb(s) || jsonb_build_object('plan_code', p.code, 'plan_name_en', p.name_en, 'plan_name_ar', p.name_ar,
                                                              'scheduled_plan_code', sp.code, 'operational', app.tenant_is_operational(p_tenant))
                     from public.tenant_subscriptions s
                     join public.subscription_plans p on p.id = s.plan_id
                     left join public.subscription_plans sp on sp.id = s.scheduled_plan_id
                     where s.tenant_id = p_tenant
                     order by (s.status in ('trialing', 'active', 'past_due', 'suspended')) desc, s.created_at desc limit 1),
    'usage', jsonb_build_object(
        'branches', (select count(*) from public.branches b where b.tenant_id = p_tenant),
        'staff', (select count(*) from public.employees e where e.tenant_id = p_tenant and e.is_active),
        'members', (select count(*) from public.tenant_memberships m where m.tenant_id = p_tenant and m.status = 'active'),
        'customers', (select count(*) from public.customers c where c.tenant_id = p_tenant),
        'appointments_30d', (select count(*) from public.appointments a
                             where a.tenant_id = p_tenant and a.starts_at >= now() - interval '30 days' and a.starts_at < now()),
        'sales_30d', (select coalesce(sum(i.total), 0) from public.invoices i
                      where i.tenant_id = p_tenant and i.kind = 'invoice' and i.status = 'posted' and i.issued_at >= now() - interval '30 days'),
        'messages_month', coalesce((select u.quantity from public.tenant_usage u where u.tenant_id = p_tenant and u.metric = 'messages'
                                      and u.period_start = date_trunc('month', now())::date), 0),
        'last_activity', (select max(a.created_at) from public.audit_logs a where a.tenant_id = p_tenant)),
    'modules', (select jsonb_agg(jsonb_build_object('code', m.code, 'name_en', m.name_en, 'name_ar', m.name_ar, 'is_core', m.is_core,
                                                    'enabled', app.module_enabled(p_tenant, m.code), 'source', e.source,
                                                    'is_enabled', e.is_enabled, 'valid_until', e.valid_until) order by m.sort_order)
                from public.modules m
                left join public.module_entitlements e on e.tenant_id = p_tenant and e.module_code = m.code),
    'roles', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'code', r.code, 'name_en', r.name_en, 'name_ar', r.name_ar)
                                        order by r.name_en), '[]'::jsonb)
              from public.roles r where r.tenant_id = p_tenant),
    'branches', (select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'code', b.code, 'name_en', b.name_en, 'name_ar', b.name_ar,
                                                              'is_main', b.is_main, 'is_active', b.is_active)
                                           order by b.is_main desc, b.sort_order, b.name_en), '[]'::jsonb)
                 from public.branches b where b.tenant_id = p_tenant),
    'members', (select coalesce(jsonb_agg(jsonb_build_object(
                    'membership_id', m.id, 'user_id', m.user_id, 'email', u.email, 'full_name', pr.full_name, 'is_owner', m.is_owner,
                    'status', m.status, 'job_title', m.job_title, 'all_branches', m.all_branches, 'joined_at', m.joined_at,
                    'role_ids', coalesce(array(select ur.role_id from public.user_roles ur where ur.membership_id = m.id), '{}'),
                    'branch_ids', coalesce(array(select a.branch_id from public.user_branch_access a where a.membership_id = m.id), '{}'))
                                          order by m.is_owner desc, u.email), '[]'::jsonb)
                from public.tenant_memberships m
                join auth.users u on u.id = m.user_id
                left join public.profiles pr on pr.id = m.user_id
                where m.tenant_id = p_tenant),
    'invitations', (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'email', i.email, 'make_owner', i.make_owner,
                                                                 'expires_at', i.expires_at, 'created_at', i.created_at)
                                              order by i.created_at desc), '[]'::jsonb)
                    from public.tenant_invitations i
                    where i.tenant_id = p_tenant and i.status = 'pending' and i.expires_at > now()),
    'invoices', (select coalesce(jsonb_agg(to_jsonb(i) - 'created_by' order by i.issued_at desc), '[]'::jsonb)
                 from (select * from public.subscription_invoices i where i.tenant_id = p_tenant order by i.issued_at desc limit 50) i),
    'history', (select coalesce(jsonb_agg(jsonb_build_object('action', l.action, 'data', l.data, 'created_at', l.created_at,
                                                             'actor', (select u.email from auth.users u where u.id = l.actor_user_id))
                                          order by l.created_at desc), '[]'::jsonb)
                from (select * from public.platform_audit_logs l where l.tenant_id = p_tenant order by l.created_at desc limit 30) l)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Execute privileges
-- ---------------------------------------------------------------------------
revoke all on function
  public.admin_create_tenant(text, text, text, text, text, text, text),
  public.admin_update_tenant(uuid, jsonb),
  public.admin_add_member(uuid, text, uuid[], boolean, uuid[], text, boolean),
  public.admin_update_member(uuid, uuid[], boolean, uuid[], text),
  public.admin_set_member_status(uuid, text),
  public.admin_transfer_ownership(uuid, uuid),
  public.admin_revoke_invitation(uuid)
from public, anon;
grant execute on function
  public.admin_create_tenant(text, text, text, text, text, text, text),
  public.admin_update_tenant(uuid, jsonb),
  public.admin_add_member(uuid, text, uuid[], boolean, uuid[], text, boolean),
  public.admin_update_member(uuid, uuid[], boolean, uuid[], text),
  public.admin_set_member_status(uuid, text),
  public.admin_transfer_ownership(uuid, uuid),
  public.admin_revoke_invitation(uuid)
to authenticated, service_role;

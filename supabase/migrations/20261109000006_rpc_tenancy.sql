-- =============================================================================
-- Salonzoft · Migration 0006 · Tenancy RPC functions (Phase 1)
-- -----------------------------------------------------------------------------
-- Public RPCs exposed through PostgREST (`supabase.rpc(...)`).
-- SECURITY DEFINER functions here:
--   * have EXECUTE revoked from PUBLIC/anon and granted to authenticated only,
--   * pin search_path = '' and fully qualify objects,
--   * perform explicit authorization (app.require_permission / ownership),
--   * validate every input and audit their effects.
-- Error codes are documented in docs/04-rpc-and-edge-catalogue.md.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Internal helpers
-- ---------------------------------------------------------------------------
create or replace function app.hash_token(p_token text)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(pg_catalog.sha256(pg_catalog.convert_to(p_token, 'UTF8')), 'hex');
$$;

create or replace function app.new_token()
returns text
language sql
volatile
set search_path = ''
as $$
  -- 2 × UUIDv4 = 244 bits of CSPRNG entropy, hex encoded.
  select replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
$$;

-- Validate that the caller may hand out these roles / branches (anti-escalation).
create or replace function app.assert_can_assign(
  p_tenant uuid,
  p_role_ids uuid[],
  p_all_branches boolean,
  p_branch_ids uuid[],
  p_require_branch boolean default true
)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor public.tenant_memberships%rowtype;
  v_roles uuid[] := coalesce(array(select distinct x from unnest(p_role_ids) x where x is not null), '{}');
  v_branches uuid[] := coalesce(array(select distinct x from unnest(p_branch_ids) x where x is not null), '{}');
begin
  select * into v_actor
  from public.tenant_memberships
  where tenant_id = p_tenant and user_id = auth.uid() and status = 'active';
  if not found then
    perform app.forbid();
  end if;

  if (select count(*) from public.roles r where r.tenant_id = p_tenant and r.id = any (v_roles))
     <> cardinality(v_roles) then
    perform app.raise('INVALID_ROLE', 'One or more roles do not belong to this business');
  end if;

  if not v_actor.is_owner and exists (
    select 1
    from public.role_permissions rp
    join public.permissions p on p.code = rp.permission_code
    where rp.role_id = any (v_roles)
      and app.module_enabled(p_tenant, p.module_code)
      and not app.has_permission(p_tenant, rp.permission_code)
  ) then
    perform app.raise('ROLE_ESCALATION_FORBIDDEN',
                      'You cannot assign a role with permissions you do not hold', '42501');
  end if;

  if coalesce(p_all_branches, false) then
    if not (v_actor.is_owner or v_actor.all_branches) then
      perform app.raise('BRANCH_ESCALATION_FORBIDDEN',
                        'Only users with access to all branches can grant all-branch access', '42501');
    end if;
  else
    if cardinality(v_branches) = 0 and p_require_branch then
      perform app.raise('BRANCH_REQUIRED', 'Select at least one branch');
    end if;
    if (select count(*) from public.branches b where b.tenant_id = p_tenant and b.id = any (v_branches))
       <> cardinality(v_branches) then
      perform app.raise('INVALID_BRANCH', 'One or more branches do not belong to this business');
    end if;
    if exists (select 1 from unnest(v_branches) b where not app.has_branch_access(b)) then
      perform app.raise('BRANCH_ESCALATION_FORBIDDEN',
                        'You cannot grant access to a branch you cannot access', '42501');
    end if;
  end if;
end;
$$;

-- Replace a membership's role & branch assignments.
create or replace function app.apply_member_access(
  p_membership public.tenant_memberships,
  p_role_ids uuid[],
  p_all_branches boolean,
  p_branch_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.user_roles
  where membership_id = p_membership.id
    and not (role_id = any (coalesce(p_role_ids, '{}')));

  insert into public.user_roles (tenant_id, membership_id, role_id)
  select p_membership.tenant_id, p_membership.id, r.id
  from public.roles r
  where r.tenant_id = p_membership.tenant_id and r.id = any (coalesce(p_role_ids, '{}'))
  on conflict do nothing;

  if coalesce(p_all_branches, false) then
    delete from public.user_branch_access where membership_id = p_membership.id;
  else
    delete from public.user_branch_access
    where membership_id = p_membership.id
      and not (branch_id = any (coalesce(p_branch_ids, '{}')));

    insert into public.user_branch_access (tenant_id, membership_id, branch_id)
    select p_membership.tenant_id, p_membership.id, b.id
    from public.branches b
    where b.tenant_id = p_membership.tenant_id and b.id = any (coalesce(p_branch_ids, '{}'))
    on conflict do nothing;
  end if;

  update public.tenant_memberships
  set all_branches = coalesce(p_all_branches, false)
  where id = p_membership.id and all_branches is distinct from coalesce(p_all_branches, false);
end;
$$;

revoke all on function app.hash_token(text), app.new_token(),
  app.assert_can_assign(uuid, uuid[], boolean, uuid[], boolean),
  app.apply_member_access(public.tenant_memberships, uuid[], boolean, uuid[]) from public;

-- ---------------------------------------------------------------------------
-- create_tenant — self-service onboarding
-- ---------------------------------------------------------------------------
create or replace function public.create_tenant(
  p_name text,
  p_slug text,
  p_business_type text default 'unisex_salon',
  p_branch_name text default null,
  p_default_language text default 'en',
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid        uuid := app.require_user();
  v_name       text := btrim(p_name);
  v_slug       text := lower(btrim(p_slug));
  v_lang       text := coalesce(p_default_language, 'en');
  v_type       text := coalesce(p_business_type, 'unisex_salon');
  v_plan       public.subscription_plans%rowtype;
  v_tenant     uuid;
  v_branch     uuid;
  v_membership uuid;
begin
  -- Idempotent replay: same user + same key returns the original tenant.
  if p_idempotency_key is not null then
    select t.id into v_tenant
    from public.tenants t
    where t.created_by = v_uid and t.creation_key = p_idempotency_key;
    if found then
      return jsonb_build_object(
        'tenant_id', v_tenant,
        'branch_id', (select b.id from public.branches b where b.tenant_id = v_tenant and b.is_main),
        'slug',      (select t.slug from public.tenants t where t.id = v_tenant),
        'replayed',  true);
    end if;
  end if;

  if v_name is null or char_length(v_name) not between 2 and 120 then
    perform app.raise('INVALID_NAME', 'Business name must be 2–120 characters');
  end if;
  if v_slug is null or v_slug !~ '^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$' or v_slug ~ '--' then
    perform app.raise('INVALID_SLUG', 'Use 3–48 lowercase letters, digits or single hyphens');
  end if;
  if v_slug = any (array['admin', 'api', 'app', 'auth', 'book', 'booking', 'dashboard', 'help',
                         'login', 'mail', 'salonzoft', 'signup', 'static', 'status', 'support', 'www']) then
    perform app.raise('SLUG_RESERVED', 'This address is reserved');
  end if;
  if v_lang not in ('en', 'ar') then
    perform app.raise('INVALID_LANGUAGE', 'Language must be en or ar');
  end if;
  if v_type not in ('barbershop', 'beauty_salon', 'unisex_salon', 'nail_studio', 'makeup_studio', 'spa', 'multi_concept') then
    perform app.raise('INVALID_BUSINESS_TYPE', 'Unknown business type');
  end if;
  if (select count(*) from public.tenants t where t.created_by = v_uid) >= 5 and not app.is_platform_admin() then
    perform app.raise('TENANT_LIMIT_REACHED', 'You can create at most 5 businesses. Contact support.');
  end if;
  if exists (select 1 from public.tenants t where t.slug = v_slug) then
    perform app.raise('TENANT_SLUG_TAKEN', 'This booking address is already taken');
  end if;

  select * into v_plan from public.subscription_plans where code = 'professional' and is_active;
  if not found then
    perform app.raise('PLAN_NOT_CONFIGURED', 'Trial plan is not configured');
  end if;

  begin
    insert into public.tenants (slug, name, business_type, created_by, creation_key)
    values (v_slug, v_name, v_type, v_uid, p_idempotency_key)
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
  select v_tenant, pm.module_code, 'plan'
  from public.plan_modules pm
  where pm.plan_id = v_plan.id;

  insert into public.roles (tenant_id, code, name_en, name_ar, description, is_system, template_code)
  select v_tenant, rt.code, rt.name_en, rt.name_ar, rt.description_en, true, rt.code
  from public.role_templates rt;

  insert into public.role_permissions (tenant_id, role_id, permission_code)
  select v_tenant, r.id, rtp.permission_code
  from public.roles r
  join public.role_template_permissions rtp on rtp.role_code = r.template_code
  where r.tenant_id = v_tenant;

  insert into public.tenant_memberships (tenant_id, user_id, status, is_owner, all_branches, job_title)
  values (v_tenant, v_uid, 'active', true, true, 'Owner')
  returning id into v_membership;

  insert into public.branches (tenant_id, code, name_en, is_main)
  values (v_tenant, 'MAIN', coalesce(nullif(btrim(p_branch_name), ''), v_name), true)
  returning id into v_branch;

  -- Default hours: Sat–Thu 09:00–22:00, Friday 14:00–22:00 (after Jumu'ah).
  insert into public.branch_working_hours (tenant_id, branch_id, day_of_week, opens_at, closes_at)
  select v_tenant, v_branch, d,
         case when d = 5 then time '14:00' else time '09:00' end,
         time '22:00'
  from generate_series(0, 6) as d;

  perform app.audit(v_tenant, 'tenant.created', 'tenants', v_tenant::text, null, null,
                    jsonb_build_object('plan', v_plan.code, 'slug', v_slug));

  return jsonb_build_object('tenant_id', v_tenant, 'branch_id', v_branch, 'slug', v_slug, 'replayed', false);
end;
$$;

-- ---------------------------------------------------------------------------
-- Slug availability (no information beyond a boolean is revealed)
-- ---------------------------------------------------------------------------
create or replace function public.is_slug_available(p_slug text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select lower(btrim(p_slug)) ~ '^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$'
     and lower(btrim(p_slug)) !~ '--'
     and not exists (select 1 from public.tenants t where t.slug = lower(btrim(p_slug)));
$$;

-- ---------------------------------------------------------------------------
-- get_my_tenants — tenants the caller belongs to (RLS-driven, invoker)
-- ---------------------------------------------------------------------------
create or replace function public.get_my_tenants()
returns table (
  tenant_id uuid,
  slug text,
  name text,
  name_ar text,
  status text,
  is_owner boolean,
  subscription_status text,
  trial_ends_at timestamptz,
  plan_code text
)
language sql
stable
security invoker
set search_path = ''
as $$
  select t.id, t.slug, t.name, t.name_ar, t.status, m.is_owner, s.status, s.trial_ends_at, p.code
  from public.tenant_memberships m
  join public.tenants t on t.id = m.tenant_id
  left join public.tenant_subscriptions s
    on s.tenant_id = t.id and s.status in ('trialing', 'active', 'past_due', 'suspended')
  left join public.subscription_plans p on p.id = s.plan_id
  where m.user_id = auth.uid()
    and m.status = 'active'
    and t.status <> 'closed'
  order by t.name;
$$;

-- ---------------------------------------------------------------------------
-- get_tenant_context — everything the UI needs to render navigation.
-- The client still never *decides* access: the same helpers back RLS.
-- ---------------------------------------------------------------------------
create or replace function public.get_tenant_context(p_tenant uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_uid uuid := app.require_user();
begin
  if not app.is_tenant_member(p_tenant) then
    perform app.forbid('Not a member of this business');
  end if;

  return jsonb_build_object(
    'tenant', (select to_jsonb(t) - 'creation_key' - 'created_by'
               from public.tenants t where t.id = p_tenant),
    'settings', (select to_jsonb(s) from public.tenant_settings s where s.tenant_id = p_tenant),
    'membership', (select jsonb_build_object('id', m.id, 'is_owner', m.is_owner,
                                             'all_branches', m.all_branches, 'job_title', m.job_title)
                   from public.tenant_memberships m
                   where m.tenant_id = p_tenant and m.user_id = v_uid),
    'roles', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'code', r.code,
                                                           'name_en', r.name_en, 'name_ar', r.name_ar)
                                        order by r.name_en), '[]'::jsonb)
              from public.tenant_memberships m
              join public.user_roles ur on ur.membership_id = m.id
              join public.roles r on r.id = ur.role_id
              where m.tenant_id = p_tenant and m.user_id = v_uid),
    'permissions', (select coalesce(jsonb_agg(x.code order by x.code), '[]'::jsonb)
                    from app.permissions_for(p_tenant) as x(code)),
    'modules', (select coalesce(jsonb_agg(m.code order by m.sort_order), '[]'::jsonb)
                from public.modules m where app.module_enabled(p_tenant, m.code)),
    'branches', (select coalesce(jsonb_agg(jsonb_build_object(
                          'id', b.id, 'code', b.code, 'name_en', b.name_en, 'name_ar', b.name_ar,
                          'is_main', b.is_main, 'is_active', b.is_active, 'timezone', b.timezone)
                        order by b.is_main desc, b.sort_order, b.name_en), '[]'::jsonb)
                 from public.branches b
                 where b.tenant_id = p_tenant and b.id in (select app.accessible_branch_ids())),
    'subscription', (select jsonb_build_object(
                              'status', s.status, 'plan_code', p.code,
                              'plan_name_en', p.name_en, 'plan_name_ar', p.name_ar,
                              'trial_ends_at', s.trial_ends_at, 'current_period_end', s.current_period_end,
                              'max_branches', p.max_branches, 'max_staff', p.max_staff)
                     from public.tenant_subscriptions s
                     join public.subscription_plans p on p.id = s.plan_id
                     where s.tenant_id = p_tenant
                       and s.status in ('trialing', 'active', 'past_due', 'suspended')),
    'operational', app.tenant_is_operational(p_tenant),
    'is_platform_admin', app.is_platform_admin()
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Invitations
-- ---------------------------------------------------------------------------
create or replace function public.create_invitation(
  p_tenant uuid,
  p_email text,
  p_role_ids uuid[],
  p_all_branches boolean default false,
  p_branch_ids uuid[] default '{}'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email  text := lower(btrim(p_email));
  v_token  text := app.new_token();
  v_id     uuid;
  v_expiry timestamptz;
begin
  perform app.require_permission(p_tenant, 'team.manage');

  if v_email is null or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or char_length(v_email) > 254 then
    perform app.raise('INVALID_EMAIL', 'Enter a valid email address');
  end if;

  perform app.assert_can_assign(p_tenant, p_role_ids, p_all_branches, p_branch_ids);

  -- Serialise seat checks per tenant.
  perform 1 from public.tenants where id = p_tenant for update;

  if exists (select 1
             from public.tenant_memberships m
             join auth.users u on u.id = m.user_id
             where m.tenant_id = p_tenant and lower(u.email) = v_email) then
    perform app.raise('MEMBER_ALREADY_EXISTS', 'This person is already a member');
  end if;

  update public.tenant_invitations
  set status = 'revoked'
  where tenant_id = p_tenant and email = v_email and status = 'pending';

  perform app.assert_staff_capacity(p_tenant, 1);

  insert into public.tenant_invitations
    (tenant_id, email, token_hash, role_ids, branch_ids, all_branches, invited_by)
  values
    (p_tenant, v_email, app.hash_token(v_token),
     coalesce(array(select distinct x from unnest(p_role_ids) x where x is not null), '{}'),
     case when coalesce(p_all_branches, false) then '{}'::uuid[]
          else coalesce(array(select distinct x from unnest(p_branch_ids) x where x is not null), '{}') end,
     coalesce(p_all_branches, false), auth.uid())
  returning id, expires_at into v_id, v_expiry;

  -- The plaintext token is returned exactly once; only its hash is stored.
  return jsonb_build_object('invitation_id', v_id, 'token', v_token, 'email', v_email,
                            'expires_at', v_expiry);
end;
$$;

create or replace function public.revoke_invitation(p_invitation_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant uuid;
begin
  perform app.require_user();
  select tenant_id into v_tenant from public.tenant_invitations where id = p_invitation_id;
  if not found or not app.has_permission(v_tenant, 'team.manage') then
    perform app.raise('NOT_FOUND', 'Invitation not found');
  end if;
  update public.tenant_invitations
  set status = 'revoked'
  where id = p_invitation_id and status = 'pending';
end;
$$;

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
-- Team management
-- ---------------------------------------------------------------------------
create or replace function public.list_tenant_members(p_tenant uuid)
returns table (
  membership_id uuid,
  user_id uuid,
  email text,
  full_name text,
  phone text,
  status text,
  is_owner boolean,
  all_branches boolean,
  job_title text,
  joined_at timestamptz,
  role_ids uuid[],
  branch_ids uuid[]
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform app.require_permission(p_tenant, 'team.view');
  return query
  select m.id, m.user_id, u.email::text, p.full_name, p.phone, m.status, m.is_owner,
         m.all_branches, m.job_title, m.joined_at,
         coalesce(array(select ur.role_id from public.user_roles ur where ur.membership_id = m.id), '{}'),
         coalesce(array(select uba.branch_id from public.user_branch_access uba where uba.membership_id = m.id), '{}')
  from public.tenant_memberships m
  join auth.users u on u.id = m.user_id
  left join public.profiles p on p.id = m.user_id
  where m.tenant_id = p_tenant
  order by m.is_owner desc, p.full_name nulls last, u.email;
end;
$$;

create or replace function public.update_member_access(
  p_membership_id uuid,
  p_role_ids uuid[],
  p_all_branches boolean,
  p_branch_ids uuid[],
  p_job_title text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_mem public.tenant_memberships%rowtype;
begin
  perform app.require_user();
  select * into v_mem from public.tenant_memberships where id = p_membership_id for update;
  if not found or not app.has_permission(v_mem.tenant_id, 'team.manage') then
    perform app.raise('NOT_FOUND', 'Member not found');
  end if;
  if v_mem.is_owner then
    perform app.raise('OWNER_IMMUTABLE', 'The owner''s access cannot be changed', '42501');
  end if;
  if v_mem.user_id = auth.uid() then
    perform app.raise('SELF_MODIFICATION_FORBIDDEN', 'You cannot change your own access', '42501');
  end if;
  if char_length(p_job_title) > 80 then
    perform app.raise('INVALID_JOB_TITLE', 'Job title is too long');
  end if;

  -- The actor must outrank the member's current access as well as the new one.
  perform app.assert_can_assign(
    v_mem.tenant_id,
    coalesce(array(select ur.role_id from public.user_roles ur where ur.membership_id = v_mem.id), '{}'),
    v_mem.all_branches,
    coalesce(array(select b.branch_id from public.user_branch_access b where b.membership_id = v_mem.id), '{}'),
    false);
  perform app.assert_can_assign(v_mem.tenant_id, p_role_ids, p_all_branches, p_branch_ids);

  perform app.apply_member_access(v_mem, p_role_ids, p_all_branches, p_branch_ids);

  update public.tenant_memberships
  set job_title = nullif(btrim(p_job_title), '')
  where id = v_mem.id and job_title is distinct from nullif(btrim(p_job_title), '');
end;
$$;

create or replace function public.set_member_status(p_membership_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_mem public.tenant_memberships%rowtype;
begin
  perform app.require_user();
  if p_status not in ('active', 'suspended') then
    perform app.raise('INVALID_STATUS', 'Status must be active or suspended');
  end if;
  select * into v_mem from public.tenant_memberships where id = p_membership_id for update;
  if not found or not app.has_permission(v_mem.tenant_id, 'team.manage') then
    perform app.raise('NOT_FOUND', 'Member not found');
  end if;
  if v_mem.is_owner then
    perform app.raise('OWNER_IMMUTABLE', 'The owner cannot be suspended', '42501');
  end if;
  if v_mem.user_id = auth.uid() then
    perform app.raise('SELF_MODIFICATION_FORBIDDEN', 'You cannot change your own status', '42501');
  end if;
  if v_mem.status = p_status then
    return;
  end if;
  if p_status = 'active' then
    perform 1 from public.tenants where id = v_mem.tenant_id for update;
    perform app.assert_staff_capacity(v_mem.tenant_id, 1);
  end if;
  update public.tenant_memberships set status = p_status where id = v_mem.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Branch working hours — replace a branch's weekly schedule atomically.
-- SECURITY INVOKER: RLS (branches.manage) governs the writes.
-- p_hours: [{ "day_of_week": 0-6, "opens_at": "09:00", "closes_at": "22:00" }, …]
-- ---------------------------------------------------------------------------
create or replace function public.set_branch_working_hours(p_branch_id uuid, p_hours jsonb)
returns setof public.branch_working_hours
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_tenant uuid;
  v_rows   jsonb;
begin
  perform app.require_user();
  select b.tenant_id into v_tenant from public.branches b where b.id = p_branch_id;
  if not found then
    perform app.raise('NOT_FOUND', 'Branch not found');
  end if;
  perform app.require_permission(v_tenant, 'branches.manage');

  if p_hours is null or jsonb_typeof(p_hours) <> 'array' or jsonb_array_length(p_hours) > 28 then
    perform app.raise('INVALID_WORKING_HOURS', 'Provide up to 28 time ranges');
  end if;

  -- Normalise + type-check every element (bad casts become a clean error).
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

  delete from public.branch_working_hours where branch_id = p_branch_id;

  insert into public.branch_working_hours (tenant_id, branch_id, day_of_week, opens_at, closes_at)
  select v_tenant, p_branch_id, h.day_of_week, h.opens_at, h.closes_at
  from jsonb_to_recordset(v_rows) as h(idx int, day_of_week smallint, opens_at time, closes_at time)
  order by h.day_of_week, h.opens_at;

  return query
  select * from public.branch_working_hours w
  where w.branch_id = p_branch_id
  order by w.day_of_week, w.opens_at;
end;
$$;

-- ---------------------------------------------------------------------------
-- Dashboard summary (Phase 1 scope — extended by later migrations as
-- appointments, POS and inventory land). SECURITY INVOKER: RLS applies.
-- ---------------------------------------------------------------------------
create or replace function public.get_dashboard_summary(p_tenant uuid, p_branch_id uuid default null)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_settings     public.tenant_settings%rowtype;
  v_can_team     boolean;
  v_members      integer;
  v_invites      integer;
  v_hours_set    boolean;
  v_sub          jsonb;
begin
  perform app.require_permission(p_tenant, 'dashboard.view');
  if p_branch_id is not null and not app.has_branch_access(p_branch_id) then
    perform app.forbid('No access to this branch');
  end if;

  select * into v_settings from public.tenant_settings where tenant_id = p_tenant;
  v_can_team := app.has_permission(p_tenant, 'team.view');

  select count(*) into v_members
  from public.tenant_memberships where tenant_id = p_tenant and status = 'active';
  select count(*) into v_invites
  from public.tenant_invitations
  where tenant_id = p_tenant and status = 'pending' and expires_at > now();

  select exists (select 1 from public.branch_working_hours w
                 where w.tenant_id = p_tenant
                   and (p_branch_id is null or w.branch_id = p_branch_id))
    into v_hours_set;

  select jsonb_build_object(
           'status', s.status, 'plan_code', p.code, 'plan_name_en', p.name_en, 'plan_name_ar', p.name_ar,
           'trial_ends_at', s.trial_ends_at,
           'trial_days_left', case when s.status = 'trialing'
                                   then greatest(0, ceil(extract(epoch from (s.trial_ends_at - now())) / 86400))::int end,
           'max_branches', p.max_branches, 'max_staff', p.max_staff)
    into v_sub
  from public.tenant_subscriptions s
  join public.subscription_plans p on p.id = s.plan_id
  where s.tenant_id = p_tenant and s.status in ('trialing', 'active', 'past_due', 'suspended');

  return jsonb_build_object(
    'generated_at', now(),
    'timezone', v_settings.timezone,
    'currency_code', v_settings.currency_code,
    'operational', app.tenant_is_operational(p_tenant),
    'subscription', v_sub,
    'branches', (select jsonb_build_object(
                          'total', count(*),
                          'active', count(*) filter (where b.is_active))
                 from public.branches b
                 where b.tenant_id = p_tenant
                   and (p_branch_id is null or b.id = p_branch_id)),
    'team', case when v_can_team then jsonb_build_object(
                   'active_members', v_members,
                   'pending_invitations', v_invites) end,
    'setup', jsonb_build_object(
               'business_profile', (select t.legal_name is not null from public.tenants t where t.id = p_tenant),
               'vat_configured', v_settings.vat_registered and v_settings.vat_number is not null,
               'logo_uploaded', v_settings.logo_path is not null,
               'working_hours', v_hours_set,
               'team_invited', v_members > 1 or v_invites > 0)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Execute privileges
-- ---------------------------------------------------------------------------
revoke all on function
  public.create_tenant(text, text, text, text, text, text),
  public.is_slug_available(text),
  public.get_my_tenants(),
  public.get_tenant_context(uuid),
  public.create_invitation(uuid, text, uuid[], boolean, uuid[]),
  public.revoke_invitation(uuid),
  public.accept_invitation(text),
  public.list_tenant_members(uuid),
  public.update_member_access(uuid, uuid[], boolean, uuid[], text),
  public.set_member_status(uuid, text),
  public.set_branch_working_hours(uuid, jsonb),
  public.get_dashboard_summary(uuid, uuid)
from public, anon;

grant execute on function
  public.create_tenant(text, text, text, text, text, text),
  public.is_slug_available(text),
  public.get_my_tenants(),
  public.get_tenant_context(uuid),
  public.create_invitation(uuid, text, uuid[], boolean, uuid[]),
  public.revoke_invitation(uuid),
  public.accept_invitation(text),
  public.list_tenant_members(uuid),
  public.update_member_access(uuid, uuid[], boolean, uuid[], text),
  public.set_member_status(uuid, text),
  public.set_branch_working_hours(uuid, jsonb),
  public.get_dashboard_summary(uuid, uuid)
to authenticated, service_role;

-- =============================================================================
-- Salonzoft · Migration 0007 · Tenant-scoped Storage
-- -----------------------------------------------------------------------------
-- Bucket `tenant-assets` (private). Object paths MUST follow:
--   tenants/{tenant_id}/{area}/{file}
--   tenants/{tenant_id}/branches/{branch_id}/{area}/{file}
-- Policies parse the path; anything not matching the convention is denied.
-- Downloads use short-lived signed URLs (createSignedUrl) from the client.
-- NOTE: Storage objects are NOT included in PostgreSQL backups — see
-- docs/06-deployment.md for the separate storage backup procedure.
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('tenant-assets', 'tenant-assets', false, 5242880,
        array['image/png', 'image/jpeg', 'image/webp'])  -- no SVG (script injection risk)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Tenant id from a storage path, or null when the path is malformed.
create or replace function app.storage_tenant_id(p_name text)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select case
    when split_part(p_name, '/', 1) = 'tenants'
     and split_part(p_name, '/', 2) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then split_part(p_name, '/', 2)::uuid
  end;
$$;

-- Branch id from a branch-scoped path, or null.
create or replace function app.storage_branch_id(p_name text)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select case
    when split_part(p_name, '/', 3) = 'branches'
     and split_part(p_name, '/', 4) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then split_part(p_name, '/', 4)::uuid
  end;
$$;

-- Does the caller hold `p_permission` for the tenant (and branch) in the path?
create or replace function app.storage_path_allowed(p_name text, p_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app.storage_tenant_id(p_name) is not null
     and p_name !~ '(^|/)\.\.(/|$)'
     and (case when p_permission is null
               then app.is_tenant_member(app.storage_tenant_id(p_name))
               else app.has_permission(app.storage_tenant_id(p_name), p_permission) end)
     and (app.storage_branch_id(p_name) is null
          or (app.has_branch_access(app.storage_branch_id(p_name))
              and exists (select 1 from public.branches b
                          where b.id = app.storage_branch_id(p_name)
                            and b.tenant_id = app.storage_tenant_id(p_name))));
$$;

revoke all on function app.storage_tenant_id(text), app.storage_branch_id(text),
                       app.storage_path_allowed(text, text) from public;
grant execute on function app.storage_tenant_id(text), app.storage_branch_id(text),
                          app.storage_path_allowed(text, text) to authenticated, service_role;

create policy tenant_assets_read on storage.objects
  for select to authenticated
  using (bucket_id = 'tenant-assets' and app.storage_path_allowed(name, null));

create policy tenant_assets_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'tenant-assets' and app.storage_path_allowed(name, 'settings.manage'));

create policy tenant_assets_update on storage.objects
  for update to authenticated
  using (bucket_id = 'tenant-assets' and app.storage_path_allowed(name, 'settings.manage'))
  with check (bucket_id = 'tenant-assets' and app.storage_path_allowed(name, 'settings.manage'));

create policy tenant_assets_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'tenant-assets' and app.storage_path_allowed(name, 'settings.manage'));

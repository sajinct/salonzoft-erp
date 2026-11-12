-- =============================================================================
-- Salonzoft · Migration 0022 · Employee import (CSV / Excel)
-- -----------------------------------------------------------------------------
-- import_employees(tenant, rows, dry_run): each row adds an employee or updates
-- an existing one (matched by code, otherwise by English name). Empty columns
-- keep the current value on update and take the default on insert.
--   branches — codes or names separated by ";": the employee's branches become
--              exactly this list (among the branches the caller can access).
--              A new employee without the column gets the salon's only branch.
--   services — codes or names separated by ";", or "all": the services the
--              employee performs become exactly this list.
-- Same mechanics as import_services: SECURITY INVOKER, one savepoint per row,
-- dry run saves nothing. The plan's employee limit applies per added row.
-- =============================================================================

create or replace function app.import_date(p_value text)
returns date
language plpgsql
immutable
set search_path = ''
as $$
declare
  v text := btrim(coalesce(p_value, ''));
  m text[];
begin
  if v = '' then
    return null;
  end if;
  -- 2024-01-15, also with a time part (Excel date cells arrive as ISO timestamps).
  m := regexp_match(v, '^(\d{4})-(\d{1,2})-(\d{1,2})([T ].*)?$');
  if m is not null then
    return make_date(m[1]::integer, m[2]::integer, m[3]::integer);
  end if;
  -- 15/01/2024 (day first).
  m := regexp_match(v, '^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$');
  if m is not null then
    return make_date(m[3]::integer, m[2]::integer, m[1]::integer);
  end if;
  perform app.raise('INVALID_DATE', 'Use YYYY-MM-DD or DD/MM/YYYY, not "' || left(v, 40) || '"');
  return null;
exception when datetime_field_overflow then
  perform app.raise('INVALID_DATE', 'Not a real date: "' || left(v, 40) || '"');
  return null;
end;
$$;
revoke all on function app.import_date(text) from public;
grant execute on function app.import_date(text) to authenticated, service_role;

create or replace function public.import_employees(p_tenant uuid, p_rows jsonb, p_dry_run boolean default false)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_row       jsonb;
  v_idx       integer;
  v_name      text;
  v_code      text;
  v_key       text;
  v_seen      text[] := '{}';
  v_id        uuid;
  v_is_update boolean;
  v_phone     text;
  v_gender    text;
  v_hired     date;
  v_sort      integer;
  v_bookable  boolean;
  v_active    boolean;
  v_tok       text;
  v_ref       uuid;
  v_branches  uuid[];
  v_services  uuid[];
  v_inserted  integer := 0;
  v_updated   integer := 0;
  v_errors    jsonb := '[]'::jsonb;
  v_err       text;
  v_detail    text;
begin
  perform app.require_permission(p_tenant, 'employees.manage');
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    perform app.raise('INVALID_IMPORT', 'Rows must be a JSON array');
  end if;
  if jsonb_array_length(p_rows) > 1000 then
    perform app.raise('IMPORT_TOO_LARGE', 'Import at most 1000 employees at a time');
  end if;

  for v_row, v_idx in
    select e.value, e.ord::integer from jsonb_array_elements(p_rows) with ordinality as e(value, ord)
  loop
    v_id := null;
    v_is_update := false;
    v_key := null;
    v_branches := null;
    v_services := null;
    begin
      if jsonb_typeof(v_row) <> 'object' then
        perform app.raise('INVALID_IMPORT', 'Each row must be an object');
      end if;
      v_name := btrim(coalesce(v_row ->> 'name_en', ''));
      v_code := nullif(upper(btrim(coalesce(v_row ->> 'code', ''))), '');
      if v_name = '' then
        perform app.raise('NAME_REQUIRED', 'The employee name is missing');
      end if;
      v_key := coalesce('c:' || v_code, 'n:' || lower(v_name));
      if v_key = any (v_seen) then
        perform app.raise('DUPLICATE_IN_FILE', 'This employee appears more than once in the file');
      end if;

      v_phone    := nullif(regexp_replace(coalesce(v_row ->> 'phone', ''), '[\s\-()'']', '', 'g'), '');
      v_gender   := nullif(lower(btrim(coalesce(v_row ->> 'gender', ''))), '');
      v_gender   := case v_gender when 'f' then 'female' when 'm' then 'male' when 'أنثى' then 'female' when 'ذكر' then 'male' else v_gender end;
      v_hired    := app.import_date(v_row ->> 'hired_on');
      v_sort     := round(nullif(replace(btrim(v_row ->> 'sort_order'), ',', ''), '')::numeric)::integer;
      v_bookable := app.import_bool(v_row ->> 'is_bookable');
      v_active   := app.import_bool(v_row ->> 'is_active');

      -- Branches: codes or names, separated by ";".
      if nullif(btrim(coalesce(v_row ->> 'branches', '')), '') is not null then
        v_branches := '{}';
        foreach v_tok in array regexp_split_to_array(v_row ->> 'branches', '\s*;\s*') loop
          v_tok := btrim(v_tok);
          continue when v_tok = '';
          select b.id into v_ref from public.branches b
          where b.tenant_id = p_tenant and (upper(b.code) = upper(v_tok) or lower(btrim(b.name_en)) = lower(v_tok))
          order by (upper(b.code) = upper(v_tok)) desc limit 1;
          if v_ref is null then
            perform app.raise('INVALID_BRANCH', 'Unknown branch "' || left(v_tok, 60) || '"');
          end if;
          if not app.has_branch_access(v_ref) then
            perform app.raise('BRANCH_ESCALATION_FORBIDDEN', 'No access to branch "' || left(v_tok, 60) || '"', '42501');
          end if;
          v_branches := v_branches || v_ref;
        end loop;
      end if;

      -- Services: codes or names separated by ";", or "all" for every active service.
      if nullif(btrim(coalesce(v_row ->> 'services', '')), '') is not null then
        if lower(btrim(v_row ->> 'services')) in ('all', '*', 'الكل') then
          v_services := array(select s.id from public.services s where s.tenant_id = p_tenant and s.is_active);
        else
          v_services := '{}';
          foreach v_tok in array regexp_split_to_array(v_row ->> 'services', '\s*;\s*') loop
            v_tok := btrim(v_tok);
            continue when v_tok = '';
            select s.id into v_ref from public.services s
            where s.tenant_id = p_tenant and (s.code = upper(v_tok) or lower(btrim(s.name_en)) = lower(v_tok))
            order by (s.code = upper(v_tok)) desc nulls last, s.created_at limit 1;
            if v_ref is null then
              perform app.raise('INVALID_SERVICE', 'Unknown service "' || left(v_tok, 60) || '"');
            end if;
            v_services := v_services || v_ref;
          end loop;
        end if;
      end if;

      -- Existing employee: same code, else same name (a coded row never takes over an employee with another code).
      if v_code is not null then
        select e.id into v_id from public.employees e where e.tenant_id = p_tenant and e.code = v_code;
      end if;
      if v_id is null then
        select e.id into v_id from public.employees e
        where e.tenant_id = p_tenant and lower(btrim(e.name_en)) = lower(v_name) and (v_code is null or e.code is null)
        order by e.created_at limit 1;
      end if;

      if v_id is not null then
        v_is_update := true;
        update public.employees e
        set code = coalesce(v_code, e.code),
            name_en = v_name,
            name_ar = coalesce(nullif(btrim(v_row ->> 'name_ar'), ''), e.name_ar),
            job_title = coalesce(nullif(btrim(v_row ->> 'job_title'), ''), e.job_title),
            phone = coalesce(v_phone, e.phone),
            email = coalesce(nullif(lower(btrim(v_row ->> 'email')), ''), e.email),
            gender = coalesce(v_gender, e.gender),
            is_bookable = coalesce(v_bookable, e.is_bookable),
            is_active = coalesce(v_active, e.is_active),
            hired_on = coalesce(v_hired, e.hired_on),
            sort_order = coalesce(v_sort, e.sort_order)
        where e.id = v_id;
      else
        insert into public.employees
          (tenant_id, code, name_en, name_ar, job_title, phone, email, gender, is_bookable, is_active, hired_on, sort_order)
        values
          (p_tenant, v_code, v_name, nullif(btrim(v_row ->> 'name_ar'), ''), nullif(btrim(v_row ->> 'job_title'), ''),
           v_phone, nullif(lower(btrim(v_row ->> 'email')), ''), v_gender,
           coalesce(v_bookable, true), coalesce(v_active, true), v_hired, coalesce(v_sort, 0))
        returning id into v_id;
        -- A new employee of a single-branch salon works at that branch.
        if v_branches is null and (select count(*) from public.branches b where b.tenant_id = p_tenant) = 1 then
          v_branches := array(select b.id from public.branches b where b.tenant_id = p_tenant and app.has_branch_access(b.id));
        end if;
      end if;

      if v_branches is not null then
        delete from public.employee_branches eb
        where eb.employee_id = v_id
          and eb.branch_id in (select app.accessible_branch_ids())
          and eb.branch_id <> all (v_branches);
        insert into public.employee_branches (tenant_id, employee_id, branch_id)
        select distinct p_tenant, v_id, x from unnest(v_branches) x
        on conflict do nothing;
      end if;
      if v_services is not null then
        delete from public.employee_services es
        where es.employee_id = v_id and es.service_id <> all (v_services);
        insert into public.employee_services (tenant_id, employee_id, service_id)
        select distinct p_tenant, v_id, x from unnest(v_services) x
        on conflict do nothing;
      end if;

      if p_dry_run then
        -- Validated; undo this row's writes by leaving the savepoint with an error.
        raise exception using errcode = 'P0001', message = 'DRY_RUN_ROW_OK';
      end if;
      v_err := null;
    exception when others then
      v_err := sqlerrm;
      get stacked diagnostics v_detail = pg_exception_detail;
    end;

    if v_err is null or v_err = 'DRY_RUN_ROW_OK' then
      if v_is_update then v_updated := v_updated + 1; else v_inserted := v_inserted + 1; end if;
      v_seen := v_seen || v_key;
    else
      v_errors := v_errors || jsonb_build_object(
        'row', v_idx,
        'code', case when v_err ~ '^[A-Z][A-Z0-9_]{2,}$' then v_err
                     when v_err like '%employees_code_idx%' then 'DUPLICATE'
                     else 'INVALID_VALUE' end,
        -- our own errors explain themselves ("Unknown branch …"); database errors keep their message
        'detail', case when v_err ~ '^[A-Z][A-Z0-9_]{2,}$' then coalesce(nullif(v_detail, ''), v_err) else v_err end);
    end if;
    v_err := null;
  end loop;

  return jsonb_build_object(
    'dry_run', coalesce(p_dry_run, false),
    'total', jsonb_array_length(p_rows),
    'inserted', v_inserted,
    'updated', v_updated,
    'errors', v_errors);
end;
$$;

revoke all on function public.import_employees(uuid, jsonb, boolean) from public, anon;
grant execute on function public.import_employees(uuid, jsonb, boolean) to authenticated, service_role;

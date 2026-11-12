-- =============================================================================
-- Salonzoft · Migration 0021 · Service catalogue import (CSV / Excel)
-- -----------------------------------------------------------------------------
-- import_services(tenant, rows, dry_run): each row adds a service or updates an
-- existing one. A row matches an existing service by its code, otherwise by its
-- English name. Columns left empty keep the current value on update and take
-- the default on insert. Categories are matched by English name and created
-- when missing.
-- Like import_customers: SECURITY INVOKER (RLS and column grants apply), every
-- row runs in its own savepoint so bad rows are reported without stopping the
-- file, and a dry run validates everything while saving nothing.
-- =============================================================================

create or replace function app.import_bool(p_value text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_value is null or btrim(p_value) = '' then
    return null;
  end if;
  if lower(btrim(p_value)) in ('true', 'yes', 'y', '1', 'نعم') then
    return true;
  elsif lower(btrim(p_value)) in ('false', 'no', 'n', '0', 'لا') then
    return false;
  end if;
  perform app.raise('INVALID_VALUE', 'Use yes or no, not "' || left(p_value, 40) || '"');
  return null;
end;
$$;
revoke all on function app.import_bool(text) from public;
grant execute on function app.import_bool(text) to authenticated, service_role;

create or replace function public.import_services(p_tenant uuid, p_rows jsonb, p_dry_run boolean default false)
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
  v_cat_name  text;
  v_cat       uuid;
  v_new_cat   text;
  v_new_cats  text[] := '{}';
  v_id        uuid;
  v_is_update boolean;
  v_duration  integer;
  v_before    integer;
  v_after     integer;
  v_sort      integer;
  v_price     numeric;
  v_online    boolean;
  v_active    boolean;
  v_inserted  integer := 0;
  v_updated   integer := 0;
  v_errors    jsonb := '[]'::jsonb;
  v_err       text;
begin
  perform app.require_permission(p_tenant, 'services.manage');
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    perform app.raise('INVALID_IMPORT', 'Rows must be a JSON array');
  end if;
  if jsonb_array_length(p_rows) > 1000 then
    perform app.raise('IMPORT_TOO_LARGE', 'Import at most 1000 services at a time');
  end if;

  for v_row, v_idx in
    select e.value, e.ord::integer from jsonb_array_elements(p_rows) with ordinality as e(value, ord)
  loop
    v_id := null;
    v_cat := null;
    v_new_cat := null;
    v_is_update := false;
    v_key := null;
    begin
      if jsonb_typeof(v_row) <> 'object' then
        perform app.raise('INVALID_IMPORT', 'Each row must be an object');
      end if;
      v_name := btrim(coalesce(v_row ->> 'name_en', ''));
      v_code := nullif(upper(btrim(coalesce(v_row ->> 'code', ''))), '');
      if v_name = '' then
        perform app.raise('NAME_REQUIRED', 'The service name is missing');
      end if;
      v_key := coalesce('c:' || v_code, 'n:' || lower(v_name));
      if v_key = any (v_seen) then
        perform app.raise('DUPLICATE_IN_FILE', 'This service appears more than once in the file');
      end if;

      v_duration := round(nullif(replace(btrim(v_row ->> 'duration_minutes'), ',', ''), '')::numeric)::integer;
      v_before   := round(nullif(replace(btrim(v_row ->> 'buffer_before_minutes'), ',', ''), '')::numeric)::integer;
      v_after    := round(nullif(replace(btrim(v_row ->> 'buffer_after_minutes'), ',', ''), '')::numeric)::integer;
      v_sort     := round(nullif(replace(btrim(v_row ->> 'sort_order'), ',', ''), '')::numeric)::integer;
      v_price    := nullif(replace(btrim(v_row ->> 'price'), ',', ''), '')::numeric;
      v_online   := app.import_bool(v_row ->> 'online_bookable');
      v_active   := app.import_bool(v_row ->> 'is_active');

      -- Category by English name; created when the salon does not have it yet.
      v_cat_name := nullif(btrim(coalesce(v_row ->> 'category', '')), '');
      if v_cat_name is not null then
        select c.id into v_cat from public.service_categories c
        where c.tenant_id = p_tenant and lower(btrim(c.name_en)) = lower(v_cat_name);
        if v_cat is null then
          insert into public.service_categories (tenant_id, name_en, name_ar)
          values (p_tenant, v_cat_name, nullif(btrim(coalesce(v_row ->> 'category_ar', '')), ''))
          returning id into v_cat;
          v_new_cat := lower(v_cat_name);
        end if;
      end if;

      -- Existing service: same code, else same name (a coded row never takes over a service with another code).
      if v_code is not null then
        select s.id into v_id from public.services s where s.tenant_id = p_tenant and s.code = v_code;
      end if;
      if v_id is null then
        select s.id into v_id from public.services s
        where s.tenant_id = p_tenant and lower(btrim(s.name_en)) = lower(v_name) and (v_code is null or s.code is null)
        order by s.created_at limit 1;
      end if;

      if v_id is not null then
        v_is_update := true;
        update public.services s
        set code = coalesce(v_code, s.code),
            name_en = v_name,
            name_ar = coalesce(nullif(btrim(v_row ->> 'name_ar'), ''), s.name_ar),
            category_id = coalesce(v_cat, s.category_id),
            description_en = coalesce(nullif(btrim(v_row ->> 'description_en'), ''), s.description_en),
            description_ar = coalesce(nullif(btrim(v_row ->> 'description_ar'), ''), s.description_ar),
            duration_minutes = coalesce(v_duration, s.duration_minutes),
            buffer_before_minutes = coalesce(v_before, s.buffer_before_minutes),
            buffer_after_minutes = coalesce(v_after, s.buffer_after_minutes),
            price = coalesce(v_price, s.price),
            price_type = coalesce(nullif(lower(btrim(v_row ->> 'price_type')), ''), s.price_type),
            vat_category = coalesce(nullif(lower(btrim(v_row ->> 'vat_category')), ''), s.vat_category),
            audience = coalesce(nullif(lower(btrim(v_row ->> 'audience')), ''), s.audience),
            online_bookable = coalesce(v_online, s.online_bookable),
            is_active = coalesce(v_active, s.is_active),
            sort_order = coalesce(v_sort, s.sort_order)
        where s.id = v_id;
      else
        insert into public.services
          (tenant_id, category_id, code, name_en, name_ar, description_en, description_ar, duration_minutes,
           buffer_before_minutes, buffer_after_minutes, price, price_type, vat_category, audience,
           online_bookable, is_active, sort_order)
        values
          (p_tenant, v_cat, v_code, v_name, nullif(btrim(v_row ->> 'name_ar'), ''),
           nullif(btrim(v_row ->> 'description_en'), ''), nullif(btrim(v_row ->> 'description_ar'), ''),
           coalesce(v_duration, 30), coalesce(v_before, 0), coalesce(v_after, 0), coalesce(v_price, 0),
           coalesce(nullif(lower(btrim(v_row ->> 'price_type')), ''), 'fixed'),
           coalesce(nullif(lower(btrim(v_row ->> 'vat_category')), ''), 'standard'),
           coalesce(nullif(lower(btrim(v_row ->> 'audience')), ''), 'all'),
           coalesce(v_online, true), coalesce(v_active, true), coalesce(v_sort, 0));
      end if;

      if p_dry_run then
        -- Validated; undo this row's writes by leaving the savepoint with an error.
        raise exception using errcode = 'P0001', message = 'DRY_RUN_ROW_OK';
      end if;
      v_err := null;
    exception when others then
      v_err := sqlerrm;
    end;

    if v_err is null or v_err = 'DRY_RUN_ROW_OK' then
      if v_is_update then v_updated := v_updated + 1; else v_inserted := v_inserted + 1; end if;
      v_seen := v_seen || v_key;
      if v_new_cat is not null and not (v_new_cat = any (v_new_cats)) then
        v_new_cats := v_new_cats || v_new_cat;
      end if;
    else
      v_errors := v_errors || jsonb_build_object(
        'row', v_idx,
        'code', case when v_err ~ '^[A-Z][A-Z0-9_]{2,}$' then v_err
                     when v_err like '%services_code_idx%' then 'DUPLICATE'
                     else 'INVALID_VALUE' end,
        'detail', v_err);
    end if;
    v_err := null;
  end loop;

  return jsonb_build_object(
    'dry_run', coalesce(p_dry_run, false),
    'total', jsonb_array_length(p_rows),
    'inserted', v_inserted,
    'updated', v_updated,
    'categories_created', cardinality(v_new_cats),
    'errors', v_errors);
end;
$$;

revoke all on function public.import_services(uuid, jsonb, boolean) from public, anon;
grant execute on function public.import_services(uuid, jsonb, boolean) to authenticated, service_role;

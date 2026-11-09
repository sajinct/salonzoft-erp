-- =============================================================================
-- Salonzoft · Migration 0009 · Customers (CRM foundation)
-- -----------------------------------------------------------------------------
--  * Customers are shared by all branches of a tenant (one client, many visits).
--  * Mobile numbers are normalised to E.164 (+968 default from tenant settings)
--    and unique per tenant, so the same person can't be created twice by
--    typing "9123 4567" and "+968 91234567".
--  * Consent is an append-only history (who recorded what, when, how) — the
--    latest row per channel + purpose is the current state (PDPL).
--  * Notes of kind allergy / medical are health data: visible and writable only
--    with customers.sensitive.
--  * Trigram search over a generated, lower-cased search_text column.
-- =============================================================================

create extension if not exists pg_trgm with schema extensions;
-- Supabase already grants this; stated explicitly because search functions
-- (SECURITY INVOKER) call extensions.word_similarity as the API role.
grant usage on schema extensions to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 1. Mobile normalisation
-- ---------------------------------------------------------------------------
-- Returns E.164 (+96891234567) or raises INVALID_MOBILE. Accepts spaces,
-- dashes, dots, parentheses, a 00 international prefix, a national trunk 0,
-- the country code without "+", or a bare local number.
create or replace function app.normalize_mobile(p_raw text, p_country_code text default '+968')
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_cc     text := regexp_replace(coalesce(p_country_code, '+968'), '[^0-9]', '', 'g');
  v_plus   boolean := coalesce(p_raw, '') ~ '^[\s(]*\+';
  v_digits text := regexp_replace(coalesce(p_raw, ''), '[^0-9]', '', 'g');
  v_out    text;
begin
  if v_digits = '' then
    return null;
  end if;

  if v_plus then
    v_out := '+' || v_digits;
  elsif v_digits like '00%' then
    v_out := '+' || substr(v_digits, 3);
  elsif v_digits like '0%' then
    v_out := '+' || v_cc || substr(v_digits, 2);
  elsif v_digits like v_cc || '%' and char_length(v_digits) >= char_length(v_cc) + 7 then
    v_out := '+' || v_digits;
  else
    v_out := '+' || v_cc || v_digits;
  end if;

  if v_out !~ '^\+[1-9][0-9]{7,14}$' then
    perform app.raise('INVALID_MOBILE', format('Not a valid mobile number: %s', p_raw));
  end if;
  return v_out;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Customers
-- ---------------------------------------------------------------------------
create table public.customers (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants (id) on delete cascade,
  first_name          text not null check (char_length(btrim(first_name)) between 1 and 80),
  last_name           text check (char_length(last_name) <= 80),
  name_ar             text check (char_length(name_ar) <= 120),
  mobile              text check (mobile ~ '^\+[1-9][0-9]{7,14}$'),
  email               text check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  gender              text check (gender in ('female', 'male')),
  date_of_birth       date check (date_of_birth between date '1900-01-01' and date '2100-01-01'),
  preferred_language  text check (preferred_language in ('en', 'ar')),
  home_branch_id      uuid,
  source              text not null default 'walk_in'
                      check (source in ('walk_in', 'phone', 'whatsapp', 'instagram', 'referral',
                                        'online', 'import', 'other')),
  tags                text[] not null default '{}'
                      check (cardinality(tags) <= 20),
  status              text not null default 'active' check (status in ('active', 'blocked', 'archived')),
  external_ref        text check (char_length(external_ref) <= 64),  -- id in a previous system
  created_by          uuid default auth.uid() references auth.users (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  search_text         text generated always as (
                        lower(first_name || ' ' || coalesce(last_name, '') || ' ' || coalesce(name_ar, '') || ' '
                              || coalesce(mobile, '') || ' ' || coalesce(email, ''))) stored,
  unique (id, tenant_id),
  foreign key (home_branch_id, tenant_id) references public.branches (id, tenant_id)
    on delete set null (home_branch_id)
);
create unique index customers_mobile_idx on public.customers (tenant_id, mobile) where mobile is not null;
create unique index customers_external_ref_idx on public.customers (tenant_id, external_ref) where external_ref is not null;
create index customers_tenant_name_idx on public.customers (tenant_id, lower(first_name), lower(last_name));
create index customers_email_idx on public.customers (tenant_id, email) where email is not null;
create index customers_home_branch_idx on public.customers (home_branch_id);
create index customers_search_trgm_idx on public.customers using gin (search_text extensions.gin_trgm_ops);
create trigger customers_updated_at before update on public.customers
  for each row execute function app.set_updated_at();

-- Normalise before every write: trimmed names, lower-case email, E.164 mobile,
-- de-duplicated tags.
create or replace function app.customers_normalize()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cc text;
begin
  select s.phone_country_code into v_cc from public.tenant_settings s where s.tenant_id = new.tenant_id;
  new.first_name := btrim(new.first_name);
  new.last_name  := nullif(btrim(new.last_name), '');
  new.name_ar    := nullif(btrim(new.name_ar), '');
  new.email      := nullif(lower(btrim(new.email)), '');
  new.mobile     := app.normalize_mobile(new.mobile, coalesce(v_cc, '+968'));
  new.external_ref := nullif(btrim(new.external_ref), '');
  new.tags := coalesce((select array_agg(distinct t order by t)
                        from unnest(new.tags) as x(raw)
                        cross join lateral (select lower(btrim(x.raw)) as t) n
                        where n.t <> '' and char_length(n.t) <= 30), '{}');
  if new.email is not null and new.email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    perform app.raise('INVALID_EMAIL', 'Enter a valid email address');
  end if;
  if new.first_name = '' then
    perform app.raise('INVALID_NAME', 'First name is required');
  end if;
  return new;
end;
$$;
create trigger customers_normalize before insert or update on public.customers
  for each row execute function app.customers_normalize();

-- ---------------------------------------------------------------------------
-- 3. Consent history (append-only)
-- ---------------------------------------------------------------------------
create table public.customer_consents (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null,
  customer_id  uuid not null,
  channel      text not null check (channel in ('whatsapp', 'sms', 'email')),
  purpose      text not null check (purpose in ('marketing', 'reminders')),
  granted      boolean not null,
  source       text not null default 'in_person'
               check (source in ('in_person', 'phone', 'online', 'import', 'customer_request')),
  recorded_by  uuid default auth.uid() references auth.users (id) on delete set null,
  recorded_at  timestamptz not null default now(),
  foreign key (customer_id, tenant_id) references public.customers (id, tenant_id) on delete cascade
);
create index customer_consents_customer_idx on public.customer_consents (customer_id, channel, purpose, recorded_at desc);
create index customer_consents_tenant_idx on public.customer_consents (tenant_id);

-- ---------------------------------------------------------------------------
-- 4. Notes (allergy / medical = sensitive)
-- ---------------------------------------------------------------------------
create table public.customer_notes (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null,
  customer_id  uuid not null,
  kind         text not null default 'general' check (kind in ('general', 'preference', 'allergy', 'medical')),
  body         text not null check (char_length(btrim(body)) between 1 and 2000),
  is_pinned    boolean not null default false,
  is_sensitive boolean generated always as (kind in ('allergy', 'medical')) stored,
  created_by   uuid default auth.uid() references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  foreign key (customer_id, tenant_id) references public.customers (id, tenant_id) on delete cascade
);
create index customer_notes_customer_idx on public.customer_notes (customer_id, is_pinned desc, created_at desc);
create index customer_notes_tenant_idx on public.customer_notes (tenant_id);
create trigger customer_notes_updated_at before update on public.customer_notes
  for each row execute function app.set_updated_at();

-- ---------------------------------------------------------------------------
-- 5. RLS + grants
-- ---------------------------------------------------------------------------
alter table public.customers          enable row level security;
alter table public.customer_consents  enable row level security;
alter table public.customer_notes     enable row level security;

revoke all on public.customers, public.customer_consents, public.customer_notes from anon, authenticated;
grant all on public.customers, public.customer_consents, public.customer_notes to service_role;

-- Customers: no delete (archive instead; erasure requests go through a
-- dedicated, audited privacy workflow in Phase 6/7).
grant select on public.customers to authenticated;
grant insert (tenant_id, first_name, last_name, name_ar, mobile, email, gender, date_of_birth,
              preferred_language, home_branch_id, source, tags, status, external_ref)
  on public.customers to authenticated;
grant update (first_name, last_name, name_ar, mobile, email, gender, date_of_birth,
              preferred_language, home_branch_id, source, tags, status, external_ref)
  on public.customers to authenticated;

create policy customers_select on public.customers
  for select to authenticated
  using (tenant_id in (select app.tenants_with_permission('customers.view')));
create policy customers_insert on public.customers
  for insert to authenticated
  with check (tenant_id in (select app.tenants_with_permission('customers.manage')));
create policy customers_update on public.customers
  for update to authenticated
  using (tenant_id in (select app.tenants_with_permission('customers.manage')))
  with check (tenant_id in (select app.tenants_with_permission('customers.manage')));

-- Consents: insert + read only (history is never rewritten).
grant select on public.customer_consents to authenticated;
grant insert (tenant_id, customer_id, channel, purpose, granted, source) on public.customer_consents to authenticated;

create policy customer_consents_select on public.customer_consents
  for select to authenticated
  using (tenant_id in (select app.tenants_with_permission('customers.view')));
create policy customer_consents_insert on public.customer_consents
  for insert to authenticated
  with check (tenant_id in (select app.tenants_with_permission('customers.manage')));

-- Notes: sensitive kinds need customers.sensitive for every operation.
grant select, delete on public.customer_notes to authenticated;
grant insert (tenant_id, customer_id, kind, body, is_pinned) on public.customer_notes to authenticated;
grant update (kind, body, is_pinned) on public.customer_notes to authenticated;

create policy customer_notes_select on public.customer_notes
  for select to authenticated
  using (tenant_id in (select app.tenants_with_permission('customers.view'))
         and (kind not in ('allergy', 'medical')
              or tenant_id in (select app.tenants_with_permission('customers.sensitive'))));
create policy customer_notes_insert on public.customer_notes
  for insert to authenticated
  with check (tenant_id in (select app.tenants_with_permission('customers.manage'))
              and (kind not in ('allergy', 'medical')
                   or tenant_id in (select app.tenants_with_permission('customers.sensitive'))));
create policy customer_notes_update on public.customer_notes
  for update to authenticated
  using (tenant_id in (select app.tenants_with_permission('customers.manage'))
         and (kind not in ('allergy', 'medical')
              or tenant_id in (select app.tenants_with_permission('customers.sensitive'))))
  with check (tenant_id in (select app.tenants_with_permission('customers.manage'))
              and (kind not in ('allergy', 'medical')
                   or tenant_id in (select app.tenants_with_permission('customers.sensitive'))));
create policy customer_notes_delete on public.customer_notes
  for delete to authenticated
  using (tenant_id in (select app.tenants_with_permission('customers.manage'))
         and (kind not in ('allergy', 'medical')
              or tenant_id in (select app.tenants_with_permission('customers.sensitive'))));

-- Audit (note bodies are stripped by app.audit_row) ------------------------------
create trigger audit_customers after insert or update on public.customers
  for each row execute function app.audit_row();
create trigger audit_customer_consents after insert on public.customer_consents
  for each row execute function app.audit_row();
create trigger audit_customer_notes after insert or update or delete on public.customer_notes
  for each row execute function app.audit_row();

-- ---------------------------------------------------------------------------
-- 6. RPCs (SECURITY INVOKER — RLS applies)
-- ---------------------------------------------------------------------------

-- Search by name (English or Arabic), mobile (any part of the digits) or email.
create or replace function public.search_customers(
  p_tenant uuid,
  p_query text,
  p_limit integer default 25,
  p_include_archived boolean default false
)
returns setof public.customers
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_q      text := lower(btrim(coalesce(p_query, '')));
  v_digits text := regexp_replace(coalesce(p_query, ''), '[^0-9]', '', 'g');
  v_limit  integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_like   text;
begin
  perform app.require_permission(p_tenant, 'customers.view');
  v_like := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';

  if v_q = '' then
    return query
    select c.* from public.customers c
    where c.tenant_id = p_tenant and (p_include_archived or c.status <> 'archived')
    order by c.created_at desc
    limit v_limit;
  elsif char_length(v_digits) >= 4 and v_q ~ '^[0-9+\s().-]+$' then
    -- Phone search: match any run of the digits (local or international form).
    return query
    select c.* from public.customers c
    where c.tenant_id = p_tenant and (p_include_archived or c.status <> 'archived')
      and c.mobile like '%' || v_digits || '%'
    order by c.first_name, c.last_name
    limit v_limit;
  else
    return query
    select c.* from public.customers c
    where c.tenant_id = p_tenant and (p_include_archived or c.status <> 'archived')
      and (c.search_text like v_like
           or extensions.word_similarity(v_q, c.search_text) >= 0.45)
    order by (c.search_text like v_like) desc,
             extensions.word_similarity(v_q, c.search_text) desc,
             c.first_name, c.last_name
    limit v_limit;
  end if;
end;
$$;

-- Possible duplicates for a new / edited customer: same mobile, same email, or
-- a very similar name. Used by the UI before saving and by imports.
create or replace function public.find_customer_duplicates(
  p_tenant uuid,
  p_mobile text,
  p_email text,
  p_first_name text,
  p_last_name text default null,
  p_exclude_id uuid default null
)
returns table (
  id uuid,
  first_name text,
  last_name text,
  mobile text,
  email text,
  status text,
  reason text,
  score real
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_cc     text;
  v_mobile text;
  v_email  text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_name   text := lower(btrim(coalesce(p_first_name, '') || ' ' || coalesce(p_last_name, '')));
begin
  perform app.require_permission(p_tenant, 'customers.view');
  select s.phone_country_code into v_cc from public.tenant_settings s where s.tenant_id = p_tenant;
  begin
    v_mobile := app.normalize_mobile(p_mobile, coalesce(v_cc, '+968'));
  exception when others then
    v_mobile := null;  -- an invalid number simply can't match
  end;

  return query
  with candidates as (
    select c.id, c.first_name, c.last_name, c.mobile, c.email, c.status, 'mobile'::text as reason, 1.0::real as score
    from public.customers c
    where c.tenant_id = p_tenant and v_mobile is not null and c.mobile = v_mobile
    union all
    select c.id, c.first_name, c.last_name, c.mobile, c.email, c.status, 'email', 0.9::real
    from public.customers c
    where c.tenant_id = p_tenant and v_email is not null and c.email = v_email
    union all
    select c.id, c.first_name, c.last_name, c.mobile, c.email, c.status, 'name',
           extensions.similarity(v_name, lower(c.first_name || ' ' || coalesce(c.last_name, '')))
    from public.customers c
    where c.tenant_id = p_tenant
      and char_length(v_name) >= 3
      and extensions.similarity(v_name, lower(c.first_name || ' ' || coalesce(c.last_name, ''))) >= 0.6
  )
  select distinct on (x.id) x.id, x.first_name, x.last_name, x.mobile, x.email, x.status, x.reason, x.score
  from candidates x
  where p_exclude_id is null or x.id <> p_exclude_id
  order by x.id, x.score desc
  limit 10;
end;
$$;

-- Bulk import (CSV rows already parsed by the client). Every row is validated
-- by the same constraints and triggers as a normal insert, inside its own
-- savepoint, so one bad row never aborts the batch. With p_dry_run = true
-- nothing is written and the result shows what would happen.
-- Row keys: first_name, last_name, name_ar, mobile, email, gender,
--           date_of_birth (YYYY-MM-DD), preferred_language, tags (array or
--           "a;b"), external_ref, note, whatsapp_marketing (true/false)
create or replace function public.import_customers(p_tenant uuid, p_rows jsonb, p_dry_run boolean default false)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_cc        text;
  v_row       jsonb;
  v_idx       integer;
  v_mobile    text;
  v_seen      text[] := '{}';
  v_seen_refs text[] := '{}';
  v_id        uuid;
  v_inserted  integer := 0;
  v_dupes     jsonb := '[]'::jsonb;
  v_errors    jsonb := '[]'::jsonb;
  v_tags      text[];
  v_consent   boolean;
  v_code      text;
begin
  perform app.require_permission(p_tenant, 'customers.manage');
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    perform app.raise('INVALID_IMPORT', 'Rows must be a JSON array');
  end if;
  if jsonb_array_length(p_rows) > 2000 then
    perform app.raise('IMPORT_TOO_LARGE', 'Import at most 2000 customers at a time');
  end if;
  select s.phone_country_code into v_cc from public.tenant_settings s where s.tenant_id = p_tenant;

  for v_row, v_idx in
    select e.value, e.ord::integer from jsonb_array_elements(p_rows) with ordinality as e(value, ord)
  loop
    begin
      if jsonb_typeof(v_row) <> 'object' then
        perform app.raise('INVALID_IMPORT', 'Each row must be an object');
      end if;

      v_mobile := app.normalize_mobile(v_row ->> 'mobile', coalesce(v_cc, '+968'));

      -- Duplicates: an existing customer, or an earlier row of this file.
      select c.id into v_id from public.customers c
      where c.tenant_id = p_tenant
        and ((v_mobile is not null and c.mobile = v_mobile)
             or (nullif(btrim(v_row ->> 'external_ref'), '') is not null
                 and c.external_ref = btrim(v_row ->> 'external_ref')))
      limit 1;
      if v_id is not null or v_mobile = any (v_seen)
         or nullif(btrim(v_row ->> 'external_ref'), '') = any (v_seen_refs) then
        v_dupes := v_dupes || jsonb_build_object('row', v_idx, 'existing_id', v_id, 'mobile', v_mobile);
        continue;
      end if;

      v_tags := case jsonb_typeof(v_row -> 'tags')
                  when 'array' then array(select jsonb_array_elements_text(v_row -> 'tags'))
                  when 'string' then string_to_array(v_row ->> 'tags', ';')
                  else '{}'::text[] end;
      v_consent := case lower(coalesce(v_row ->> 'whatsapp_marketing', ''))
                     when 'true' then true when 'yes' then true when '1' then true
                     when 'false' then false when 'no' then false when '0' then false
                     else null end;

      insert into public.customers (tenant_id, first_name, last_name, name_ar, mobile, email, gender,
                                    date_of_birth, preferred_language, source, tags, external_ref)
      values (p_tenant,
              coalesce(v_row ->> 'first_name', ''),
              v_row ->> 'last_name',
              v_row ->> 'name_ar',
              v_mobile,
              v_row ->> 'email',
              nullif(lower(btrim(v_row ->> 'gender')), ''),
              nullif(btrim(v_row ->> 'date_of_birth'), '')::date,
              nullif(lower(btrim(v_row ->> 'preferred_language')), ''),
              'import',
              v_tags,
              v_row ->> 'external_ref')
      returning id into v_id;

      if nullif(btrim(v_row ->> 'note'), '') is not null then
        insert into public.customer_notes (tenant_id, customer_id, kind, body)
        values (p_tenant, v_id, 'general', left(btrim(v_row ->> 'note'), 2000));
      end if;
      if v_consent is not null then
        insert into public.customer_consents (tenant_id, customer_id, channel, purpose, granted, source)
        values (p_tenant, v_id, 'whatsapp', 'marketing', v_consent, 'import');
      end if;

      if p_dry_run then
        -- Validated; undo this row's writes by leaving the savepoint with an error.
        raise exception using errcode = 'P0001', message = 'DRY_RUN_ROW_OK';
      end if;
      v_inserted := v_inserted + 1;
      v_seen := v_seen || v_mobile;
      v_seen_refs := v_seen_refs || nullif(btrim(v_row ->> 'external_ref'), '');
    exception when others then
      if sqlerrm = 'DRY_RUN_ROW_OK' then
        v_inserted := v_inserted + 1;
        v_seen := v_seen || v_mobile;
        v_seen_refs := v_seen_refs || nullif(btrim(v_row ->> 'external_ref'), '');
      else
        v_code := case
                    when sqlerrm ~ '^[A-Z][A-Z0-9_]{2,}$' then sqlerrm
                    when sqlstate = '22007' or sqlstate = '22008' then 'INVALID_DATE'
                    when sqlstate = '23514' then 'INVALID_VALUE'
                    when sqlstate = '23505' then 'DUPLICATE'
                    else 'INVALID_VALUE' end;
        v_errors := v_errors || jsonb_build_object('row', v_idx, 'code', v_code, 'detail', sqlerrm);
      end if;
    end;
    v_id := null;
  end loop;

  return jsonb_build_object(
    'dry_run', coalesce(p_dry_run, false),
    'total', jsonb_array_length(p_rows),
    'inserted', v_inserted,
    'duplicates', v_dupes,
    'errors', v_errors);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Execute privileges
-- ---------------------------------------------------------------------------
revoke all on function app.normalize_mobile(text, text), app.customers_normalize() from public;
grant execute on function app.normalize_mobile(text, text) to authenticated, service_role;

revoke all on function
  public.search_customers(uuid, text, integer, boolean),
  public.find_customer_duplicates(uuid, text, text, text, text, uuid),
  public.import_customers(uuid, jsonb, boolean)
from public, anon;

grant execute on function
  public.search_customers(uuid, text, integer, boolean),
  public.find_customer_duplicates(uuid, text, text, text, text, uuid),
  public.import_customers(uuid, jsonb, boolean)
to authenticated, service_role;

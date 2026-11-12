-- =============================================================================
-- Salonzoft · Migration 0023 · Send invoices and appointment details by WhatsApp
-- -----------------------------------------------------------------------------
-- Staff open WhatsApp (Web or the phone app) with a ready-made message; nothing
-- is sent by the server and no WhatsApp provider is needed.
--  * get_appointment_share(appointment): the customer's number and the message,
--    worded by the salon's "booking confirmed" template (or the built-in one),
--    with the customer's own manage / cancel link. Appointments made at the
--    front desk get a link the first time they are shared.
--  * get_invoice_share(invoice): the number, a short message with the amount,
--    and a private link to the invoice.
--  * public_get_invoice(token): what that link shows — the invoice only, found
--    by its secret token (like public_get_booking). No login.
-- =============================================================================

-- Posted invoices are immutable, so the link lives beside the invoice, not on it.
-- No grants: only the functions below read or write it.
create table public.invoice_share_links (
  invoice_id  uuid primary key,
  tenant_id   uuid not null,
  token       text not null unique check (char_length(token) between 20 and 64),
  created_by  uuid default auth.uid() references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  foreign key (invoice_id, tenant_id) references public.invoices (id, tenant_id) on delete cascade
);
create index invoice_share_links_tenant_idx on public.invoice_share_links (tenant_id);
alter table public.invoice_share_links enable row level security;
revoke all on public.invoice_share_links from public, anon, authenticated;
grant all on public.invoice_share_links to service_role;

-- ---------------------------------------------------------------------------
-- Appointment details
-- ---------------------------------------------------------------------------
create or replace function public.get_appointment_share(p_appointment_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_a        public.appointments%rowtype;
  v_c        public.customers%rowtype;
  v_t        public.tenants%rowtype;
  v_b        public.branches%rowtype;
  v_lang     text;
  v_event    text;
  v_body     text;
  v_services text;
  v_staff    text;
  v_local    timestamp;
  v_url      text := app.platform_setting('public_app_url');
  v_link     text;
  v_vars     jsonb;
  v_key      text;
begin
  perform app.require_user();
  select * into v_a from public.appointments where id = p_appointment_id;
  -- Same visibility as the calendar: the branch's front desk, or the stylist's own appointments.
  if not found or not (
       exists (select 1 from app.branch_ids_with_any_permission(array['appointments.view', 'appointments.manage']) x where x = v_a.branch_id)
       or (exists (select 1 from app.tenants_with_permission('appointments.own') x where x = v_a.tenant_id)
           and exists (select 1 from public.appointment_services s
                       where s.appointment_id = v_a.id and s.employee_id in (select app.my_employee_ids())))) then
    perform app.raise('NOT_FOUND', 'Appointment not found');
  end if;

  if v_a.public_token is null then
    update public.appointments set public_token = app.new_token() where id = v_a.id returning * into v_a;
  end if;

  select * into v_c from public.customers where id = v_a.customer_id;
  select * into v_t from public.tenants where id = v_a.tenant_id;
  select * into v_b from public.branches where id = v_a.branch_id;
  v_lang := coalesce(v_c.preferred_language,
                     (select s.default_language from public.tenant_settings s where s.tenant_id = v_a.tenant_id), 'en');
  v_event := case when v_a.status = 'cancelled' then 'booking_cancelled' else 'booking_confirmed' end;

  select t.body into v_body from public.notification_templates t
  where t.tenant_id = v_a.tenant_id and t.event = v_event and t.channel = 'whatsapp' and t.language = v_lang and t.is_active;
  if v_body is null then
    select d.body into v_body from app.default_template(v_event, v_lang) d;
  end if;

  select string_agg(case when v_lang = 'ar' then coalesce(s.service_name_ar, s.service_name_en) else s.service_name_en end, ', ' order by s.sort_order),
         string_agg(distinct case when v_lang = 'ar' then coalesce(e.name_ar, e.name_en) else e.name_en end, ', ')
    into v_services, v_staff
  from public.appointment_services s join public.employees e on e.id = s.employee_id
  where s.appointment_id = v_a.id;
  v_local := v_a.starts_at at time zone coalesce(v_b.timezone, 'Asia/Muscat');
  v_link := v_url || '/book/manage/' || v_a.public_token;

  v_vars := jsonb_build_object(
    'name', coalesce(v_c.first_name, ''),
    'salon', coalesce(case when v_lang = 'ar' then coalesce(v_t.name_ar, v_t.name) else v_t.name end, ''),
    'branch', coalesce(case when v_lang = 'ar' then coalesce(v_b.name_ar, v_b.name_en) else v_b.name_en end, ''),
    'branch_phone', coalesce(v_b.phone, ''),
    'date', to_char(v_local, 'DD/MM/YYYY'),
    'time', to_char(v_local, 'HH24:MI'),
    'services', coalesce(v_services, ''),
    'staff', coalesce(v_staff, ''),
    'link', v_link,
    'book_link', v_url || '/book/' || v_t.slug);
  for v_key in select jsonb_object_keys(v_vars) loop
    v_body := replace(v_body, '{{' || v_key || '}}', v_vars ->> v_key);
  end loop;

  return jsonb_build_object(
    'mobile', v_c.mobile,
    'name', nullif(btrim(coalesce(v_c.first_name, '') || ' ' || coalesce(v_c.last_name, '')), ''),
    -- Walk-ins have no name: "Hello , your…" → "Hello, your…".
    'message', btrim(replace(replace(v_body, ' ،', '،'), ' ,', ',')),
    'link', v_link);
end;
$$;

-- ---------------------------------------------------------------------------
-- Invoices
-- ---------------------------------------------------------------------------
create or replace function public.get_invoice_share(p_invoice_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inv      public.invoices%rowtype;
  v_c        public.customers%rowtype;
  v_set      public.tenant_settings%rowtype;
  v_lang     text;
  v_name     text;
  v_salon    text;
  v_total    text;
  v_balance  numeric;
  v_token    text;
  v_link     text;
  v_message  text;
begin
  perform app.require_user();
  select * into v_inv from public.invoices where id = p_invoice_id;
  if not found or not exists (select 1 from app.branch_ids_with_any_permission(app.sales_reader_permissions()) x
                              where x = v_inv.branch_id) then
    perform app.raise('NOT_FOUND', 'Invoice not found');
  end if;
  if v_inv.status <> 'posted' then
    perform app.raise('INVOICE_NOT_POSTED', 'Only issued invoices can be sent');
  end if;

  insert into public.invoice_share_links (invoice_id, tenant_id, token)
  values (v_inv.id, v_inv.tenant_id, app.new_token())
  on conflict (invoice_id) do nothing;
  select l.token into v_token from public.invoice_share_links l where l.invoice_id = v_inv.id;

  select * into v_c from public.customers where id = v_inv.customer_id;
  select * into v_set from public.tenant_settings where tenant_id = v_inv.tenant_id;
  v_lang := coalesce(v_c.preferred_language, v_set.default_language, 'en');
  v_name := coalesce(v_c.first_name, nullif(split_part(btrim(coalesce(v_inv.customer_name, '')), ' ', 1), ''));
  v_salon := case when v_lang = 'ar' then coalesce(v_inv.seller_name_ar, v_inv.seller_name) else v_inv.seller_name end;
  v_total := v_inv.currency_code || ' ' || round(v_inv.total, v_set.currency_decimals)::text;
  v_balance := app.invoice_balance(v_inv);
  v_link := app.platform_setting('public_app_url') || '/i/' || v_token;

  if v_lang = 'ar' then
    v_message := 'مرحباً' || coalesce(' ' || v_name, '') || '، '
      || case when v_inv.kind = 'credit_note'
              then 'إشعاركم الدائن ' || v_inv.number || ' من ' || v_salon || ': ' || v_total || '.'
              else 'شكراً لزيارتكم ' || v_salon || '. فاتورتكم ' || v_inv.number || ': ' || v_total
                   || case when v_balance > 0 then ' (المتبقي ' || round(v_balance, v_set.currency_decimals)::text || ')' else '' end || '.' end
      || ' للاطلاع عليها: ' || v_link;
  else
    v_message := 'Hello' || coalesce(' ' || v_name, '') || ', '
      || case when v_inv.kind = 'credit_note'
              then 'your credit note ' || v_inv.number || ' from ' || v_salon || ': ' || v_total || '.'
              else 'thank you for visiting ' || v_salon || '. Your invoice ' || v_inv.number || ': ' || v_total
                   || case when v_balance > 0 then ' (balance due ' || round(v_balance, v_set.currency_decimals)::text || ')' else '' end || '.' end
      || ' View it here: ' || v_link;
  end if;

  return jsonb_build_object(
    'mobile', coalesce(v_c.mobile, v_inv.customer_mobile),
    'name', coalesce(nullif(btrim(coalesce(v_c.first_name, '') || ' ' || coalesce(v_c.last_name, '')), ''), v_inv.customer_name),
    'number', v_inv.number,
    'message', v_message,
    'link', v_link);
end;
$$;

-- The invoice behind a shared link: the document only, by its secret token.
create or replace function public.public_get_invoice(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_inv public.invoices%rowtype;
begin
  select i.* into v_inv
  from public.invoice_share_links l join public.invoices i on i.id = l.invoice_id
  where l.token = p_token and char_length(coalesce(p_token, '')) >= 20 and i.status = 'posted';
  if not found then
    perform app.raise('NOT_FOUND', 'Invoice not found');
  end if;
  return jsonb_build_object(
    'kind', v_inv.kind, 'number', v_inv.number, 'issued_at', v_inv.issued_at, 'currency_code', v_inv.currency_code,
    'prices_include_vat', v_inv.prices_include_vat, 'vat_registered', v_inv.vat_registered, 'vat_number', v_inv.vat_number,
    'seller_name', v_inv.seller_name, 'seller_name_ar', v_inv.seller_name_ar, 'seller_legal_name', v_inv.seller_legal_name,
    'branch_name', v_inv.branch_name, 'branch_name_ar', v_inv.branch_name_ar, 'branch_address', v_inv.branch_address,
    'branch_phone', v_inv.branch_phone, 'customer_name', v_inv.customer_name, 'customer_mobile', null,
    'footer_en', v_inv.footer_en, 'footer_ar', v_inv.footer_ar,
    'discount_total', v_inv.discount_total, 'subtotal', v_inv.subtotal, 'vat_total', v_inv.vat_total, 'total', v_inv.total,
    'paid_total', v_inv.paid_total, 'credited_total', v_inv.credited_total, 'refunded_total', v_inv.refunded_total,
    'reason', v_inv.reason)
    || jsonb_build_object(
    'balance_due', app.invoice_balance(v_inv),
    'items', (select coalesce(jsonb_agg(jsonb_build_object(
                  'description_en', it.description_en, 'description_ar', it.description_ar, 'quantity', it.quantity,
                  'unit_price', it.unit_price, 'discount_amount', it.discount_amount, 'vat_rate', it.vat_rate,
                  'vat_amount', it.vat_amount, 'total_amount', it.total_amount) order by it.sort_order), '[]'::jsonb)
              from public.invoice_items it where it.invoice_id = v_inv.id),
    'payments', (select coalesce(jsonb_agg(jsonb_build_object('method', p.method, 'direction', p.direction, 'amount', p.amount,
                                                              'reference', null) order by p.received_at), '[]'::jsonb)
                 from public.payments p
                 where p.invoice_id = v_inv.id
                    or p.invoice_id in (select c.id from public.invoices c where c.original_invoice_id = v_inv.id)),
    'original', (select jsonb_build_object('number', o.number) from public.invoices o where o.id = v_inv.original_invoice_id),
    'template', (select jsonb_build_object('receipt_paper', s.receipt_paper, 'receipt_language', s.receipt_language,
                                           'receipt_header_en', s.receipt_header_en, 'receipt_header_ar', s.receipt_header_ar,
                                           'receipt_show_logo', false, 'currency_decimals', s.currency_decimals, 'timezone', s.timezone)
                 from public.tenant_settings s where s.tenant_id = v_inv.tenant_id));
end;
$$;

revoke all on function public.get_appointment_share(uuid), public.get_invoice_share(uuid) from public, anon;
grant execute on function public.get_appointment_share(uuid), public.get_invoice_share(uuid) to authenticated, service_role;

revoke all on function public.public_get_invoice(text) from public;
grant execute on function public.public_get_invoice(text) to anon, authenticated, service_role;

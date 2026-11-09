-- =============================================================================
-- Salonzoft · Migration 0018 · Reports & exports (Phase 6, part 2)
-- -----------------------------------------------------------------------------
-- One read-only report engine: run_report(tenant, report, from, to, branch)
-- returns { rows, truncated } for a fixed catalogue of reports. Periods are
-- calendar days in the salon's timezone (max 366 days). Credit notes are
-- subtracted everywhere. Access:
--   financial   (reports.financial)           sales_daily, vat, invoices, payments
--   operational (reports.view or .financial)  services, staff, products, appointments
--   customers   (reports.view + customers.view; mobile only with customers.export)
-- Rows are limited to branches the caller can report on. Exports are audited
-- through log_report_export().
-- =============================================================================

create or replace function app.report_branches(p_tenant uuid, p_report text, p_branch uuid)
returns uuid[]
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_perms text[];
  v_branches uuid[];
begin
  perform app.require_user();
  v_perms := case
    when p_report in ('sales_daily', 'vat', 'invoices', 'payments') then array['reports.financial']
    when p_report in ('services', 'staff', 'products', 'appointments', 'customers') then array['reports.view', 'reports.financial']
  end;
  if v_perms is null then
    perform app.raise('INVALID_VALUE', 'Unknown report');
  end if;
  if not app.module_enabled(p_tenant, 'reports')
     or not exists (select 1 from app.tenants_with_any_permission(v_perms) x where x = p_tenant)
     or (p_report = 'customers' and not app.has_permission(p_tenant, 'customers.view')) then
    perform app.forbid('No access to this report');
  end if;
  select array_agg(b) into v_branches
  from app.branch_ids_with_any_permission(v_perms) b
  join public.branches br on br.id = b and br.tenant_id = p_tenant;
  if p_branch is not null then
    if not (p_branch = any (coalesce(v_branches, '{}'))) then
      perform app.forbid('No access to this branch');
    end if;
    v_branches := array[p_branch];
  end if;
  return coalesce(v_branches, '{}');
end;
$$;

create or replace function public.run_report(p_tenant uuid, p_report text, p_from date, p_to date, p_branch uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_br uuid[] := app.report_branches(p_tenant, p_report, p_branch);
  v_tz text;
  v_from timestamptz;
  v_to timestamptz;
  v_limit constant integer := 10000;
  v_mobile boolean := app.has_permission(p_tenant, 'customers.export');
  v_rows jsonb;
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
    perform app.raise('INVALID_RANGE', 'Choose a period of at most one year');
  end if;
  select s.timezone into v_tz from public.tenant_settings s where s.tenant_id = p_tenant;
  v_from := p_from::timestamp at time zone v_tz;
  v_to := (p_to + 1)::timestamp at time zone v_tz;

  case p_report
  -- ---- Financial ------------------------------------------------------------
  when 'sales_daily' then
    with inv as (
      select (i.issued_at at time zone v_tz)::date as d, i.kind, case when i.kind = 'invoice' then 1 else -1 end as sg,
             i.subtotal, i.vat_total, i.total, i.discount_total
      from public.invoices i
      where i.tenant_id = p_tenant and i.status = 'posted' and i.issued_at >= v_from and i.issued_at < v_to and i.branch_id = any (v_br)
    ), pay as (
      select (p.received_at at time zone v_tz)::date as d, p.method,
             sum(case when p.direction = 'in' then p.amount else -p.amount end) as amount
      from public.payments p
      where p.tenant_id = p_tenant and p.received_at >= v_from and p.received_at < v_to and p.branch_id = any (v_br)
      group by 1, 2
    ), days as (select d from inv union select d from pay)
    select coalesce(jsonb_agg(to_jsonb(r) order by r.date), '[]'::jsonb) into v_rows
    from (
      select days.d as date,
             (select count(*) from inv where inv.d = days.d and inv.kind = 'invoice') as invoices,
             (select coalesce(sum(inv.discount_total * inv.sg), 0) from inv where inv.d = days.d) as discounts,
             (select coalesce(sum(inv.total), 0) from inv where inv.d = days.d and inv.kind = 'credit_note') as credit_notes,
             (select coalesce(sum(inv.subtotal * inv.sg), 0) from inv where inv.d = days.d) as net_sales,
             (select coalesce(sum(inv.vat_total * inv.sg), 0) from inv where inv.d = days.d) as vat,
             (select coalesce(sum(inv.total * inv.sg), 0) from inv where inv.d = days.d) as total,
             (select coalesce(sum(pay.amount), 0) from pay where pay.d = days.d and pay.method = 'cash') as cash,
             (select coalesce(sum(pay.amount), 0) from pay where pay.d = days.d and pay.method = 'card') as card,
             (select coalesce(sum(pay.amount), 0) from pay where pay.d = days.d and pay.method = 'bank_transfer') as bank_transfer,
             (select coalesce(sum(pay.amount), 0) from pay where pay.d = days.d and pay.method = 'other') as other
      from days
    ) r;

  when 'vat' then
    select coalesce(jsonb_agg(to_jsonb(r) order by r.month, r.vat_category, r.vat_rate desc), '[]'::jsonb) into v_rows
    from (
      select to_char(i.issued_at at time zone v_tz, 'YYYY-MM') as month, it.vat_category, it.vat_rate,
             sum(case when i.kind = 'invoice' then it.net_amount else 0 end) as sales_net,
             sum(case when i.kind = 'invoice' then it.vat_amount else 0 end) as sales_vat,
             sum(case when i.kind = 'credit_note' then it.net_amount else 0 end) as credits_net,
             sum(case when i.kind = 'credit_note' then it.vat_amount else 0 end) as credits_vat,
             sum(case when i.kind = 'invoice' then it.net_amount else -it.net_amount end) as taxable,
             sum(case when i.kind = 'invoice' then it.vat_amount else -it.vat_amount end) as vat_due
      from public.invoices i
      join public.invoice_items it on it.invoice_id = i.id
      where i.tenant_id = p_tenant and i.status = 'posted' and i.issued_at >= v_from and i.issued_at < v_to and i.branch_id = any (v_br)
      group by 1, 2, 3
    ) r;

  when 'invoices' then
    select coalesce(jsonb_agg(to_jsonb(r) order by r.issued_at, r.number), '[]'::jsonb) into v_rows
    from (
      select i.number, i.issued_at, i.kind, coalesce(i.branch_name, b.name_en) as branch, i.customer_name,
             o.number as original_number, i.subtotal, i.vat_total as vat, i.total, i.paid_total,
             case when i.kind = 'invoice' then i.total - i.paid_total - i.credited_total + i.refunded_total end as balance,
             i.payment_status
      from public.invoices i
      join public.branches b on b.id = i.branch_id
      left join public.invoices o on o.id = i.original_invoice_id
      where i.tenant_id = p_tenant and i.status = 'posted' and i.issued_at >= v_from and i.issued_at < v_to and i.branch_id = any (v_br)
      order by i.issued_at, i.number
      limit v_limit + 1
    ) r;

  when 'payments' then
    select coalesce(jsonb_agg(to_jsonb(r) order by r.received_at), '[]'::jsonb) into v_rows
    from (
      select p.received_at, i.number as invoice_number, b.name_en as branch, p.method, p.direction,
             case when p.direction = 'in' then p.amount else -p.amount end as amount, p.reference
      from public.payments p
      join public.branches b on b.id = p.branch_id
      left join public.invoices i on i.id = p.invoice_id
      where p.tenant_id = p_tenant and p.received_at >= v_from and p.received_at < v_to and p.branch_id = any (v_br)
      order by p.received_at
      limit v_limit + 1
    ) r;

  -- ---- Operational ------------------------------------------------------------
  when 'services' then
    select coalesce(jsonb_agg(to_jsonb(r) order by r.revenue desc, r.name_en), '[]'::jsonb) into v_rows
    from (
      select coalesce(s.name_en, min(it.description_en)) as name_en, coalesce(s.name_ar, min(it.description_ar)) as name_ar,
             sum(case when i.kind = 'invoice' then it.quantity else -it.quantity end) as quantity,
             count(*) filter (where it.customer_package_id is not null and i.kind = 'invoice') as from_packages,
             sum(case when i.kind = 'invoice' then it.net_amount else -it.net_amount end) as revenue,
             round(sum(case when i.kind = 'invoice' then it.net_amount else -it.net_amount end)
                   / nullif(sum(case when i.kind = 'invoice' then it.quantity else -it.quantity end), 0), 3) as average
      from public.invoice_items it
      join public.invoices i on i.id = it.invoice_id
      left join public.services s on s.id = it.service_id
      where i.tenant_id = p_tenant and i.status = 'posted' and i.issued_at >= v_from and i.issued_at < v_to
        and i.branch_id = any (v_br) and it.kind = 'service'
      group by it.service_id, s.name_en, s.name_ar
    ) r;

  when 'staff' then
    select coalesce(jsonb_agg(to_jsonb(r) order by r.service_revenue desc, r.name_en), '[]'::jsonb) into v_rows
    from (
      select e.name_en, e.name_ar,
             coalesce(x.services, 0) as services, coalesce(x.service_revenue, 0) as service_revenue,
             coalesce(x.product_revenue, 0) as product_revenue,
             coalesce(a.completed, 0) as appointments, coalesce(a.no_shows, 0) as no_shows,
             f.rating, coalesce(f.ratings, 0) as ratings
      from public.employees e
      left join lateral (
        select sum(case when i.kind = 'invoice' then it.quantity else -it.quantity end) filter (where it.kind = 'service') as services,
               sum(case when i.kind = 'invoice' then it.net_amount else -it.net_amount end) filter (where it.kind = 'service') as service_revenue,
               sum(case when i.kind = 'invoice' then it.net_amount else -it.net_amount end) filter (where it.kind = 'product') as product_revenue
        from public.invoice_items it join public.invoices i on i.id = it.invoice_id
        where it.employee_id = e.id and i.status = 'posted' and i.issued_at >= v_from and i.issued_at < v_to and i.branch_id = any (v_br)
      ) x on true
      left join lateral (
        select count(distinct ap.id) filter (where ap.status = 'completed') as completed,
               count(distinct ap.id) filter (where ap.status = 'no_show') as no_shows
        from public.appointment_services s join public.appointments ap on ap.id = s.appointment_id
        where s.employee_id = e.id and ap.starts_at >= v_from and ap.starts_at < v_to and ap.branch_id = any (v_br)
      ) a on true
      left join lateral (
        select round(avg(cf.rating), 2) as rating, count(distinct cf.id) as ratings
        from public.customer_feedback cf join public.appointment_services s on s.appointment_id = cf.appointment_id
        where s.employee_id = e.id and cf.submitted_at >= v_from and cf.submitted_at < v_to and cf.branch_id = any (v_br)
      ) f on true
      where e.tenant_id = p_tenant
        and (e.is_active or x.services is not null or x.product_revenue is not null or a.completed > 0)
    ) r;

  when 'products' then
    select coalesce(jsonb_agg(to_jsonb(r) order by r.revenue desc, r.name_en), '[]'::jsonb) into v_rows
    from (
      select p.sku, p.name_en, p.name_ar,
             sum(case when i.kind = 'invoice' then it.quantity else -it.quantity end) as quantity,
             sum(case when i.kind = 'invoice' then it.net_amount else -it.net_amount end) as revenue,
             round(sum(case when i.kind = 'invoice' then it.quantity else -it.quantity end) * p.cost_price, 3) as cost,
             sum(case when i.kind = 'invoice' then it.net_amount else -it.net_amount end)
               - round(sum(case when i.kind = 'invoice' then it.quantity else -it.quantity end) * p.cost_price, 3) as margin
      from public.invoice_items it
      join public.invoices i on i.id = it.invoice_id
      join public.products p on p.id = it.product_id
      where i.tenant_id = p_tenant and i.status = 'posted' and i.issued_at >= v_from and i.issued_at < v_to
        and i.branch_id = any (v_br) and it.kind = 'product'
      group by p.id, p.sku, p.name_en, p.name_ar, p.cost_price
    ) r;

  when 'appointments' then
    select coalesce(jsonb_agg(to_jsonb(r) order by r.date), '[]'::jsonb) into v_rows
    from (
      select (a.starts_at at time zone v_tz)::date as date, count(*) as total,
             count(*) filter (where a.status = 'completed') as completed,
             count(*) filter (where a.status = 'cancelled') as cancelled,
             count(*) filter (where a.status = 'no_show') as no_show,
             count(*) filter (where a.source = 'online') as online,
             count(*) filter (where a.source = 'walk_in') as walk_in,
             count(distinct a.customer_id) as customers
      from public.appointments a
      where a.tenant_id = p_tenant and a.starts_at >= v_from and a.starts_at < v_to and a.branch_id = any (v_br)
      group by 1
    ) r;

  when 'customers' then
    select coalesce(jsonb_agg(to_jsonb(r) order by r.spend desc, r.visits desc), '[]'::jsonb) into v_rows
    from (
      select concat_ws(' ', c.first_name, c.last_name) as name, c.name_ar,
             case when v_mobile then c.mobile end as mobile,
             count(distinct i.id) filter (where i.kind = 'invoice') as visits,
             sum(case when i.kind = 'invoice' then i.total else -i.total end) as spend,
             round(sum(case when i.kind = 'invoice' then i.total else -i.total end)
                   / nullif(count(distinct i.id) filter (where i.kind = 'invoice'), 0), 3) as average,
             max(i.issued_at) as last_visit,
             c.created_at >= v_from as is_new
      from public.invoices i
      join public.customers c on c.id = i.customer_id
      where i.tenant_id = p_tenant and i.status = 'posted' and i.issued_at >= v_from and i.issued_at < v_to and i.branch_id = any (v_br)
      group by c.id
      order by 5 desc
      limit 500
    ) r;
  end case;

  return jsonb_build_object(
    'report', p_report, 'from', p_from, 'to', p_to, 'timezone', v_tz,
    'truncated', jsonb_array_length(v_rows) > v_limit,
    'rows', case when jsonb_array_length(v_rows) > v_limit then v_rows - v_limit else v_rows end);
end;
$$;

-- Exports are audited (who took which data out, for which period).
create or replace function public.log_report_export(p_tenant uuid, p_report text, p_from date, p_to date, p_branch uuid, p_rows integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app.report_branches(p_tenant, p_report, p_branch);
  perform app.audit(p_tenant, 'report.exported', 'reports', p_report, null, null,
                    jsonb_build_object('from', p_from, 'to', p_to, 'branch_id', p_branch, 'rows', p_rows), p_branch);
end;
$$;

revoke all on function app.report_branches(uuid, text, uuid) from public;
revoke all on function public.run_report(uuid, text, date, date, uuid), public.log_report_export(uuid, text, date, date, uuid, integer) from public, anon;
grant execute on function public.run_report(uuid, text, date, date, uuid), public.log_report_export(uuid, text, date, date, uuid, integer)
to authenticated, service_role;

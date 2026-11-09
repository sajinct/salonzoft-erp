// Phase 6 · reports: figures (credit notes subtracted, VAT by rate, payments by
// method), access by permission and branch, customer PII gating, export audit.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createTenantWithOwner, q, expectPgError, addMember } from './helpers/db.mjs';

let db, A, B, analyst, cashier, manager, accountant, receptionist, reena, merlyn, haircut, colour, shampoo, aisha, noor, branch2, s1;

const sale = async (uid, items, customer = null, branch = A.branchId) => {
  const id = (await q(db, uid, `select public.create_invoice_draft($1, $2, $3) r`, [A.tenantId, branch, customer]))[0].r.invoice_id;
  await q(db, uid, `select public.save_invoice_draft($1, $2, $3)`, [id, customer, JSON.stringify(items)]);
  return (await q(db, uid, `select public.finalize_invoice($1) r`, [id]))[0].r;
};
const pay = (uid, invoice, method, amount) => q(db, uid, `select public.record_payment($1, $2, $3)`, [invoice, method, amount]);
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Muscat' });
const report = async (uid, name, branch = null, from = today(), to = today()) =>
  (await q(db, uid, `select public.run_report($1, $2, $3, $4, $5) r`, [A.tenantId, name, from, to, branch]))[0].r;
const n = (v) => Number(v);

before(async () => {
  db = await createDb();
  A = await createTenantWithOwner(db, { email: 'rep-owner-a@example.com', slug: 'rep-salon-a' });
  B = await createTenantWithOwner(db, { email: 'rep-owner-b@example.com', slug: 'rep-salon-b' });
  await q(db, A.ownerId, `update public.tenant_settings set vat_registered = true, vat_number = 'OM1100088888' where tenant_id = $1`, [A.tenantId]);
  [{ id: branch2 }] = await q(db, A.ownerId, `insert into public.branches (tenant_id, code, name_en) values ($1, 'B2', 'Seeb') returning id`, [A.tenantId]);
  cashier = await addMember(db, { tenantId: A.tenantId, inviterId: A.ownerId, email: 'rep-cash@example.com', roleCodes: ['cashier'], allBranches: true });
  manager = await addMember(db, { tenantId: A.tenantId, inviterId: A.ownerId, email: 'rep-mgr@example.com', roleCodes: ['manager'], branchIds: [A.branchId] });
  accountant = await addMember(db, { tenantId: A.tenantId, inviterId: A.ownerId, email: 'rep-acc@example.com', roleCodes: ['accountant'], allBranches: true });
  const [role] = await q(db, A.ownerId, `insert into public.roles (tenant_id, code, name_en) values ($1, 'analyst', 'Analyst') returning id`, [A.tenantId]);
  for (const p of ['reports.view', 'customers.view']) {
    await q(db, A.ownerId, `insert into public.role_permissions (tenant_id, role_id, permission_code) values ($1, $2, $3)`, [A.tenantId, role.id, p]);
  }
  analyst = await addMember(db, { tenantId: A.tenantId, inviterId: A.ownerId, email: 'rep-ana@example.com', roleCodes: ['analyst'], branchIds: [A.branchId] });
  receptionist = await addMember(db, { tenantId: A.tenantId, inviterId: A.ownerId, email: 'rep-rec@example.com', roleCodes: ['receptionist'], allBranches: true });

  [{ id: haircut }] = await q(db, A.ownerId, `insert into public.services (tenant_id, name_en, name_ar, price) values ($1, 'Haircut', 'قص', 21) returning id`, [A.tenantId]);
  [{ id: colour }] = await q(db, A.ownerId, `insert into public.services (tenant_id, name_en, price) values ($1, 'Colour', 42) returning id`, [A.tenantId]);
  [{ id: reena }] = await q(db, A.ownerId, `insert into public.employees (tenant_id, name_en) values ($1, 'Reena') returning id`, [A.tenantId]);
  [{ id: merlyn }] = await q(db, A.ownerId, `insert into public.employees (tenant_id, name_en) values ($1, 'Merlyn') returning id`, [A.tenantId]);
  [{ id: shampoo }] = await q(db, A.ownerId, `insert into public.products (tenant_id, sku, name_en, kind, sale_price, cost_price) values ($1, 'SH-1', 'Shampoo', 'retail', 10.5, 4) returning id`, [A.tenantId]);
  await q(db, A.ownerId, `select public.adjust_stock($1, $2)`, [A.branchId, JSON.stringify([{ product_id: shampoo, delta: 10 }])]);
  [{ id: aisha }] = await q(db, A.ownerId, `insert into public.customers (tenant_id, first_name, mobile) values ($1, 'Aisha', '91234567') returning id`, [A.tenantId]);
  [{ id: noor }] = await q(db, A.ownerId, `insert into public.customers (tenant_id, first_name, mobile) values ($1, 'Noor', '92345678') returning id`, [A.tenantId]);

  // Main branch: 2 sales + 1 credit note. Seeb: 1 sale.
  s1 = await sale(cashier.userId, [{ service_id: haircut, employee_id: reena }, { service_id: colour, employee_id: merlyn }, { product_id: shampoo, quantity: 2, employee_id: reena }], aisha);
  await pay(cashier.userId, s1.id, 'card', 84); // 21 + 42 + 21
  const s2 = await sale(cashier.userId, [{ service_id: haircut, employee_id: reena }], noor);
  await pay(cashier.userId, s2.id, 'bank_transfer', 21);
  const line = s1.items.find((i) => i.service_id === colour);
  await q(db, A.ownerId, `select public.create_credit_note($1, $2, 'Redo', 'card')`, [s1.id, JSON.stringify([{ item_id: line.id, quantity: 1 }])]);
  await sale(cashier.userId, [{ service_id: haircut, employee_id: merlyn }], noor, branch2);
});

test('daily sales: credit notes subtracted, payments by method, branch filter', async () => {
  const r = await report(accountant.userId, 'sales_daily');
  assert.equal(r.truncated, false);
  assert.equal(r.rows.length, 1);
  const d = r.rows[0];
  assert.equal(d.date, today());
  assert.equal(d.invoices, 3);
  assert.deepEqual([n(d.total), n(d.credit_notes), n(d.net_sales), n(d.vat)], [84 + 21 + 21 - 42, 42, 80, 4]);
  assert.deepEqual([n(d.card), n(d.bank_transfer), n(d.cash)], [84 - 42, 21, 0]);

  const seeb = await report(accountant.userId, 'sales_daily', branch2);
  assert.equal(n(seeb.rows[0].total), 21);
});

test('VAT summary by rate and invoice register', async () => {
  const vat = await report(accountant.userId, 'vat');
  assert.equal(vat.rows.length, 1);
  const v = vat.rows[0];
  assert.equal(v.vat_category, 'standard');
  assert.deepEqual([n(v.sales_net), n(v.sales_vat), n(v.credits_net), n(v.credits_vat), n(v.taxable), n(v.vat_due)], [120, 6, 40, 2, 80, 4]);

  const reg = await report(accountant.userId, 'invoices');
  assert.equal(reg.rows.length, 4);
  const cn = reg.rows.find((x) => x.kind === 'credit_note');
  assert.equal(cn.original_number, s1.number);
  assert.equal(cn.balance, null);
  assert.deepEqual((await report(accountant.userId, 'payments')).rows.map((p) => n(p.amount)), [84, 21, -42]);
});

test('services, staff and products', async () => {
  const s = await report(manager.userId, 'services', A.branchId);
  const hc = s.rows.find((x) => x.name_en === 'Haircut');
  const co = s.rows.find((x) => x.name_en === 'Colour');
  assert.deepEqual([n(hc.quantity), n(hc.revenue), n(hc.average)], [2, 40, 20]);
  assert.deepEqual([n(co.quantity), n(co.revenue)], [0, 0], 'the credited colour cancels out');

  const staff = await report(accountant.userId, 'staff');
  const r = staff.rows.find((x) => x.name_en === 'Reena');
  assert.deepEqual([n(r.services), n(r.service_revenue), n(r.product_revenue)], [2, 40, 20]);
  const m = staff.rows.find((x) => x.name_en === 'Merlyn');
  assert.deepEqual([n(m.services), n(m.service_revenue)], [1, 20], 'colour credited, Seeb haircut counted');

  const p = await report(accountant.userId, 'products');
  assert.deepEqual([n(p.rows[0].quantity), n(p.rows[0].revenue), n(p.rows[0].cost), n(p.rows[0].margin)], [2, 20, 8, 12]);
});

test('top customers: needs customers.view; mobile only with customers.export', async () => {
  const c = await report(A.ownerId, 'customers');
  assert.deepEqual(c.rows.map((x) => [x.name, n(x.spend), x.visits, x.mobile]), [['Noor', 42, 2, '+96892345678'], ['Aisha', 42, 1, '+96891234567']].sort((a, b) => b[2] - a[2]));
  assert.equal(c.rows[0].is_new, true);
  const m = await report(analyst.userId, 'customers');
  assert.ok(m.rows.length > 0 && m.rows.every((x) => x.mobile === null), 'no customers.export, no mobiles');
  await expectPgError(report(receptionist.userId, 'customers'), 'FORBIDDEN');
});

test('access: financial reports need reports.financial; branches are enforced; tenants isolated', async () => {
  await expectPgError(report(analyst.userId, 'sales_daily'), 'FORBIDDEN');   // reports.view only
  await expectPgError(report(cashier.userId, 'services'), 'FORBIDDEN');      // cashiers have no reports permission
  await expectPgError(report(receptionist.userId, 'staff'), 'FORBIDDEN');
  await expectPgError(report(analyst.userId, 'services', branch2), 'FORBIDDEN');
  await expectPgError(report(manager.userId, 'services', branch2), 'FORBIDDEN');
  const mine = await report(analyst.userId, 'staff');
  assert.equal(n(mine.rows.find((x) => x.name_en === 'Merlyn').service_revenue), 0, 'only the main branch');
  await expectPgError(q(db, B.ownerId, `select public.run_report($1, 'sales_daily', $2, $2, null)`, [A.tenantId, today()]), 'FORBIDDEN');
  await expectPgError(report(accountant.userId, 'nope'), 'INVALID_VALUE');
  await expectPgError(report(accountant.userId, 'vat', null, '2025-01-01', '2026-11-09'), 'INVALID_RANGE');

  await db.query(`update public.module_entitlements set is_enabled = false where tenant_id = $1 and module_code = 'reports'`, [A.tenantId]);
  await expectPgError(report(A.ownerId, 'sales_daily'), 'FORBIDDEN');
  await db.query(`update public.module_entitlements set is_enabled = true where tenant_id = $1 and module_code = 'reports'`, [A.tenantId]);
});

test('exports are audited', async () => {
  await q(db, accountant.userId, `select public.log_report_export($1, 'invoices', $2, $2, null, 4)`, [A.tenantId, today()]);
  const [log] = await q(db, A.ownerId, `select action, entity_id, metadata from public.audit_logs where action = 'report.exported'`);
  assert.equal(log.entity_id, 'invoices');
  assert.equal(log.metadata.rows, 4);
  await expectPgError(q(db, analyst.userId, `select public.log_report_export($1, 'invoices', $2, $2, null, 4)`, [A.tenantId, today()]), 'FORBIDDEN');
});

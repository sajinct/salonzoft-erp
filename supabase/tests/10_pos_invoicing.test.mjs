// Phase 3 · POS: VAT arithmetic, server-side pricing & discount permission,
// gap-free numbering, immutability of posted invoices, split payments, cash
// sessions, credit notes / refunds, appointment checkout and isolation.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createTenantWithOwner, q, expectPgError, addMember } from './helpers/db.mjs';

let db, A, B, cashier, manager, stylist, haircut, colour, consult, year;

const draft = async (uid, extra = {}) =>
  (await q(db, uid, `select public.create_invoice_draft($1, $2, $3, $4, $5) r`,
    [extra.tenant ?? A.tenantId, extra.branch ?? A.branchId, extra.customer ?? null, extra.appointment ?? null, extra.key ?? null]))[0].r.invoice_id;
const save = async (uid, id, items, customer = null) =>
  (await q(db, uid, `select public.save_invoice_draft($1, $2, $3) r`, [id, customer, JSON.stringify(items)]))[0].r;
const finalize = async (uid, id) => (await q(db, uid, `select public.finalize_invoice($1) r`, [id]))[0].r;
const pay = async (uid, id, method, amount, key = null) =>
  (await q(db, uid, `select public.record_payment($1, $2, $3, null, $4) r`, [id, method, amount, key]))[0].r;
const sale = async (uid, items) => {
  const id = await draft(uid);
  await save(uid, id, items);
  return finalize(uid, id);
};

before(async () => {
  db = await createDb();
  A = await createTenantWithOwner(db, { email: 'pos-owner-a@example.com', slug: 'pos-salon-a' });
  B = await createTenantWithOwner(db, { email: 'pos-owner-b@example.com', slug: 'pos-salon-b' });
  await q(db, A.ownerId, `update public.tenant_settings set vat_registered = true, vat_number = 'OM1100012345', default_vat_rate = 5, prices_include_vat = true where tenant_id = $1`, [A.tenantId]);
  cashier = await addMember(db, { tenantId: A.tenantId, inviterId: A.ownerId, email: 'pos-cash@example.com', roleCodes: ['cashier'], allBranches: true });
  manager = await addMember(db, { tenantId: A.tenantId, inviterId: A.ownerId, email: 'pos-mgr@example.com', roleCodes: ['manager'], allBranches: true });
  stylist = await addMember(db, { tenantId: A.tenantId, inviterId: A.ownerId, email: 'pos-sty@example.com', roleCodes: ['stylist'], allBranches: true });
  const svc = (name, price, type, vat = 'standard') =>
    q(db, A.ownerId, `insert into public.services (tenant_id, name_en, price, price_type, vat_category) values ($1, $2, $3, $4, $5) returning id`, [A.tenantId, name, price, type, vat]).then((r) => r[0].id);
  haircut = await svc('Haircut', 12, 'fixed');
  colour = await svc('Colour', 30, 'from');
  consult = await svc('Consultation', 0, 'variable', 'exempt');
  year = new Date().toLocaleString('en-US', { timeZone: 'Asia/Muscat', year: 'numeric' });
});

test('VAT is computed per line, inclusive prices, 3 decimals half-up', async () => {
  const id = await draft(cashier.userId);
  const inv = await save(cashier.userId, id, [{ service_id: haircut }, { service_id: consult, unit_price: 5 }, { service_id: haircut, quantity: 2 }]);
  const lines = inv.items.map((i) => [i.description_en, i.net_amount, i.vat_amount, i.total_amount]);
  assert.deepEqual(lines, [
    ['Haircut', 11.429, 0.571, 12],          // 12 × 5/105 = 0.5714 → 0.571
    ['Consultation', 5, 0, 5],               // exempt
    ['Haircut', 22.857, 1.143, 24],
  ]);
  assert.deepEqual([inv.subtotal, inv.vat_total, inv.total], [39.286, 1.714, 41]);
  await q(db, cashier.userId, `select public.void_invoice_draft($1)`, [id]);
});

test('exclusive prices add VAT on top; non-registered businesses charge none', async () => {
  await q(db, A.ownerId, `update public.tenant_settings set prices_include_vat = false where tenant_id = $1`, [A.tenantId]);
  const id = await draft(cashier.userId);
  await save(cashier.userId, id, [{ service_id: haircut }]);
  const inv = await finalize(cashier.userId, id);
  assert.deepEqual([inv.subtotal, inv.vat_total, inv.total, inv.prices_include_vat], [12, 0.6, 12.6, false]);
  assert.equal(inv.vat_number, 'OM1100012345');
  await q(db, A.ownerId, `update public.tenant_settings set prices_include_vat = true where tenant_id = $1`, [A.tenantId]);

  const [bSvc] = await q(db, B.ownerId, `insert into public.services (tenant_id, name_en, price) values ($1, 'Cut', 10) returning id`, [B.tenantId]);
  const bId = await draft(B.ownerId, { tenant: B.tenantId, branch: B.branchId });
  const bInv = await save(B.ownerId, bId, [{ service_id: bSvc.id }]);
  assert.deepEqual([bInv.vat_total, bInv.total], [0, 10]);
});

test('prices come from the server; overrides and discounts need pos.discount', async () => {
  const id = await draft(cashier.userId);
  await expectPgError(save(cashier.userId, id, [{ service_id: haircut, unit_price: 10 }]), 'PRICE_OVERRIDE_FORBIDDEN');
  await expectPgError(save(cashier.userId, id, [{ service_id: haircut, unit_price: 15 }]), 'PRICE_OVERRIDE_FORBIDDEN');
  await expectPgError(save(cashier.userId, id, [{ service_id: haircut, discount_amount: 2 }]), 'DISCOUNT_FORBIDDEN');
  await expectPgError(save(cashier.userId, id, [{ service_id: colour, unit_price: 25 }]), 'PRICE_OVERRIDE_FORBIDDEN');
  const up = await save(cashier.userId, id, [{ service_id: colour, unit_price: 45 }, { service_id: consult, unit_price: 3 }]);
  assert.deepEqual(up.items.map((i) => i.unit_price), [45, 3], '"from" prices may go up, variable prices are free');
  // The manager holds pos.discount.
  const disc = await save(manager.userId, id, [{ service_id: haircut, unit_price: 10, discount_amount: 1.5 }]);
  assert.deepEqual([disc.items[0].list_price, disc.items[0].total_amount, disc.discount_total], [12, 8.5, 1.5]);
  await expectPgError(save(manager.userId, id, [{ service_id: haircut, discount_amount: 13 }]), 'INVALID_DISCOUNT');
  await expectPgError(save(manager.userId, id, [{ service_id: haircut, quantity: 0 }]), 'INVALID_QUANTITY');
  await expectPgError(save(manager.userId, id, [{ service_id: haircut, unit_price: 1.2345 }]), 'INVALID_PRICE');
  await expectPgError(save(manager.userId, id, [{ kind: 'custom', unit_price: 5 }]), 'INVALID_ITEMS');
  const custom = await save(cashier.userId, id, [{ kind: 'custom', description: 'Hair clip', unit_price: 2.1 }]);
  assert.equal(custom.total, 2.1);
  await q(db, cashier.userId, `select public.void_invoice_draft($1)`, [id]);
});

test('gap-free numbering per branch and year; drafts and failures use no number', async () => {
  const before = (await q(db, A.ownerId, `select count(*)::int n from public.invoices where tenant_id = $1 and status = 'posted' and kind = 'invoice'`, [A.tenantId]))[0].n;
  const empty = await draft(cashier.userId);
  await expectPgError(finalize(cashier.userId, empty), 'EMPTY_INVOICE');
  await q(db, cashier.userId, `select public.void_invoice_draft($1)`, [empty]);
  const a = await sale(cashier.userId, [{ service_id: haircut }]);
  const b = await sale(cashier.userId, [{ service_id: haircut }]);
  assert.equal(a.number, `INV-MAIN-${year}-${String(before + 1).padStart(6, '0')}`);
  assert.equal(b.number, `INV-MAIN-${year}-${String(before + 2).padStart(6, '0')}`);
  // Finalising twice is idempotent and keeps the number.
  assert.equal((await finalize(cashier.userId, a.id)).number, a.number);
  const all = await q(db, A.ownerId, `select sequence_no from public.invoices where tenant_id = $1 and status = 'posted' and kind = 'invoice' order by sequence_no`, [A.tenantId]);
  assert.deepEqual(all.map((r) => r.sequence_no), all.map((_, i) => i + 1), 'no gaps');
});

test('posted invoices are immutable, even for the database owner', async () => {
  const inv = await sale(cashier.userId, [{ service_id: haircut }]);
  await expectPgError(save(cashier.userId, inv.id, [{ service_id: consult, unit_price: 1 }]), 'INVOICE_NOT_DRAFT');
  await expectPgError(q(db, cashier.userId, `select public.void_invoice_draft($1)`, [inv.id]), 'INVOICE_NOT_DRAFT');
  await expectPgError(q(db, A.ownerId, `update public.invoices set total = 0 where id = $1`, [inv.id]), /permission denied/);
  await expectPgError(db.query(`update public.invoices set total = 0 where id = $1`, [inv.id]), 'INVOICE_POSTED_IMMUTABLE');
  await expectPgError(db.query(`update public.invoice_items set unit_price = 0 where invoice_id = $1`, [inv.id]), 'INVOICE_POSTED_IMMUTABLE');
  await expectPgError(db.query(`delete from public.invoices where id = $1`, [inv.id]), 'INVOICE_POSTED_IMMUTABLE');
});

test('split payments, cash sessions and overpayment', async () => {
  const inv = await sale(cashier.userId, [{ service_id: haircut }, { service_id: haircut }]); // 24.000
  const p1 = await pay(cashier.userId, inv.id, 'card', 10, 'pay-1');
  assert.deepEqual([p1.balance_due, p1.payment_status], [14, 'partial']);
  assert.equal((await pay(cashier.userId, inv.id, 'card', 10, 'pay-1')).replayed, true, 'retry is idempotent');
  await expectPgError(pay(cashier.userId, inv.id, 'cash', 14), 'CASH_SESSION_REQUIRED');

  const [{ s }] = await q(db, cashier.userId, `select public.open_cash_session($1, 20) s`, [A.branchId]);
  await expectPgError(q(db, manager.userId, `select public.open_cash_session($1, 5)`, [A.branchId]), 'CASH_SESSION_ALREADY_OPEN');
  await expectPgError(pay(cashier.userId, inv.id, 'cash', 14.001), 'OVERPAYMENT');
  const p2 = await pay(cashier.userId, inv.id, 'cash', 14);
  assert.deepEqual([p2.balance_due, p2.payment_status], [0, 'paid']);
  await expectPgError(pay(cashier.userId, inv.id, 'card', 1), 'OVERPAYMENT');
  await expectPgError(q(db, A.ownerId, `delete from public.payments`), /permission denied/);
  await expectPgError(db.query(`update public.payments set amount = 1`), 'PAYMENT_IMMUTABLE');

  const [{ r }] = await q(db, cashier.userId, `select public.close_cash_session($1, 33.5, 'short by 0.5') r`, [s]);
  assert.deepEqual(r, { expected_cash: 34, counted_cash: 33.5, variance: -0.5, petty_cash: 0 });
  await expectPgError(q(db, cashier.userId, `select public.close_cash_session($1, 1)`, [s]), 'CASH_SESSION_CLOSED');
  await expectPgError(q(db, stylist.userId, `select public.open_cash_session($1, 0)`, [A.branchId]), 'FORBIDDEN');
});

test('credit notes: permission, limits, refunds and balances', async () => {
  const inv = await sale(cashier.userId, [{ service_id: haircut, quantity: 2 }, { service_id: consult, unit_price: 6 }]); // 24 + 6 = 30
  await pay(cashier.userId, inv.id, 'card', 30);
  const cn = (args) => q(db, manager.userId, `select public.create_credit_note($1, $2, $3, $4) r`, args).then((r) => r[0].r);
  const line = inv.items[0];

  await expectPgError(q(db, cashier.userId, `select public.create_credit_note($1, null, 'x', 'card')`, [inv.id]), 'FORBIDDEN');
  await expectPgError(cn([inv.id, null, '  ', 'card']), 'CREDIT_REASON_REQUIRED');
  await expectPgError(cn([inv.id, JSON.stringify([{ item_id: line.id, quantity: 3 }]), 'Too many', 'card']), 'CREDIT_EXCEEDS_INVOICE');
  await expectPgError(cn([inv.id, JSON.stringify([{ item_id: line.id, quantity: 1 }]), 'Unhappy', null]), 'REFUND_METHOD_REQUIRED');

  const first = await cn([inv.id, JSON.stringify([{ item_id: line.id, quantity: 1 }]), 'Unhappy with one cut', 'card']);
  assert.equal(first.number, `CN-MAIN-${year}-000001`);
  assert.deepEqual([first.total, first.refunded], [12, 12]);
  const after = (await q(db, manager.userId, `select public.get_invoice($1) r`, [inv.id]))[0].r;
  assert.deepEqual([after.credited_total, after.refunded_total, after.balance_due, after.payment_status], [12, 12, 0, 'paid']);
  assert.equal(after.credit_notes.length, 1);
  assert.ok(after.payments.some((p) => p.direction === 'out' && p.amount === 12));

  // Only one more cut and the consultation remain.
  await expectPgError(cn([inv.id, JSON.stringify([{ item_id: line.id, quantity: 2 }]), 'Again', 'card']), 'CREDIT_EXCEEDS_INVOICE');
  const rest = await cn([inv.id, null, 'Close the visit', 'bank_transfer']);
  assert.deepEqual([rest.total, rest.refunded], [18, 18]);
  await expectPgError(cn([inv.id, null, 'Nothing left', 'card']), 'EMPTY_INVOICE');

  // Crediting an unpaid invoice just lowers what is owed — no refund.
  const unpaid = await sale(cashier.userId, [{ service_id: haircut }]);
  const c3 = await cn([unpaid.id, null, 'Goodwill', null]);
  assert.equal(c3.refunded, 0);
  const u = (await q(db, manager.userId, `select public.get_invoice($1) r`, [unpaid.id]))[0].r;
  assert.deepEqual([u.balance_due, u.payment_status], [0, 'paid']);
});

test('checkout from an appointment uses booked prices and completes the visit', async () => {
  const [emp] = await q(db, A.ownerId, `insert into public.employees (tenant_id, name_en) values ($1, 'Reena') returning id`, [A.tenantId]);
  await q(db, A.ownerId, `select public.set_employee_assignments($1, $2, $3)`, [emp.id, [A.branchId], [haircut, colour]]);
  await q(db, A.ownerId, `select public.set_employee_shifts($1, $2)`,
    [emp.id, JSON.stringify([0, 1, 2, 3, 4, 5, 6].map((d) => ({ branch_id: A.branchId, day_of_week: d, starts_at: '00:00', ends_at: '24:00' })))]);
  const [cust] = await q(db, A.ownerId, `insert into public.customers (tenant_id, first_name, mobile) values ($1, 'Aisha', '91234567') returning id`, [A.tenantId]);
  const start = new Date(Date.now() + 2 * 86_400_000);
  if (start.getUTCDay() === 5) start.setUTCDate(start.getUTCDate() + 1); // Fridays open at 14:00
  start.setUTCHours(6, 0, 0, 0); // 10:00 Muscat
  const book = async (when) => (await q(db, A.ownerId, `select public.create_appointment($1, $2, $3, $4, $5) r`,
    [A.tenantId, A.branchId, cust.id, when.toISOString(), JSON.stringify([{ service_id: haircut, employee_id: emp.id }, { service_id: colour, employee_id: emp.id }])]))[0].r.appointment_id;
  const apptId = await book(start);
  // The catalogue price changes after booking: the booked price still applies.
  await q(db, A.ownerId, `update public.services set price = 14 where id = $1`, [haircut]);

  const id = await draft(cashier.userId, { appointment: apptId });
  assert.equal(await draft(cashier.userId, { appointment: apptId }), id, 'one live invoice per appointment');
  const inv = (await q(db, cashier.userId, `select public.get_invoice($1) r`, [id]))[0].r;
  assert.deepEqual(inv.items.map((i) => [i.description_en, i.unit_price, i.employee_id === emp.id]), [['Haircut', 12, true], ['Colour', 30, true]]);
  assert.equal(inv.customer_id, cust.id);
  // Re-saving the booked line keeps the booked price for a cashier.
  await save(cashier.userId, id, inv.items.map((i) => ({ service_id: i.service_id, employee_id: i.employee_id, appointment_service_id: i.appointment_service_id })), cust.id);
  const posted = await finalize(cashier.userId, id);
  assert.equal(posted.total, 42);
  assert.equal(posted.customer_name, 'Aisha');
  const [appt] = await q(db, A.ownerId, `select status from public.appointments where id = $1`, [apptId]);
  assert.equal(appt.status, 'completed');

  const later = new Date(start.getTime() + 3 * 3_600_000);
  const cancelled = await book(later);
  await q(db, A.ownerId, `select public.set_appointment_status($1, 'cancelled')`, [cancelled]);
  await expectPgError(draft(cashier.userId, { appointment: cancelled }), 'APPOINTMENT_NOT_BILLABLE');
  await q(db, A.ownerId, `update public.services set price = 12 where id = $1`, [haircut]);
});

test('who can see sales; tenants are isolated', async () => {
  assert.equal((await q(db, stylist.userId, `select id from public.invoices`)).length, 0, 'stylists have no POS access');
  await expectPgError(draft(stylist.userId), 'FORBIDDEN');
  assert.ok((await q(db, cashier.userId, `select id from public.invoices`)).length > 0);
  const [mine] = await q(db, A.ownerId, `select id from public.invoices where tenant_id = $1 and status = 'posted' limit 1`, [A.tenantId]);
  for (const table of ['invoices', 'invoice_items', 'payments', 'cash_sessions']) {
    const rows = await q(db, B.ownerId, `select tenant_id from public.${table}`);
    for (const r of rows) assert.equal(r.tenant_id, B.tenantId, `${table} leaked`);
  }
  await expectPgError(q(db, B.ownerId, `select public.get_invoice($1)`, [mine.id]), 'NOT_FOUND');
  await expectPgError(q(db, B.ownerId, `select public.finalize_invoice($1)`, [mine.id]), 'NOT_FOUND');
  await expectPgError(q(db, B.ownerId, `select public.record_payment($1, 'card', 1)`, [mine.id]), 'NOT_FOUND');
  await expectPgError(q(db, B.ownerId, `select public.create_credit_note($1, null, 'x', 'card')`, [mine.id]), 'NOT_FOUND');
  await expectPgError(draft(B.ownerId, { tenant: A.tenantId }), 'FORBIDDEN');
  await expectPgError(q(db, A.ownerId, `select * from public.invoice_sequences`), /permission denied/);
  await expectPgError(q(db, A.ownerId, `insert into public.invoices (tenant_id, branch_id) values ($1, $2)`, [A.tenantId, A.branchId]), /permission denied/);
});

test('sales summary nets credit notes and splits by method', async () => {
  const [{ s }] = await q(db, A.ownerId, `select public.get_sales_summary($1) s`, [A.tenantId]);
  assert.ok(s.invoices > 0);
  assert.equal(typeof s.gross_sales, 'number');
  assert.ok('card' in s.by_method && 'cash' in s.by_method);
  await expectPgError(q(db, stylist.userId, `select public.get_sales_summary($1)`, [A.tenantId]), 'FORBIDDEN');
});

// Phase 3 · packages, memberships, gift vouchers, store credit and deposits.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createTenantWithOwner, q, expectPgError, addMember } from './helpers/db.mjs';

let db, A, B, cashier, manager, stylist, haircut, blowdry, pkg, gold, aisha, noor;

const draft = async (uid, customer = null) =>
  (await q(db, uid, `select public.create_invoice_draft($1, $2, $3) r`, [A.tenantId, A.branchId, customer]))[0].r.invoice_id;
const save = async (uid, id, items, customer = null) =>
  (await q(db, uid, `select public.save_invoice_draft($1, $2, $3) r`, [id, customer, JSON.stringify(items)]))[0].r;
const finalize = async (uid, id) => (await q(db, uid, `select public.finalize_invoice($1) r`, [id]))[0].r;
const sale = async (uid, items, customer = null) => {
  const id = await draft(uid, customer);
  await save(uid, id, items, customer);
  return finalize(uid, id);
};
const pay = async (uid, id, method, amount, ref = null) =>
  (await q(db, uid, `select public.record_payment($1, $2, $3, $4) r`, [id, method, amount, ref]))[0].r;
const wallet = async (uid, customer) => (await q(db, uid, `select public.get_customer_wallet($1) r`, [customer]))[0].r;
const credit = async (uid, id, items, reason, method) =>
  (await q(db, uid, `select public.create_credit_note($1, $2, $3, $4) r`, [id, items ? JSON.stringify(items) : null, reason, method]))[0].r;

before(async () => {
  db = await createDb();
  A = await createTenantWithOwner(db, { email: 'pkg-owner-a@example.com', slug: 'pkg-salon-a' });
  B = await createTenantWithOwner(db, { email: 'pkg-owner-b@example.com', slug: 'pkg-salon-b' });
  await q(db, A.ownerId, `update public.tenant_settings set vat_registered = true, vat_number = 'OM1100099999' where tenant_id = $1`, [A.tenantId]);
  cashier = await addMember(db, { tenantId: A.tenantId, inviterId: A.ownerId, email: 'pkg-cash@example.com', roleCodes: ['cashier'], allBranches: true });
  manager = await addMember(db, { tenantId: A.tenantId, inviterId: A.ownerId, email: 'pkg-mgr@example.com', roleCodes: ['manager'], allBranches: true });
  stylist = await addMember(db, { tenantId: A.tenantId, inviterId: A.ownerId, email: 'pkg-sty@example.com', roleCodes: ['stylist'], allBranches: true });
  const svc = (name, price) => q(db, A.ownerId, `insert into public.services (tenant_id, name_en, price) values ($1, $2, $3) returning id`, [A.tenantId, name, price]).then((r) => r[0].id);
  haircut = await svc('Haircut', 12);
  blowdry = await svc('Blow-dry', 8);
  [aisha] = await q(db, A.ownerId, `insert into public.customers (tenant_id, first_name, mobile) values ($1, 'Aisha', '91234567') returning id`, [A.tenantId]);
  [noor] = await q(db, A.ownerId, `insert into public.customers (tenant_id, first_name, mobile) values ($1, 'Noor', '95551111') returning id`, [A.tenantId]);
  aisha = aisha.id;
  noor = noor.id;
});

test('catalogue: packages and memberships are managed with packages.manage', async () => {
  [{ id: pkg }] = await q(db, manager.userId, `insert into public.packages (tenant_id, name_en, price, validity_days) values ($1, '5 Blow-dries', 30, 90) returning id`, [A.tenantId]);
  await q(db, manager.userId, `select public.set_package_items($1, $2)`, [pkg, JSON.stringify([{ service_id: blowdry, sessions: 5 }])]);
  [{ id: gold }] = await q(db, manager.userId, `insert into public.memberships (tenant_id, name_en, price, duration_days, service_discount_percent) values ($1, 'Gold', 50, 30, 10) returning id`, [A.tenantId]);
  await expectPgError(q(db, cashier.userId, `insert into public.packages (tenant_id, name_en, price) values ($1, 'Hack', 1)`, [A.tenantId]), /row-level security/);
  await expectPgError(q(db, cashier.userId, `select public.set_package_items($1, '[]')`, [pkg]), 'FORBIDDEN');
  await expectPgError(q(db, manager.userId, `select public.set_package_items($1, $2)`, [pkg, JSON.stringify([{ service_id: blowdry, sessions: 0 }])]), 'INVALID_ITEMS');
  assert.equal((await q(db, cashier.userId, `select id from public.packages`)).length, 1, 'sellers can read the catalogue');
  assert.equal((await q(db, stylist.userId, `select id from public.packages`)).length, 0);
});

test('selling a package needs a customer and creates session balances', async () => {
  const noCustomer = await draft(cashier.userId);
  await save(cashier.userId, noCustomer, [{ package_id: pkg }]);
  await expectPgError(finalize(cashier.userId, noCustomer), 'CUSTOMER_REQUIRED');
  await q(db, cashier.userId, `select public.void_invoice_draft($1)`, [noCustomer]);

  const inv = await sale(cashier.userId, [{ package_id: pkg }], aisha);
  assert.equal(inv.total, 30);
  const w = await wallet(cashier.userId, aisha);
  assert.equal(w.packages.length, 1);
  assert.deepEqual(w.packages[0].balances.map((b) => [b.service_name_en, b.remaining, b.total]), [['Blow-dry', 5, 5]]);
  assert.ok(new Date(w.packages[0].expires_at) > new Date(Date.now() + 89 * 86_400_000));
});

test('redeeming package sessions: price 0, guarded balance, own packages only', async () => {
  const cp = (await wallet(cashier.userId, aisha)).packages[0].id;
  const id = await draft(cashier.userId, aisha);
  const d = await save(cashier.userId, id, [{ service_id: blowdry, customer_package_id: cp, quantity: 2 }], aisha);
  assert.deepEqual([d.items[0].unit_price, d.items[0].list_price, d.total], [0, 8, 0]);
  await finalize(cashier.userId, id);
  assert.equal((await wallet(cashier.userId, aisha)).packages[0].balances[0].remaining, 3);

  const over = await draft(cashier.userId, aisha);
  await expectPgError(save(cashier.userId, over, [{ service_id: blowdry, customer_package_id: cp, quantity: 4 }], aisha), 'INSUFFICIENT_BALANCE');
  // Two lines of the same cart are counted together.
  await expectPgError(save(cashier.userId, over, [{ service_id: blowdry, customer_package_id: cp, quantity: 2 }, { service_id: blowdry, customer_package_id: cp, quantity: 2 }], aisha), 'INSUFFICIENT_BALANCE');
  // Someone else's package can't be used.
  await expectPgError(save(cashier.userId, over, [{ service_id: blowdry, customer_package_id: cp }], noor), 'INSUFFICIENT_BALANCE');
  // A package only covers its own services.
  await expectPgError(save(cashier.userId, over, [{ service_id: haircut, customer_package_id: cp }], aisha), 'INSUFFICIENT_BALANCE');
  await q(db, cashier.userId, `select public.void_invoice_draft($1)`, [over]);
});

test('two tills redeeming the last sessions: the second finalise fails and uses no number', async () => {
  const cp = (await wallet(cashier.userId, aisha)).packages[0].id; // 3 left
  const t1 = await draft(cashier.userId, aisha);
  const t2 = await draft(manager.userId, aisha);
  await save(cashier.userId, t1, [{ service_id: blowdry, customer_package_id: cp, quantity: 2 }], aisha);
  await save(manager.userId, t2, [{ service_id: blowdry, customer_package_id: cp, quantity: 2 }], aisha); // valid when saved
  const first = await finalize(cashier.userId, t1);
  await expectPgError(finalize(manager.userId, t2), 'INSUFFICIENT_BALANCE');
  assert.equal((await wallet(cashier.userId, aisha)).packages[0].balances[0].remaining, 1);
  const [still] = await q(db, A.ownerId, `select status, number from public.invoices where id = $1`, [t2]);
  assert.deepEqual(still, { status: 'draft', number: null });
  const next = await sale(cashier.userId, [{ service_id: haircut }]);
  assert.equal(next.sequence_no, first.sequence_no + 1, 'no gap after the failed finalise');
  await q(db, manager.userId, `select public.void_invoice_draft($1)`, [t2]);
});

test('credit notes give sessions back and refuse to return used packages', async () => {
  const cp = (await wallet(cashier.userId, aisha)).packages[0].id;
  const [redeemInv] = await q(db, A.ownerId,
    `select i.id from public.invoices i join public.invoice_items it on it.invoice_id = i.id where it.customer_package_id = $1 and i.kind = 'invoice' and i.status = 'posted' order by i.issued_at limit 1`, [cp]);
  await credit(manager.userId, redeemInv.id, null, 'Service not performed', null);
  assert.equal((await wallet(cashier.userId, aisha)).packages[0].balances[0].remaining, 3);

  const [pkgInv] = await q(db, A.ownerId, `select i.id from public.invoices i join public.invoice_items it on it.invoice_id = i.id where it.kind = 'package' and i.kind = 'invoice' and i.status = 'posted' order by i.issued_at limit 1`);
  await pay(cashier.userId, pkgInv.id, 'card', 30);
  await expectPgError(credit(manager.userId, pkgInv.id, null, 'Return', 'card'), 'PACKAGE_IN_USE');

  // An unused package can be returned (and is then cancelled).
  const fresh = await sale(cashier.userId, [{ package_id: pkg }], noor);
  await credit(manager.userId, fresh.id, null, 'Changed mind', null);
  assert.equal((await wallet(cashier.userId, noor)).packages.length, 0);
});

test('members get their discount automatically, without discount permission', async () => {
  const before = await draft(cashier.userId, noor);
  assert.equal((await save(cashier.userId, before, [{ service_id: haircut }], noor)).discount_total, 0);
  await q(db, cashier.userId, `select public.void_invoice_draft($1)`, [before]);

  await sale(cashier.userId, [{ membership_id: gold }], noor);
  const w = await wallet(cashier.userId, noor);
  assert.deepEqual([w.membership.name_en, w.membership.discount_percent], ['Gold', 10]);
  const id = await draft(cashier.userId, noor);
  const d = await save(cashier.userId, id, [{ service_id: haircut }, { service_id: blowdry, quantity: 2 }], noor);
  assert.deepEqual(d.items.map((i) => [i.discount_amount, i.member_discount_percent]), [[1.2, 10], [1.6, 10]]);
  assert.equal(d.total, 28 - 2.8);
  // A manual discount still needs pos.discount.
  await expectPgError(save(cashier.userId, id, [{ service_id: haircut, discount_amount: 3 }], noor), 'DISCOUNT_FORBIDDEN');
  await q(db, cashier.userId, `select public.void_invoice_draft($1)`, [id]);
});

let voucherCode;
test('gift vouchers: sold without VAT, then spent as a payment with a guarded balance', async () => {
  const inv = await sale(cashier.userId, [{ kind: 'voucher', unit_price: 20, description: 'Gift for Mum' }], aisha);
  assert.deepEqual([inv.total, inv.vat_total], [20, 0], 'multi-purpose vouchers carry VAT when spent');
  const [g] = await q(db, cashier.userId, `select code, kind, balance::float8 as balance from public.gift_vouchers where invoice_id = $1`, [inv.id]);
  assert.match(g.code, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.deepEqual([g.kind, g.balance], ['gift', 20]);
  voucherCode = g.code;
  await expectPgError(pay(cashier.userId, inv.id, 'voucher', 20, voucherCode), 'INVALID_VOUCHER'); // can't pay for itself

  const bill = await sale(cashier.userId, [{ service_id: haircut }]);
  const r = await pay(cashier.userId, bill.id, 'voucher', 12, voucherCode.toLowerCase().replaceAll('-', ' '));
  assert.deepEqual([r.voucher_balance, r.payment_status], [8, 'paid']);
  const bill2 = await sale(cashier.userId, [{ service_id: haircut }]);
  await expectPgError(pay(cashier.userId, bill2.id, 'voucher', 9, voucherCode), 'INSUFFICIENT_BALANCE');
  await expectPgError(pay(cashier.userId, bill2.id, 'voucher', 1, 'AAAA-BBBB-CCCC'), 'INVALID_VOUCHER');
  const [{ r: look }] = await q(db, cashier.userId, `select public.lookup_voucher($1, $2) r`, [A.tenantId, voucherCode]);
  assert.deepEqual([look.balance, look.status], [8, 'active']);
  // A partly used voucher can't be credited.
  await pay(cashier.userId, inv.id, 'card', 20);
  await expectPgError(credit(manager.userId, inv.id, null, 'Return', 'card'), 'VOUCHER_IN_USE');
});

test('refunds can be paid as store credit', async () => {
  const bill = await sale(cashier.userId, [{ service_id: haircut }], aisha);
  await pay(cashier.userId, bill.id, 'card', 12);
  const cn = await credit(manager.userId, bill.id, null, 'Unhappy', 'voucher');
  assert.equal(cn.refunded, 12);
  assert.match(cn.store_credit_code, /^[A-Z0-9]{4}-/);
  const [g] = await q(db, cashier.userId, `select kind, balance::float8 as balance, customer_id from public.gift_vouchers where code = $1`, [cn.store_credit_code]);
  assert.deepEqual([g.kind, g.balance, g.customer_id], ['store_credit', 12, aisha]);
  assert.ok((await wallet(cashier.userId, aisha)).vouchers.some((v) => v.code === cn.store_credit_code));
});

test('booking deposits are vouchers linked to the appointment', async () => {
  const [emp] = await q(db, A.ownerId, `insert into public.employees (tenant_id, name_en) values ($1, 'Reena') returning id`, [A.tenantId]);
  await q(db, A.ownerId, `select public.set_employee_assignments($1, $2, $3)`, [emp.id, [A.branchId], [haircut]]);
  await q(db, A.ownerId, `select public.set_employee_shifts($1, $2)`,
    [emp.id, JSON.stringify([0, 1, 2, 3, 4, 5, 6].map((d) => ({ branch_id: A.branchId, day_of_week: d, starts_at: '00:00', ends_at: '24:00' })))]);
  const start = new Date(Date.now() + 3 * 86_400_000);
  if (start.getUTCDay() === 5) start.setUTCDate(start.getUTCDate() + 1);
  start.setUTCHours(7, 0, 0, 0);
  const [{ r: appt }] = await q(db, A.ownerId, `select public.create_appointment($1, $2, $3, $4, $5) r`,
    [A.tenantId, A.branchId, noor, start.toISOString(), JSON.stringify([{ service_id: haircut, employee_id: emp.id }])]);

  const dep = await sale(cashier.userId, [{ kind: 'voucher', unit_price: 5, appointment_id: appt.appointment_id }], noor);
  assert.equal(dep.items[0].description_en, 'Booking deposit');
  const [g] = await q(db, cashier.userId, `select kind, appointment_id from public.gift_vouchers where invoice_id = $1`, [dep.id]);
  assert.deepEqual([g.kind, g.appointment_id], ['deposit', appt.appointment_id]);
  const w = await wallet(cashier.userId, noor);
  assert.ok(w.vouchers.some((v) => v.kind === 'deposit' && v.appointment_id === appt.appointment_id && v.balance === 5));
  // Deposits only for upcoming appointments.
  await q(db, A.ownerId, `select public.set_appointment_status($1, 'cancelled')`, [appt.appointment_id]);
  const id = await draft(cashier.userId, noor);
  await expectPgError(save(cashier.userId, id, [{ kind: 'voucher', unit_price: 5, appointment_id: appt.appointment_id }], noor), 'INVALID_APPOINTMENT');
  // The unused deposit is refundable through a credit note.
  await pay(cashier.userId, dep.id, 'card', 5);
  const cn = await credit(manager.userId, dep.id, null, 'Booking cancelled', 'card');
  assert.equal(cn.refunded, 5);
});

test('isolation: holdings, codes and wallets stay inside the tenant', async () => {
  for (const table of ['packages', 'memberships', 'customer_packages', 'customer_package_balances', 'package_redemptions',
    'customer_memberships', 'gift_vouchers', 'voucher_transactions']) {
    const rows = await q(db, B.ownerId, `select tenant_id from public.${table}`);
    for (const r of rows) assert.equal(r.tenant_id, B.tenantId, `${table} leaked`);
  }
  await expectPgError(q(db, B.ownerId, `select public.get_customer_wallet($1)`, [aisha]), 'NOT_FOUND');
  await expectPgError(q(db, B.ownerId, `select public.lookup_voucher($1, $2)`, [A.tenantId, voucherCode]), 'FORBIDDEN');
  const [bSvc] = await q(db, B.ownerId, `insert into public.services (tenant_id, name_en, price) values ($1, 'Cut', 10) returning id`, [B.tenantId]);
  const bId = (await q(db, B.ownerId, `select public.create_invoice_draft($1, $2) r`, [B.tenantId, B.branchId]))[0].r.invoice_id;
  await q(db, B.ownerId, `select public.save_invoice_draft($1, null, $2)`, [bId, JSON.stringify([{ service_id: bSvc.id }])]);
  await q(db, B.ownerId, `select public.finalize_invoice($1)`, [bId]);
  await expectPgError(q(db, B.ownerId, `select public.record_payment($1, 'voucher', 1, $2)`, [bId, voucherCode]), 'INVALID_VOUCHER');
  await expectPgError(q(db, A.ownerId, `update public.gift_vouchers set balance = 1000`), /permission denied/);
  await expectPgError(q(db, A.ownerId, `update public.customer_package_balances set remaining_sessions = 99`), /permission denied/);
});

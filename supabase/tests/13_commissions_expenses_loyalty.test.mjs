// Phase 4 · commissions (rule specificity, claw-backs, payouts), expenses &
// petty cash (approval, drawer), profit summary, loyalty points.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createTenantWithOwner, q, expectPgError, addMember } from './helpers/db.mjs';

let db, A, B, cashier, manager, accountant, bookkeeper, stylist, reena, merlyn, haircut, colour, hair, aisha, foodCat;

const draft = async (uid, customer = null) =>
  (await q(db, uid, `select public.create_invoice_draft($1, $2, $3) r`, [A.tenantId, A.branchId, customer]))[0].r.invoice_id;
const sale = async (uid, items, customer = null) => {
  const id = await draft(uid, customer);
  await q(db, uid, `select public.save_invoice_draft($1, $2, $3)`, [id, customer, JSON.stringify(items)]);
  return (await q(db, uid, `select public.finalize_invoice($1) r`, [id]))[0].r;
};
const entries = async (invoiceId) =>
  (await q(db, A.ownerId, `select employee_id, amount::float8 a from public.commission_entries where invoice_id = $1 order by amount desc`, [invoiceId]));
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Muscat' });
const points = async (customer) =>
  ((await q(db, A.ownerId, `select balance from public.loyalty_accounts where customer_id = $1`, [customer]))[0]?.balance ?? 0);

before(async () => {
  db = await createDb();
  A = await createTenantWithOwner(db, { email: 'fin-owner-a@example.com', slug: 'fin-salon-a' });
  B = await createTenantWithOwner(db, { email: 'fin-owner-b@example.com', slug: 'fin-salon-b' });
  await q(db, A.ownerId, `update public.tenant_settings set vat_registered = true, vat_number = 'OM1100077777' where tenant_id = $1`, [A.tenantId]);
  cashier = await addMember(db, { tenantId: A.tenantId, inviterId: A.ownerId, email: 'fin-cash@example.com', roleCodes: ['cashier'], allBranches: true });
  manager = await addMember(db, { tenantId: A.tenantId, inviterId: A.ownerId, email: 'fin-mgr@example.com', roleCodes: ['manager'], allBranches: true });
  accountant = await addMember(db, { tenantId: A.tenantId, inviterId: A.ownerId, email: 'fin-acc@example.com', roleCodes: ['accountant'], allBranches: true });
  // A custom role that can record expenses but not approve them.
  const [role] = await q(db, A.ownerId, `insert into public.roles (tenant_id, code, name_en) values ($1, 'bookkeeper', 'Bookkeeper') returning id`, [A.tenantId]);
  for (const p of ['finance.view', 'finance.manage']) {
    await q(db, A.ownerId, `insert into public.role_permissions (tenant_id, role_id, permission_code) values ($1, $2, $3)`, [A.tenantId, role.id, p]);
  }
  bookkeeper = await addMember(db, { tenantId: A.tenantId, inviterId: A.ownerId, email: 'fin-book@example.com', roleCodes: ['bookkeeper'], allBranches: true });
  stylist = await addMember(db, { tenantId: A.tenantId, inviterId: A.ownerId, email: 'fin-sty@example.com', roleCodes: ['stylist'], allBranches: true });

  [{ id: hair }] = await q(db, A.ownerId, `insert into public.service_categories (tenant_id, name_en) values ($1, 'Hair') returning id`, [A.tenantId]);
  // 21.000 incl. 5% VAT = 20.000 net
  [{ id: haircut }] = await q(db, A.ownerId, `insert into public.services (tenant_id, category_id, name_en, price) values ($1, $2, 'Haircut', 21) returning id`, [A.tenantId, hair]);
  [{ id: colour }] = await q(db, A.ownerId, `insert into public.services (tenant_id, category_id, name_en, price) values ($1, $2, 'Colour', 42) returning id`, [A.tenantId, hair]);
  [{ id: reena }] = await q(db, A.ownerId, `insert into public.employees (tenant_id, name_en, membership_id) values ($1, 'Reena', $2) returning id`, [A.tenantId, stylist.membershipId]);
  [{ id: merlyn }] = await q(db, A.ownerId, `insert into public.employees (tenant_id, name_en) values ($1, 'Merlyn') returning id`, [A.tenantId]);
  [{ id: aisha }] = await q(db, A.ownerId, `insert into public.customers (tenant_id, first_name, mobile) values ($1, 'Aisha', '91234567') returning id`, [A.tenantId]);
});

test('commission rules: managed with employees.manage, readable by finance', async () => {
  await q(db, manager.userId, `insert into public.commission_rules (tenant_id, item_kind, rate_percent) values ($1, 'service', 10)`, [A.tenantId]);
  await q(db, manager.userId, `insert into public.commission_rules (tenant_id, employee_id, service_id, rate_percent) values ($1, $2, $3, 20)`, [A.tenantId, reena, haircut]);
  await q(db, manager.userId, `insert into public.commission_rules (tenant_id, service_category_id, rate_percent, fixed_amount) values ($1, $2, 5, 1)`, [A.tenantId, hair]);
  await expectPgError(q(db, accountant.userId, `insert into public.commission_rules (tenant_id, rate_percent) values ($1, 5)`, [A.tenantId]), /row-level security/);
  await expectPgError(q(db, manager.userId, `insert into public.commission_rules (tenant_id) values ($1)`, [A.tenantId]), /check constraint/);
  assert.equal((await q(db, accountant.userId, `select id from public.commission_rules`)).length, 3);
  assert.equal((await q(db, cashier.userId, `select id from public.commission_rules`)).length, 0);
});

let firstSale;
test('commission on the net line amount; the most specific rule wins', async () => {
  firstSale = await sale(cashier.userId, [
    { service_id: haircut, employee_id: reena },   // employee + service: 20% of 20.000 = 4.000
    { service_id: haircut, employee_id: merlyn },  // category: 5% of 20.000 + 1.000 = 2.000
    { service_id: colour, employee_id: reena },    // category: 5% of 40.000 + 1.000 = 3.000
    { service_id: colour },                        // no employee: no commission
  ]);
  const e = await entries(firstSale.id);
  assert.deepEqual(e.map((x) => [x.employee_id === reena ? 'reena' : 'merlyn', x.a]), [['reena', 4], ['reena', 3], ['merlyn', 2]]);
});

test('credit notes claw commission back pro rata', async () => {
  const line = firstSale.items.find((i) => i.employee_id === reena && i.service_id === haircut);
  const [{ r: cn }] = await q(db, manager.userId, `select public.create_credit_note($1, $2, 'Redo', null) r`, [firstSale.id, JSON.stringify([{ item_id: line.id, quantity: 1 }])]);
  assert.deepEqual((await entries(cn.credit_note_id)).map((x) => x.a), [-4]);
});

test('commission report: everyone for managers, only yourself for stylists', async () => {
  const report = async (uid) => q(db, uid, `select employee_id, commission::float8 c, unpaid::float8 u from public.get_commission_report($1, $2, $2)`, [A.tenantId, today()]);
  const all = await report(manager.userId);
  assert.deepEqual(all.filter((r) => r.c !== 0).map((r) => [r.employee_id === reena ? 'reena' : 'merlyn', r.c]).sort(), [['merlyn', 2], ['reena', 3]]);
  const mine = await report(stylist.userId);
  assert.deepEqual(mine.map((r) => r.employee_id), [reena]);
  assert.equal((await q(db, stylist.userId, `select distinct employee_id from public.commission_entries`)).map((r) => r.employee_id).join(), reena);
  await expectPgError(report(cashier.userId), 'FORBIDDEN');
});

test('payouts settle pending commission up to a date; claw-backs carry over', async () => {
  await expectPgError(q(db, cashier.userId, `select public.pay_commissions($1, $2, $3, 'cash')`, [A.tenantId, reena, today()]), 'FORBIDDEN');
  const [{ r }] = await q(db, accountant.userId, `select public.pay_commissions($1, $2, $3, 'bank_transfer', 'TRX-1') r`, [A.tenantId, reena, today()]);
  assert.equal(r.total, 3);
  await expectPgError(q(db, accountant.userId, `select public.pay_commissions($1, $2, $3, 'cash')`, [A.tenantId, reena, today()]), 'NOTHING_TO_PAY');
  // A return after the payout creates a negative entry that reduces the next payout.
  const colourLine = firstSale.items.find((i) => i.employee_id === reena && i.service_id === colour);
  await q(db, manager.userId, `select public.create_credit_note($1, $2, 'Unhappy', null)`, [firstSale.id, JSON.stringify([{ item_id: colourLine.id, quantity: 1 }])]);
  await expectPgError(q(db, accountant.userId, `select public.pay_commissions($1, $2, $3, 'cash')`, [A.tenantId, reena, today()]), 'NOTHING_TO_PAY');
  const [{ u }] = await q(db, manager.userId, `select unpaid::float8 u from public.get_commission_report($1, $2, $2) where employee_id = $3`, [A.tenantId, today(), reena]);
  assert.equal(u, -3);
  await expectPgError(q(db, A.ownerId, `update public.commission_entries set amount = 100`), /permission denied/);
});

test('expenses: approvers are approved at once, others wait for review', async () => {
  [{ id: foodCat }] = await q(db, accountant.userId, `insert into public.expense_categories (tenant_id, name_en) values ($1, 'Supplies') returning id`, [A.tenantId]);
  await expectPgError(q(db, cashier.userId, `insert into public.expense_categories (tenant_id, name_en) values ($1, 'Hack')`, [A.tenantId]), /row-level security/);
  const rec = (uid, amount, vat = 0, extra = {}) =>
    q(db, uid, `select public.record_expense($1, $2, $3, $4, $5, $6, $7, $8) r`,
      [A.branchId, foodCat, extra.date ?? today(), amount, vat, extra.desc ?? 'Towels', extra.method ?? 'card', extra.drawer ?? false]).then((x) => x[0].r);
  assert.equal((await rec(accountant.userId, 10.5, 0.5)).status, 'approved');
  const pending = await rec(bookkeeper.userId, 30);
  assert.equal(pending.status, 'pending');
  await expectPgError(q(db, bookkeeper.userId, `select public.review_expense($1, true)`, [pending.expense_id]), 'FORBIDDEN');
  await expectPgError(q(db, manager.userId, `select public.review_expense($1, false)`, [pending.expense_id]), 'REASON_REQUIRED');
  await q(db, manager.userId, `select public.review_expense($1, false, 'Not a business cost')`, [pending.expense_id]);
  await expectPgError(q(db, manager.userId, `select public.review_expense($1, true)`, [pending.expense_id]), 'EXPENSE_NOT_PENDING');
  await expectPgError(rec(accountant.userId, 5, 6), 'INVALID_AMOUNT');
  await expectPgError(rec(accountant.userId, 5, 0, { date: '2099-01-01' }), 'INVALID_DATE');
  await expectPgError(rec(cashier.userId, 5), 'FORBIDDEN');
  await expectPgError(q(db, A.ownerId, `update public.expenses set amount = 1`), /permission denied/);
});

test('petty cash from the drawer lowers the expected cash at close', async () => {
  const [{ s }] = await q(db, cashier.userId, `select public.open_cash_session($1, 50) s`, [A.branchId]);
  await expectPgError(q(db, accountant.userId, `select public.record_expense($1, $2, $3, 5, 0, 'Taxi', 'card', true)`, [A.branchId, foodCat, today()]), 'INVALID_PAYMENT_METHOD');
  await q(db, accountant.userId, `select public.record_expense($1, $2, $3, 5, 0, 'Taxi for delivery', 'cash', true)`, [A.branchId, foodCat, today()]);
  const [{ r }] = await q(db, cashier.userId, `select public.close_cash_session($1, 45) r`, [s]);
  assert.deepEqual([r.expected_cash, r.petty_cash, r.variance], [45, 5, 0]);
  await expectPgError(q(db, accountant.userId, `select public.record_expense($1, $2, $3, 5, 0, 'Taxi', 'cash', true)`, [A.branchId, foodCat, today()]), 'CASH_SESSION_REQUIRED');
});

test('profit summary: revenue − cost of goods − products used − commission − expenses', async () => {
  const [{ s }] = await q(db, accountant.userId, `select public.get_finance_summary($1, $2, $2) s`, [A.tenantId, today()]);
  assert.equal(s.net_profit, Math.round((s.revenue - s.cost_of_goods - s.products_used - s.commissions - s.expenses) * 1000) / 1000);
  assert.equal(s.expenses, 15, 'approved expenses excl. VAT: 10 + 5 (rejected one excluded)');
  assert.equal(s.commissions, 2, '4 + 3 + 2 − 4 − 3');
  assert.equal(s.revenue, 60, '120 net billed (2 × 20 + 2 × 40) − 60 credited');
  assert.deepEqual(s.expenses_by_category.map((c) => c.name_en), ['Supplies']);
  await expectPgError(q(db, cashier.userId, `select public.get_finance_summary($1, $2, $2)`, [A.tenantId, today()]), 'FORBIDDEN');
});

test('loyalty: earn on net spend, redeem into store credit, reverse on returns', async () => {
  // Disabled by default: nothing is earned.
  await sale(cashier.userId, [{ service_id: haircut }], aisha);
  assert.equal(await points(aisha), 0);
  await expectPgError(q(db, cashier.userId, `select public.redeem_loyalty_points($1, 100)`, [aisha]), 'LOYALTY_DISABLED');

  await q(db, A.ownerId, `update public.tenant_settings set loyalty_enabled = true, loyalty_points_per_unit = 2, loyalty_point_value = 0.01, loyalty_min_redeem = 50 where tenant_id = $1`, [A.tenantId]);
  const big = await sale(cashier.userId, [{ service_id: colour }, { service_id: haircut }, { kind: 'voucher', unit_price: 30 }], aisha);
  assert.equal(await points(aisha), 120, '2 points × 60.000 net; vouchers earn nothing');

  await expectPgError(q(db, cashier.userId, `select public.redeem_loyalty_points($1, 10)`, [aisha]), 'INVALID_POINTS');
  await expectPgError(q(db, cashier.userId, `select public.redeem_loyalty_points($1, 500)`, [aisha]), 'INSUFFICIENT_BALANCE');
  const [{ r }] = await q(db, cashier.userId, `select public.redeem_loyalty_points($1, 100) r`, [aisha]);
  assert.equal(r.amount, 1);
  const [v] = await q(db, cashier.userId, `select kind, balance::float8 b from public.gift_vouchers where code = $1`, [r.code]);
  assert.deepEqual(v, { kind: 'store_credit', b: 1 });
  assert.equal(await points(aisha), 20);

  // Returning the colour (40 net = 80 points) can only take back what is left.
  const line = big.items.find((i) => i.service_id === colour);
  await q(db, manager.userId, `select public.create_credit_note($1, $2, 'Return', null)`, [big.id, JSON.stringify([{ item_id: line.id, quantity: 1 }])]).catch(async (e) => {
    if (!/REFUND_METHOD_REQUIRED/.test(e.message)) throw e;
  });
  assert.equal(await points(aisha), 0);

  await expectPgError(q(db, cashier.userId, `select public.adjust_loyalty_points($1, 50, 'Birthday')`, [aisha]), 'FORBIDDEN');
  assert.equal((await q(db, manager.userId, `select public.adjust_loyalty_points($1, 50, 'Birthday gift') n`, [aisha]))[0].n, 50);
  await expectPgError(q(db, manager.userId, `select public.adjust_loyalty_points($1, -60, 'Too much')`, [aisha]), 'INSUFFICIENT_BALANCE');
  const [{ r: w }] = await q(db, cashier.userId, `select public.get_customer_wallet($1) r`, [aisha]);
  assert.deepEqual(w.loyalty, { points: 50, point_value: 0.01, min_redeem: 50 });
});

test('isolation', async () => {
  for (const table of ['commission_rules', 'commission_entries', 'commission_payouts', 'expense_categories', 'expenses', 'loyalty_accounts', 'loyalty_transactions']) {
    const rows = await q(db, B.ownerId, `select tenant_id from public.${table}`);
    for (const r of rows) assert.equal(r.tenant_id, B.tenantId, `${table} leaked`);
  }
  await expectPgError(q(db, B.ownerId, `select public.pay_commissions($1, $2, $3, 'cash')`, [A.tenantId, reena, today()]), 'FORBIDDEN');
  await expectPgError(q(db, B.ownerId, `select public.redeem_loyalty_points($1, 50)`, [aisha]), 'NOT_FOUND');
  await expectPgError(q(db, B.ownerId, `select public.get_finance_summary($1, $2, $2)`, [A.tenantId, today()]), 'FORBIDDEN');
  const [bCat] = await q(db, B.ownerId, `insert into public.expense_categories (tenant_id, name_en) values ($1, 'B cat') returning id`, [B.tenantId]);
  await expectPgError(q(db, accountant.userId, `select public.record_expense($1, $2, $3, 1, 0, 'x', 'card')`, [A.branchId, bCat.id, today()]), 'INVALID_CATEGORY');
});

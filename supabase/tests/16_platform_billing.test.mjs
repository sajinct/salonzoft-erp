// Phase 6 · SaaS commercialisation: super-admin console roles, subscription
// invoices (VAT, gap-free numbers), plan changes with pro-rata credit, scheduled
// downgrades, plan limits, billing cycle (renewal → past due → suspended),
// cancellation, gateway webhook idempotency, module overrides, plan edits.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createTenantWithOwner, createUser, q, expectPgError } from './helpers/db.mjs';

let db, A, B, C, admin, support, billing;

const rpc = async (uid, fn, args = []) =>
  (await q(db, uid, `select public.${fn}(${args.map((_, i) => '$' + (i + 1)).join(', ')}) r`, args))[0].r;
const asService = (sql, params = []) =>
  db.transaction(async (tx) => {
    await tx.exec('set local role service_role');
    return (await tx.query(sql, params)).rows;
  });
const cycle = async () => (await asService(`select public.run_billing_cycle() r`))[0].r;
const current = async (tenantId) =>
  (await db.query(
    `select s.*, p.code plan_code from public.tenant_subscriptions s join public.subscription_plans p on p.id = s.plan_id
     where s.tenant_id = $1 order by (s.status in ('trialing','active','past_due','suspended')) desc, s.created_at desc limit 1`,
    [tenantId],
  )).rows[0];
const ctx = async (T) => (await q(db, T.ownerId, `select public.get_tenant_context($1) c`, [T.tenantId]))[0].c;
const openInvoice = async (tenantId) =>
  (await db.query(`select * from public.subscription_invoices where tenant_id = $1 and status = 'open'`, [tenantId])).rows;
const makeAdmin = async (email, role) => {
  const id = await createUser(db, email);
  await db.query(`insert into public.platform_admins (user_id, role) values ($1, $2)`, [id, role]);
  return id;
};
const DAY = 86_400_000;

before(async () => {
  db = await createDb();
  A = await createTenantWithOwner(db, { email: 'bill-owner-a@example.com', slug: 'bill-a', name: 'Salon Bill A' });
  B = await createTenantWithOwner(db, { email: 'bill-owner-b@example.com', slug: 'bill-b', name: 'Salon Bill B' });
  C = await createTenantWithOwner(db, { email: 'bill-owner-c@example.com', slug: 'bill-c', name: 'Salon Bill C' });
  admin = await makeAdmin('root@salonzoft.test', 'admin');
  support = await makeAdmin('help@salonzoft.test', 'support');
  billing = await makeAdmin('money@salonzoft.test', 'billing');
});

test('only platform admins reach the console, and each role only its actions', async () => {
  await expectPgError(rpc(A.ownerId, 'admin_overview'), 'FORBIDDEN');
  await expectPgError(rpc(A.ownerId, 'admin_list_tenants', [null, 'all', 50, 0]), 'FORBIDDEN');
  assert.equal((await rpc(A.ownerId, 'admin_whoami')).role, null);
  assert.equal((await rpc(support, 'admin_whoami')).role, 'support');

  const list = await rpc(support, 'admin_list_tenants', [null, 'all', 50, 0]);
  assert.equal(list.total, 3);
  assert.ok(list.rows.some((r) => r.owner_email === 'bill-owner-a@example.com' && r.sub_status === 'trialing' && r.branches === 1));
  assert.equal((await rpc(support, 'admin_list_tenants', ['bill-b', 'all', 50, 0])).rows[0].slug, 'bill-b');
  assert.equal((await rpc(support, 'admin_list_tenants', [null, 'trialing', 50, 0])).total, 3);

  await expectPgError(rpc(support, 'admin_create_invoice', [A.tenantId, 'starter', 'monthly', 'new']), 'FORBIDDEN');
  await expectPgError(rpc(support, 'admin_save_plan', [JSON.stringify({ code: 'x' })]), 'FORBIDDEN');
  await expectPgError(rpc(billing, 'admin_extend_trial', [A.tenantId, 5]), 'FORBIDDEN');
  await expectPgError(rpc(billing, 'admin_set_admin', ['help@salonzoft.test', null]), 'FORBIDDEN');

  // Platform audit and invoices are not readable as tables by anyone but their owners.
  await assert.rejects(q(db, admin, `select * from public.platform_audit_logs`), /permission denied/);
});

test('trial checkout: VAT invoice, replacing an open invoice, payment starts after the trial', async () => {
  const before = await current(A.tenantId);
  const r1 = await rpc(A.ownerId, 'request_plan_change', [A.tenantId, 'enterprise', 'yearly']);
  assert.equal(r1.scheduled, false);
  assert.match(r1.number, /^SZ-\d{4}-00001$/);
  assert.equal(Number(r1.total), 787.5); // 750 + 5 % VAT

  const r2 = await rpc(A.ownerId, 'request_plan_change', [A.tenantId, 'professional', 'monthly']);
  assert.match(r2.number, /^SZ-\d{4}-00002$/);
  const open = await openInvoice(A.tenantId);
  assert.equal(open.length, 1);
  assert.equal(open[0].kind, 'new');
  assert.equal(open[0].buyer_name, 'Salon Bill A');
  assert.equal((await db.query(`select status from public.subscription_invoices where number = $1`, [r1.number])).rows[0].status, 'void');

  // Tenants see only their own invoices.
  assert.equal((await q(db, A.ownerId, `select id from public.subscription_invoices`)).length, 2);
  assert.equal((await q(db, B.ownerId, `select id from public.subscription_invoices`)).length, 0);
  await expectPgError(rpc(B.ownerId, 'get_billing_overview', [A.tenantId]), 'FORBIDDEN');
  assert.equal((await rpc(A.ownerId, 'get_subscription_invoice', [r2.invoice_id])).number, r2.number);
  assert.equal((await rpc(support, 'get_subscription_invoice', [r2.invoice_id])).tenant_slug, 'bill-a');
  await expectPgError(rpc(B.ownerId, 'get_subscription_invoice', [r2.invoice_id]), 'NOT_FOUND');

  await expectPgError(rpc(billing, 'admin_record_payment', [r2.invoice_id, 'gateway', 'x', null]), 'INVALID_VALUE');
  const paid = await rpc(billing, 'admin_record_payment', [r2.invoice_id, 'bank_transfer', 'TRX-1', null]);
  assert.equal(new Date(paid.period_start).getTime(), before.trial_ends_at.getTime(), 'the remaining trial is kept');
  const s = await current(A.tenantId);
  assert.equal(s.status, 'active');
  assert.equal(s.plan_code, 'professional');
  await expectPgError(rpc(billing, 'admin_record_payment', [r2.invoice_id, 'cash', null, null]), 'INVOICE_NOT_OPEN');

  const overview = await rpc(A.ownerId, 'get_billing_overview', [A.tenantId]);
  assert.equal(overview.subscription.status, 'active');
  assert.equal(overview.invoices[0].status, 'paid');
  assert.equal(overview.usage.branches, 1);
  assert.deepEqual(overview.plans.map((p) => p.code), ['starter', 'professional', 'enterprise']);
  await expectPgError(rpc(A.ownerId, 'request_plan_change', [A.tenantId, 'professional', 'monthly']), 'PLAN_UNCHANGED');
});

test('upgrade gets a pro-rata credit; downgrade waits for the period end and must fit the limits', async () => {
  const r = await rpc(B.ownerId, 'request_plan_change', [B.tenantId, 'professional', 'monthly']);
  await rpc(billing, 'admin_record_payment', [r.invoice_id, 'cash', null, null]);
  // Paid period starts when the trial ends (in the future): the whole period is unused.
  const up = await rpc(B.ownerId, 'request_plan_change', [B.tenantId, 'enterprise', 'monthly']);
  const [inv] = await openInvoice(B.tenantId);
  assert.equal(inv.kind, 'change');
  assert.deepEqual([Number(inv.amount), Number(inv.credit), Number(inv.subtotal), Number(inv.total)], [75, 35, 40, 42]);
  assert.equal(up.number, inv.number);

  await rpc(B.ownerId, 'cancel_pending_change', [B.tenantId]);
  assert.equal((await openInvoice(B.tenantId)).length, 0);

  for (let i = 1; i <= 6; i++) {
    await q(db, B.ownerId, `insert into public.employees (tenant_id, name_en) values ($1, $2)`, [B.tenantId, 'Stylist ' + i]);
  }
  await expectPgError(rpc(B.ownerId, 'request_plan_change', [B.tenantId, 'starter', 'monthly']), 'PLAN_LIMIT_EMPLOYEES');
  await db.query(`update public.employees set is_active = false where tenant_id = $1 and name_en = 'Stylist 6'`, [B.tenantId]);

  await db.query(`insert into public.branches (tenant_id, code, name_en) values ($1, 'B2', 'Second')`, [B.tenantId]);
  await expectPgError(rpc(B.ownerId, 'request_plan_change', [B.tenantId, 'starter', 'monthly']), 'PLAN_LIMIT_BRANCHES');
  await db.query(`delete from public.branches where tenant_id = $1 and code = 'B2'`, [B.tenantId]);

  const down = await rpc(B.ownerId, 'request_plan_change', [B.tenantId, 'starter', 'monthly']);
  assert.equal(down.scheduled, true);
  const s = await current(B.tenantId);
  assert.equal(s.plan_code, 'professional', 'still on the paid plan until the period ends');
  assert.equal(new Date(down.effective_at).getTime(), s.current_period_end.getTime());
  assert.equal((await openInvoice(B.tenantId)).length, 0);
});

test('billing cycle: renewal invoice, past-due grace, suspension, payment restores; cancellation', async () => {
  const setPeriod = (startDays, endDays) =>
    db.query(`update public.tenant_subscriptions set current_period_start = now() + make_interval(days => $2), current_period_end = now() + make_interval(days => $3)
              where tenant_id = $1 and status in ('active','past_due','suspended')`, [B.tenantId, startDays, endDays]);

  await setPeriod(-27, 3);
  assert.deepEqual(await cycle(), { renewal_invoices: 1, past_due: 0, suspended: 0, cancelled: 0 });
  const [renewal] = await openInvoice(B.tenantId);
  assert.equal(renewal.kind, 'renewal');
  assert.equal(renewal.plan_name_en, 'Starter', 'the scheduled downgrade is billed at renewal');
  assert.equal(Number(renewal.total), 15.75);
  assert.equal((await cycle()).renewal_invoices, 0, 'one open invoice at a time');

  await setPeriod(-31, -1);
  assert.equal((await cycle()).past_due, 1);
  assert.equal((await current(B.tenantId)).status, 'past_due');
  assert.equal((await ctx(B)).operational, true, 'grace period');

  await setPeriod(-50, -20);
  assert.equal((await cycle()).suspended, 1);
  const c = await ctx(B);
  assert.equal(c.operational, false);
  assert.ok(c.permissions.includes('billing.manage'));
  assert.equal((await rpc(B.ownerId, 'get_billing_overview', [B.tenantId])).subscription.status, 'suspended');

  await rpc(billing, 'admin_record_payment', [renewal.id, 'bank_transfer', 'TRX-B', null]);
  const s = await current(B.tenantId);
  assert.equal(s.status, 'active');
  assert.equal(s.plan_code, 'starter');
  assert.equal(s.scheduled_plan_id, null);
  assert.ok(s.current_period_end.getTime() > Date.now());
  const after = await ctx(B);
  assert.equal(after.operational, true);
  assert.ok(!after.modules.includes('marketing'), 'starter entitlements applied');

  await rpc(B.ownerId, 'set_cancel_at_period_end', [B.tenantId, true]);
  await setPeriod(-31, -1);
  assert.equal((await cycle()).cancelled, 1);
  assert.equal((await current(B.tenantId)).status, 'cancelled');
  assert.equal((await ctx(B)).operational, false);
  await expectPgError(rpc(B.ownerId, 'set_cancel_at_period_end', [B.tenantId, false]), 'SUBSCRIPTION_NOT_ACTIVE');

  // Coming back: a new subscription, paid through the gateway entry point (idempotent).
  const again = await rpc(B.ownerId, 'request_plan_change', [B.tenantId, 'starter', 'monthly']);
  await assert.rejects(q(db, B.ownerId, `select public.billing_apply_gateway_payment($1, 'gw-1')`, [again.invoice_id]), /permission denied/);
  assert.equal((await asService(`select public.billing_apply_gateway_payment($1, 'gw-1') r`, [again.invoice_id]))[0].r.replayed, false);
  assert.equal((await asService(`select public.billing_apply_gateway_payment($1, 'gw-1') r`, [again.invoice_id]))[0].r.replayed, true);
  assert.equal((await current(B.tenantId)).status, 'active');
  assert.equal((await ctx(B)).operational, true);
});

test('admin actions: trial extension, suspension, module overrides, plan edits, admins, settings', async () => {
  const trialEnd = (await current(C.tenantId)).trial_ends_at.getTime();
  const extended = await rpc(support, 'admin_extend_trial', [C.tenantId, 10]);
  assert.ok(Math.abs(new Date(extended).getTime() - (trialEnd + 10 * DAY)) < 60_000);
  await expectPgError(rpc(support, 'admin_extend_trial', [A.tenantId, 10]), 'SUBSCRIPTION_NOT_TRIAL');

  await expectPgError(rpc(support, 'admin_set_tenant_status', [C.tenantId, 'suspended', null]), 'REASON_REQUIRED');
  await rpc(support, 'admin_set_tenant_status', [C.tenantId, 'suspended', 'Chargeback']);
  assert.equal((await ctx(C)).operational, false);
  await expectPgError(rpc(support, 'admin_set_tenant_status', [C.tenantId, 'closed', 'Requested']), 'FORBIDDEN');
  await rpc(admin, 'admin_set_tenant_status', [C.tenantId, 'active', null]);
  assert.equal((await ctx(C)).operational, true);

  await rpc(support, 'admin_set_module', [C.tenantId, 'inventory', false, null]);
  assert.ok(!(await ctx(C)).modules.includes('inventory'));
  await rpc(support, 'admin_set_module', [C.tenantId, 'multi_branch', true, null]);

  const plans = await rpc(admin, 'admin_list_plans');
  const pro = plans.find((p) => p.code === 'professional');
  assert.equal(pro.subscribers, 2);
  await rpc(admin, 'admin_save_plan', [JSON.stringify({ ...pro, modules: pro.modules.filter((m) => m !== 'loyalty') })]);
  let c = await ctx(C);
  assert.ok(!c.modules.includes('loyalty'), 'plan edits reach subscribers');
  assert.ok(!c.modules.includes('inventory'), 'overrides survive plan sync');
  await rpc(support, 'admin_set_module', [C.tenantId, 'inventory', null, null]);
  c = await ctx(C);
  assert.ok(c.modules.includes('inventory'));
  await expectPgError(rpc(admin, 'admin_save_plan', [JSON.stringify({ ...pro, is_active: false })]), 'TRIAL_PLAN_REQUIRED');
  await expectPgError(rpc(admin, 'admin_save_plan', [JSON.stringify({ ...pro, modules: ['nope'] })]), 'INVALID_VALUE');
  await expectPgError(rpc(support, 'admin_set_module', [C.tenantId, 'dashboard', false, null]), 'INVALID_VALUE');

  await rpc(admin, 'admin_set_admin', ['help@salonzoft.test', 'billing']);
  assert.equal((await rpc(support, 'admin_whoami')).role, 'billing');
  await expectPgError(rpc(admin, 'admin_set_admin', ['root@salonzoft.test', null]), 'ADMIN_SELF');
  await expectPgError(rpc(admin, 'admin_set_admin', ['nobody@example.com', 'support']), 'USER_NOT_FOUND');
  assert.equal((await rpc(admin, 'admin_list_admins')).length, 3);

  await expectPgError(rpc(admin, 'admin_save_settings', [JSON.stringify({ billing_vat_rate: 'abc' })]), 'INVALID_VALUE');
  await rpc(admin, 'admin_save_settings', [JSON.stringify({ billing_vat_rate: '0', billing_bank_details: 'Bank Muscat · IBAN OM00' })]);
  const inv = await rpc(billing, 'admin_create_invoice', [C.tenantId, 'starter', 'monthly', 'new']);
  assert.equal(Number(inv.total), 15);
  assert.equal((await rpc(C.ownerId, 'get_billing_overview', [C.tenantId])).payment.bank_details, 'Bank Muscat · IBAN OM00');
  await expectPgError(rpc(billing, 'admin_void_invoice', [inv.invoice_id, '']), 'REASON_REQUIRED');
  await rpc(billing, 'admin_void_invoice', [inv.invoice_id, 'Wrong plan']);

  const detail = await rpc(support, 'admin_get_tenant', [C.tenantId]);
  assert.ok(detail.history.some((h) => h.action === 'tenant.status' && h.actor === 'help@salonzoft.test'));
  assert.equal(detail.members[0].email, 'bill-owner-c@example.com');
  assert.equal(detail.modules.find((m) => m.code === 'multi_branch').source, 'override');

  const o = await rpc(admin, 'admin_overview');
  assert.equal(o.tenants.total, 3);
  assert.equal(o.months.length, 12);
  assert.equal(Number(o.mrr), 35 + 15);
  assert.ok(Number(o.collected_month) > 0);
  assert.equal((await rpc(admin, 'admin_list_invoices', ['void', null, 100, 0])).total, 3);
});

// Mandatory scenario: subscription restrictions cannot be bypassed.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createTenantWithOwner, q, addMember, expectPgError } from './helpers/db.mjs';

let db, T, staff;
before(async () => {
  db = await createDb();
  T = await createTenantWithOwner(db, { email: 'sub-owner@example.com', slug: 'sub-salon' });
  staff = await addMember(db, { tenantId: T.tenantId, inviterId: T.ownerId, email: 'sub-staff@example.com', roleCodes: ['manager'], allBranches: true });
});

const perms = async (uid) => (await q(db, uid, `select public.get_tenant_context($1) c`, [T.tenantId]))[0].c.permissions;

test('module permissions disappear when the module is not entitled', async () => {
  assert.ok((await perms(staff.userId)).includes('inventory.view'));
  await db.query(`update public.module_entitlements set is_enabled = false where tenant_id = $1 and module_code = 'inventory'`, [T.tenantId]);
  const p = await perms(staff.userId);
  assert.ok(!p.includes('inventory.view'));
  assert.ok(!(await perms(T.ownerId)).includes('inventory.manage'), 'even the owner loses un-entitled modules');
  await db.query(`update public.module_entitlements set is_enabled = true where tenant_id = $1 and module_code = 'inventory'`, [T.tenantId]);
});

test('entitlements with a past valid_until are ignored', async () => {
  await db.query(`update public.module_entitlements set valid_until = now() - interval '1 day' where tenant_id = $1 and module_code = 'pos'`, [T.tenantId]);
  assert.ok(!(await perms(staff.userId)).includes('pos.access'));
  await db.query(`update public.module_entitlements set valid_until = null where tenant_id = $1 and module_code = 'pos'`, [T.tenantId]);
});

test('expired trial: staff lose all permissions, owner keeps billing access only', async () => {
  await db.query(`update public.tenant_subscriptions set trial_ends_at = now() - interval '1 minute' where tenant_id = $1`, [T.tenantId]);

  assert.deepEqual(await perms(staff.userId), []);
  const ownerPerms = await perms(T.ownerId);
  assert.deepEqual([...ownerPerms].sort(), ['billing.manage', 'dashboard.view', 'settings.view', 'team.view']);

  // Writes protected by permissions are now refused, even for the owner.
  const upd = await q(db, T.ownerId, `update public.tenant_settings set default_vat_rate = 0 where tenant_id = $1 returning tenant_id`, [T.tenantId]);
  assert.equal(upd.length, 0);
  await expectPgError(
    q(db, T.ownerId, `select public.create_invitation($1, 'late-joiner@example.com', '{}', true, '{}')`, [T.tenantId]),
    'FORBIDDEN',
  );

  const [{ c }] = await q(db, T.ownerId, `select public.get_tenant_context($1) c`, [T.tenantId]);
  assert.equal(c.operational, false);

  // Re-activate (as the billing webhook would) and everything returns.
  await db.query(`update public.tenant_subscriptions set status = 'active', trial_ends_at = null where tenant_id = $1`, [T.tenantId]);
  assert.ok((await perms(staff.userId)).includes('appointments.manage'));
});

test('suspended tenant is not operational', async () => {
  await db.query(`update public.tenants set status = 'suspended' where id = $1`, [T.tenantId]);
  assert.deepEqual(await perms(staff.userId), []);
  await db.query(`update public.tenants set status = 'active' where id = $1`, [T.tenantId]);
});

test('closed tenant disappears for its members entirely', async () => {
  await db.query(`update public.tenants set status = 'closed' where id = $1`, [T.tenantId]);
  assert.equal((await q(db, T.ownerId, `select * from public.get_my_tenants()`)).length, 0);
  assert.equal((await q(db, T.ownerId, `select id from public.tenants`)).length, 0);
  await db.query(`update public.tenants set status = 'active' where id = $1`, [T.tenantId]);
});

test('clients cannot self-upgrade or toggle entitlements', async () => {
  await expectPgError(
    q(db, T.ownerId, `update public.module_entitlements set is_enabled = true where tenant_id = $1`, [T.tenantId]),
    /permission denied/,
  );
  await expectPgError(
    q(db, T.ownerId, `update public.tenant_subscriptions set plan_id = (select id from public.subscription_plans where code = 'enterprise')`),
    /permission denied/,
  );
});

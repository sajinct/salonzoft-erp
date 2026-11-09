// Mandatory scenario: Tenant A cannot access Tenant B — reads, inserts,
// updates, deletes and RPCs, across every Phase 1 table.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createTenantWithOwner, q, expectPgError, addMember } from './helpers/db.mjs';

let db, A, B;

before(async () => {
  db = await createDb();
  A = await createTenantWithOwner(db, { email: 'owner-a@example.com', slug: 'salon-a' });
  B = await createTenantWithOwner(db, { email: 'owner-b@example.com', slug: 'salon-b' });
  // Give B some extra data to (attempt to) leak.
  await addMember(db, { tenantId: B.tenantId, inviterId: B.ownerId, email: 'staff-b@example.com', roleCodes: ['receptionist'], allBranches: true });
});

const tenantScopedTables = [
  'tenants', 'tenant_settings', 'tenant_subscriptions', 'module_entitlements', 'tenant_usage',
  'roles', 'role_permissions', 'tenant_memberships', 'user_roles', 'branches',
  'branch_working_hours', 'user_branch_access', 'tenant_invitations', 'audit_logs',
];

test('owner A reads zero rows of tenant B in every tenant-scoped table', async () => {
  for (const table of tenantScopedTables) {
    const column = table === 'tenants' ? 'id' : 'tenant_id';
    const selectList = table === 'tenant_invitations' ? 'id' : '*';
    const rows = await q(db, A.ownerId, `select ${selectList} from public.${table} where ${column} = $1`, [B.tenantId]);
    assert.equal(rows.length, 0, `${table} leaked ${rows.length} row(s) of tenant B`);
  }
});

test('owner A only ever sees their own tenant in unfiltered reads', async () => {
  for (const table of tenantScopedTables) {
    const column = table === 'tenants' ? 'id' : 'tenant_id';
    const rows = await q(db, A.ownerId, `select distinct ${column} as t from public.${table}`);
    for (const r of rows) assert.equal(r.t, A.tenantId, `${table} returned a foreign tenant row`);
  }
});

test('owner A cannot see profiles of tenant B members', async () => {
  const rows = await q(db, A.ownerId, `select id from public.profiles where id = $1`, [B.ownerId]);
  assert.equal(rows.length, 0);
});

test('owner A cannot insert rows into tenant B', async () => {
  await expectPgError(
    q(db, A.ownerId, `insert into public.branches (tenant_id, code, name_en) values ($1, 'HACK', 'Hack')`, [B.tenantId]),
    /row-level security/,
  );
  await expectPgError(
    q(db, A.ownerId, `insert into public.roles (tenant_id, code, name_en) values ($1, 'hacker', 'Hacker')`, [B.tenantId]),
    /row-level security/,
  );
  await expectPgError(
    q(db, A.ownerId, `insert into public.branch_working_hours (tenant_id, branch_id, day_of_week, opens_at, closes_at)
                      values ($1, $2, 1, '09:00', '10:00')`, [B.tenantId, B.branchId]),
    /row-level security/,
  );
});

test('composite FKs stop a tenant-A row from pointing at a tenant-B parent', async () => {
  // Correct tenant_id (A) but B's branch id → FK violation, not a cross-tenant link.
  await expectPgError(
    q(db, A.ownerId, `insert into public.branch_working_hours (tenant_id, branch_id, day_of_week, opens_at, closes_at)
                      values ($1, $2, 1, '09:00', '10:00')`, [A.tenantId, B.branchId]),
    /foreign key/,
  );
  const [bRole] = (await db.query(`select id from public.roles where tenant_id = $1 limit 1`, [B.tenantId])).rows;
  await expectPgError(
    q(db, A.ownerId, `insert into public.role_permissions (tenant_id, role_id, permission_code) values ($1, $2, 'pos.access')`,
      [A.tenantId, bRole.id]),
    /foreign key/,
  );
});

test('owner A cannot update or delete tenant B rows (silently affects 0 rows)', async () => {
  const updated = await q(db, A.ownerId, `update public.branches set name_en = 'Pwned' where tenant_id = $1 returning id`, [B.tenantId]);
  assert.equal(updated.length, 0);
  const updatedTenant = await q(db, A.ownerId, `update public.tenants set name = 'Pwned' where id = $1 returning id`, [B.tenantId]);
  assert.equal(updatedTenant.length, 0);
  const deleted = await q(db, A.ownerId, `delete from public.roles where tenant_id = $1 returning id`, [B.tenantId]);
  assert.equal(deleted.length, 0);
  const deletedHours = await q(db, A.ownerId, `delete from public.branch_working_hours where tenant_id = $1 returning id`, [B.tenantId]);
  assert.equal(deletedHours.length, 0);
  const [{ name }] = (await db.query(`select name from public.tenants where id = $1`, [B.tenantId])).rows;
  assert.equal(name, 'Salon salon-b');
});

test('tenant_id can never be changed by a client (not in the column grant)', async () => {
  await expectPgError(
    q(db, A.ownerId, `update public.branches set tenant_id = $1 where tenant_id = $2`, [B.tenantId, A.tenantId]),
    /permission denied/,
  );
});

test('RPCs refuse foreign tenant ids', async () => {
  await expectPgError(q(db, A.ownerId, `select public.get_tenant_context($1)`, [B.tenantId]), 'FORBIDDEN');
  await expectPgError(q(db, A.ownerId, `select public.get_dashboard_summary($1)`, [B.tenantId]), 'FORBIDDEN');
  await expectPgError(q(db, A.ownerId, `select * from public.list_tenant_members($1)`, [B.tenantId]), 'FORBIDDEN');
  await expectPgError(
    q(db, A.ownerId, `select public.create_invitation($1, 'x@example.com', '{}', true, '{}')`, [B.tenantId]),
    'FORBIDDEN',
  );
  await expectPgError(
    q(db, A.ownerId, `select * from public.set_branch_working_hours($1, '[]'::jsonb)`, [B.branchId]),
    'NOT_FOUND',
  );
  const [bMember] = (await db.query(`select id from public.tenant_memberships where tenant_id = $1 and not is_owner`, [B.tenantId])).rows;
  await expectPgError(
    q(db, A.ownerId, `select public.set_member_status($1, 'suspended')`, [bMember.id]),
    'NOT_FOUND',
  );
  await expectPgError(
    q(db, A.ownerId, `select public.update_member_access($1, '{}', true, '{}')`, [bMember.id]),
    'NOT_FOUND',
  );
});

test('get_my_tenants lists only the caller’s tenants', async () => {
  const rows = await q(db, A.ownerId, `select tenant_id from public.get_my_tenants()`);
  assert.deepEqual(rows.map((r) => r.tenant_id), [A.tenantId]);
});

test('a user in both tenants sees exactly both — and nothing else', async () => {
  const shared = await addMember(db, {
    tenantId: A.tenantId, inviterId: A.ownerId, email: 'shared@example.com', roleCodes: ['cashier'], allBranches: true,
  });
  const [{ inv }] = await q(db, B.ownerId, `select public.create_invitation($1, 'shared@example.com', '{}', true, '{}') as inv`, [B.tenantId]);
  await q(db, shared.userId, `select public.accept_invitation($1)`, [inv.token]);
  const rows = await q(db, shared.userId, `select tenant_id from public.get_my_tenants() order by name`);
  assert.deepEqual(new Set(rows.map((r) => r.tenant_id)), new Set([A.tenantId, B.tenantId]));
  // Permissions are per-tenant: cashier in A, no roles in B.
  const [{ c: ctxA }] = await q(db, shared.userId, `select public.get_tenant_context($1) c`, [A.tenantId]);
  const [{ c: ctxB }] = await q(db, shared.userId, `select public.get_tenant_context($1) c`, [B.tenantId]);
  assert.ok(ctxA.permissions.includes('pos.access'));
  assert.deepEqual(ctxB.permissions, []);
});

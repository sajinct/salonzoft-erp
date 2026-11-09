// Team invitations, role-based permissions, anti-escalation and branch-level
// isolation ("staff cannot access unauthorized branches").
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createUser, createTenantWithOwner, q, expectPgError, addMember } from './helpers/db.mjs';

let db, T, branch2, manager, receptionist;

const roleId = async (code) =>
  (await db.query(`select id from public.roles where tenant_id = $1 and code = $2`, [T.tenantId, code])).rows[0].id;

before(async () => {
  db = await createDb();
  T = await createTenantWithOwner(db, { email: 'owner@example.com', slug: 'team-salon' });
  [branch2] = await q(db, T.ownerId, `insert into public.branches (tenant_id, code, name_en) values ($1, 'SEEB', 'Seeb') returning id`, [T.tenantId]);
  manager = await addMember(db, { tenantId: T.tenantId, inviterId: T.ownerId, email: 'manager@example.com', roleCodes: ['manager'], branchIds: [T.branchId] });
  receptionist = await addMember(db, { tenantId: T.tenantId, inviterId: T.ownerId, email: 'reception@example.com', roleCodes: ['receptionist'], branchIds: [branch2.id] });
});

test('staff only see the branches they are assigned to', async () => {
  const mgr = await q(db, manager.userId, `select id from public.branches`);
  assert.deepEqual(mgr.map((b) => b.id), [T.branchId]);
  const rec = await q(db, receptionist.userId, `select id from public.branches`);
  assert.deepEqual(rec.map((b) => b.id), [branch2.id]);
  const owner = await q(db, T.ownerId, `select id from public.branches order by is_main desc`);
  assert.equal(owner.length, 2);
  const hours = await q(db, receptionist.userId, `select distinct branch_id from public.branch_working_hours`);
  for (const h of hours) assert.equal(h.branch_id, branch2.id);
});

test('dashboard for an unassigned branch is forbidden', async () => {
  await expectPgError(q(db, receptionist.userId, `select public.get_dashboard_summary($1, $2)`, [T.tenantId, T.branchId]), 'FORBIDDEN');
  const [{ d }] = await q(db, receptionist.userId, `select public.get_dashboard_summary($1, $2) d`, [T.tenantId, branch2.id]);
  assert.equal(d.branches.total, 1);
  assert.equal(d.team, null); // receptionist lacks team.view
});

test('role permissions drive the effective permission set', async () => {
  const [{ c }] = await q(db, receptionist.userId, `select public.get_tenant_context($1) c`, [T.tenantId]);
  assert.ok(c.permissions.includes('appointments.manage'));
  assert.ok(!c.permissions.includes('settings.manage'));
  assert.ok(!c.permissions.includes('team.view'));
  assert.deepEqual(c.branches.map((b) => b.id), [branch2.id]);
});

test('non-admin staff cannot change settings or branches', async () => {
  const s = await q(db, receptionist.userId, `update public.tenant_settings set default_vat_rate = 0 where tenant_id = $1 returning tenant_id`, [T.tenantId]);
  assert.equal(s.length, 0);
  const b = await q(db, manager.userId, `update public.branches set name_en = 'X' where id = $1 returning id`, [T.branchId]);
  assert.equal(b.length, 0, 'manager template lacks branches.manage');
  await expectPgError(
    q(db, receptionist.userId, `insert into public.branches (tenant_id, code, name_en) values ($1, 'NEW', 'New')`, [T.tenantId]),
    /row-level security/,
  );
});

test('memberships, roles and branch access cannot be written directly', async () => {
  await expectPgError(
    q(db, receptionist.userId, `update public.tenant_memberships set is_owner = true where user_id = $1`, [receptionist.userId]),
    /permission denied/,
  );
  await expectPgError(
    q(db, receptionist.userId, `insert into public.user_roles (tenant_id, membership_id, role_id) values ($1, $2, $3)`,
      [T.tenantId, receptionist.membershipId, await roleId('manager')]),
    /permission denied/,
  );
  await expectPgError(
    q(db, receptionist.userId, `insert into public.user_branch_access (tenant_id, membership_id, branch_id) values ($1, $2, $3)`,
      [T.tenantId, receptionist.membershipId, T.branchId]),
    /permission denied/,
  );
});

test('a manager cannot invite someone into a role with permissions the manager lacks', async () => {
  const [auditor] = await q(db, T.ownerId, `insert into public.roles (tenant_id, code, name_en) values ($1, 'auditor', 'Auditor') returning id`, [T.tenantId]);
  await q(db, T.ownerId, `insert into public.role_permissions (tenant_id, role_id, permission_code) values ($1, $2, 'audit.view')`, [T.tenantId, auditor.id]);
  await expectPgError(
    q(db, manager.userId, `select public.create_invitation($1, 'acc@example.com', $2, false, $3)`,
      [T.tenantId, [auditor.id], [T.branchId]]),
    // audit.view is excluded from the manager template
    'ROLE_ESCALATION_FORBIDDEN',
  );
  // …but can invite a receptionist into their own branch.
  await q(db, manager.userId, `select public.create_invitation($1, 'rec2@example.com', $2, false, $3)`,
    [T.tenantId, [await roleId('receptionist')], [T.branchId]]);
});

test('a manager cannot grant access to a branch they cannot access, nor all-branch access', async () => {
  await expectPgError(
    q(db, manager.userId, `select public.create_invitation($1, 'x1@example.com', $2, false, $3)`,
      [T.tenantId, [await roleId('receptionist')], [branch2.id]]),
    'BRANCH_ESCALATION_FORBIDDEN',
  );
  await expectPgError(
    q(db, manager.userId, `select public.create_invitation($1, 'x2@example.com', $2, true, '{}')`,
      [T.tenantId, [await roleId('receptionist')]]),
    'BRANCH_ESCALATION_FORBIDDEN',
  );
});

test('roles.manage holders cannot grant permissions they do not hold', async () => {
  // Give the manager's role roles.manage (owner action) to set up the scenario.
  await q(db, T.ownerId, `insert into public.role_permissions (tenant_id, role_id, permission_code) values ($1, $2, 'roles.manage')`,
    [T.tenantId, await roleId('manager')]);
  await expectPgError(
    q(db, manager.userId, `insert into public.role_permissions (tenant_id, role_id, permission_code) values ($1, $2, 'billing.manage')`,
      [T.tenantId, await roleId('manager')]),
    /row-level security/,
  );
  await q(db, T.ownerId, `delete from public.role_permissions where role_id = $1 and permission_code = 'roles.manage'`, [await roleId('manager')]);
});

test('system roles cannot be deleted; custom roles can', async () => {
  const del = await q(db, T.ownerId, `delete from public.roles where code = 'cashier' and tenant_id = $1 returning id`, [T.tenantId]);
  assert.equal(del.length, 0);
  const [custom] = await q(db, T.ownerId, `insert into public.roles (tenant_id, code, name_en) values ($1, 'nail_tech', 'Nail technician') returning id, is_system`, [T.tenantId]);
  assert.equal(custom.is_system, false);
  const del2 = await q(db, T.ownerId, `delete from public.roles where id = $1 returning id`, [custom.id]);
  assert.equal(del2.length, 1);
});

test('invitations: token is single-use, email-bound, expiring, and hash-only at rest', async () => {
  const [{ inv }] = await q(db, T.ownerId, `select public.create_invitation($1, 'Newbie@Example.com', $2, false, $3) as inv`,
    [T.tenantId, [await roleId('cashier')], [T.branchId]]);
  assert.match(inv.token, /^[0-9a-f]{64}$/);
  assert.equal(inv.email, 'newbie@example.com');

  // Token never stored in plaintext; token_hash not readable by API roles.
  const [{ n }] = (await db.query(`select count(*)::int n from public.tenant_invitations where token_hash = $1`, [inv.token])).rows;
  assert.equal(n, 0);
  await expectPgError(q(db, T.ownerId, `select token_hash from public.tenant_invitations`), /permission denied/);

  const intruder = await createUser(db, 'intruder@example.com');
  await expectPgError(q(db, intruder, `select public.accept_invitation($1)`, [inv.token]), 'INVITATION_EMAIL_MISMATCH');

  const unconfirmed = await createUser(db, 'newbie@example.com', { confirmed: false });
  await expectPgError(q(db, unconfirmed, `select public.accept_invitation($1)`, [inv.token]), 'EMAIL_NOT_CONFIRMED');
  await db.query(`update auth.users set email_confirmed_at = now() where id = $1`, [unconfirmed]);

  await q(db, unconfirmed, `select public.accept_invitation($1)`, [inv.token]);
  await expectPgError(q(db, unconfirmed, `select public.accept_invitation($1)`, [inv.token]), 'INVITATION_INVALID');

  const [{ inv: inv2 }] = await q(db, T.ownerId, `select public.create_invitation($1, 'late@example.com', '{}', false, $2) as inv`, [T.tenantId, [T.branchId]]);
  await db.query(`update public.tenant_invitations set expires_at = now() - interval '1 minute' where email = 'late@example.com'`);
  const late = await createUser(db, 'late@example.com');
  await expectPgError(q(db, late, `select public.accept_invitation($1)`, [inv2.token]), 'INVITATION_EXPIRED');
  await expectPgError(q(db, late, `select public.accept_invitation('not-a-token')`), 'INVITATION_INVALID');
});

test('cannot invite an existing member', async () => {
  await expectPgError(
    q(db, T.ownerId, `select public.create_invitation($1, 'manager@example.com', '{}', true, '{}')`, [T.tenantId]),
    'MEMBER_ALREADY_EXISTS',
  );
});

test('owner is immutable; nobody can modify their own access', async () => {
  const [ownerMem] = (await db.query(`select id from public.tenant_memberships where tenant_id = $1 and is_owner`, [T.tenantId])).rows;
  await expectPgError(q(db, T.ownerId, `select public.set_member_status($1, 'suspended')`, [ownerMem.id]), 'OWNER_IMMUTABLE');
  await q(db, T.ownerId, `insert into public.role_permissions (tenant_id, role_id, permission_code) values ($1, $2, 'team.manage') on conflict do nothing`,
    [T.tenantId, await roleId('manager')]);
  await expectPgError(
    q(db, manager.userId, `select public.update_member_access($1, $2, true, '{}')`, [manager.membershipId, [await roleId('manager')]]),
    'SELF_MODIFICATION_FORBIDDEN',
  );
});

test('update_member_access replaces roles and branches; suspended members lose access immediately', async () => {
  await q(db, T.ownerId, `select public.update_member_access($1, $2, false, $3, 'Senior receptionist')`,
    [receptionist.membershipId, [await roleId('cashier')], [T.branchId, branch2.id]]);
  const branches = await q(db, receptionist.userId, `select id from public.branches`);
  assert.equal(branches.length, 2);
  const [{ c }] = await q(db, receptionist.userId, `select public.get_tenant_context($1) c`, [T.tenantId]);
  assert.ok(c.permissions.includes('pos.cash_session'));
  assert.ok(!c.permissions.includes('appointments.manage'));

  await q(db, T.ownerId, `select public.set_member_status($1, 'suspended')`, [receptionist.membershipId]);
  assert.equal((await q(db, receptionist.userId, `select id from public.branches`)).length, 0);
  assert.equal((await q(db, receptionist.userId, `select * from public.get_my_tenants()`)).length, 0);
  await expectPgError(q(db, receptionist.userId, `select public.get_tenant_context($1)`, [T.tenantId]), 'FORBIDDEN');
  await q(db, T.ownerId, `select public.set_member_status($1, 'active')`, [receptionist.membershipId]);
});

test('list_tenant_members requires team.view and returns emails only to authorised users', async () => {
  const members = await q(db, T.ownerId, `select email, is_owner from public.list_tenant_members($1)`, [T.tenantId]);
  assert.ok(members.length >= 3);
  assert.equal(members[0].is_owner, true);
  await expectPgError(q(db, receptionist.userId, `select * from public.list_tenant_members($1)`, [T.tenantId]), 'FORBIDDEN');
});

test('membership changes are audited', async () => {
  const rows = await q(db, T.ownerId, `select entity_type, action from public.audit_logs where tenant_id = $1 and entity_type in ('user_roles','tenant_memberships','user_branch_access')`, [T.tenantId]);
  assert.ok(rows.some((r) => r.entity_type === 'user_roles' && r.action === 'insert'));
  assert.ok(rows.some((r) => r.entity_type === 'tenant_memberships' && r.action === 'update'));
  await expectPgError(q(db, T.ownerId, `delete from public.audit_logs where tenant_id = $1`, [T.tenantId]), /permission denied/);
  await expectPgError(db.query(`update public.audit_logs set action = 'tampered'`), 'AUDIT_LOG_IMMUTABLE');
});

test('staff limit from plan is enforced across members + pending invitations', async () => {
  const small = await createTenantWithOwner(db, { email: 'tiny@example.com', slug: 'tiny-salon' });
  // Move tiny salon to the Starter plan (max 5 seats) as the platform would.
  await db.query(`update public.tenant_subscriptions set plan_id = (select id from public.subscription_plans where code = 'starter') where tenant_id = $1`, [small.tenantId]);
  for (let i = 1; i <= 4; i++) {
    await q(db, small.ownerId, `select public.create_invitation($1, $2, '{}', true, '{}')`, [small.tenantId, `seat${i}@example.com`]);
  }
  await expectPgError(
    q(db, small.ownerId, `select public.create_invitation($1, 'seat5@example.com', '{}', true, '{}')`, [small.tenantId]),
    'PLAN_LIMIT_STAFF',
  );
});

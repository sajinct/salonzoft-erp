// Super-admin: creating businesses (existing owner account or owner invitation),
// editing them, and managing their users (add / invite, access, status,
// ownership transfer, revoking invitations).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createTenantWithOwner, createUser, q, expectPgError } from './helpers/db.mjs';

let db, A, admin, support, billing;

const rpc = async (uid, fn, args = []) =>
  (await q(db, uid, `select public.${fn}(${args.map((_, i) => '$' + (i + 1)).join(', ')}) r`, args))[0].r;
const makeAdmin = async (email, role) => {
  const id = await createUser(db, email);
  await db.query(`insert into public.platform_admins (user_id, role) values ($1, $2)`, [id, role]);
  return id;
};
const detail = (tenantId) => rpc(support, 'admin_get_tenant', [tenantId]);
const roleId = (d, code) => d.roles.find((r) => r.code === code).id;

before(async () => {
  db = await createDb();
  A = await createTenantWithOwner(db, { email: 'mgmt-owner-a@example.com', slug: 'mgmt-a', name: 'Salon Mgmt A' });
  admin = await makeAdmin('root@salonzoft.test', 'admin');
  support = await makeAdmin('help@salonzoft.test', 'support');
  billing = await makeAdmin('money@salonzoft.test', 'billing');
});

test('only admin / support may create and edit businesses', async () => {
  const args = ['New Salon', 'new-salon', 'someone@example.com'];
  await expectPgError(rpc(A.ownerId, 'admin_create_tenant', args), 'FORBIDDEN');
  await expectPgError(rpc(billing, 'admin_create_tenant', args), 'FORBIDDEN');
  await expectPgError(rpc(billing, 'admin_update_tenant', [A.tenantId, JSON.stringify({ name: 'X Y' })]), 'FORBIDDEN');
  await expectPgError(rpc(A.ownerId, 'admin_add_member', [A.tenantId, 'x@example.com']), 'FORBIDDEN');
});

test('creating a business for an existing account makes that account the owner', async () => {
  const owner = await createUser(db, 'existing-owner@example.com');
  await expectPgError(rpc(admin, 'admin_create_tenant', ['Glow', 'mgmt-a', 'existing-owner@example.com']), 'TENANT_SLUG_TAKEN');
  await expectPgError(rpc(admin, 'admin_create_tenant', ['Glow', 'admin', 'existing-owner@example.com']), 'SLUG_RESERVED');
  await expectPgError(rpc(admin, 'admin_create_tenant', ['Glow', 'glow', 'not-an-email']), 'INVALID_EMAIL');
  await expectPgError(rpc(admin, 'admin_create_tenant', ['Glow', 'glow', 'existing-owner@example.com', 'spa', 'en', 'nope']), 'PLAN_NOT_FOUND');

  const r = await rpc(admin, 'admin_create_tenant', ['Glow Spa', 'Glow', ' Existing-Owner@example.com ', 'spa', 'ar', 'starter']);
  assert.equal(r.slug, 'glow');
  assert.equal(r.owner_added, true);
  assert.equal(r.invitation, null);

  const ctx = (await q(db, owner, `select public.get_tenant_context($1) c`, [r.tenant_id]))[0].c;
  assert.equal(ctx.membership.is_owner, true);
  assert.equal(ctx.operational, true);
  assert.equal(ctx.subscription.plan_code, 'starter');
  assert.equal(ctx.subscription.status, 'trialing');
  assert.equal(ctx.settings.default_language, 'ar');
  assert.equal(ctx.branches.length, 1);
  assert.ok(ctx.permissions.includes('team.manage'));

  const d = await detail(r.tenant_id);
  assert.equal(d.tenant.business_type, 'spa');
  assert.equal(d.roles.length, 5);
  assert.equal(d.members.length, 1);
  assert.equal(d.members[0].email, 'existing-owner@example.com');
  assert.ok(d.history.some((h) => h.action === 'tenant.created' && h.actor === 'root@salonzoft.test'));
});

test('creating a business for a new e-mail returns an owner invitation', async () => {
  const r = await rpc(support, 'admin_create_tenant', ['Fresh Cuts', 'fresh-cuts', 'new-owner@example.com', 'barbershop']);
  assert.equal(r.owner_added, false);
  assert.match(r.invitation.token, /^[0-9a-f]{64}$/);

  let d = await detail(r.tenant_id);
  assert.equal(d.members.length, 0);
  assert.equal(d.invitations.length, 1);
  assert.equal(d.invitations[0].make_owner, true);

  const stranger = await createUser(db, 'stranger@example.com');
  await expectPgError(rpc(stranger, 'accept_invitation', [r.invitation.token]), 'INVITATION_EMAIL_MISMATCH');

  const owner = await createUser(db, 'new-owner@example.com');
  await rpc(owner, 'accept_invitation', [r.invitation.token]);
  d = await detail(r.tenant_id);
  assert.equal(d.invitations.length, 0);
  assert.equal(d.members.length, 1);
  assert.equal(d.members[0].is_owner, true);
  assert.equal(d.members[0].all_branches, true);
  const mine = await q(db, owner, `select * from public.get_my_tenants()`);
  assert.deepEqual(mine.map((t) => [t.slug, t.is_owner]), [['fresh-cuts', true]]);

  // A second owner cannot be added while one exists.
  await expectPgError(rpc(admin, 'admin_add_member', [r.tenant_id, 'other@example.com', [], true, [], null, true]), 'OWNER_EXISTS');
});

test('editing a business validates the patch', async () => {
  await rpc(support, 'admin_update_tenant', [A.tenantId, JSON.stringify({ name: 'Salon Renamed', name_ar: 'صالون', legal_name: 'Renamed LLC', business_type: 'spa' })]);
  let d = await detail(A.tenantId);
  assert.equal(d.tenant.name, 'Salon Renamed');
  assert.equal(d.tenant.name_ar, 'صالون');
  assert.equal(d.tenant.legal_name, 'Renamed LLC');
  assert.equal(d.tenant.slug, 'mgmt-a');

  await rpc(support, 'admin_update_tenant', [A.tenantId, JSON.stringify({ slug: 'mgmt-renamed', name_ar: '' })]);
  d = await detail(A.tenantId);
  assert.equal(d.tenant.slug, 'mgmt-renamed');
  assert.equal(d.tenant.name_ar, null);
  assert.equal(d.tenant.name, 'Salon Renamed');

  const patch = (p) => rpc(support, 'admin_update_tenant', [A.tenantId, JSON.stringify(p)]);
  await expectPgError(patch({ slug: 'glow' }), 'TENANT_SLUG_TAKEN');
  await expectPgError(patch({ slug: 'Bad Slug' }), 'INVALID_SLUG');
  await expectPgError(patch({ name: 'x' }), 'INVALID_NAME');
  await expectPgError(patch({ business_type: 'bakery' }), 'INVALID_BUSINESS_TYPE');
  await expectPgError(patch({ status: 'closed' }), 'INVALID_VALUE');
  await expectPgError(rpc(support, 'admin_update_tenant', ['00000000-0000-0000-0000-000000000000', '{}']), 'NOT_FOUND');
});

test('adding users: direct for existing accounts, invitation otherwise', async () => {
  const d0 = await detail(A.tenantId);
  const cashier = roleId(d0, 'cashier');
  const manager = roleId(d0, 'manager');
  const otherRole = roleId(await detail((await rpc(admin, 'admin_list_tenants', ['glow', 'all', 5, 0])).rows[0].id), 'cashier');

  await expectPgError(rpc(support, 'admin_add_member', [A.tenantId, 'staff1@example.com', [otherRole], true, []]), 'INVALID_ROLE');
  await expectPgError(rpc(support, 'admin_add_member', [A.tenantId, 'staff1@example.com', [cashier], false, []]), 'BRANCH_REQUIRED');
  await expectPgError(rpc(support, 'admin_add_member', [A.tenantId, 'mgmt-owner-a@example.com', [cashier], true, []]), 'MEMBER_ALREADY_EXISTS');
  await expectPgError(rpc(support, 'admin_add_member', [A.tenantId, 'staff1@example.com', [], true, [], null, true]), 'FORBIDDEN');

  // Existing account → membership straight away.
  const staff1 = await createUser(db, 'staff1@example.com');
  const added = await rpc(support, 'admin_add_member', [A.tenantId, 'staff1@example.com', [cashier], false, [A.branchId], 'Front desk']);
  assert.equal(added.added, true);
  let ctx = (await q(db, staff1, `select public.get_tenant_context($1) c`, [A.tenantId]))[0].c;
  assert.deepEqual(ctx.roles.map((r) => r.code), ['cashier']);
  assert.equal(ctx.membership.job_title, 'Front desk');
  assert.equal(ctx.branches.length, 1);

  // No account → invitation, accepted later with the chosen access.
  const invited = await rpc(support, 'admin_add_member', [A.tenantId, 'staff2@example.com', [manager], true, []]);
  assert.equal(invited.added, false);
  assert.equal((await detail(A.tenantId)).invitations[0].email, 'staff2@example.com');
  const staff2 = await createUser(db, 'staff2@example.com');
  await rpc(staff2, 'accept_invitation', [invited.invitation.token]);
  ctx = (await q(db, staff2, `select public.get_tenant_context($1) c`, [A.tenantId]))[0].c;
  assert.deepEqual(ctx.roles.map((r) => r.code), ['manager']);
  assert.equal(ctx.membership.is_owner, false);
  assert.equal(ctx.membership.all_branches, true);

  // Revoking an invitation kills the link.
  const inv3 = await rpc(support, 'admin_add_member', [A.tenantId, 'staff3@example.com', [cashier], true, []]);
  await rpc(support, 'admin_revoke_invitation', [inv3.invitation.invitation_id]);
  await expectPgError(rpc(support, 'admin_revoke_invitation', [inv3.invitation.invitation_id]), 'NOT_FOUND');
  const staff3 = await createUser(db, 'staff3@example.com');
  await expectPgError(rpc(staff3, 'accept_invitation', [inv3.invitation.token]), 'INVITATION_INVALID');
});

test('changing access and status; the owner is protected', async () => {
  let d = await detail(A.tenantId);
  const owner = d.members.find((m) => m.is_owner);
  const staff1 = d.members.find((m) => m.email === 'staff1@example.com');
  const manager = roleId(d, 'manager');

  await expectPgError(rpc(support, 'admin_update_member', [owner.membership_id, [manager], true, [], null]), 'OWNER_IMMUTABLE');
  await expectPgError(rpc(support, 'admin_set_member_status', [owner.membership_id, 'suspended']), 'OWNER_IMMUTABLE');
  await expectPgError(rpc(A.ownerId, 'admin_update_member', [staff1.membership_id, [manager], true, [], null]), 'FORBIDDEN');

  await rpc(support, 'admin_update_member', [staff1.membership_id, [manager], true, [], 'Branch manager']);
  d = await detail(A.tenantId);
  const s1 = d.members.find((m) => m.email === 'staff1@example.com');
  assert.deepEqual(s1.role_ids, [manager]);
  assert.equal(s1.all_branches, true);
  assert.deepEqual(s1.branch_ids, []);
  assert.equal(s1.job_title, 'Branch manager');

  await rpc(support, 'admin_set_member_status', [staff1.membership_id, 'suspended']);
  assert.equal((await q(db, staff1.user_id, `select * from public.get_my_tenants()`)).length, 0);
  await expectPgError(rpc(admin, 'admin_transfer_ownership', [A.tenantId, staff1.membership_id]), 'MEMBER_NOT_ACTIVE');
  await rpc(support, 'admin_set_member_status', [staff1.membership_id, 'active']);
  assert.equal((await q(db, staff1.user_id, `select * from public.get_my_tenants()`)).length, 1);
  await expectPgError(rpc(support, 'admin_set_member_status', [staff1.membership_id, 'deleted']), 'INVALID_STATUS');
});

test('ownership transfer is admin-only and keeps the old owner as a manager', async () => {
  let d = await detail(A.tenantId);
  const staff1 = d.members.find((m) => m.email === 'staff1@example.com');
  await expectPgError(rpc(support, 'admin_transfer_ownership', [A.tenantId, staff1.membership_id]), 'FORBIDDEN');

  await rpc(admin, 'admin_transfer_ownership', [A.tenantId, staff1.membership_id]);
  d = await detail(A.tenantId);
  assert.deepEqual(d.members.filter((m) => m.is_owner).map((m) => m.email), ['staff1@example.com']);
  const old = d.members.find((m) => m.email === 'mgmt-owner-a@example.com');
  assert.equal(old.is_owner, false);
  assert.equal(old.all_branches, true);
  assert.deepEqual(old.role_ids, [roleId(d, 'manager')]);

  const ctx = (await q(db, A.ownerId, `select public.get_tenant_context($1) c`, [A.tenantId]))[0].c;
  assert.ok(!ctx.permissions.includes('billing.manage'));
  assert.ok(d.history.some((h) => h.action === 'tenant.ownership' && h.data.to === 'staff1@example.com'));
});

test('seat limits apply to admin-added users', async () => {
  const d = await detail(A.tenantId);
  await db.query(`update public.subscription_plans set max_staff = $1 where code = 'professional'`, [d.members.length]);
  await expectPgError(rpc(support, 'admin_add_member', [A.tenantId, 'overflow@example.com', [], true, []]), 'PLAN_LIMIT_STAFF');
});

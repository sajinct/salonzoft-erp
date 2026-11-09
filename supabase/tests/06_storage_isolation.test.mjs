// Mandatory scenario: storage isolation is enforced.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createTenantWithOwner, q, addMember, expectPgError } from './helpers/db.mjs';

let db, A, B, staffA, branchA2;

const put = (uid, name) =>
  q(db, uid, `insert into storage.objects (bucket_id, name, owner) values ('tenant-assets', $1, $2) returning name`, [name, uid]);

before(async () => {
  db = await createDb();
  A = await createTenantWithOwner(db, { email: 'sa@example.com', slug: 'store-a' });
  B = await createTenantWithOwner(db, { email: 'sb@example.com', slug: 'store-b' });
  [branchA2] = await q(db, A.ownerId, `insert into public.branches (tenant_id, code, name_en) values ($1, 'B2', 'Two') returning id`, [A.tenantId]);
  staffA = await addMember(db, { tenantId: A.tenantId, inviterId: A.ownerId, email: 'staff-store@example.com', roleCodes: ['receptionist'], branchIds: [A.branchId] });
  await put(A.ownerId, `tenants/${A.tenantId}/branding/logo.png`);
  await put(A.ownerId, `tenants/${A.tenantId}/branches/${branchA2.id}/photos/front.jpg`);
  await put(B.ownerId, `tenants/${B.tenantId}/branding/logo.png`);
});

test('bucket is private with a size limit and no SVG', async () => {
  const [b] = (await db.query(`select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'tenant-assets'`)).rows;
  assert.equal(b.public, false);
  assert.equal(Number(b.file_size_limit), 5242880);
  assert.ok(!b.allowed_mime_types.includes('image/svg+xml'));
});

test('tenant A cannot list, read, write or delete tenant B objects', async () => {
  const listed = await q(db, A.ownerId, `select name from storage.objects`);
  assert.ok(listed.every((o) => o.name.startsWith(`tenants/${A.tenantId}/`)));
  await expectPgError(put(A.ownerId, `tenants/${B.tenantId}/branding/evil.png`), /row-level security/);
  const del = await q(db, A.ownerId, `delete from storage.objects where name like $1 returning name`, [`tenants/${B.tenantId}/%`]);
  assert.equal(del.length, 0);
  const upd = await q(db, A.ownerId, `update storage.objects set name = $1 where name like $2 returning name`, [`tenants/${A.tenantId}/stolen.png`, `tenants/${B.tenantId}/%`]);
  assert.equal(upd.length, 0);
});

test('malformed or traversal paths are denied', async () => {
  await expectPgError(put(A.ownerId, `logo.png`), /row-level security/);
  await expectPgError(put(A.ownerId, `tenants/not-a-uuid/logo.png`), /row-level security/);
  await expectPgError(put(A.ownerId, `tenants/${A.tenantId}/../${B.tenantId}/x.png`), /row-level security/);
});

test('staff can read tenant-wide files but not branches they lack, and cannot upload without settings.manage', async () => {
  const names = (await q(db, staffA.userId, `select name from storage.objects`)).map((o) => o.name);
  assert.ok(names.includes(`tenants/${A.tenantId}/branding/logo.png`));
  assert.ok(!names.some((n) => n.includes(branchA2.id)), 'unassigned branch file leaked');
  await expectPgError(put(staffA.userId, `tenants/${A.tenantId}/branding/new.png`), /row-level security/);
});

test('a branch path must belong to the tenant in the same path', async () => {
  await expectPgError(put(A.ownerId, `tenants/${A.tenantId}/branches/${B.branchId}/x.png`), /row-level security/);
});

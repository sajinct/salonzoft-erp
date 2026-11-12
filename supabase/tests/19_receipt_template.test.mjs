// Receipt / invoice print template: per-salon settings, editable only with
// settings.manage, validated by the table constraints, visible in the context.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createTenantWithOwner, addMember, q } from './helpers/db.mjs';

let db, A, B, cashier;

before(async () => {
  db = await createDb();
  A = await createTenantWithOwner(db, { email: 'rcpt-owner-a@example.com', slug: 'rcpt-a' });
  B = await createTenantWithOwner(db, { email: 'rcpt-owner-b@example.com', slug: 'rcpt-b' });
  cashier = await addMember(db, { tenantId: A.tenantId, inviterId: A.ownerId, email: 'rcpt-cashier@example.com', roleCodes: ['cashier'], allBranches: true });
});

const update = (uid, tenantId, set, params = []) =>
  q(db, uid, `update public.tenant_settings set ${set} where tenant_id = $1 returning tenant_id`, [tenantId, ...params]);

test('defaults: A4, both languages, logo on, no auto print', async () => {
  const [s] = await q(db, A.ownerId, `select * from public.tenant_settings where tenant_id = $1`, [A.tenantId]);
  assert.equal(s.receipt_paper, 'a4');
  assert.equal(s.receipt_language, 'both');
  assert.equal(s.receipt_show_logo, true);
  assert.equal(s.receipt_auto_print, false);
  assert.equal(s.receipt_header_en, null);
});

test('the owner sets the template and every member gets it in the context', async () => {
  const rows = await update(A.ownerId, A.tenantId,
    `receipt_paper = '80mm', receipt_language = 'ar', receipt_header_en = $2, receipt_header_ar = $3, receipt_show_logo = false, receipt_auto_print = true`,
    ['CR 1234567\nTel 2400 0000', 'س.ت 1234567']);
  assert.equal(rows.length, 1);
  const [{ c }] = await q(db, cashier.userId, `select public.get_tenant_context($1) c`, [A.tenantId]);
  assert.equal(c.settings.receipt_paper, '80mm');
  assert.equal(c.settings.receipt_language, 'ar');
  assert.equal(c.settings.receipt_header_en, 'CR 1234567\nTel 2400 0000');
  assert.equal(c.settings.receipt_auto_print, true);
});

test('members without settings.manage and other salons cannot change it', async () => {
  assert.equal((await update(cashier.userId, A.tenantId, `receipt_paper = '58mm'`)).length, 0);
  assert.equal((await update(B.ownerId, A.tenantId, `receipt_paper = '58mm'`)).length, 0);
  const [s] = await q(db, A.ownerId, `select receipt_paper from public.tenant_settings where tenant_id = $1`, [A.tenantId]);
  assert.equal(s.receipt_paper, '80mm');
});

test('paper, language and header length are validated', async () => {
  await assert.rejects(update(A.ownerId, A.tenantId, `receipt_paper = 'letter'`), /check constraint/);
  await assert.rejects(update(A.ownerId, A.tenantId, `receipt_language = 'fr'`), /check constraint/);
  await assert.rejects(update(A.ownerId, A.tenantId, `receipt_header_en = $2`, ['x'.repeat(501)]), /check constraint/);
});

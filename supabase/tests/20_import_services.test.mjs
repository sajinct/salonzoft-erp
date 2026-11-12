// Service catalogue import: add / update by code or name, categories created on
// the fly, per-row errors, dry run saves nothing, services.manage only.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createTenantWithOwner, addMember, q, expectPgError } from './helpers/db.mjs';

let db, A, B, cashier;

const imp = async (uid, tenantId, rows, dry = false) =>
  (await q(db, uid, `select public.import_services($1, $2, $3) r`, [tenantId, JSON.stringify(rows), dry]))[0].r;
const services = (tenantId) =>
  db.query(`select s.*, c.name_en category from public.services s left join public.service_categories c on c.id = s.category_id
            where s.tenant_id = $1 order by s.name_en`, [tenantId]).then((r) => r.rows);

before(async () => {
  db = await createDb();
  A = await createTenantWithOwner(db, { email: 'imp-owner-a@example.com', slug: 'imp-a' });
  B = await createTenantWithOwner(db, { email: 'imp-owner-b@example.com', slug: 'imp-b' });
  cashier = await addMember(db, { tenantId: A.tenantId, inviterId: A.ownerId, email: 'imp-cashier@example.com', roleCodes: ['cashier'], allBranches: true });
});

const FILE = [
  { code: 'hc-01', name_en: 'Haircut', name_ar: 'قص شعر', category: 'Hair', category_ar: 'الشعر', duration_minutes: '45', price: '5.500', price_type: 'Fixed', online_bookable: 'yes' },
  { name_en: 'Blow dry', category: 'hair', duration_minutes: 30, price: 4, is_active: 'no' },
  { name_en: 'Manicure', category: 'Nails', price: '1,250.5', audience: 'female', vat_category: 'zero' },
];

test('only services.manage may import, and only into its own salon', async () => {
  await expectPgError(imp(cashier.userId, A.tenantId, FILE), 'FORBIDDEN');
  await expectPgError(imp(B.ownerId, A.tenantId, FILE), 'FORBIDDEN');
  await expectPgError(imp(A.ownerId, A.tenantId, { not: 'an array' }), 'INVALID_IMPORT');
});

test('a dry run validates and saves nothing', async () => {
  const r = await imp(A.ownerId, A.tenantId, FILE, true);
  assert.deepEqual([r.dry_run, r.total, r.inserted, r.updated, r.categories_created, r.errors.length], [true, 3, 3, 0, 2, 0]);
  assert.equal((await services(A.tenantId)).length, 0);
  assert.equal((await db.query(`select 1 from public.service_categories where tenant_id = $1`, [A.tenantId])).rows.length, 0);
});

test('import adds services and creates the categories once', async () => {
  const r = await imp(A.ownerId, A.tenantId, FILE);
  assert.deepEqual([r.inserted, r.updated, r.categories_created, r.errors.length], [3, 0, 2, 0]);
  const [blow, cut, mani] = await services(A.tenantId);
  assert.deepEqual([cut.code, cut.name_ar, cut.category, cut.duration_minutes, Number(cut.price), cut.price_type, cut.online_bookable],
    ['HC-01', 'قص شعر', 'Hair', 45, 5.5, 'fixed', true]);
  assert.deepEqual([blow.category, blow.is_active, Number(blow.price), blow.duration_minutes], ['Hair', false, 4, 30]);
  assert.deepEqual([mani.category, Number(mani.price), mani.audience, mani.vat_category, mani.duration_minutes], ['Nails', 1250.5, 'female', 'zero', 30]);
  const cats = (await db.query(`select name_en, name_ar from public.service_categories where tenant_id = $1 order by name_en`, [A.tenantId])).rows;
  assert.deepEqual(cats, [{ name_en: 'Hair', name_ar: 'الشعر' }, { name_en: 'Nails', name_ar: null }]);
  assert.equal((await services(B.tenantId)).length, 0);
});

test('re-importing updates by code or name and keeps values that are left empty', async () => {
  const r = await imp(A.ownerId, A.tenantId, [
    { code: 'HC-01', name_en: 'Haircut & wash', price: '6' },          // by code: renamed, new price
    { name_en: 'blow DRY', is_active: 'yes', code: 'BD-01' },           // by name: reactivated, gets a code
    { name_en: 'Pedicure', category: 'Nails' },                         // new
  ]);
  assert.deepEqual([r.inserted, r.updated, r.categories_created, r.errors.length], [1, 2, 0, 0]);
  const all = await services(A.tenantId);
  assert.equal(all.length, 4);
  const cut = all.find((s) => s.code === 'HC-01');
  assert.deepEqual([cut.name_en, cut.name_ar, Number(cut.price), cut.duration_minutes, cut.category], ['Haircut & wash', 'قص شعر', 6, 45, 'Hair']);
  const blow = all.find((s) => s.code === 'BD-01');
  assert.deepEqual([blow.is_active, Number(blow.price)], [true, 4]);
});

test('bad rows are reported by line and the rest still imports', async () => {
  const r = await imp(A.ownerId, A.tenantId, [
    { name_en: '' },
    { name_en: 'Facial', price: 'ten' },
    { name_en: 'Facial', duration_minutes: 2 },
    { name_en: 'Facial', online_bookable: 'maybe' },
    { name_en: 'Facial', price_type: 'free' },
    { name_en: 'Massage', price: 20 },
    { name_en: 'massage', price: 25 },
    { name_en: 'Waxing', code: 'bad code!' },
  ]);
  assert.equal(r.inserted, 1);
  assert.deepEqual(r.errors.map((e) => [e.row, e.code]), [
    [1, 'NAME_REQUIRED'], [2, 'INVALID_VALUE'], [3, 'INVALID_VALUE'], [4, 'INVALID_VALUE'], [5, 'INVALID_VALUE'],
    [7, 'DUPLICATE_IN_FILE'], [8, 'INVALID_VALUE'],
  ]);
  const all = await services(A.tenantId);
  assert.ok(all.some((s) => s.name_en === 'Massage' && Number(s.price) === 20));
  assert.ok(!all.some((s) => s.name_en === 'Facial'));
});

test('at most 1000 rows', async () => {
  const many = Array.from({ length: 1001 }, (_, i) => ({ name_en: `S${i}` }));
  await expectPgError(imp(A.ownerId, A.tenantId, many), 'IMPORT_TOO_LARGE');
});

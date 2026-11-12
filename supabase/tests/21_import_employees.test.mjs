// Employee import: add / update by code or name, branches and services by code
// or name, per-row errors, dry run saves nothing, plan limit, employees.manage.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createTenantWithOwner, addMember, q, expectPgError } from './helpers/db.mjs';

let db, A, B, cashier, branch2;

const imp = async (uid, tenantId, rows, dry = false) =>
  (await q(db, uid, `select public.import_employees($1, $2, $3) r`, [tenantId, JSON.stringify(rows), dry]))[0].r;
const employees = (tenantId) =>
  db.query(
    `select e.*, to_char(e.hired_on, 'YYYY-MM-DD') hired,
            array(select b.code from public.employee_branches eb join public.branches b on b.id = eb.branch_id where eb.employee_id = e.id order by b.code) branches,
            array(select s.name_en from public.employee_services es join public.services s on s.id = es.service_id where es.employee_id = e.id order by s.name_en) services
     from public.employees e where e.tenant_id = $1 order by e.name_en`, [tenantId]).then((r) => r.rows);

before(async () => {
  db = await createDb();
  A = await createTenantWithOwner(db, { email: 'emp-owner-a@example.com', slug: 'emp-a' });
  B = await createTenantWithOwner(db, { email: 'emp-owner-b@example.com', slug: 'emp-b' });
  cashier = await addMember(db, { tenantId: A.tenantId, inviterId: A.ownerId, email: 'emp-cashier@example.com', roleCodes: ['cashier'], allBranches: true });
  await q(db, A.ownerId, `select public.import_services($1, $2)`, [A.tenantId, JSON.stringify([
    { code: 'HC-01', name_en: 'Haircut' }, { name_en: 'Blow dry' }, { name_en: 'Manicure' }, { name_en: 'Old service', is_active: 'no' },
  ])]);
});

const FILE = [
  { code: 'e-01', name_en: 'Fatma Al Harthy', name_ar: 'فاطمة', job_title: 'Senior stylist', phone: '+968 9000-0001', email: 'Fatma@Example.com', gender: 'F', hired_on: '2024-01-15T00:00:00.000Z', services: 'hc-01; blow dry' },
  { name_en: 'Maryam', gender: 'female', is_bookable: 'no', hired_on: '03/02/2023', services: 'all' },
  { name_en: 'Salim', is_active: 'no', phone: "'+968 9000 0003" },
];

test('only employees.manage may import, and only into its own salon', async () => {
  await expectPgError(imp(cashier.userId, A.tenantId, FILE), 'FORBIDDEN');
  await expectPgError(imp(B.ownerId, A.tenantId, FILE), 'FORBIDDEN');
});

test('a dry run validates and saves nothing', async () => {
  const r = await imp(A.ownerId, A.tenantId, FILE, true);
  assert.deepEqual([r.dry_run, r.total, r.inserted, r.updated, r.errors.length], [true, 3, 3, 0, 0]);
  assert.equal((await employees(A.tenantId)).length, 0);
});

test('import adds employees with their services; a single-branch salon assigns its branch', async () => {
  const r = await imp(A.ownerId, A.tenantId, FILE);
  assert.deepEqual([r.inserted, r.updated, r.errors.length], [3, 0, 0]);
  const [fatma, maryam, salim] = await employees(A.tenantId);
  assert.deepEqual([fatma.code, fatma.name_ar, fatma.job_title, fatma.phone, fatma.email, fatma.gender, fatma.hired],
    ['E-01', 'فاطمة', 'Senior stylist', '+96890000001', 'fatma@example.com', 'female', '2024-01-15']);
  assert.deepEqual(fatma.services, ['Blow dry', 'Haircut']);
  assert.deepEqual(fatma.branches, ['MAIN']);
  assert.deepEqual([maryam.is_bookable, maryam.hired, maryam.services], [false, '2023-02-03', ['Blow dry', 'Haircut', 'Manicure']]);
  assert.deepEqual([salim.is_active, salim.services, salim.branches, salim.phone], [false, [], ['MAIN'], '+96890000003']);
  assert.equal((await employees(B.tenantId)).length, 0);
});

test('re-importing updates by code or name; branches and services are replaced only when given', async () => {
  [{ id: branch2 }] = await q(db, A.ownerId,
    `insert into public.branches (tenant_id, code, name_en) values ($1, 'B2', 'Second branch') returning id`, [A.tenantId]);
  const r = await imp(A.ownerId, A.tenantId, [
    { code: 'E-01', name_en: 'Fatma Al Harthy', job_title: 'Manager', branches: 'b2; main', services: 'Manicure' },
    { name_en: 'MARYAM', code: 'E-02', branches: 'Second branch' },
    { name_en: 'Salim', is_active: 'yes' },
    { name_en: 'Noor' },
  ]);
  assert.deepEqual([r.inserted, r.updated, r.errors.length], [1, 3, 0]);
  const all = await employees(A.tenantId);
  const by = (name) => all.find((e) => e.name_en === name);
  assert.deepEqual([by('Fatma Al Harthy').job_title, by('Fatma Al Harthy').name_ar, by('Fatma Al Harthy').branches, by('Fatma Al Harthy').services],
    ['Manager', 'فاطمة', ['B2', 'MAIN'], ['Manicure']]);
  assert.deepEqual([by('MARYAM').code, by('MARYAM').branches, by('MARYAM').services.length], ['E-02', ['B2'], 3]);
  assert.deepEqual([by('Salim').is_active, by('Salim').branches], [true, ['MAIN']]);
  assert.deepEqual(by('Noor').branches, [], 'with several branches a new employee gets none unless the file says so');
});

test('bad rows are reported by line and the rest still imports', async () => {
  const r = await imp(A.ownerId, A.tenantId, [
    { name_en: '' },
    { name_en: 'Huda', branches: 'Nowhere' },
    { name_en: 'Huda', services: 'Haircut; Teleport' },
    { name_en: 'Huda', hired_on: '2024-02-31' },
    { name_en: 'Huda', hired_on: 'last year' },
    { name_en: 'Huda', gender: 'other' },
    { name_en: 'Huda', phone: 'call me' },
    { name_en: 'Huda', email: 'not-an-email' },
    { name_en: 'Huda', job_title: 'Therapist' },
    { name_en: 'huda' },
  ]);
  assert.equal(r.inserted, 1);
  assert.deepEqual(r.errors.map((e) => [e.row, e.code]), [
    [1, 'NAME_REQUIRED'], [2, 'INVALID_BRANCH'], [3, 'INVALID_SERVICE'], [4, 'INVALID_DATE'], [5, 'INVALID_DATE'],
    [6, 'INVALID_VALUE'], [7, 'INVALID_VALUE'], [8, 'INVALID_VALUE'], [10, 'DUPLICATE_IN_FILE'],
  ]);
  assert.equal((await employees(A.tenantId)).filter((e) => e.name_en === 'Huda').length, 1);
});

test('a branch-limited manager cannot assign branches they cannot access', async () => {
  const manager = await addMember(db, { tenantId: A.tenantId, inviterId: A.ownerId, email: 'emp-manager@example.com', roleCodes: ['manager'], branchIds: [A.branchId] });
  const r = await imp(manager.userId, A.tenantId, [{ name_en: 'Zainab', branches: 'B2' }, { name_en: 'Zahra', branches: 'MAIN' }]);
  // Row-level security hides the other branch from this manager, so it is simply unknown to them.
  assert.deepEqual(r.errors.map((e) => [e.row, e.code]), [[1, 'INVALID_BRANCH']]);
  assert.equal(r.inserted, 1);
});

test('the plan employee limit applies to imported rows', async () => {
  const active = (await employees(A.tenantId)).filter((e) => e.is_active).length;
  await db.query(`update public.subscription_plans set max_staff = $1 where code = 'professional'`, [active + 1]);
  const r = await imp(A.ownerId, A.tenantId, [{ name_en: 'Extra One' }, { name_en: 'Extra Two' }]);
  assert.equal(r.inserted, 1);
  assert.deepEqual(r.errors.map((e) => [e.row, e.code]), [[2, 'PLAN_LIMIT_EMPLOYEES']]);
});

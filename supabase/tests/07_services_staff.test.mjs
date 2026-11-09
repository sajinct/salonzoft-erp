// Phase 2 · services, resources, employees, shifts, leave and special periods:
// tenant isolation, permission gating, branch scope and validation rules.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createTenantWithOwner, q, expectPgError, addMember } from './helpers/db.mjs';

let db, A, B, branch2, manager, receptionist, stylist, catA, svcA, empA;

before(async () => {
  db = await createDb();
  A = await createTenantWithOwner(db, { email: 'svc-owner-a@example.com', slug: 'svc-salon-a' });
  B = await createTenantWithOwner(db, { email: 'svc-owner-b@example.com', slug: 'svc-salon-b' });
  [branch2] = await q(db, A.ownerId, `insert into public.branches (tenant_id, code, name_en) values ($1, 'SEEB', 'Seeb') returning id`, [A.tenantId]);
  // Manager is restricted to the main branch; receptionist to branch 2.
  manager = await addMember(db, { tenantId: A.tenantId, inviterId: A.ownerId, email: 'svc-manager@example.com', roleCodes: ['manager'], branchIds: [A.branchId] });
  receptionist = await addMember(db, { tenantId: A.tenantId, inviterId: A.ownerId, email: 'svc-reception@example.com', roleCodes: ['receptionist'], branchIds: [branch2.id] });
  stylist = await addMember(db, { tenantId: A.tenantId, inviterId: A.ownerId, email: 'svc-stylist@example.com', roleCodes: ['stylist'], branchIds: [A.branchId] });

  [catA] = await q(db, A.ownerId, `insert into public.service_categories (tenant_id, name_en, name_ar) values ($1, 'Hair', 'الشعر') returning id`, [A.tenantId]);
  [svcA] = await q(db, A.ownerId,
    `insert into public.services (tenant_id, category_id, name_en, duration_minutes, price) values ($1, $2, 'Haircut', 45, 12.5) returning id`,
    [A.tenantId, catA.id]);
  [empA] = await q(db, A.ownerId, `insert into public.employees (tenant_id, name_en) values ($1, 'Reena') returning id`, [A.tenantId]);
  await q(db, A.ownerId, `select public.set_employee_assignments($1, $2, $3)`, [empA.id, [A.branchId, branch2.id], [svcA.id]]);
});

const newTables = [
  'service_categories', 'services', 'service_prices', 'resources', 'employees', 'employee_branches',
  'employee_services', 'staff_shifts', 'staff_leaves', 'branch_special_periods', 'branch_special_hours',
];

test('tenant B sees none of tenant A services, staff or schedules', async () => {
  await q(db, A.ownerId, `select public.set_employee_shifts($1, $2)`, [empA.id, JSON.stringify([{ branch_id: A.branchId, day_of_week: 1, starts_at: '09:00', ends_at: '13:00' }])]);
  await q(db, A.ownerId, `insert into public.staff_leaves (tenant_id, employee_id, starts_at, ends_at) values ($1, $2, now(), now() + interval '1 day')`, [A.tenantId, empA.id]);
  await q(db, A.ownerId, `select public.save_branch_special_period($1, null, 'closed', 'National Day', null, '2026-11-18', '2026-11-19')`, [A.branchId]);
  for (const table of newTables) {
    const rows = await q(db, B.ownerId, `select tenant_id from public.${table}`);
    for (const r of rows) assert.equal(r.tenant_id, B.tenantId, `${table} leaked a row of tenant A`);
    const own = await q(db, A.ownerId, `select count(*)::int as n from public.${table} where tenant_id = $1`, [A.tenantId]);
    if (!['service_prices', 'resources', 'branch_special_hours'].includes(table)) assert.ok(own[0].n > 0, `${table} should have rows for A`);
  }
});

test('tenant B cannot write into tenant A, even with ids of A', async () => {
  await expectPgError(
    q(db, B.ownerId, `insert into public.services (tenant_id, name_en) values ($1, 'Hack')`, [A.tenantId]),
    /row-level security/,
  );
  // Pointing a B service at A's category fails the composite foreign key.
  await expectPgError(
    q(db, B.ownerId, `insert into public.services (tenant_id, category_id, name_en) values ($1, $2, 'Cross')`, [B.tenantId, catA.id]),
    /foreign key/,
  );
  const upd = await q(db, B.ownerId, `update public.services set price = 0 where id = $1 returning id`, [svcA.id]);
  assert.equal(upd.length, 0);
  await expectPgError(q(db, B.ownerId, `select public.set_employee_assignments($1, $2, $3)`, [empA.id, [], []]), 'NOT_FOUND');
  await expectPgError(q(db, B.ownerId, `select public.set_service_branch_prices($1, '[]')`, [svcA.id]), 'NOT_FOUND');
});

test('who can read and manage services', async () => {
  // The stylist (services.view) and receptionist can read; only services.manage can write.
  assert.equal((await q(db, stylist.userId, `select id from public.services`)).length, 1);
  assert.equal((await q(db, receptionist.userId, `select id from public.services`)).length, 1);
  await expectPgError(
    q(db, receptionist.userId, `insert into public.services (tenant_id, name_en) values ($1, 'Nails')`, [A.tenantId]),
    /row-level security/,
  );
  const upd = await q(db, stylist.userId, `update public.services set price = 1 where id = $1 returning id`, [svcA.id]);
  assert.equal(upd.length, 0);
  // Services are never deleted (invoices will reference them) — deactivate instead.
  await expectPgError(q(db, A.ownerId, `delete from public.services where id = $1`, [svcA.id]), /permission denied/);
});

test('service validation: duration, price, code and VAT category', async () => {
  for (const [sql, msg] of [
    [`insert into public.services (tenant_id, name_en, duration_minutes) values ($1, 'Too short', 2)`, /check constraint/],
    [`insert into public.services (tenant_id, name_en, price) values ($1, 'Negative', -1)`, /check constraint/],
    [`insert into public.services (tenant_id, name_en, code) values ($1, 'Bad code', 'lower case')`, /check constraint/],
    [`insert into public.services (tenant_id, name_en, vat_category) values ($1, 'VAT', 'reduced')`, /check constraint/],
  ]) {
    await expectPgError(q(db, A.ownerId, sql, [A.tenantId]), msg);
  }
  await expectPgError(
    q(db, A.ownerId, `insert into public.service_categories (tenant_id, name_en) values ($1, ' hair ')`, [A.tenantId]),
    /duplicate key/,
  );
});

test('branch prices: replaced atomically, only for accessible branches', async () => {
  const rows = await q(db, A.ownerId, `select * from public.set_service_branch_prices($1, $2)`, [
    svcA.id,
    JSON.stringify([{ branch_id: A.branchId, price: 15 }, { branch_id: branch2.id, price: null, is_available: false }]),
  ]);
  assert.equal(rows.length, 2);
  // The manager (main branch only) cannot set a price for branch 2 — to them
  // that branch doesn't exist (RLS hides it), so it is reported as unknown.
  await expectPgError(
    q(db, manager.userId, `select public.set_service_branch_prices($1, $2)`, [svcA.id, JSON.stringify([{ branch_id: branch2.id, price: 1 }])]),
    'INVALID_BRANCH',
  );
  // …and replacing the main-branch prices leaves branch 2's override untouched.
  await q(db, manager.userId, `select public.set_service_branch_prices($1, '[]')`, [svcA.id]);
  const left = await q(db, A.ownerId, `select branch_id from public.service_prices where service_id = $1`, [svcA.id]);
  assert.deepEqual(left.map((r) => r.branch_id), [branch2.id]);
  await expectPgError(
    q(db, A.ownerId, `select public.set_service_branch_prices($1, $2)`, [svcA.id, JSON.stringify([{ branch_id: B.branchId, price: 1 }])]),
    'INVALID_BRANCH',
  );
  await expectPgError(
    q(db, A.ownerId, `select public.set_service_branch_prices($1, $2)`, [svcA.id, JSON.stringify([{ branch_id: A.branchId, price: 'abc' }])]),
    'INVALID_PRICE',
  );
});

test('resources are branch-scoped', async () => {
  await q(db, A.ownerId, `insert into public.resources (tenant_id, branch_id, name_en, kind) values ($1, $2, 'Room 1', 'room'), ($1, $3, 'Room 2', 'room')`,
    [A.tenantId, A.branchId, branch2.id]);
  const rec = await q(db, receptionist.userId, `select branch_id from public.resources`);
  assert.deepEqual(rec.map((r) => r.branch_id), [branch2.id]);
  await expectPgError(
    q(db, manager.userId, `insert into public.resources (tenant_id, branch_id, name_en) values ($1, $2, 'Spa bed')`, [A.tenantId, branch2.id]),
    /row-level security/,
  );
});

test('employees: readers, own record and managers', async () => {
  const [linked] = await q(db, A.ownerId,
    `insert into public.employees (tenant_id, membership_id, name_en) values ($1, $2, 'Stylist Self') returning id`,
    [A.tenantId, stylist.membershipId]);
  // The stylist has no employees.view but sees their own employee record.
  const own = await q(db, stylist.userId, `select id from public.employees`);
  assert.deepEqual(own.map((r) => r.id), [linked.id]);
  // The receptionist (employees.view) sees all employees.
  assert.equal((await q(db, receptionist.userId, `select id from public.employees`)).length, 2);
  // Only employees.manage can write.
  const upd = await q(db, receptionist.userId, `update public.employees set name_en = 'X' where id = $1 returning id`, [empA.id]);
  assert.equal(upd.length, 0);
  await expectPgError(q(db, A.ownerId, `delete from public.employees where id = $1`, [empA.id]), /permission denied/);
  // A membership can be linked to at most one employee, and only within the tenant.
  await expectPgError(
    q(db, A.ownerId, `insert into public.employees (tenant_id, membership_id, name_en) values ($1, $2, 'Twin')`, [A.tenantId, stylist.membershipId]),
    /duplicate key/,
  );
  const [bMember] = await q(db, B.ownerId, `select id from public.tenant_memberships where tenant_id = $1`, [B.tenantId]);
  await expectPgError(
    q(db, A.ownerId, `insert into public.employees (tenant_id, membership_id, name_en) values ($1, $2, 'Foreign')`, [A.tenantId, bMember.id]),
    /foreign key/,
  );
});

test('employee assignments respect branch access and tenant services', async () => {
  await expectPgError(
    q(db, manager.userId, `select public.set_employee_assignments($1, $2, $3)`, [empA.id, [A.branchId, branch2.id], [svcA.id]]),
    'INVALID_BRANCH', // branch 2 is invisible to this manager
  );
  // Manager drops the main branch only; branch 2 (not accessible to them) stays.
  await q(db, manager.userId, `select public.set_employee_assignments($1, $2, $3)`, [empA.id, [], [svcA.id]]);
  const branches = await q(db, A.ownerId, `select branch_id from public.employee_branches where employee_id = $1`, [empA.id]);
  assert.deepEqual(branches.map((r) => r.branch_id), [branch2.id]);
  const [svcB] = await q(db, B.ownerId, `insert into public.services (tenant_id, name_en) values ($1, 'B service') returning id`, [B.tenantId]);
  await expectPgError(
    q(db, A.ownerId, `select public.set_employee_assignments($1, $2, $3)`, [empA.id, [A.branchId, branch2.id], [svcB.id]]),
    'INVALID_SERVICE',
  );
  await q(db, A.ownerId, `select public.set_employee_assignments($1, $2, $3)`, [empA.id, [A.branchId, branch2.id], [svcA.id]]);
});

test('shifts: split shifts allowed, overlaps and unassigned branches refused', async () => {
  const split = [
    { branch_id: A.branchId, day_of_week: 0, starts_at: '09:00', ends_at: '13:00' },
    { branch_id: branch2.id, day_of_week: 0, starts_at: '16:00', ends_at: '22:00' },
    { branch_id: A.branchId, day_of_week: 4, starts_at: '14:00', ends_at: '24:00' },
  ];
  const rows = await q(db, A.ownerId, `select * from public.set_employee_shifts($1, $2)`, [empA.id, JSON.stringify(split)]);
  assert.equal(rows.length, 3);

  await expectPgError(
    q(db, A.ownerId, `select public.set_employee_shifts($1, $2)`, [empA.id, JSON.stringify([
      { branch_id: A.branchId, day_of_week: 1, starts_at: '09:00', ends_at: '13:00' },
      { branch_id: branch2.id, day_of_week: 1, starts_at: '12:00', ends_at: '18:00' },
    ])]),
    'OVERLAPPING_SHIFTS',
  );
  await expectPgError(
    q(db, A.ownerId, `select public.set_employee_shifts($1, $2)`, [empA.id, JSON.stringify([{ branch_id: A.branchId, day_of_week: 1, starts_at: '13:00', ends_at: '09:00' }])]),
    'INVALID_SHIFTS',
  );
  const [emp2] = await q(db, A.ownerId, `insert into public.employees (tenant_id, name_en) values ($1, 'No branch') returning id`, [A.tenantId]);
  await expectPgError(
    q(db, A.ownerId, `select public.set_employee_shifts($1, $2)`, [emp2.id, JSON.stringify([{ branch_id: A.branchId, day_of_week: 1, starts_at: '09:00', ends_at: '13:00' }])]),
    'SHIFT_BRANCH_NOT_ASSIGNED',
  );
  // The trigger also guards direct inserts against overlapping an existing shift.
  await expectPgError(
    q(db, A.ownerId, `insert into public.staff_shifts (tenant_id, employee_id, branch_id, day_of_week, starts_at, ends_at)
                      values ($1, $2, $3, 0, '12:00', '14:00')`, [A.tenantId, empA.id, A.branchId]),
    'OVERLAPPING_SHIFTS',
  );
  // The manager replacing shifts only touches the main branch; branch 2's shift survives.
  await q(db, manager.userId, `select public.set_employee_shifts($1, '[]')`, [empA.id]);
  const left = await q(db, A.ownerId, `select branch_id from public.staff_shifts where employee_id = $1`, [empA.id]);
  assert.deepEqual(left.map((r) => r.branch_id), [branch2.id]);
  // Removing the branch assignment removes its shifts (FK cascade).
  await q(db, A.ownerId, `select public.set_employee_assignments($1, $2, $3)`, [empA.id, [A.branchId], [svcA.id]]);
  assert.equal((await q(db, A.ownerId, `select id from public.staff_shifts where employee_id = $1`, [empA.id])).length, 0);
});

test('leave: attendance.manage only, valid ranges', async () => {
  await expectPgError(
    q(db, receptionist.userId, `insert into public.staff_leaves (tenant_id, employee_id, starts_at, ends_at) values ($1, $2, now(), now() + interval '1 hour')`, [A.tenantId, empA.id]),
    /row-level security/,
  );
  await expectPgError(
    q(db, A.ownerId, `insert into public.staff_leaves (tenant_id, employee_id, starts_at, ends_at) values ($1, $2, now(), now() - interval '1 hour')`, [A.tenantId, empA.id]),
    /check constraint/,
  );
  await q(db, manager.userId, `insert into public.staff_leaves (tenant_id, employee_id, leave_type, starts_at, ends_at) values ($1, $2, 'sick', now(), now() + interval '2 days')`, [A.tenantId, empA.id]);
  assert.ok((await q(db, receptionist.userId, `select id from public.staff_leaves`)).length >= 1, 'receptionists see leave for booking');
});

test('active employees count against the plan staff limit', async () => {
  await db.query(`update public.subscription_plans set max_staff = 4 where code = 'professional'`);
  try {
    const [{ n }] = await q(db, A.ownerId, `select count(*)::int n from public.employees where tenant_id = $1 and is_active`, [A.tenantId]);
    for (let i = n; i < 4; i++) {
      await q(db, A.ownerId, `insert into public.employees (tenant_id, name_en) values ($1, $2)`, [A.tenantId, `Filler ${i}`]);
    }
    await expectPgError(q(db, A.ownerId, `insert into public.employees (tenant_id, name_en) values ($1, 'One too many')`, [A.tenantId]), 'PLAN_LIMIT_EMPLOYEES');
    // Inactive employees don't count, and reactivating is checked too.
    const [inactive] = await q(db, A.ownerId, `insert into public.employees (tenant_id, name_en, is_active) values ($1, 'Former', false) returning id`, [A.tenantId]);
    await expectPgError(q(db, A.ownerId, `update public.employees set is_active = true where id = $1`, [inactive.id]), 'PLAN_LIMIT_EMPLOYEES');
  } finally {
    await db.query(`update public.subscription_plans set max_staff = 25 where code = 'professional'`);
  }
});

test('special periods: closures, Ramadan hours, no overlaps, branches.manage only', async () => {
  const [{ id }] = await q(db, A.ownerId, `select public.save_branch_special_period($1, null, 'special_hours', 'Ramadan', 'رمضان', '2027-02-08', '2027-03-09', $2) as id`, [
    branch2.id,
    JSON.stringify([{ day_of_week: 0, opens_at: '10:00', closes_at: '15:00' }, { day_of_week: 0, opens_at: '20:00', closes_at: '24:00' }]),
  ]);
  assert.equal((await q(db, A.ownerId, `select id from public.branch_special_hours where period_id = $1`, [id])).length, 2);
  // Updating replaces the hours.
  await q(db, A.ownerId, `select public.save_branch_special_period($1, $2, 'special_hours', 'Ramadan', null, '2027-02-08', '2027-03-09', $3)`, [
    branch2.id, id, JSON.stringify([{ day_of_week: 5, opens_at: '20:00', closes_at: '24:00' }]),
  ]);
  assert.equal((await q(db, A.ownerId, `select id from public.branch_special_hours where period_id = $1`, [id])).length, 1);

  await expectPgError(
    q(db, A.ownerId, `select public.save_branch_special_period($1, null, 'closed', 'Eid', null, '2027-03-08', '2027-03-12')`, [branch2.id]),
    'OVERLAPPING_SPECIAL_PERIODS',
  );
  await expectPgError(
    q(db, A.ownerId, `select public.save_branch_special_period($1, null, 'closed', 'Bad', null, '2027-05-02', '2027-05-01')`, [branch2.id]),
    'INVALID_PERIOD',
  );
  await expectPgError(
    q(db, A.ownerId, `select public.save_branch_special_period($1, null, 'closed', 'Closed with hours', null, '2027-06-01', '2027-06-01', $2)`, [
      branch2.id, JSON.stringify([{ day_of_week: 1, opens_at: '10:00', closes_at: '12:00' }]),
    ]),
    'INVALID_PERIOD',
  );
  await expectPgError(
    q(db, manager.userId, `select public.save_branch_special_period($1, null, 'closed', 'Manager holiday', null, '2027-07-01', '2027-07-01')`, [A.branchId]),
    'FORBIDDEN',
  );
  // Staff of branch 2 see its periods; staff of other branches don't.
  assert.ok((await q(db, receptionist.userId, `select id from public.branch_special_periods where branch_id = $1`, [branch2.id])).length >= 1);
  assert.equal((await q(db, stylist.userId, `select id from public.branch_special_periods where branch_id = $1`, [branch2.id])).length, 0);
});

test('changes to services and employees are audited', async () => {
  const rows = await q(db, A.ownerId,
    `select distinct entity_type from public.audit_logs where tenant_id = $1 and entity_type in ('services', 'employees', 'employee_services', 'service_prices')`,
    [A.tenantId]);
  assert.deepEqual(rows.map((r) => r.entity_type).sort(), ['employee_services', 'employees', 'service_prices', 'services']);
});

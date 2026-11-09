// Mandatory scenario: "two users can't reserve the same employee/time".
//
// PGlite is single-connection, so this suite runs against REAL Postgres (the
// local Supabase stack started in CI) with many parallel connections firing
// create_appointment at the same instant. Run: `npm run test:concurrency`
// (DATABASE_URL defaults to the local Supabase stack).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const url = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(url)) {
  throw new Error(`Refusing to run concurrency tests against a non-local database: ${url}`);
}

const admin = new pg.Client({ connectionString: url });
const suffix = randomUUID().slice(0, 8);
let tenantId, branchId, ownerId, svcId, emp1, emp2, day;

/** Run one statement as an authenticated user on a fresh connection. */
async function asUser(userId, sql, params) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query('begin');
    await c.query('set local role authenticated');
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: userId, role: 'authenticated' })]);
    const res = await c.query(sql, params);
    await c.query('commit');
    return res.rows;
  } catch (err) {
    await c.query('rollback').catch(() => {});
    throw err;
  } finally {
    await c.end();
  }
}

/** Fire `n` identical bookings at once; resolve to { ok, errors[] }. */
async function race(n, items, startsAt) {
  const results = await Promise.allSettled(
    Array.from({ length: n }, () =>
      asUser(ownerId, `select public.create_appointment($1, $2, null, $3, $4) as r`, [tenantId, branchId, startsAt, JSON.stringify(items)]),
    ),
  );
  return {
    ok: results.filter((r) => r.status === 'fulfilled').length,
    errors: results.filter((r) => r.status === 'rejected').map((r) => r.reason.message),
  };
}

before(async () => {
  await admin.connect();
  ownerId = randomUUID();
  await admin.query(
    `insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, now(), '{}', '{}', now(), now())`,
    [ownerId, `race-owner-${suffix}@example.com`],
  );
  const [{ r }] = await asUser(ownerId, `select public.create_tenant($1, $2) as r`, [`Race ${suffix}`, `race-${suffix}`]);
  tenantId = r.tenant_id;
  branchId = r.branch_id;
  [{ id: svcId }] = await asUser(ownerId,
    `insert into public.services (tenant_id, name_en, duration_minutes, buffer_after_minutes) values ($1, 'Race cut', 45, 15) returning id`, [tenantId]);
  const emp = async (name) => (await asUser(ownerId, `insert into public.employees (tenant_id, name_en) values ($1, $2) returning id`, [tenantId, name]))[0].id;
  emp1 = await emp('Racer One');
  emp2 = await emp('Racer Two');
  const week = JSON.stringify([0, 1, 2, 3, 4, 5, 6].map((d) => ({ branch_id: branchId, day_of_week: d, starts_at: '09:00', ends_at: '22:00' })));
  for (const e of [emp1, emp2]) {
    await asUser(ownerId, `select public.set_employee_assignments($1, $2, $3)`, [e, [branchId], [svcId]]);
    await asUser(ownerId, `select public.set_employee_shifts($1, $2)`, [e, week]);
  }
  const d = new Date(Date.now() + 9 * 86_400_000);
  if (d.getUTCDay() === 5) d.setUTCDate(d.getUTCDate() + 1);
  day = d.toISOString().slice(0, 10);
});

after(async () => {
  if (tenantId) await admin.query(`delete from public.tenants where id = $1`, [tenantId]).catch(() => {});
  if (ownerId) await admin.query(`delete from auth.users where id = $1`, [ownerId]).catch(() => {});
  await admin.end();
});

test('12 simultaneous bookings of one employee and time: exactly one wins', async () => {
  const { ok, errors } = await race(12, [{ service_id: svcId, employee_id: emp1 }], `${day}T10:00:00+04:00`);
  assert.equal(ok, 1, `expected one success, got ${ok}`);
  assert.equal(errors.length, 11);
  for (const e of errors) assert.equal(e, 'SLOT_UNAVAILABLE', `unexpected error: ${e}`);
});

test('overlapping (not identical) times also collide, including the clean-up buffer', async () => {
  // 11:00–11:45 + 15 min buffer vs 11:50: the buffer overlaps.
  const [a, b] = await Promise.allSettled([
    asUser(ownerId, `select public.create_appointment($1, $2, null, $3, $4)`, [tenantId, branchId, `${day}T11:00:00+04:00`, JSON.stringify([{ service_id: svcId, employee_id: emp1 }])]),
    asUser(ownerId, `select public.create_appointment($1, $2, null, $3, $4)`, [tenantId, branchId, `${day}T11:50:00+04:00`, JSON.stringify([{ service_id: svcId, employee_id: emp1 }])]),
  ]);
  const outcomes = [a, b].map((r) => (r.status === 'fulfilled' ? 'ok' : r.reason.message)).sort();
  assert.deepEqual(outcomes, ['SLOT_UNAVAILABLE', 'ok']);
});

test('"any employee": 8 simultaneous requests fill exactly the 2 free employees', async () => {
  const { ok, errors } = await race(8, [{ service_id: svcId, employee_id: null }], `${day}T14:00:00+04:00`);
  assert.equal(ok, 2);
  for (const e of errors) assert.equal(e, 'SLOT_UNAVAILABLE', `unexpected error: ${e}`);
  const rows = (await admin.query(
    `select employee_id from public.appointment_services s join public.appointments a on a.id = s.appointment_id
     where a.tenant_id = $1 and s.starts_at = $2 and s.is_active`, [tenantId, `${day}T14:00:00+04:00`])).rows;
  assert.deepEqual(rows.map((r) => r.employee_id).sort(), [emp1, emp2].sort());
});

test('idempotent retries racing each other create one appointment', async () => {
  const key = `retry-${suffix}`;
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, () =>
      asUser(ownerId, `select public.create_appointment($1, $2, null, $3, $4, null, 'front_desk', $5) as r`,
        [tenantId, branchId, `${day}T16:00:00+04:00`, JSON.stringify([{ service_id: svcId, employee_id: emp2 }]), key]),
    ),
  );
  for (const r of results) assert.equal(r.status, 'fulfilled', `a retry failed: ${r.reason?.message}`);
  const ids = new Set(results.map((r) => r.value[0].r.appointment_id));
  assert.equal(ids.size, 1, 'every retry returns the same appointment');
  const [{ n }] = (await admin.query(`select count(*)::int n from public.appointments where tenant_id = $1 and idempotency_key = $2`, [tenantId, key])).rows;
  assert.equal(n, 1);
});

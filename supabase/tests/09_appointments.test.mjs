// Phase 2 · appointments: availability, booking rules, no double-booking
// (exclusion constraint), idempotency, reschedule, status machine, and
// role / branch / tenant scope. Concurrency across real connections is
// covered by supabase/tests/concurrency (runs against real Postgres in CI).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createTenantWithOwner, q, expectPgError, addMember } from './helpers/db.mjs';

let db, A, B, cashier, stylist, haircut, blowdry, color, reena, merlyn, aisha, D;

// A future, non-Friday date in Asia/Muscat (UTC+4, no DST).
function bookingDate() {
  const d = new Date(Date.now() + 8 * 86_400_000);
  if (d.getUTCDay() === 5) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
const at = (hhmm, date = D) => `${date}T${hhmm}:00+04:00`;
const iso = (v) => new Date(v).toISOString();
const items = (...list) => JSON.stringify(list.map(([service_id, employee_id = null]) => ({ service_id, employee_id })));
const book = (uid, startHHMM, list, extra = {}) =>
  q(db, uid, `select public.create_appointment($1, $2, $3, $4, $5, $6, $7, $8) r`, [
    A.tenantId, extra.branch ?? A.branchId, extra.customer === undefined ? aisha.id : extra.customer,
    at(startHHMM, extra.date), list, extra.notes ?? null, 'front_desk', extra.key ?? null,
  ]).then((rows) => rows[0].r);
const slots = async (uid, serviceIds, employeeId = null, date = D) =>
  (await q(db, uid, `select starts_at, employee_id from public.calculate_availability($1, $2, $3, $4)`, [A.branchId, serviceIds, date, employeeId]))
    .map((r) => ({ t: iso(r.starts_at), e: r.employee_id }));

before(async () => {
  D = bookingDate();
  db = await createDb();
  A = await createTenantWithOwner(db, { email: 'appt-owner-a@example.com', slug: 'appt-salon-a' });
  B = await createTenantWithOwner(db, { email: 'appt-owner-b@example.com', slug: 'appt-salon-b' });
  cashier = await addMember(db, { tenantId: A.tenantId, inviterId: A.ownerId, email: 'appt-cash@example.com', roleCodes: ['cashier'], allBranches: true });
  stylist = await addMember(db, { tenantId: A.tenantId, inviterId: A.ownerId, email: 'appt-sty@example.com', roleCodes: ['stylist'], branchIds: [A.branchId] });

  const svc = (name, dur, before, after, price) =>
    q(db, A.ownerId, `insert into public.services (tenant_id, name_en, duration_minutes, buffer_before_minutes, buffer_after_minutes, price) values ($1, $2, $3, $4, $5, $6) returning id`,
      [A.tenantId, name, dur, before, after, price]).then((r) => r[0].id);
  haircut = await svc('Haircut', 45, 0, 15, 12);
  blowdry = await svc('Blow-dry', 30, 0, 0, 8);
  color = await svc('Colour', 60, 10, 10, 30);

  const emp = (name, extra = {}) =>
    q(db, A.ownerId, `insert into public.employees (tenant_id, name_en, membership_id, sort_order) values ($1, $2, $3, $4) returning id`,
      [A.tenantId, name, extra.membership ?? null, extra.sort ?? 0]).then((r) => r[0].id);
  reena = await emp('Reena', { membership: stylist.membershipId, sort: 1 });
  merlyn = await emp('Merlyn', { sort: 2 });
  await q(db, A.ownerId, `select public.set_employee_assignments($1, $2, $3)`, [reena, [A.branchId], [haircut, blowdry, color]]);
  await q(db, A.ownerId, `select public.set_employee_assignments($1, $2, $3)`, [merlyn, [A.branchId], [haircut, blowdry]]);
  const allWeek = JSON.stringify([0, 1, 2, 3, 4, 5, 6].map((d) => ({ branch_id: A.branchId, day_of_week: d, starts_at: '09:00', ends_at: '22:00' })));
  await q(db, A.ownerId, `select public.set_employee_shifts($1, $2)`, [reena, allWeek]);
  await q(db, A.ownerId, `select public.set_employee_shifts($1, $2)`, [merlyn, allWeek]);
  [aisha] = await q(db, A.ownerId, `insert into public.customers (tenant_id, first_name, mobile) values ($1, 'Aisha', '91234567') returning id`, [A.tenantId]);
});

test('availability follows branch hours, shifts and buffers', async () => {
  const s = await slots(A.ownerId, [haircut], reena);
  assert.equal(s[0].t, iso(at('09:00')), 'first slot at opening');
  // 45 min + 15 min clean-up must end by 22:00 → last start 21:00.
  assert.equal(s.at(-1).t, iso(at('21:00')));
  assert.equal(s.length, (21 - 9) * 4 + 1);
  // Merlyn can't do colour, so colour availability lists Reena only.
  const c = await slots(A.ownerId, [color]);
  assert.ok(c.length > 0 && c.every((x) => x.e === reena));
  // Two services back-to-back with one employee: 45 + 30 min, inner buffer dropped.
  const combo = await slots(A.ownerId, [haircut, blowdry], reena);
  assert.equal(combo.at(-1).t, iso(at('20:45')));
});

test('booking a specific employee snapshots service and price', async () => {
  const r = await book(A.ownerId, '10:00', items([haircut, reena]), { notes: 'First visit' });
  assert.equal(r.replayed, false);
  assert.equal(iso(r.ends_at), iso(at('10:45')));
  const [line] = await q(db, A.ownerId, `select service_name_en, price::text, employee_id, blocked_until from public.appointment_services where appointment_id = $1`, [r.appointment_id]);
  assert.deepEqual({ ...line, blocked_until: iso(line.blocked_until) }, { service_name_en: 'Haircut', price: '12.000', employee_id: reena, blocked_until: iso(at('11:00')) });
});

test('no double-booking: overlaps and buffers are refused', async () => {
  await expectPgError(book(A.ownerId, '10:30', items([blowdry, reena])), 'SLOT_UNAVAILABLE');
  // 10:45 falls in the 15-minute clean-up after the haircut.
  await expectPgError(book(A.ownerId, '10:45', items([blowdry, reena])), 'SLOT_UNAVAILABLE');
  const s = (await slots(A.ownerId, [blowdry], reena)).map((x) => x.t);
  assert.ok(!s.includes(iso(at('10:45'))) && s.includes(iso(at('11:00'))));
  // The database itself enforces it, even for a privileged direct insert.
  const [appt] = await q(db, A.ownerId, `select id from public.appointments limit 1`);
  await expectPgError(
    db.query(`insert into public.appointment_services (tenant_id, branch_id, appointment_id, service_id, employee_id, starts_at, ends_at, blocked_from, blocked_until, duration_minutes, service_name_en, price, price_type)
              values ($1, $2, $3, $4, $5, $6, $7, $6, $7, 30, 'x', 0, 'fixed')`,
      [A.tenantId, A.branchId, appt.id, blowdry, reena, at('10:15'), at('10:40')]),
    /appointment_services_no_employee_overlap/,
  );
});

test('"any employee" picks the first free qualified one', async () => {
  const r = await book(A.ownerId, '10:00', items([blowdry]));
  const [line] = await q(db, A.ownerId, `select employee_id from public.appointment_services where appointment_id = $1`, [r.appointment_id]);
  assert.equal(line.employee_id, merlyn, 'Reena is busy at 10:00');
  // Colour at 10:00: only Reena qualifies and she is busy.
  await expectPgError(book(A.ownerId, '10:00', items([color])), 'SLOT_UNAVAILABLE');
});

test('consecutive services with one employee form one continuous block', async () => {
  const r = await book(A.ownerId, '12:00', items([haircut, merlyn], [blowdry, merlyn]));
  const lines = await q(db, A.ownerId, `select starts_at, ends_at, blocked_from, blocked_until from public.appointment_services where appointment_id = $1 order by sort_order`, [r.appointment_id]);
  assert.deepEqual(lines.map((l) => [iso(l.starts_at), iso(l.ends_at), iso(l.blocked_until)]), [
    [iso(at('12:00')), iso(at('12:45')), iso(at('12:45'))],
    [iso(at('12:45')), iso(at('13:15')), iso(at('13:15'))],
  ]);
  assert.equal(iso(r.ends_at), iso(at('13:15')));
});

test('opening hours, holidays and leave are respected', async () => {
  await expectPgError(book(A.ownerId, '08:00', items([blowdry, reena])), 'OUTSIDE_WORKING_HOURS');
  await expectPgError(book(A.ownerId, '21:45', items([haircut, reena])), 'OUTSIDE_WORKING_HOURS');
  // Leave for Merlyn in the afternoon.
  await q(db, A.ownerId, `insert into public.staff_leaves (tenant_id, employee_id, starts_at, ends_at) values ($1, $2, $3, $4)`, [A.tenantId, merlyn, at('15:00'), at('18:00')]);
  await expectPgError(book(A.ownerId, '16:00', items([blowdry, merlyn])), 'OUTSIDE_WORKING_HOURS');
  assert.ok(!(await slots(A.ownerId, [blowdry], merlyn)).some((x) => x.t === iso(at('16:00'))));
  // A public holiday closes the branch for everyone.
  const next = new Date(Date.parse(D) + 7 * 86_400_000).toISOString().slice(0, 10);
  await q(db, A.ownerId, `select public.save_branch_special_period($1, null, 'closed', 'Holiday', null, $2, $2)`, [A.branchId, next]);
  assert.deepEqual(await slots(A.ownerId, [blowdry], null, next), []);
  await expectPgError(book(A.ownerId, '10:00', items([blowdry]), { date: next }), 'SLOT_UNAVAILABLE');
});

test('booking validation: qualification, branch offer, customer, past, client prices', async () => {
  await expectPgError(book(A.ownerId, '14:00', items([color, merlyn])), 'EMPLOYEE_NOT_QUALIFIED');
  await q(db, A.ownerId, `select public.set_service_branch_prices($1, $2)`, [color, JSON.stringify([{ branch_id: A.branchId, price: null, is_available: false }])]);
  await expectPgError(book(A.ownerId, '14:00', items([color, reena])), 'SERVICE_NOT_OFFERED');
  await q(db, A.ownerId, `select public.set_service_branch_prices($1, '[]')`, [color]);
  await expectPgError(book(A.ownerId, '14:00', items([blowdry]), { date: '2020-01-05' }), 'APPOINTMENT_IN_PAST');
  await expectPgError(book(A.ownerId, '14:00', '[]'), 'INVALID_ITEMS');
  const [blocked] = await q(db, A.ownerId, `insert into public.customers (tenant_id, first_name, status) values ($1, 'Blocked', 'blocked') returning id`, [A.tenantId]);
  await expectPgError(book(A.ownerId, '14:00', items([blowdry]), { customer: blocked.id }), 'CUSTOMER_BLOCKED');
  const [bCustomer] = await q(db, B.ownerId, `insert into public.customers (tenant_id, first_name) values ($1, 'Other') returning id`, [B.tenantId]);
  await expectPgError(book(A.ownerId, '14:00', items([blowdry]), { customer: bCustomer.id }), 'INVALID_CUSTOMER');
  // A price sent by the client is ignored; a branch override applies.
  await q(db, A.ownerId, `select public.set_service_branch_prices($1, $2)`, [blowdry, JSON.stringify([{ branch_id: A.branchId, price: 9.5 }])]);
  const r = await book(A.ownerId, '14:00', JSON.stringify([{ service_id: blowdry, employee_id: reena, price: 0 }]), { customer: null });
  const [line] = await q(db, A.ownerId, `select price::text from public.appointment_services where appointment_id = $1`, [r.appointment_id]);
  assert.equal(line.price, '9.500');
});

test('idempotent retries return the same appointment', async () => {
  const first = await book(A.ownerId, '19:00', items([blowdry, reena]), { key: 'retry-1' });
  const again = await book(A.ownerId, '19:00', items([blowdry, reena]), { key: 'retry-1' });
  assert.equal(again.appointment_id, first.appointment_id);
  assert.equal(again.replayed, true);
});

test('reschedule moves all services atomically', async () => {
  // Haircut + blow-dry with Reena: 75 minutes.
  const r = await book(A.ownerId, '15:00', items([haircut, reena], [blowdry, reena]));
  const [{ r: moved }] = await q(db, A.ownerId, `select public.reschedule_appointment($1, $2) r`, [r.appointment_id, at('16:30')]);
  assert.equal(iso(moved.ends_at), iso(at('17:45')));
  // 18:30–19:45 would collide with Reena's 19:00 booking: refused, nothing changes.
  await expectPgError(q(db, A.ownerId, `select public.reschedule_appointment($1, $2)`, [r.appointment_id, at('18:30')]), 'SLOT_UNAVAILABLE');
  const [a] = await q(db, A.ownerId, `select starts_at from public.appointments where id = $1`, [r.appointment_id]);
  assert.equal(iso(a.starts_at), iso(at('16:30')));
  assert.equal((await q(db, A.ownerId, `select id from public.appointment_services where appointment_id = $1`, [r.appointment_id])).length, 2);
  // Move to Merlyn in the evening; prices booked earlier are kept.
  await q(db, A.ownerId, `select public.reschedule_appointment($1, $2, $3)`, [r.appointment_id, at('20:30'), merlyn]);
  const lines = await q(db, A.ownerId, `select employee_id, price::text from public.appointment_services where appointment_id = $1 order by sort_order`, [r.appointment_id]);
  assert.deepEqual(lines, [{ employee_id: merlyn, price: '12.000' }, { employee_id: merlyn, price: '9.500' }]);
  // Colour can't move to Merlyn: she doesn't perform it.
  const c = await book(A.ownerId, '11:30', items([color, reena]));
  await expectPgError(q(db, A.ownerId, `select public.reschedule_appointment($1, $2, $3)`, [c.appointment_id, at('11:30'), merlyn]), 'EMPLOYEE_NOT_QUALIFIED');
});

test('status machine and cancellation frees the slot', async () => {
  const r = await book(A.ownerId, '20:00', items([blowdry, merlyn]));
  await expectPgError(q(db, A.ownerId, `select public.set_appointment_status($1, 'completed')`, [r.appointment_id]), 'INVALID_STATUS_TRANSITION');
  await expectPgError(q(db, A.ownerId, `select public.set_appointment_status($1, null)`, [r.appointment_id]), 'INVALID_STATUS_TRANSITION');
  await q(db, A.ownerId, `select public.set_appointment_status($1, 'cancelled', 'Customer called')`, [r.appointment_id]);
  const [a] = await q(db, A.ownerId, `select status, cancel_reason, cancelled_at is not null as stamped from public.appointments where id = $1`, [r.appointment_id]);
  assert.deepEqual(a, { status: 'cancelled', cancel_reason: 'Customer called', stamped: true });
  await expectPgError(q(db, A.ownerId, `select public.set_appointment_status($1, 'confirmed')`, [r.appointment_id]), 'INVALID_STATUS_TRANSITION');
  await expectPgError(q(db, A.ownerId, `select public.reschedule_appointment($1, $2)`, [r.appointment_id, at('20:15')]), 'INVALID_STATUS_TRANSITION');
  // The slot is free again.
  const again = await book(A.ownerId, '20:00', items([blowdry, merlyn]));
  for (const s of ['checked_in', 'in_service', 'completed']) {
    await q(db, A.ownerId, `select public.set_appointment_status($1, $2)`, [again.appointment_id, s]);
  }
  const [done] = await q(db, A.ownerId, `select status, checked_in_at is not null as ci, completed_at is not null as co from public.appointments where id = $1`, [again.appointment_id]);
  assert.deepEqual(done, { status: 'completed', ci: true, co: true });
});

test('roles: cashier views, stylist sees and completes only their own', async () => {
  await expectPgError(book(cashier.userId, '13:30', items([blowdry])), 'FORBIDDEN');
  const calCashier = (await q(db, cashier.userId, `select public.get_calendar($1, $2, $3) c`, [A.branchId, at('00:00'), at('23:59')]))[0].c;
  assert.ok(calCashier.appointments.length >= 5);
  assert.equal(calCashier.employees.length, 2);
  assert.equal(calCashier.can_manage, false);

  const ownRows = await q(db, stylist.userId, `select distinct s.employee_id from public.appointment_services s`);
  assert.deepEqual(ownRows.map((r) => r.employee_id), [reena], 'RLS: stylist reads only her own lines');
  const cal = (await q(db, stylist.userId, `select public.get_calendar($1, $2, $3) c`, [A.branchId, at('00:00'), at('23:59')]))[0].c;
  assert.deepEqual(cal.employees.map((e) => e.id), [reena]);
  assert.ok(cal.appointments.every((a) => a.lines.every((l) => l.employee_id === reena)));
  assert.ok(cal.appointments.every((a) => !a.customer || a.customer.mobile === null), 'no customer contact without customers.view');
  await expectPgError(q(db, stylist.userId, `select * from public.calculate_availability($1, $2, $3)`, [A.branchId, [blowdry], D]), 'FORBIDDEN');

  const [mine] = await q(db, A.ownerId, `select a.id from public.appointments a join public.appointment_services s on s.appointment_id = a.id where s.employee_id = $1 and a.status = 'booked' limit 1`, [reena]);
  await expectPgError(q(db, stylist.userId, `select public.set_appointment_status($1, 'cancelled')`, [mine.id]), 'FORBIDDEN');
  await q(db, stylist.userId, `select public.set_appointment_status($1, 'in_service')`, [mine.id]);
  await q(db, stylist.userId, `select public.set_appointment_status($1, 'completed')`, [mine.id]);
  const [other] = await q(db, A.ownerId, `select a.id from public.appointments a join public.appointment_services s on s.appointment_id = a.id where s.employee_id = $1 and a.status = 'booked' limit 1`, [merlyn]);
  await expectPgError(q(db, stylist.userId, `select public.set_appointment_status($1, 'in_service')`, [other.id]), 'NOT_FOUND');
});

test('apps cannot write booking tables directly', async () => {
  await expectPgError(q(db, A.ownerId, `update public.appointments set status = 'completed'`), /permission denied/);
  await expectPgError(q(db, A.ownerId, `delete from public.appointment_services`), /permission denied/);
  await expectPgError(
    q(db, A.ownerId, `insert into public.appointments (tenant_id, branch_id, starts_at, ends_at) values ($1, $2, now(), now() + interval '1 hour')`, [A.tenantId, A.branchId]),
    /permission denied/,
  );
});

test('tenant isolation for appointments and booking RPCs', async () => {
  assert.equal((await q(db, B.ownerId, `select id from public.appointments`)).length, 0);
  assert.equal((await q(db, B.ownerId, `select id from public.appointment_services`)).length, 0);
  await expectPgError(
    q(db, B.ownerId, `select public.create_appointment($1, $2, null, $3, $4)`, [A.tenantId, A.branchId, at('15:00'), items([blowdry])]),
    'FORBIDDEN',
  );
  await expectPgError(q(db, B.ownerId, `select public.get_calendar($1, $2, $3)`, [A.branchId, at('00:00'), at('23:59')]), 'FORBIDDEN');
  await expectPgError(q(db, B.ownerId, `select * from public.calculate_availability($1, $2, $3)`, [A.branchId, [blowdry], D]), 'FORBIDDEN');
  const [appt] = await q(db, A.ownerId, `select id from public.appointments where status = 'booked' limit 1`);
  await expectPgError(q(db, B.ownerId, `select public.set_appointment_status($1, 'cancelled')`, [appt.id]), 'NOT_FOUND');
  await expectPgError(q(db, B.ownerId, `select public.reschedule_appointment($1, $2)`, [appt.id, at('11:00')]), 'NOT_FOUND');
  // B booking with A's service ids fails validation.
  const [bBranch] = await q(db, B.ownerId, `select id from public.branches where tenant_id = $1`, [B.tenantId]);
  await expectPgError(
    q(db, B.ownerId, `select public.create_appointment($1, $2, null, $3, $4)`, [B.tenantId, bBranch.id, at('15:00'), items([blowdry])]),
    'INVALID_SERVICE',
  );
});

test('calendar window limits and today stats', async () => {
  await expectPgError(q(db, A.ownerId, `select public.get_calendar($1, now(), now() + interval '40 days')`, [A.branchId]), 'INVALID_RANGE');
  const [{ s }] = await q(db, A.ownerId, `select public.get_appointment_stats($1) s`, [A.tenantId]);
  assert.deepEqual(Object.keys(s).sort(), ['cancelled', 'checked_in', 'completed', 'today', 'upcoming']);
  await expectPgError(q(db, stylist.userId, `select public.get_appointment_stats($1)`, [A.tenantId]), 'FORBIDDEN');
});

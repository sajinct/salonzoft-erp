// Phase 5 · public online booking (anon), customer self-service, consent-
// based notification queue, worker claim / retry, templates.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createTenantWithOwner, q, qAnon, expectPgError, addMember } from './helpers/db.mjs';

let db, A, B, cashier, haircut, hidden, reena, day;

const at = (hhmm, d = day) => `${d}T${hhmm}:00+04:00`;
const asService = (sql, params = []) =>
  db.transaction(async (tx) => {
    await tx.exec('set local role service_role');
    return (await tx.query(sql, params)).rows;
  });
let keyN = 0;
const book = (extra = {}) =>
  qAnon(db, `select public.public_create_booking($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) r`, [
    extra.slug ?? 'online-a', extra.branch ?? A.branchId, extra.services ?? [haircut], extra.employee ?? null,
    extra.when ?? at('10:00'), extra.first ?? 'Noor', extra.last ?? null, extra.mobile ?? '95550001',
    extra.email ?? null, null, extra.consent ?? true, extra.key ?? `key-${++keyN}`,
  ]).then((r) => r[0].r);
const jobs = (appointmentId) =>
  q(db, A.ownerId, `select event, channel, status from public.notification_jobs where appointment_id = $1 order by created_at, event`, [appointmentId]);

before(async () => {
  db = await createDb();
  A = await createTenantWithOwner(db, { email: 'web-owner-a@example.com', slug: 'online-a', name: 'Salon Online' });
  B = await createTenantWithOwner(db, { email: 'web-owner-b@example.com', slug: 'online-b' });
  cashier = await addMember(db, { tenantId: A.tenantId, inviterId: A.ownerId, email: 'web-cash@example.com', roleCodes: ['cashier'], allBranches: true });
  await q(db, A.ownerId, `update public.branches set online_booking_enabled = true where id = $1`, [A.branchId]);
  await q(db, A.ownerId, `update public.tenant_settings set notify_whatsapp = true, online_booking_cancel_hours = 12 where tenant_id = $1`, [A.tenantId]);
  [{ id: haircut }] = await q(db, A.ownerId, `insert into public.services (tenant_id, name_en, name_ar, price, duration_minutes) values ($1, 'Haircut', 'قص', 12, 45) returning id`, [A.tenantId]);
  [{ id: hidden }] = await q(db, A.ownerId, `insert into public.services (tenant_id, name_en, price, online_bookable) values ($1, 'Bridal (call us)', 200, false) returning id`, [A.tenantId]);
  [{ id: reena }] = await q(db, A.ownerId, `insert into public.employees (tenant_id, name_en, phone) values ($1, 'Reena', '+96891112222') returning id`, [A.tenantId]);
  await q(db, A.ownerId, `select public.set_employee_assignments($1, $2, $3)`, [reena, [A.branchId], [haircut, hidden]]);
  await q(db, A.ownerId, `select public.set_employee_shifts($1, $2)`,
    [reena, JSON.stringify([0, 1, 2, 3, 4, 5, 6].map((d) => ({ branch_id: A.branchId, day_of_week: d, starts_at: '00:00', ends_at: '24:00' })))]);
  const d = new Date(Date.now() + 3 * 86_400_000);
  if (d.getUTCDay() === 5) d.setUTCDate(d.getUTCDate() + 1);
  day = d.toISOString().slice(0, 10);
});

test('the public salon page exposes only online branches, online services and staff names', async () => {
  const [{ s }] = await qAnon(db, `select public.public_get_salon('ONLINE-A ') s`);
  assert.equal(s.salon.name, 'Salon Online');
  assert.deepEqual(s.branches.map((b) => b.id), [A.branchId]);
  assert.deepEqual(s.services.map((x) => x.name_en), ['Haircut']);
  assert.deepEqual(Object.keys(s.staff[0]).sort(), ['branch_ids', 'color', 'id', 'name_ar', 'name_en', 'service_ids']);
  await expectPgError(qAnon(db, `select public.public_get_salon('nope')`), 'BOOKING_UNAVAILABLE');
  await expectPgError(qAnon(db, `select public.public_get_salon('online-b')`), 'BOOKING_UNAVAILABLE'); // no online branch
});

test('anon can only call the public functions — no tables, no staff RPCs', async () => {
  for (const t of ['appointments', 'customers', 'employees', 'services', 'notification_jobs', 'public_booking_attempts']) {
    await expectPgError(qAnon(db, `select * from public.${t}`), /permission denied/);
  }
  await expectPgError(qAnon(db, `select * from public.calculate_availability($1, $2, $3)`, [A.branchId, [haircut], day]), /permission denied/);
  await expectPgError(qAnon(db, `select public.create_appointment($1, $2, null, $3, '[]')`, [A.tenantId, A.branchId, at('10:00')]), /permission denied/);
});

test('public availability respects lead time, horizon and online-only services', async () => {
  const slots = await qAnon(db, `select starts_at from public.public_availability('online-a', $1, $2, $3)`, [A.branchId, [haircut], day]);
  assert.ok(slots.length > 0);
  await expectPgError(qAnon(db, `select * from public.public_availability('online-a', $1, $2, $3)`, [A.branchId, [hidden], day]), 'INVALID_SERVICE');
  const far = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);
  await expectPgError(qAnon(db, `select * from public.public_availability('online-a', $1, $2, $3)`, [A.branchId, [haircut], far]), 'INVALID_RANGE');
  await expectPgError(qAnon(db, `select * from public.public_availability('online-a', $1, $2, $3)`, [B.branchId, [haircut], day]), 'INVALID_BRANCH');
});

let first;
test('booking online creates the customer, the appointment, consent and a manage token', async () => {
  first = await book({ key: 'browser-1', first: 'Noor', mobile: '9555 0001', when: at('10:00') });
  assert.equal(first.replayed, false);
  assert.ok(first.token.length >= 40);
  const [a] = await q(db, A.ownerId, `select source, status, created_by, customer_id from public.appointments where id = $1`, [first.appointment_id]);
  assert.deepEqual([a.source, a.status, a.created_by], ['online', 'booked', null]);
  const [c] = await q(db, A.ownerId, `select first_name, mobile, source from public.customers where id = $1`, [a.customer_id]);
  assert.deepEqual(c, { first_name: 'Noor', mobile: '+96895550001', source: 'online' });
  const consents = await q(db, A.ownerId, `select channel, purpose, granted, source from public.customer_consents where customer_id = $1 order by channel`, [a.customer_id]);
  assert.deepEqual(consents.map((x) => x.channel), ['sms', 'whatsapp']);
  // A retry from the same browser returns the same booking.
  const again = await book({ key: 'browser-1' });
  assert.deepEqual([again.appointment_id, again.replayed], [first.appointment_id, true]);
});

test('an existing customer is never changed from the public form; blocked customers cannot book', async () => {
  const [existing] = await q(db, A.ownerId, `insert into public.customers (tenant_id, first_name, mobile) values ($1, 'Aisha', '91234567') returning id`, [A.tenantId]);
  const r = await book({ first: 'Hacker', mobile: '+968 9123 4567', when: at('12:00') });
  const [a] = await q(db, A.ownerId, `select customer_id from public.appointments where id = $1`, [r.appointment_id]);
  assert.equal(a.customer_id, existing.id);
  const [c] = await q(db, A.ownerId, `select first_name from public.customers where id = $1`, [existing.id]);
  assert.equal(c.first_name, 'Aisha');
  await q(db, A.ownerId, `insert into public.customers (tenant_id, first_name, mobile, status) values ($1, 'Blocked', '95559999', 'blocked')`, [A.tenantId]);
  await expectPgError(book({ mobile: '95559999', when: at('14:00') }), 'BOOKING_UNAVAILABLE');
});

test('public booking validation: conflicts, timing, services, rate limits', async () => {
  await expectPgError(book({ mobile: '95550002', when: at('10:15') }), 'SLOT_UNAVAILABLE');
  await expectPgError(book({ mobile: '95550002', when: new Date(Date.now() + 10 * 60_000).toISOString() }), 'APPOINTMENT_IN_PAST');
  await expectPgError(book({ mobile: '95550002', services: [hidden], when: at('15:00') }), 'INVALID_SERVICE');
  await expectPgError(book({ mobile: 'abc', when: at('15:00') }), 'INVALID_MOBILE');
  await expectPgError(book({ slug: 'online-b', when: at('15:00') }), 'BOOKING_UNAVAILABLE');
  // 3 per mobile per day.
  await book({ mobile: '95550003', when: at('15:00') });
  await book({ mobile: '95550003', when: at('16:00') });
  await book({ mobile: '95550003', when: at('17:00') });
  await expectPgError(book({ mobile: '95550003', when: at('18:00') }), 'TOO_MANY_REQUESTS');
});

test('customers can view and cancel their booking with the token, within the window', async () => {
  const [{ r }] = await qAnon(db, `select public.public_get_booking($1) r`, [first.token]);
  assert.equal(r.status, 'booked');
  assert.equal(r.can_cancel, true);
  assert.deepEqual(r.services.map((s) => s.name_en), ['Haircut']);
  await expectPgError(qAnon(db, `select public.public_get_booking('x')`), 'NOT_FOUND');
  await expectPgError(qAnon(db, `select public.public_get_booking($1)`, ['0'.repeat(40)]), 'NOT_FOUND');

  const late = await book({ mobile: '95550004', when: at('19:00') });
  await q(db, A.ownerId, `update public.tenant_settings set online_booking_cancel_hours = 168 where tenant_id = $1`, [A.tenantId]);
  await expectPgError(qAnon(db, `select public.public_cancel_booking($1)`, [late.token]), 'CANCEL_TOO_LATE');
  await q(db, A.ownerId, `update public.tenant_settings set online_booking_cancel_hours = 12 where tenant_id = $1`, [A.tenantId]);
  await qAnon(db, `select public.public_cancel_booking($1)`, [late.token]);
  const [a] = await q(db, A.ownerId, `select status from public.appointments where id = $1`, [late.appointment_id]);
  assert.equal(a.status, 'cancelled');
  await expectPgError(qAnon(db, `select public.public_cancel_booking($1)`, [late.token]), 'CANCEL_TOO_LATE');
});

test('notifications are queued only with consent, and follow cancellations', async () => {
  assert.deepEqual(await jobs(first.appointment_id), [
    { event: 'booking_confirmed', channel: 'whatsapp', status: 'queued' },
    { event: 'booking_reminder', channel: 'whatsapp', status: 'queued' },
  ]);
  const noConsent = await book({ mobile: '95550005', consent: false, when: at('20:00') });
  assert.deepEqual(await jobs(noConsent.appointment_id), []);
  // A withdrawn consent stops new messages.
  const [{ customer_id: noorId }] = await q(db, A.ownerId, `select customer_id from public.appointments where id = $1`, [first.appointment_id]);
  await q(db, A.ownerId, `insert into public.customer_consents (tenant_id, customer_id, channel, purpose, granted) values ($1, $2, 'whatsapp', 'reminders', false), ($1, $2, 'sms', 'reminders', false)`, [A.tenantId, noorId]);
  const [{ r: staffBooked }] = await q(db, A.ownerId, `select public.create_appointment($1, $2, $3, $4, $5) r`,
    [A.tenantId, A.branchId, noorId, at('13:00'), JSON.stringify([{ service_id: haircut, employee_id: reena }])]);
  assert.deepEqual(await jobs(staffBooked.appointment_id), []);
  // Cancelling the first booking cancels its reminder and queues a cancellation.
  await q(db, A.ownerId, `insert into public.customer_consents (tenant_id, customer_id, channel, purpose, granted) values ($1, $2, 'whatsapp', 'reminders', true)`, [A.tenantId, noorId]);
  await q(db, A.ownerId, `select public.set_appointment_status($1, 'cancelled')`, [first.appointment_id]);
  const after = await jobs(first.appointment_id);
  assert.deepEqual(after.map((j) => `${j.event}:${j.status}`).sort(), ['booking_cancelled:queued', 'booking_confirmed:cancelled', 'booking_reminder:cancelled']);
});

test('the worker claims due jobs, renders them, and retries with backoff', async () => {
  await expectPgError(q(db, A.ownerId, `select * from public.claim_notification_jobs(10)`), /permission denied/);
  const claimed = await asService(`select * from public.claim_notification_jobs(50)`);
  const cancelMsg = claimed.find((j) => j.event === 'booking_cancelled' && j.appointment_id === first.appointment_id);
  assert.ok(cancelMsg, 'the due cancellation is claimed');
  assert.equal(cancelMsg.status, 'sending');
  assert.equal(cancelMsg.to_address, '+96895550001');
  assert.match(cancelMsg.body, /Hello Noor, your appointment at Salon Online on \d{2}\/\d{2}\/\d{4} at 10:00 has been cancelled/);
  assert.match(cancelMsg.body, /\/book\/online-a/);
  assert.ok(!claimed.some((j) => j.event === 'booking_reminder'), 'reminders are not due yet');
  assert.equal((await asService(`select * from public.claim_notification_jobs(50)`)).length, 0, 'claimed jobs are not handed out twice');

  await asService(`select public.complete_notification_job($1, 'sent', 'log', 'msg-1')`, [cancelMsg.id]);
  const other = claimed.find((j) => j.id !== cancelMsg.id);
  await asService(`select public.complete_notification_job($1, 'failed', 'whatsapp', null, 'timeout')`, [other.id]);
  const [retry] = await q(db, A.ownerId, `select status, attempts, scheduled_for > now() as later, last_error from public.notification_jobs where id = $1`, [other.id]);
  assert.deepEqual(retry, { status: 'queued', attempts: 1, later: true, last_error: 'timeout' });
  // After 5 attempts it stops.
  await db.query(`update public.notification_jobs set attempts = 5, status = 'sending' where id = $1`, [other.id]);
  await asService(`select public.complete_notification_job($1, 'failed', 'whatsapp', null, 'still down')`, [other.id]);
  const [dead] = await q(db, A.ownerId, `select status from public.notification_jobs where id = $1`, [other.id]);
  assert.equal(dead.status, 'failed');
  const [sent] = await q(db, A.ownerId, `select status, provider_message_id from public.notification_jobs where id = $1`, [cancelMsg.id]);
  assert.deepEqual(sent, { status: 'sent', provider_message_id: 'msg-1' });
});

test('salons can write their own templates; job logs are for notifications.manage only', async () => {
  await q(db, A.ownerId, `insert into public.notification_templates (tenant_id, event, channel, language, body) values ($1, 'booking_confirmed', 'whatsapp', 'en', 'Hi {{name}}! See you {{date}} {{time}} at {{branch}}.')`, [A.tenantId]);
  const [{ p }] = await q(db, A.ownerId, `select public.preview_notification($1, 'Hi {{name}} — {{services}} with {{staff}}') p`, [A.tenantId]);
  assert.equal(p, 'Hi Aisha — Haircut, Blow-dry with Reena');
  const r = await book({ mobile: '95550006', when: at('21:00') });
  const [job] = await asService(`select * from public.claim_notification_jobs(50) where appointment_id = $1`, [r.appointment_id]);
  assert.match(job.body, /^Hi Noor! See you \d{2}\/\d{2}\/\d{4} 21:00 at /);
  assert.equal((await q(db, cashier.userId, `select id from public.notification_jobs`)).length, 0);
  await expectPgError(q(db, cashier.userId, `insert into public.notification_templates (tenant_id, event, channel, language, body) values ($1, 'booking_reminder', 'sms', 'en', 'xxxxxxx')`, [A.tenantId]), /row-level security/);
  assert.equal((await q(db, B.ownerId, `select id from public.notification_jobs`)).length, 0);
});

// Phase 5 · marketing campaigns (marketing consent, audience, plan allowance,
// unsubscribe) and post-visit feedback.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createTenantWithOwner, q, qAnon, expectPgError, addMember } from './helpers/db.mjs';

let db, A, B, cashier, manager, aisha, noor, maryam, fatma, haircut, reena;

const asService = (sql, params = []) =>
  db.transaction(async (tx) => {
    await tx.exec('set local role service_role');
    return (await tx.query(sql, params)).rows;
  });
const consent = (customer, channel, purpose, granted) =>
  q(db, A.ownerId, `insert into public.customer_consents (tenant_id, customer_id, channel, purpose, granted) values ($1, $2, $3, $4, $5)`, [A.tenantId, customer, channel, purpose, granted]);
const preview = async (segment, channel = 'whatsapp', uid = manager.userId) =>
  (await q(db, uid, `select public.preview_campaign_audience($1, $2, $3) r`, [A.tenantId, JSON.stringify(segment), channel]))[0].r;
const draft = async (fields = {}) =>
  (await q(db, manager.userId, `insert into public.campaigns (tenant_id, name, channel, segment, body_en, body_ar, scheduled_for) values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [A.tenantId, fields.name ?? 'Eid offer', fields.channel ?? 'whatsapp', JSON.stringify(fields.segment ?? {}), fields.body_en ?? 'Hi {{name}}, 20% off at {{salon}} this week! {{book_link}}',
      fields.body_ar ?? 'مرحباً {{name}}، خصم 20٪ لدى {{salon}}!', fields.scheduled_for ?? null]))[0].id;

before(async () => {
  db = await createDb();
  A = await createTenantWithOwner(db, { email: 'mkt-owner-a@example.com', slug: 'mkt-salon-a', name: 'Salon Mkt' });
  B = await createTenantWithOwner(db, { email: 'mkt-owner-b@example.com', slug: 'mkt-salon-b' });
  cashier = await addMember(db, { tenantId: A.tenantId, inviterId: A.ownerId, email: 'mkt-cash@example.com', roleCodes: ['cashier'], allBranches: true });
  manager = await addMember(db, { tenantId: A.tenantId, inviterId: A.ownerId, email: 'mkt-mgr@example.com', roleCodes: ['manager'], allBranches: true });
  const cust = async (first, mobile, extra = {}) =>
    (await q(db, A.ownerId, `insert into public.customers (tenant_id, first_name, mobile, email, tags, preferred_language) values ($1, $2, $3, $4, $5, $6) returning id`,
      [A.tenantId, first, mobile, extra.email ?? null, extra.tags ?? [], extra.lang ?? null]))[0].id;
  aisha = await cust('Aisha', '91234567', { tags: ['vip'] });
  noor = await cust('Noor', '95551111', { lang: 'ar' });
  maryam = await cust('Maryam', '92001122');
  fatma = await cust('Fatma', '99887766', { email: 'fatma@example.com' });
  await consent(aisha, 'whatsapp', 'marketing', true);
  await consent(noor, 'whatsapp', 'marketing', true);
  await consent(fatma, 'email', 'marketing', true);
  await consent(aisha, 'whatsapp', 'reminders', true); // reminders consent is NOT marketing consent
  await consent(maryam, 'whatsapp', 'reminders', true);
  [{ id: haircut }] = await q(db, A.ownerId, `insert into public.services (tenant_id, name_en, price) values ($1, 'Haircut', 12) returning id`, [A.tenantId]);
  [{ id: reena }] = await q(db, A.ownerId, `insert into public.employees (tenant_id, name_en) values ($1, 'Reena') returning id`, [A.tenantId]);
  await q(db, A.ownerId, `select public.set_employee_assignments($1, $2, $3)`, [reena, [A.branchId], [haircut]]);
  await q(db, A.ownerId, `select public.set_employee_shifts($1, $2)`,
    [reena, JSON.stringify([0, 1, 2, 3, 4, 5, 6].map((d) => ({ branch_id: A.branchId, day_of_week: d, starts_at: '00:00', ends_at: '24:00' })))]);
});

test('campaigns are managed with marketing.manage', async () => {
  await expectPgError(q(db, cashier.userId, `insert into public.campaigns (tenant_id, name, channel, body_en) values ($1, 'x', 'sms', 'hello there')`, [A.tenantId]), /row-level security/);
  await expectPgError(preview({}, 'whatsapp', cashier.userId), 'FORBIDDEN');
  assert.ok(await draft());
});

test('the audience needs marketing consent (latest wins) and matches the filters', async () => {
  assert.equal((await preview({})).count, 2, 'Aisha and Noor; Maryam only agreed to reminders');
  await consent(noor, 'whatsapp', 'marketing', false);
  assert.equal((await preview({})).count, 1, 'a withdrawal wins over the earlier consent');
  await consent(noor, 'whatsapp', 'marketing', true);
  assert.equal((await preview({ tags: ['VIP'] })).count, 1);
  assert.deepEqual((await preview({ tags: ['vip'] })).sample, ['Aisha']);
  assert.equal((await preview({ min_visits: 1 })).count, 0);
  assert.equal((await preview({ inactive_days: 30 })).count, 2, 'never visited counts as inactive');
  assert.equal((await preview({}, 'email')).count, 1);
  await expectPgError(preview({ min_visits: 'many' }), 'INVALID_SEGMENT');
});

let launchedId;
test('launching queues one message per recipient and uses the monthly allowance', async () => {
  launchedId = await draft({ name: 'Weekend' });
  const [{ r }] = await q(db, manager.userId, `select public.launch_campaign($1) r`, [launchedId]);
  assert.equal(r.recipients, 2);
  const jobs = await q(db, A.ownerId, `select customer_id, channel, language, status from public.notification_jobs where campaign_id = $1 order by language`, [launchedId]);
  assert.deepEqual(jobs.map((j) => [j.customer_id === noor ? 'noor' : 'aisha', j.language, j.status]), [['noor', 'ar', 'queued'], ['aisha', 'en', 'queued']].sort((a, b) => a[1].localeCompare(b[1])));
  const [{ quantity }] = await q(db, A.ownerId, `select quantity from public.tenant_usage where tenant_id = $1 and metric = 'messages'`, [A.tenantId]);
  assert.equal(Number(quantity), 2);
  await expectPgError(q(db, manager.userId, `select public.launch_campaign($1)`, [launchedId]), 'CAMPAIGN_NOT_DRAFT');
  const upd = await q(db, manager.userId, `update public.campaigns set body_en = 'changed text' where id = $1 returning id`, [launchedId]);
  assert.equal(upd.length, 0, 'launched campaigns are read-only');
  await expectPgError(q(db, manager.userId, `select public.launch_campaign($1)`, [await draft({ segment: { min_visits: 5 } })]), 'EMPTY_AUDIENCE');
  await db.query(`update public.subscription_plans set max_monthly_messages = 3 where code = 'professional'`);
  try {
    await expectPgError(q(db, manager.userId, `select public.launch_campaign($1)`, [await draft()]), 'PLAN_LIMIT_MESSAGES');
  } finally {
    await db.query(`update public.subscription_plans set max_monthly_messages = 3000 where code = 'professional'`);
  }
});

let unsubscribeToken;
test('messages are rendered per language and always carry an unsubscribe link', async () => {
  const claimed = await asService(`select * from public.claim_notification_jobs(50) where campaign_id = $1`, [launchedId]);
  const en = claimed.find((j) => j.customer_id === aisha);
  const ar = claimed.find((j) => j.customer_id === noor);
  assert.match(en.body, /^Hi Aisha, 20% off at Salon Mkt this week! https:\/\/erp\.salonzoft\.com\/book\/mkt-salon-a\nStop messages: https:\/\/erp\.salonzoft\.com\/unsubscribe\/[0-9a-f]{64}$/);
  assert.match(ar.body, /^مرحباً Noor، خصم 20٪ لدى Salon Mkt!\nلإيقاف الرسائل: /);
  unsubscribeToken = en.body.split('/unsubscribe/')[1];
});

test('unsubscribing withdraws marketing consent and stops pending campaign messages', async () => {
  const later = await draft({ name: 'Next week', scheduled_for: new Date(Date.now() + 3 * 86_400_000).toISOString() });
  await q(db, manager.userId, `select public.launch_campaign($1)`, [later]);
  const [{ r }] = await qAnon(db, `select public.public_unsubscribe($1) r`, [unsubscribeToken]);
  assert.equal(r.salon, 'Salon Mkt');
  const [latest] = await q(db, A.ownerId, `select granted, source from public.customer_consents where customer_id = $1 and purpose = 'marketing' order by recorded_at desc, id desc limit 1`, [aisha]);
  assert.deepEqual(latest, { granted: false, source: 'customer_request' });
  const pending = await q(db, A.ownerId, `select status from public.notification_jobs where campaign_id = $1 and customer_id = $2`, [later, aisha]);
  assert.deepEqual(pending.map((p) => p.status), ['cancelled']);
  assert.equal((await preview({})).count, 1, 'only Noor left');
  await expectPgError(qAnon(db, `select public.public_unsubscribe('nope')`), 'NOT_FOUND');
  // Stopping the scheduled campaign cancels what is still queued.
  const [{ n }] = await q(db, manager.userId, `select public.cancel_campaign($1) n`, [later]);
  assert.equal(n, 1);
  await expectPgError(q(db, manager.userId, `select public.cancel_campaign($1)`, [later]), 'CAMPAIGN_NOT_LAUNCHED');
  const [{ s }] = await q(db, manager.userId, `select jsonb_agg(x) s from public.get_campaign_stats($1) x`, [A.tenantId]);
  assert.ok(s.some((x) => x.campaign_id === later && x.cancelled === 2));
});

let feedbackToken;
test('completed visits get a feedback request (with consent) after the delay', async () => {
  await q(db, A.ownerId, `update public.tenant_settings set feedback_enabled = true, feedback_delay_hours = 2, notify_whatsapp = true where tenant_id = $1`, [A.tenantId]);
  const start = new Date(Date.now() + 2 * 86_400_000);
  if (start.getUTCDay() === 5) start.setUTCDate(start.getUTCDate() + 1);
  start.setUTCHours(7, 0, 0, 0);
  const visit = async (customer, offsetH) => {
    const when = new Date(start.getTime() + offsetH * 3_600_000).toISOString();
    const [{ r }] = await q(db, A.ownerId, `select public.create_appointment($1, $2, $3, $4, $5) r`,
      [A.tenantId, A.branchId, customer, when, JSON.stringify([{ service_id: haircut, employee_id: reena }])]);
    await q(db, A.ownerId, `select public.set_appointment_status($1, 'in_service')`, [r.appointment_id]);
    await q(db, A.ownerId, `select public.set_appointment_status($1, 'completed')`, [r.appointment_id]);
    return r.appointment_id;
  };
  const withConsent = await visit(aisha, 0);
  const [f] = await q(db, A.ownerId, `select token, rating from public.customer_feedback where appointment_id = $1`, [withConsent]);
  assert.equal(f.rating, null);
  feedbackToken = f.token;
  const [job] = await q(db, A.ownerId, `select status, scheduled_for > now() + interval '1 hour' as delayed from public.notification_jobs where appointment_id = $1 and event = 'feedback_request'`, [withConsent]);
  assert.deepEqual(job, { status: 'queued', delayed: true });
  // Reminder for the completed visit is no longer needed.
  const [rem] = await q(db, A.ownerId, `select status from public.notification_jobs where appointment_id = $1 and event = 'booking_reminder'`, [withConsent]);
  assert.equal(rem.status, 'cancelled');
  // No channel consent at all → no request.
  const noChannel = await visit(fatma, 2);
  assert.equal((await q(db, A.ownerId, `select id from public.customer_feedback where appointment_id = $1`, [noChannel])).length, 0);
});

test('customers rate once through the secret link; salons see the summary', async () => {
  const [{ r }] = await qAnon(db, `select public.public_get_feedback($1) r`, [feedbackToken]);
  assert.deepEqual([r.submitted, r.expired, r.salon.name], [false, false, 'Salon Mkt']);
  assert.deepEqual(r.services.map((s) => s.staff_en), ['Reena']);
  await expectPgError(qAnon(db, `select public.public_submit_feedback($1, 6, null)`, [feedbackToken]), 'INVALID_VALUE');
  await qAnon(db, `select public.public_submit_feedback($1, 5, '  Lovely cut  ')`, [feedbackToken]);
  await expectPgError(qAnon(db, `select public.public_submit_feedback($1, 1, 'changed my mind')`, [feedbackToken]), 'FEEDBACK_ALREADY_SENT');
  await expectPgError(qAnon(db, `select * from public.customer_feedback`), /permission denied/);

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Muscat' });
  const [{ s }] = await q(db, manager.userId, `select public.get_feedback_summary($1, $2, $2) s`, [A.tenantId, today]);
  assert.equal(s.average, 5);
  assert.equal(s.responses, 1);
  assert.deepEqual(s.staff.map((x) => [x.name_en, x.average]), [['Reena', 5]]);
  assert.deepEqual(s.recent.map((x) => [x.customer, x.comment]), [['Aisha', 'Lovely cut']]);
  await expectPgError(q(db, cashier.userId, `select public.get_feedback_summary($1, $2, $2)`, [A.tenantId, today]), 'FORBIDDEN');
});

test('isolation', async () => {
  for (const table of ['campaigns', 'customer_feedback']) {
    assert.equal((await q(db, B.ownerId, `select id from public.${table}`)).length, 0, `${table} leaked`);
  }
  await expectPgError(q(db, B.ownerId, `select public.launch_campaign($1)`, [launchedId]), 'NOT_FOUND');
  await expectPgError(q(db, B.ownerId, `select public.preview_campaign_audience($1, '{}', 'whatsapp')`, [A.tenantId]), 'FORBIDDEN');
  await expectPgError(q(db, A.ownerId, `select * from public.campaign_recipients`), /permission denied/);
});

// Sending invoices and appointment details by WhatsApp: the share functions
// return the customer's number and a ready message with a private link; the
// invoice link opens without a login and shows that invoice only.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createTenantWithOwner, addMember, q, qAnon, expectPgError } from './helpers/db.mjs';

let db, A, B, cashier, stylist, otherStylist, haircut, reena, merlyn, aisha, D;

function bookingDate() {
  const d = new Date(Date.now() + 8 * 86_400_000);
  if (d.getUTCDay() === 5) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
const at = (hhmm) => `${D}T${hhmm}:00+04:00`;
const rpc = async (uid, fn, arg) => (await q(db, uid, `select public.${fn}($1) r`, [arg]))[0].r;
const book = async (hhmm, customer, employee = reena) =>
  (await q(db, A.ownerId, `select public.create_appointment($1, $2, $3, $4, $5, null, 'front_desk', null) r`,
    [A.tenantId, A.branchId, customer, at(hhmm), JSON.stringify([{ service_id: haircut, employee_id: employee }])]))[0].r;
const sale = async (customer, pay = null) => {
  const [{ r: d }] = await q(db, cashier.userId, `select public.create_invoice_draft($1, $2, $3, null, null) r`, [A.tenantId, A.branchId, customer]);
  await q(db, cashier.userId, `select public.save_invoice_draft($1, $2, $3)`, [d.invoice_id, customer, JSON.stringify([{ service_id: haircut }])]);
  const [{ r: inv }] = await q(db, cashier.userId, `select public.finalize_invoice($1) r`, [d.invoice_id]);
  if (pay) await q(db, cashier.userId, `select public.record_payment($1, 'card', $2, null, null)`, [inv.id, pay]);
  return inv;
};

before(async () => {
  D = bookingDate();
  db = await createDb();
  A = await createTenantWithOwner(db, { email: 'wa-owner-a@example.com', slug: 'wa-salon-a', name: 'Glow Salon' });
  B = await createTenantWithOwner(db, { email: 'wa-owner-b@example.com', slug: 'wa-salon-b' });
  await q(db, A.ownerId, `update public.tenants set name_ar = 'صالون جلو' where id = $1`, [A.tenantId]);
  await q(db, A.ownerId, `update public.tenant_settings set receipt_language = 'en', receipt_header_en = 'CR 123' where tenant_id = $1`, [A.tenantId]);
  cashier = await addMember(db, { tenantId: A.tenantId, inviterId: A.ownerId, email: 'wa-cash@example.com', roleCodes: ['cashier'], allBranches: true });
  stylist = await addMember(db, { tenantId: A.tenantId, inviterId: A.ownerId, email: 'wa-sty@example.com', roleCodes: ['stylist'], branchIds: [A.branchId] });
  otherStylist = await addMember(db, { tenantId: A.tenantId, inviterId: A.ownerId, email: 'wa-sty2@example.com', roleCodes: ['stylist'], branchIds: [A.branchId] });
  [{ id: haircut }] = await q(db, A.ownerId,
    `insert into public.services (tenant_id, name_en, name_ar, duration_minutes, price) values ($1, 'Haircut', 'قص شعر', 45, 12) returning id`, [A.tenantId]);
  const emp = (name, membership) =>
    q(db, A.ownerId, `insert into public.employees (tenant_id, name_en, membership_id) values ($1, $2, $3) returning id`, [A.tenantId, name, membership]).then((r) => r[0].id);
  reena = await emp('Reena', stylist.membershipId);
  merlyn = await emp('Merlyn', otherStylist.membershipId);
  const allWeek = JSON.stringify([0, 1, 2, 3, 4, 5, 6].map((d) => ({ branch_id: A.branchId, day_of_week: d, starts_at: '09:00', ends_at: '22:00' })));
  for (const e of [reena, merlyn]) {
    await q(db, A.ownerId, `select public.set_employee_assignments($1, $2, $3)`, [e, [A.branchId], [haircut]]);
    await q(db, A.ownerId, `select public.set_employee_shifts($1, $2)`, [e, allWeek]);
  }
  [aisha] = await q(db, A.ownerId, `insert into public.customers (tenant_id, first_name, last_name, mobile) values ($1, 'Aisha', 'Al Balushi', '91234567') returning id`, [A.tenantId]);
});

test('appointment details: number, message and a working manage link', async () => {
  const appt = await book('10:00', aisha.id);
  const s = await rpc(cashier.userId, 'get_appointment_share', appt.appointment_id);
  assert.equal(s.mobile, '+96891234567');
  assert.equal(s.name, 'Aisha Al Balushi');
  const [dd, mm, yyyy] = [D.slice(8, 10), D.slice(5, 7), D.slice(0, 4)];
  assert.ok(s.message.startsWith(`Hello Aisha, your appointment at Glow Salon`), s.message);
  assert.ok(s.message.includes(`${dd}/${mm}/${yyyy} at 10:00: Haircut`), s.message);
  assert.match(s.link, /^https:\/\/erp\.salonzoft\.com\/book\/manage\/[0-9a-f]{64}$/);
  assert.ok(s.message.endsWith(s.link));

  // The link is stable and opens the customer's booking page.
  assert.equal((await rpc(cashier.userId, 'get_appointment_share', appt.appointment_id)).link, s.link);
  const [{ b }] = await qAnon(db, `select public.public_get_booking($1) b`, [s.link.split('/').pop()]);
  assert.equal(b.status, 'booked');
  assert.equal(b.services[0].name_en, 'Haircut');
});

test('appointment wording follows the customer language, the salon template and the status', async () => {
  await q(db, A.ownerId, `update public.customers set preferred_language = 'ar' where id = $1`, [aisha.id]);
  const appt = await book('12:00', aisha.id);
  let s = await rpc(A.ownerId, 'get_appointment_share', appt.appointment_id);
  assert.ok(s.message.startsWith('مرحباً Aisha، تم حجز موعدك لدى صالون جلو'), s.message);
  assert.ok(s.message.includes('قص شعر'));

  await q(db, A.ownerId, `insert into public.notification_templates (tenant_id, event, channel, language, body)
                          values ($1, 'booking_confirmed', 'whatsapp', 'ar', 'موعدك {{date}} {{time}} مع {{staff}} — {{link}}')`, [A.tenantId]);
  s = await rpc(A.ownerId, 'get_appointment_share', appt.appointment_id);
  assert.ok(/^موعدك \d\d\/\d\d\/\d{4} 12:00 مع Reena — https:/.test(s.message), s.message);

  await q(db, A.ownerId, `select public.set_appointment_status($1, 'cancelled', 'test')`, [appt.appointment_id]);
  s = await rpc(A.ownerId, 'get_appointment_share', appt.appointment_id);
  assert.ok(s.message.includes('تم إلغاء موعدك'), s.message);
  await q(db, A.ownerId, `update public.customers set preferred_language = null where id = $1`, [aisha.id]);
});

test('a walk-in appointment has no number but still a clean message', async () => {
  const appt = await book('14:00', null);
  const s = await rpc(cashier.userId, 'get_appointment_share', appt.appointment_id);
  assert.equal(s.mobile, null);
  assert.equal(s.name, null);
  assert.ok(s.message.startsWith('Hello, your appointment at Glow Salon'), s.message);
});

test('appointments: only people who can see them may share them', async () => {
  const appt = await book('16:00', aisha.id, reena);
  await expectPgError(rpc(B.ownerId, 'get_appointment_share', appt.appointment_id), 'NOT_FOUND');
  await expectPgError(rpc(otherStylist.userId, 'get_appointment_share', appt.appointment_id), 'NOT_FOUND');
  assert.equal((await rpc(stylist.userId, 'get_appointment_share', appt.appointment_id)).mobile, '+96891234567');
  await assert.rejects(qAnon(db, `select public.get_appointment_share($1)`, [appt.appointment_id]), /permission denied/);
});

test('invoice: message with the amount and a private link that shows the invoice only', async () => {
  const inv = await sale(aisha.id, 12);
  const s = await rpc(cashier.userId, 'get_invoice_share', inv.id);
  assert.equal(s.mobile, '+96891234567');
  assert.equal(s.number, inv.number);
  assert.match(s.link, /^https:\/\/erp\.salonzoft\.com\/i\/[0-9a-f]{64}$/);
  assert.equal(s.message, `Hello Aisha, thank you for visiting Glow Salon. Your invoice ${inv.number}: OMR 12.000. View it here: ${s.link}`);
  assert.equal((await rpc(cashier.userId, 'get_invoice_share', inv.id)).link, s.link);

  const token = s.link.split('/').pop();
  const [{ d }] = await qAnon(db, `select public.public_get_invoice($1) d`, [token]);
  assert.deepEqual([d.number, d.seller_name, Number(d.total), Number(d.balance_due), d.customer_name, d.customer_mobile],
    [inv.number, 'Glow Salon', 12, 0, 'Aisha Al Balushi', null]);
  assert.deepEqual([d.items.length, d.items[0].description_en, d.payments.length, d.payments[0].method], [1, 'Haircut', 1, 'card']);
  assert.deepEqual([d.template.receipt_language, d.template.receipt_header_en, d.template.receipt_show_logo], ['en', 'CR 123', false]);
  for (const hidden of ['id', 'tenant_id', 'branch_id', 'customer_id', 'created_by', 'token', 'notes']) {
    assert.ok(!(hidden in d), `${hidden} must not be public`);
  }
});

test('invoice: balance due, Arabic, walk-in, and no access for others', async () => {
  const unpaid = await sale(aisha.id, 5);
  let s = await rpc(cashier.userId, 'get_invoice_share', unpaid.id);
  assert.ok(s.message.includes(`OMR 12.000 (balance due 7.000).`), s.message);

  await q(db, A.ownerId, `update public.customers set preferred_language = 'ar' where id = $1`, [aisha.id]);
  s = await rpc(cashier.userId, 'get_invoice_share', unpaid.id);
  assert.ok(s.message.startsWith(`مرحباً Aisha، شكراً لزيارتكم صالون جلو. فاتورتكم ${unpaid.number}: OMR 12.000 (المتبقي 7.000).`), s.message);

  const walkIn = await sale(null, 12);
  s = await rpc(cashier.userId, 'get_invoice_share', walkIn.id);
  assert.equal(s.mobile, null);
  assert.ok(s.message.startsWith('Hello, thank you for visiting Glow Salon.'), s.message);

  await expectPgError(rpc(B.ownerId, 'get_invoice_share', unpaid.id), 'NOT_FOUND');
  await expectPgError(rpc(stylist.userId, 'get_invoice_share', unpaid.id), 'NOT_FOUND');
  const [{ r: d }] = await q(db, cashier.userId, `select public.create_invoice_draft($1, $2, null, null, null) r`, [A.tenantId, A.branchId]);
  await expectPgError(rpc(cashier.userId, 'get_invoice_share', d.invoice_id), 'INVOICE_NOT_POSTED');
});

test('the public link needs the exact token', async () => {
  await expectPgError(qAnon(db, `select public.public_get_invoice($1)`, ['x'.repeat(64)]), 'NOT_FOUND');
  await expectPgError(qAnon(db, `select public.public_get_invoice($1)`, ['']), 'NOT_FOUND');
  await expectPgError(qAnon(db, `select public.public_get_invoice(null)`), 'NOT_FOUND');
  await assert.rejects(qAnon(db, `select token from public.invoice_share_links`), /permission denied/);
  await assert.rejects(q(db, A.ownerId, `select token from public.invoice_share_links`), /permission denied/);
  await assert.rejects(qAnon(db, `select public.get_invoice_share($1)`, [A.tenantId]), /permission denied/);
});

// Phase 2 · customers: isolation, permissions, mobile normalisation and
// uniqueness, search, duplicate detection, consent history, sensitive notes
// and CSV import.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createTenantWithOwner, q, expectPgError, addMember } from './helpers/db.mjs';

let db, A, B, receptionist, cashier, stylist, manager, aisha;

before(async () => {
  db = await createDb();
  A = await createTenantWithOwner(db, { email: 'crm-owner-a@example.com', slug: 'crm-salon-a' });
  B = await createTenantWithOwner(db, { email: 'crm-owner-b@example.com', slug: 'crm-salon-b' });
  receptionist = await addMember(db, { tenantId: A.tenantId, inviterId: A.ownerId, email: 'crm-rec@example.com', roleCodes: ['receptionist'], allBranches: true });
  cashier = await addMember(db, { tenantId: A.tenantId, inviterId: A.ownerId, email: 'crm-cash@example.com', roleCodes: ['cashier'], allBranches: true });
  stylist = await addMember(db, { tenantId: A.tenantId, inviterId: A.ownerId, email: 'crm-sty@example.com', roleCodes: ['stylist'], allBranches: true });
  manager = await addMember(db, { tenantId: A.tenantId, inviterId: A.ownerId, email: 'crm-mgr@example.com', roleCodes: ['manager'], allBranches: true });
  [aisha] = await q(db, receptionist.userId,
    `insert into public.customers (tenant_id, first_name, last_name, name_ar, mobile, email) values ($1, ' Aisha ', 'Al Balushi', 'عائشة البلوشية', '9123 4567', ' Aisha@Example.COM ') returning *`,
    [A.tenantId]);
});

test('names, email and mobile are normalised on write', async () => {
  assert.equal(aisha.first_name, 'Aisha');
  assert.equal(aisha.mobile, '+96891234567');
  assert.equal(aisha.email, 'aisha@example.com');
  assert.equal(aisha.created_by, receptionist.userId);
  assert.match(aisha.search_text, /عائشة/);
});

test('mobile formats map to one E.164 number', async () => {
  const cases = [
    ['91234567', '+96891234567'],
    ['+968 9123-4567', '+96891234567'],
    ['0096891234567', '+96891234567'],
    ['968 9123 4567', '+96891234567'],
    ['(+44) 7700 900123', '+447700900123'],
  ];
  for (const [raw, expected] of cases) {
    const [{ m }] = await db.query(`select app.normalize_mobile($1, '+968') as m`, [raw]).then((r) => r.rows);
    assert.equal(m, expected, raw);
  }
  const [{ m }] = (await db.query(`select app.normalize_mobile('   ', '+968') as m`)).rows;
  assert.equal(m, null);
  await expectPgError(db.query(`select app.normalize_mobile('123', '+968')`), 'INVALID_MOBILE');
});

test('one customer per mobile per tenant — but tenants are independent', async () => {
  await expectPgError(
    q(db, receptionist.userId, `insert into public.customers (tenant_id, first_name, mobile) values ($1, 'Copy', '+968 91234567')`, [A.tenantId]),
    /duplicate key/,
  );
  const [other] = await q(db, B.ownerId, `insert into public.customers (tenant_id, first_name, mobile) values ($1, 'Aisha', '91234567') returning id`, [B.tenantId]);
  assert.ok(other.id);
});

test('tenant isolation for customers, consents and notes', async () => {
  await q(db, A.ownerId, `insert into public.customer_notes (tenant_id, customer_id, body) values ($1, $2, 'Prefers mornings')`, [A.tenantId, aisha.id]);
  await q(db, A.ownerId, `insert into public.customer_consents (tenant_id, customer_id, channel, purpose, granted) values ($1, $2, 'whatsapp', 'reminders', true)`, [A.tenantId, aisha.id]);
  for (const table of ['customers', 'customer_consents', 'customer_notes']) {
    const rows = await q(db, B.ownerId, `select tenant_id from public.${table}`);
    for (const r of rows) assert.equal(r.tenant_id, B.tenantId, `${table} leaked`);
  }
  await expectPgError(
    q(db, B.ownerId, `insert into public.customer_notes (tenant_id, customer_id, body) values ($1, $2, 'x')`, [B.tenantId, aisha.id]),
    /foreign key/,
  );
  const upd = await q(db, B.ownerId, `update public.customers set first_name = 'Hacked' where id = $1 returning id`, [aisha.id]);
  assert.equal(upd.length, 0);
  await expectPgError(q(db, B.ownerId, `select * from public.search_customers($1, 'aisha')`, [A.tenantId]), 'FORBIDDEN');
});

test('permissions: cashier reads, stylist sees nothing, nobody deletes', async () => {
  assert.equal((await q(db, cashier.userId, `select id from public.customers`)).length, 1);
  await expectPgError(
    q(db, cashier.userId, `insert into public.customers (tenant_id, first_name) values ($1, 'Walk-in')`, [A.tenantId]),
    /row-level security/,
  );
  assert.equal((await q(db, stylist.userId, `select id from public.customers`)).length, 0);
  await expectPgError(q(db, A.ownerId, `delete from public.customers where id = $1`, [aisha.id]), /permission denied/);
  await expectPgError(
    q(db, receptionist.userId, `update public.customers set tenant_id = $1 where id = $2`, [B.tenantId, aisha.id]),
    /permission denied/,
  );
});

test('consent history is append-only', async () => {
  await q(db, receptionist.userId, `insert into public.customer_consents (tenant_id, customer_id, channel, purpose, granted) values ($1, $2, 'whatsapp', 'marketing', true)`, [A.tenantId, aisha.id]);
  await q(db, receptionist.userId, `insert into public.customer_consents (tenant_id, customer_id, channel, purpose, granted, source) values ($1, $2, 'whatsapp', 'marketing', false, 'customer_request')`, [A.tenantId, aisha.id]);
  await expectPgError(q(db, A.ownerId, `update public.customer_consents set granted = true`), /permission denied/);
  await expectPgError(q(db, A.ownerId, `delete from public.customer_consents`), /permission denied/);
  const [latest] = await q(db, receptionist.userId,
    `select granted, recorded_by from public.customer_consents where customer_id = $1 and channel = 'whatsapp' and purpose = 'marketing' order by recorded_at desc, id limit 1`,
    [aisha.id]);
  assert.equal(latest.recorded_by, receptionist.userId);
});

test('allergy and medical notes require customers.sensitive', async () => {
  await expectPgError(
    q(db, receptionist.userId, `insert into public.customer_notes (tenant_id, customer_id, kind, body) values ($1, $2, 'allergy', 'PPD')`, [A.tenantId, aisha.id]),
    /row-level security/,
  );
  // Manager holds customers.sensitive.
  await q(db, manager.userId, `insert into public.customer_notes (tenant_id, customer_id, kind, body) values ($1, $2, 'allergy', 'Allergic to PPD hair dye')`, [A.tenantId, aisha.id]);
  const mgr = await q(db, manager.userId, `select kind from public.customer_notes where customer_id = $1 order by kind`, [aisha.id]);
  assert.deepEqual(mgr.map((n) => n.kind), ['allergy', 'general']);
  const rec = await q(db, receptionist.userId, `select kind from public.customer_notes where customer_id = $1`, [aisha.id]);
  assert.deepEqual(rec.map((n) => n.kind), ['general']);
  // A general note can't be turned into a hidden medical note without the permission.
  await expectPgError(
    q(db, receptionist.userId, `update public.customer_notes set kind = 'medical' where customer_id = $1`, [aisha.id]),
    /row-level security/,
  );
  // Audit entries never contain note bodies.
  const audit = await q(db, A.ownerId, `select new_data from public.audit_logs where entity_type = 'customer_notes'`);
  assert.ok(audit.length > 0);
  for (const a of audit) assert.equal(a.new_data?.body, undefined);
});

test('search by name, Arabic name, partial mobile and email', async () => {
  await q(db, receptionist.userId, `insert into public.customers (tenant_id, first_name, last_name, mobile) values ($1, 'Fatma', 'Al Harthy', '99887766'), ($1, 'Maryam', null, '92001122')`, [A.tenantId]);
  const ids = async (term) => (await q(db, receptionist.userId, `select first_name from public.search_customers($1, $2)`, [A.tenantId, term])).map((r) => r.first_name);
  assert.deepEqual(await ids('aisha'), ['Aisha']);
  assert.deepEqual(await ids('البلوشية'), ['Aisha']);
  assert.deepEqual(await ids('9988'), ['Fatma']);
  assert.deepEqual(await ids('+968 9200 1122'), ['Maryam']);
  assert.deepEqual(await ids('AISHA@example'), ['Aisha']);
  assert.ok((await ids('harthi')).includes('Fatma'), 'fuzzy match tolerates spelling');
  assert.deepEqual(await ids('100%_'), []);
  assert.equal((await ids('')).length, 3);
  // Archived customers are hidden unless requested.
  await q(db, receptionist.userId, `update public.customers set status = 'archived' where first_name = 'Maryam' and tenant_id = $1`, [A.tenantId]);
  assert.deepEqual(await ids('maryam'), []);
});

test('duplicate detection by mobile, email and similar name', async () => {
  const dupes = async (...args) =>
    q(db, receptionist.userId, `select first_name, reason from public.find_customer_duplicates($1, $2, $3, $4, $5, $6)`, [A.tenantId, ...args]);
  assert.deepEqual(await dupes('+96891234567', null, 'Someone', null, null), [{ first_name: 'Aisha', reason: 'mobile' }]);
  assert.deepEqual(await dupes(null, 'aisha@EXAMPLE.com', 'Someone', null, null), [{ first_name: 'Aisha', reason: 'email' }]);
  assert.deepEqual((await dupes(null, null, 'Fatma', 'Al Harthi', null)).map((d) => d.reason), ['name']);
  assert.deepEqual(await dupes('91234567', null, 'Aisha', 'Al Balushi', aisha.id), [], 'the edited customer is excluded');
  assert.deepEqual(await dupes('not a number', null, 'Nobody Here', null, null), []);
});

test('CSV import: dry run, duplicates, per-row errors, consent and notes', async () => {
  const rows = [
    { first_name: 'Noor', last_name: 'Al Said', mobile: '9555 1111', email: 'noor@example.com', tags: 'vip;hair', whatsapp_marketing: 'yes', note: 'Imported from SMSERP' },
    { first_name: 'Aisha copy', mobile: '+968 9123 4567' },                    // existing customer
    { first_name: 'Noor twin', mobile: '95551111' },                           // duplicate inside the file
    { first_name: '', mobile: '95552222' },                                    // invalid name
    { first_name: 'Bad phone', mobile: '12' },                                 // invalid mobile
    { first_name: 'Bad date', mobile: '95553333', date_of_birth: '1990-13-40' },
    { first_name: 'Ref', external_ref: 'SM-1' },
    { first_name: 'Ref twin', external_ref: 'SM-1' },                          // duplicate external_ref
  ];
  const run = async (dry) => (await q(db, receptionist.userId, `select public.import_customers($1, $2, $3) r`, [A.tenantId, JSON.stringify(rows), dry]))[0].r;
  const countNoor = async () => (await q(db, A.ownerId, `select count(*)::int n from public.customers where tenant_id = $1 and first_name = 'Noor'`, [A.tenantId]))[0].n;

  const dry = await run(true);
  assert.equal(dry.dry_run, true);
  assert.equal(dry.inserted, 2);
  assert.deepEqual(dry.duplicates.map((d) => d.row), [2, 3, 8]);
  assert.deepEqual(dry.errors.map((e) => [e.row, e.code]), [[4, 'INVALID_NAME'], [5, 'INVALID_MOBILE'], [6, 'INVALID_DATE']]);
  assert.equal(await countNoor(), 0, 'dry run writes nothing');

  const real = await run(false);
  assert.equal(real.inserted, 2);
  assert.deepEqual(real.duplicates.map((d) => d.row), [2, 3, 8]);
  const [noor] = await q(db, A.ownerId, `select id, source, tags, mobile from public.customers where tenant_id = $1 and first_name = 'Noor'`, [A.tenantId]);
  assert.deepEqual({ source: noor.source, tags: noor.tags, mobile: noor.mobile }, { source: 'import', tags: ['hair', 'vip'], mobile: '+96895551111' });
  const consent = await q(db, A.ownerId, `select granted, source from public.customer_consents where customer_id = $1`, [noor.id]);
  assert.deepEqual(consent, [{ granted: true, source: 'import' }]);
  assert.equal((await q(db, A.ownerId, `select id from public.customer_notes where customer_id = $1`, [noor.id])).length, 1);

  // Re-running the same file is safe: everything is now a duplicate.
  const again = await run(false);
  assert.equal(again.inserted, 0);

  await expectPgError(q(db, cashier.userId, `select public.import_customers($1, '[]')`, [A.tenantId]), 'FORBIDDEN');
  await expectPgError(q(db, A.ownerId, `select public.import_customers($1, '{}')`, [A.tenantId]), 'INVALID_IMPORT');
  const big = JSON.stringify(Array.from({ length: 2001 }, (_, i) => ({ first_name: `C${i}` })));
  await expectPgError(q(db, A.ownerId, `select public.import_customers($1, $2)`, [A.tenantId, big]), 'IMPORT_TOO_LARGE');
});

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createUser, q, expectPgError } from './helpers/db.mjs';

let db, uid;
before(async () => {
  db = await createDb();
  uid = await createUser(db, 'founder@example.com', { fullName: 'Founder' });
});

test('create_tenant provisions tenant, settings, trial, entitlements, roles, owner, main branch and hours', async () => {
  const [{ r }] = await q(db, uid, `select public.create_tenant('Al Noor Spa', 'al-noor', 'spa', 'Muscat Grand Mall', 'ar') as r`);
  assert.equal(r.slug, 'al-noor');
  assert.equal(r.replayed, false);

  const [settings] = await q(db, uid, `select * from public.tenant_settings where tenant_id = $1`, [r.tenant_id]);
  assert.equal(settings.currency_code, 'OMR');
  assert.equal(settings.currency_decimals, 3);
  assert.equal(settings.timezone, 'Asia/Muscat');
  assert.equal(settings.phone_country_code, '+968');
  assert.equal(settings.default_vat_rate, '5.00');
  assert.equal(settings.default_language, 'ar');
  assert.deepEqual(settings.weekend_days, [5, 6]);

  const [sub] = await q(db, uid, `select status, trial_ends_at from public.tenant_subscriptions where tenant_id = $1`, [r.tenant_id]);
  assert.equal(sub.status, 'trialing');
  assert.ok(new Date(sub.trial_ends_at) > new Date(Date.now() + 13 * 86400_000));

  const roles = await q(db, uid, `select code from public.roles where tenant_id = $1 order by code`, [r.tenant_id]);
  assert.deepEqual(roles.map((x) => x.code), ['accountant', 'cashier', 'manager', 'receptionist', 'stylist']);

  const [mem] = await q(db, uid, `select is_owner, all_branches from public.tenant_memberships where tenant_id = $1`, [r.tenant_id]);
  assert.deepEqual(mem, { is_owner: true, all_branches: true });

  const [branch] = await q(db, uid, `select code, name_en, is_main from public.branches where id = $1`, [r.branch_id]);
  assert.deepEqual(branch, { code: 'MAIN', name_en: 'Muscat Grand Mall', is_main: true });

  const hours = await q(db, uid, `select day_of_week, opens_at::text, closes_at::text from public.branch_working_hours where branch_id = $1 order by day_of_week`, [r.branch_id]);
  assert.equal(hours.length, 7);
  assert.deepEqual(hours[5], { day_of_week: 5, opens_at: '14:00:00', closes_at: '22:00:00' }); // Friday

  const [{ c }] = await q(db, uid, `select public.get_tenant_context($1) c`, [r.tenant_id]);
  assert.ok(c.permissions.includes('settings.manage'));
  assert.ok(c.permissions.includes('billing.manage'));
  assert.equal(c.operational, true);

  const audit = await q(db, uid, `select action from public.audit_logs where tenant_id = $1 and action = 'tenant.created'`, [r.tenant_id]);
  assert.equal(audit.length, 1);
});

test('create_tenant is idempotent per user + key', async () => {
  const [{ r: first }] = await q(db, uid, `select public.create_tenant('Fade Lab', 'fade-lab', 'barbershop', null, 'en', 'key-123') as r`);
  const [{ r: second }] = await q(db, uid, `select public.create_tenant('Fade Lab', 'fade-lab', 'barbershop', null, 'en', 'key-123') as r`);
  assert.equal(second.tenant_id, first.tenant_id);
  assert.equal(second.replayed, true);
  const [{ n }] = (await db.query(`select count(*)::int n from public.tenants where slug = 'fade-lab'`)).rows;
  assert.equal(n, 1);
});

test('create_tenant validates input with structured error codes', async () => {
  await expectPgError(q(db, uid, `select public.create_tenant('X', 'ok-slug')`), 'INVALID_NAME');
  await expectPgError(q(db, uid, `select public.create_tenant('Valid', 'Bad Slug')`), 'INVALID_SLUG');
  await expectPgError(q(db, uid, `select public.create_tenant('Valid', 'a--b')`), 'INVALID_SLUG');
  await expectPgError(q(db, uid, `select public.create_tenant('Valid', 'admin')`), 'SLUG_RESERVED');
  await expectPgError(q(db, uid, `select public.create_tenant('Valid', 'valid-x', 'casino')`), 'INVALID_BUSINESS_TYPE');
  await expectPgError(q(db, uid, `select public.create_tenant('Valid', 'valid-y', 'spa', null, 'fr')`), 'INVALID_LANGUAGE');
  await expectPgError(q(db, uid, `select public.create_tenant('Dup', 'al-noor')`), 'TENANT_SLUG_TAKEN');
});

test('a failed create_tenant leaves no partial rows', async () => {
  const before = (await db.query(`select (select count(*) from public.tenants) t, (select count(*) from public.roles) r, (select count(*) from public.branches) b`)).rows[0];
  await expectPgError(q(db, uid, `select public.create_tenant('Dup', 'al-noor')`), 'TENANT_SLUG_TAKEN');
  const after = (await db.query(`select (select count(*) from public.tenants) t, (select count(*) from public.roles) r, (select count(*) from public.branches) b`)).rows[0];
  assert.deepEqual(after, before);
});

test('a user can create at most 5 tenants', async () => {
  const other = await createUser(db, 'serial@example.com');
  for (let i = 0; i < 5; i++) {
    await q(db, other, `select public.create_tenant($1, $2)`, [`Chain ${i}`, `chain-${i}`]);
  }
  await expectPgError(q(db, other, `select public.create_tenant('Chain 6', 'chain-6')`), 'TENANT_LIMIT_REACHED');
});

test('is_slug_available', async () => {
  const [{ a }] = await q(db, uid, `select public.is_slug_available('al-noor') a`);
  const [{ b }] = await q(db, uid, `select public.is_slug_available('brand-new') b`);
  const [{ c }] = await q(db, uid, `select public.is_slug_available('NO SPACES') c`);
  assert.deepEqual([a, b, c], [false, true, false]);
});

test('timezone is validated on settings and branches', async () => {
  const [{ r }] = await q(db, uid, `select public.create_tenant('Tz Test', 'tz-test') as r`);
  await expectPgError(
    q(db, uid, `update public.tenant_settings set timezone = 'Mars/Olympus' where tenant_id = $1`, [r.tenant_id]),
    'INVALID_TIMEZONE',
  );
  await q(db, uid, `update public.tenant_settings set timezone = 'Asia/Dubai' where tenant_id = $1`, [r.tenant_id]);
});

test('VAT registration requires a VAT number', async () => {
  const [{ r }] = await q(db, uid, `select public.create_tenant('Vat Test', 'vat-test') as r`);
  await expectPgError(
    q(db, uid, `update public.tenant_settings set vat_registered = true where tenant_id = $1`, [r.tenant_id]),
    /tenant_settings_vat_number_required/,
  );
  await q(db, uid, `update public.tenant_settings set vat_registered = true, vat_number = 'OM1100123456' where tenant_id = $1`, [r.tenant_id]);
});

test('branch working hours: atomic replace, split shifts, overlap rejection', async () => {
  const [{ r }] = await q(db, uid, `select public.create_tenant('Hours Test', 'hours-test') as r`);
  const rows = await q(db, uid, `select * from public.set_branch_working_hours($1, $2::jsonb)`, [
    r.branch_id,
    JSON.stringify([
      { day_of_week: 5, opens_at: '09:00', closes_at: '11:30' },
      { day_of_week: 5, opens_at: '14:00', closes_at: '24:00' },
      { day_of_week: 0, opens_at: '10:00', closes_at: '22:00' },
    ]),
  ]);
  assert.equal(rows.length, 3);
  await expectPgError(
    q(db, uid, `select * from public.set_branch_working_hours($1, $2::jsonb)`, [
      r.branch_id,
      JSON.stringify([
        { day_of_week: 1, opens_at: '09:00', closes_at: '13:00' },
        { day_of_week: 1, opens_at: '12:00', closes_at: '18:00' },
      ]),
    ]),
    'OVERLAPPING_WORKING_HOURS',
  );
  await expectPgError(
    q(db, uid, `select * from public.set_branch_working_hours($1, $2::jsonb)`, [r.branch_id, JSON.stringify([{ day_of_week: 1, opens_at: 'nine', closes_at: '13:00' }])]),
    'INVALID_WORKING_HOURS',
  );
  await expectPgError(
    q(db, uid, `select * from public.set_branch_working_hours($1, $2::jsonb)`, [r.branch_id, JSON.stringify([{ day_of_week: 1, opens_at: '13:00', closes_at: '09:00' }])]),
    'INVALID_WORKING_HOURS',
  );
  // Failed calls left the previous schedule intact.
  const [{ n }] = await q(db, uid, `select count(*)::int n from public.branch_working_hours where branch_id = $1`, [r.branch_id]);
  assert.equal(n, 3);
});

test('branch limit from plan is enforced (professional = 3)', async () => {
  const uid = await createUser(db, 'branchy@example.com');
  const [{ r }] = await q(db, uid, `select public.create_tenant('Branchy', 'branchy') as r`);
  await q(db, uid, `insert into public.branches (tenant_id, code, name_en) values ($1, 'B2', 'Second')`, [r.tenant_id]);
  await q(db, uid, `insert into public.branches (tenant_id, code, name_en) values ($1, 'B3', 'Third')`, [r.tenant_id]);
  await expectPgError(
    q(db, uid, `insert into public.branches (tenant_id, code, name_en) values ($1, 'B4', 'Fourth')`, [r.tenant_id]),
    'PLAN_LIMIT_BRANCHES',
  );
});

test('setting a new main branch demotes the old one', async () => {
  const uid = await createUser(db, 'mainswap@example.com');
  const [{ r }] = await q(db, uid, `select public.create_tenant('Main Swap', 'main-swap') as r`);
  const [b2] = await q(db, uid, `insert into public.branches (tenant_id, code, name_en) values ($1, 'B2', 'Second') returning id`, [r.tenant_id]);
  await q(db, uid, `update public.branches set is_main = true where id = $1`, [b2.id]);
  const mains = await q(db, uid, `select id from public.branches where tenant_id = $1 and is_main`, [r.tenant_id]);
  assert.deepEqual(mains.map((m) => m.id), [b2.id]);
});

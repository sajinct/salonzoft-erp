// Static security invariants of the schema — these guard every future
// migration: a new table without RLS, or a SECURITY DEFINER function without a
// pinned search_path / with anon EXECUTE, fails the build.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, qAnon, createUser, q } from './helpers/db.mjs';

let db;
before(async () => {
  db = await createDb();
});

test('RLS is enabled on every table in public', async () => {
  const { rows } = await db.query(`
    select c.relname
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity`);
  assert.deepEqual(rows, [], `Tables without RLS: ${rows.map((r) => r.relname).join(', ')}`);
});

test('every business table (except catalogues/profiles) has tenant_id NOT NULL', async () => {
  const exempt = new Set([
    'modules', 'permissions', 'subscription_plans', 'plan_modules', 'role_templates',
    'role_template_permissions', 'platform_admins', 'profiles', 'tenants', 'audit_logs',
  ]);
  const { rows: tables } = await db.query(`
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'`);
  for (const { relname } of tables) {
    if (exempt.has(relname)) continue;
    const { rows } = await db.query(
      `select is_nullable from information_schema.columns
       where table_schema = 'public' and table_name = $1 and column_name = 'tenant_id'`,
      [relname],
    );
    assert.equal(rows.length, 1, `${relname} has no tenant_id column`);
    assert.equal(rows[0].is_nullable, 'NO', `${relname}.tenant_id must be NOT NULL`);
  }
});

test('SECURITY DEFINER functions pin search_path', async () => {
  const { rows } = await db.query(`
    select n.nspname || '.' || p.proname as fn
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'app') and p.prosecdef
      and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')`);
  assert.deepEqual(rows, []);
});

test('anon cannot execute any public function', async () => {
  const { rows } = await db.query(`
    select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute')`);
  assert.deepEqual(rows, [], `anon can execute: ${rows.map((r) => r.proname).join(', ')}`);
});

test('PUBLIC has no EXECUTE on SECURITY DEFINER functions', async () => {
  const { rows } = await db.query(`
    select n.nspname || '.' || p.proname as fn
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    where n.nspname in ('public', 'app') and p.prosecdef and a.grantee = 0 and a.privilege_type = 'EXECUTE'`);
  assert.deepEqual(rows, []);
});

test('anon sees nothing except public subscription plans', async () => {
  const plans = await qAnon(db, `select code from public.subscription_plans order by sort_order`);
  assert.deepEqual(plans.map((p) => p.code), ['starter', 'professional', 'enterprise']);
  for (const table of ['tenants', 'branches', 'profiles', 'tenant_memberships', 'audit_logs', 'roles']) {
    await assert.rejects(qAnon(db, `select * from public.${table}`), /permission denied/);
  }
});

test('anon cannot call create_tenant', async () => {
  await assert.rejects(qAnon(db, `select public.create_tenant('X', 'anon-salon')`), /permission denied/);
});

test('signed-in users cannot write audit logs, subscriptions or entitlements directly', async () => {
  const uid = await createUser(db, 'schema-writer@example.com');
  await assert.rejects(
    q(db, uid, `insert into public.audit_logs (action, entity_type) values ('x', 'y')`),
    /permission denied/,
  );
  await assert.rejects(
    q(db, uid, `update public.tenant_subscriptions set status = 'active'`),
    /permission denied/,
  );
  await assert.rejects(
    q(db, uid, `insert into public.module_entitlements (tenant_id, module_code) values (gen_random_uuid(), 'pos')`),
    /permission denied/,
  );
  await assert.rejects(q(db, uid, `insert into public.platform_admins (user_id) values ($1)`, [uid]), /permission denied/);
});

test('a profile is created for every new auth user with sanitised metadata', async () => {
  const { rows } = await db.query(
    `insert into auth.users (email, raw_user_meta_data) values ('meta@example.com', '{"full_name":"  Aisha  ","preferred_language":"xx"}') returning id`,
  );
  const [profile] = (await db.query(`select full_name, preferred_language from public.profiles where id = $1`, [rows[0].id])).rows;
  assert.deepEqual(profile, { full_name: 'Aisha', preferred_language: 'en' });
});

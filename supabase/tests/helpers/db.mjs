// Test harness: boots PGlite, applies the Supabase shim + every migration in
// order, and offers helpers to run SQL as a specific authenticated user.
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const supabaseDir = join(here, '..', '..');
const migrationsDir = join(supabaseDir, 'migrations');

export function migrationFiles() {
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

/** Fresh database with all migrations applied. */
export async function createDb() {
  // Extensions used by migrations (Supabase installs them into `extensions`).
  const db = new PGlite({ extensions: { pg_trgm, btree_gist } });
  await db.exec(readFileSync(join(here, 'supabase-shim.sql'), 'utf8'));
  for (const file of migrationFiles()) {
    try {
      await db.exec(readFileSync(join(migrationsDir, file), 'utf8'));
    } catch (err) {
      err.message = `Migration ${file} failed: ${err.message}`;
      throw err;
    }
  }
  return db;
}

/** Create an auth user (as the platform would). Returns the user's id. */
export async function createUser(db, email, { fullName = null, confirmed = true } = {}) {
  const { rows } = await db.query(
    `insert into auth.users (email, raw_user_meta_data, email_confirmed_at)
     values ($1, jsonb_build_object('full_name', $2::text), case when $3 then now() end)
     returning id`,
    [email, fullName, confirmed],
  );
  return rows[0].id;
}

async function withClaims(db, role, claims, fn) {
  return db.transaction(async (tx) => {
    await tx.exec(`set local role ${role}`);
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
    return fn(tx);
  });
}

/** Run `fn(tx)` inside a transaction as the given authenticated user. */
export function asUser(db, userId, fn) {
  return withClaims(db, 'authenticated', { sub: userId, role: 'authenticated' }, fn);
}

/** Run `fn(tx)` as an anonymous (signed-out) client. */
export function asAnon(db, fn) {
  return withClaims(db, 'anon', { role: 'anon' }, fn);
}

/** Convenience: run one query as a user and return rows. */
export async function q(db, userId, sql, params = []) {
  return asUser(db, userId, async (tx) => (await tx.query(sql, params)).rows);
}

export async function qAnon(db, sql, params = []) {
  return asAnon(db, async (tx) => (await tx.query(sql, params)).rows);
}

/** Assert that a promise rejects with the given Postgres message (error code). */
export async function expectPgError(promise, expected) {
  try {
    await promise;
  } catch (err) {
    const matches = expected instanceof RegExp ? expected.test(err.message) : err.message === expected;
    assert.ok(matches, `Expected error ${expected} but got: ${err.message}`);
    return err;
  }
  assert.fail(`Expected error ${expected} but the statement succeeded`);
}

/** Create a user who owns a fresh tenant. */
export async function createTenantWithOwner(db, { email, slug, name = 'Salon ' + slug } = {}) {
  const ownerId = await createUser(db, email, { fullName: `Owner of ${slug}` });
  const [{ create_tenant: result }] = await q(db, ownerId, `select public.create_tenant($1, $2) as create_tenant`, [
    name,
    slug,
  ]);
  return { ownerId, tenantId: result.tenant_id, branchId: result.branch_id };
}

/** Invite + accept in one go; returns the new member's user id and membership id. */
export async function addMember(db, { tenantId, inviterId, email, roleCodes = [], allBranches = false, branchIds = [] }) {
  const roleRows = await q(db, inviterId, `select id from public.roles where tenant_id = $1 and code = any($2)`, [
    tenantId,
    roleCodes,
  ]);
  const [{ inv }] = await q(db, inviterId, `select public.create_invitation($1, $2, $3, $4, $5) as inv`, [
    tenantId,
    email,
    roleRows.map((r) => r.id),
    allBranches,
    branchIds,
  ]);
  const userId = await createUser(db, email);
  const [{ res }] = await q(db, userId, `select public.accept_invitation($1) as res`, [inv.token]);
  return { userId, membershipId: res.membership_id };
}

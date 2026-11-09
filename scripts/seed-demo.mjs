#!/usr/bin/env node
// Creates demo data in a LOCAL Supabase stack through the real flows:
//   * two businesses with owners (tenant isolation is visible in the UI),
//   * a second branch, and staff invited + accepted with different roles.
//
// Usage (local only — refuses to run against *.supabase.co):
//   SUPABASE_URL=http://127.0.0.1:54321 \
//   SUPABASE_PUBLISHABLE_KEY=<anon/publishable key> \
//   SUPABASE_SECRET_KEY=<service_role/secret key> \
//   npm run db:seed:demo
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
const publishable = process.env.SUPABASE_PUBLISHABLE_KEY;
const secret = process.env.SUPABASE_SECRET_KEY;
if (!publishable || !secret) {
  console.error('Set SUPABASE_PUBLISHABLE_KEY and SUPABASE_SECRET_KEY (see `npx supabase status`).');
  process.exit(1);
}
if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url)) {
  console.error(`Refusing to seed non-local Supabase at ${url}`);
  process.exit(1);
}

const PASSWORD = 'Salonzoft2026!';
const admin = createClient(url, secret, { auth: { persistSession: false } });

async function user(email, fullName) {
  const { data, error } = await admin.auth.admin.createUser({
    email, password: PASSWORD, email_confirm: true, user_metadata: { full_name: fullName },
  });
  if (error && !/already/i.test(error.message)) throw error;
  const client = createClient(url, publishable, { auth: { persistSession: false } });
  const signIn = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error) throw signIn.error;
  return { client, id: data?.user?.id ?? signIn.data.user.id };
}

async function rpc(client, fn, args) {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message} ${error.details ?? ''}`);
  return data;
}

const owner = await user('owner@alnoor.test', 'Fatma Al Balushi');
const tenant = await rpc(owner.client, 'create_tenant', {
  p_name: 'Al Noor Beauty Lounge', p_slug: 'al-noor', p_business_type: 'beauty_salon',
  p_branch_name: 'Al Mouj', p_default_language: 'en', p_idempotency_key: 'seed-al-noor',
});
await owner.client.from('tenants').update({ name_ar: 'صالون النور للتجميل', legal_name: 'Al Noor Beauty Lounge LLC' }).eq('id', tenant.tenant_id);
await owner.client.from('tenant_settings').update({ vat_registered: true, vat_number: 'OM1100000001' }).eq('tenant_id', tenant.tenant_id);

let seeb = (await owner.client.from('branches').select('id').eq('tenant_id', tenant.tenant_id).eq('code', 'SEEB').maybeSingle()).data;
if (!seeb) {
  const { data, error } = await owner.client.from('branches')
    .insert({ tenant_id: tenant.tenant_id, code: 'SEEB', name_en: 'Seeb', name_ar: 'السيب', city: 'Seeb', governorate: 'Muscat' })
    .select('id').single();
  if (error) throw error;
  seeb = data;
}

const roles = Object.fromEntries(
  ((await owner.client.from('roles').select('id, code').eq('tenant_id', tenant.tenant_id)).data ?? []).map((r) => [r.code, r.id]),
);

for (const [email, name, role, branches] of [
  ['manager@alnoor.test', 'Salim Al Hinai', 'manager', [tenant.branch_id]],
  ['reception@alnoor.test', 'Maryam Al Lawati', 'receptionist', [seeb.id]],
]) {
  const inv = await rpc(owner.client, 'create_invitation', {
    p_tenant: tenant.tenant_id, p_email: email, p_role_ids: [roles[role]], p_all_branches: false, p_branch_ids: branches,
  }).catch((e) => (/MEMBER_ALREADY_EXISTS/.test(e.message) ? null : Promise.reject(e)));
  if (inv) {
    const staff = await user(email, name);
    await rpc(staff.client, 'accept_invitation', { p_token: inv.token });
  }
}

const other = await user('owner@fadelab.test', 'Ahmed Al Rawahi');
await rpc(other.client, 'create_tenant', {
  p_name: 'Fade Lab Barbers', p_slug: 'fade-lab', p_business_type: 'barbershop',
  p_branch_name: 'Qurum', p_default_language: 'ar', p_idempotency_key: 'seed-fade-lab',
});

console.log(`Seeded. Sign in with any of these (password ${PASSWORD}):
  owner@alnoor.test      (owner, 2 branches)
  manager@alnoor.test    (manager, Al Mouj only)
  reception@alnoor.test  (receptionist, Seeb only)
  owner@fadelab.test     (separate tenant — cannot see Al Noor)`);

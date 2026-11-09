# 06 · Environments and deployment

## Environments

| | Local | Staging | Production |
|---|---|---|---|
| Frontend | `ng serve` (http://localhost:4200) | Cloudflare Pages project `salonzoft-staging` | Cloudflare Pages project `salonzoft` (salonzoft.com) |
| Backend | `supabase start` (Docker) | Supabase project (separate) | Supabase project (Pro or higher, **PITR enabled**, region nearest Oman, e.g. `me-central-1` / `ap-south-1`; confirm data-residency needs) |
| Angular config | `environment.ts` | `environment.staging.ts` (`--configuration staging`) | `environment.production.ts` |

Only the **publishable (anon) key** goes in Angular. The secret/service-role key, gateway keys and WhatsApp tokens live in Edge Function secrets (`supabase secrets set …`) or Vault, never in the repo.

## Local development

```bash
# Node ≥ 22.22.3 or ≥ 24.15 (the repo was bootstrapped with a portable Node 24 in .tools/)
npm install && npm install --prefix apps/web

npm run test:db                      # migrations + RLS/security suite in PGlite (no Docker needed)

npx supabase start                   # requires Docker Desktop; applies migrations + seed.sql
npx supabase status                  # copy the API URL + publishable/anon key
#   → paste the key into apps/web/src/environments/environment.ts
npm run db:seed:demo                 # optional demo tenants/users (env vars in scripts/seed-demo.mjs)
npm run db:types                     # regenerate TS types from the running DB
npm run web:start                    # http://localhost:4200
npm run test:e2e                     # Playwright (after: npm run test:e2e:install)
```

Without Docker, `npm run db:types:offline` produces the same Supabase-format types from the migrations via PGlite.

## Supabase project setup (staging and production)

1. Create the project, set a strong DB password, enable PITR (production).
2. `supabase link --project-ref <ref>` then `supabase db push` (CI does this on merge to `main` for staging).
3. **Auth → URL configuration:** Site URL `https://salonzoft.com`. Redirect URLs `https://salonzoft.com/**` (staging: `https://staging.salonzoft.com/**` and `https://*.salonzoft-staging.pages.dev/**` for previews).
4. **Auth → Providers → Email:** enable *Confirm email*, secure password change, min length 10 with mixed case and digits (matching `config.toml`). Configure custom SMTP (the default sender is rate limited).
5. **Auth → Rate limits** and **Attack protection:** enable CAPTCHA (Turnstile) before opening public sign-up.
6. **API:** exposed schemas `public` only. Keep `app` unexposed.
7. **CORS:** PostgREST/Auth accept browser calls with the publishable key. Edge Functions must answer CORS themselves with an explicit allow-list (`https://salonzoft.com`, staging origin), never `*` for credentialed endpoints.
8. **Storage:** the bucket is created by migration 0007. Confirm it shows *private*.
9. **Secrets:** `supabase secrets set APP_URL=… ALLOWED_ORIGINS=…` (plus provider keys as phases ship).

## Cloudflare Pages

* Build command: `npm ci --prefix apps/web && npm --prefix apps/web run build -- --configuration production`
* Output directory: `apps/web/dist/web/browser`
* `public/_redirects` gives the SPA fallback. `public/_headers` sets HSTS, nosniff, frame-deny and CSP. **Before production:** replace the Supabase host placeholder and the hash of the inline theme/lang boot script in the CSP (or move that script to a file).
* Node version env var: `NODE_VERSION=24`.
* Custom domain `salonzoft.com` with *Always use HTTPS*.

## CI/CD (`.github/workflows/ci.yml`)

PR / push → **database** (PGlite security suite + generated-types drift check) → **web** (Vitest + production build) → **e2e** (Supabase in Docker + Playwright). On `main`: **deploy-staging** (`supabase db push` + Pages deploy). Promote to production with a tagged release workflow using the same steps against the production project, protected by a GitHub Environment with required reviewers.

## Migrations: rules and rollback

* Every schema change is a new file in `supabase/migrations`. **No dashboard edits.** Run `supabase db diff` to detect drift.
* Migrations are forward-only. Rollback means writing a new corrective migration. For destructive changes, use expand → migrate → contract across releases.
* Frontend rollback: Cloudflare Pages *Rollback to deployment* (instant). Keep the frontend backward-compatible with the previous DB version for one release.
* Before a production push: `supabase db push --dry-run`, then a manual PITR restore point label.

## Backup and restore

| Asset | Mechanism | Drill |
|---|---|---|
| Postgres | Supabase daily backups + **PITR** (production) | Quarterly: restore to a new project, run `npm run test:db`-equivalent smoke queries, verify row counts per tenant |
| Logical export | Nightly `supabase db dump --data-only` to encrypted off-platform storage (e.g. Cloudflare R2, Oman/GCC region if required) | Monthly restore into staging |
| Storage objects | **Not included in DB backups.** Nightly S3-compatible sync of buckets to R2 with versioning | Quarterly sample restore |
| Secrets | Documented in a password manager; rotated on staff change | – |

## Monitoring and alerts

Supabase reports (API errors, slow queries via `pg_stat_statements`, connection usage), log drains to your log platform, Edge Function error alerts, Cloudflare Web Analytics, and uptime checks on `/` and `${SUPABASE_URL}/auth/v1/health`. Alert on: 5xx rate, RLS-denied spikes (possible probing), DB CPU above 70%, connections above 80%, failed notification jobs, webhook signature failures.

## Commercial production readiness

The free tier (auto-pause, no PITR, low limits) is not suitable for paying tenants. Use Pro or higher with compute sized from load tests, PITR, and a support plan. Before launch, complete the Phase 7 security review, tax compliance review (VAT, Fawtara) and privacy review (Oman PDPL, Royal Decree 6/2022).

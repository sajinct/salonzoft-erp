# Salonzoft

Multi-tenant **Salon & Spa ERP SaaS** for Oman (then GCC and India), built with **Angular 22** and **Supabase** (PostgreSQL, Auth, RLS, Storage, Realtime, Edge Functions). There is no separate API server.

> **Status: Phase 1 (SaaS foundation) and Phase 2 (services, employees and shifts, customers, appointments with a no-double-booking guarantee, live calendar) and Phase 3 (POS, VAT invoices, payments, cash drawer, credit notes, packages, memberships, gift vouchers, deposits) and Phase 4 part 1 (inventory, purchasing, retail and consumables) delivered.** Auth, self-service onboarding, multi-tenant/branch isolation, roles and permissions, subscriptions and entitlements, settings (business, VAT, branches and hours, team, roles, profile), the first dashboard, and English/Arabic RTL. 123 database security tests, 46 frontend unit tests and 8 Playwright E2E tests (on real Supabase in CI) pass. Live preview: https://erp.salonzoft.com/ See [docs/07-roadmap-and-status.md](docs/07-roadmap-and-status.md).

## Repository layout

```text
apps/web/            Angular app (Salon ERP; staff portal, booking portal and super-admin share it as they ship)
supabase/
  migrations/        SQL migrations (schema, RLS, grants, triggers, RPCs, storage policies)
  tests/             Database security suite (runs real migrations in PGlite — no Docker needed)
  config.toml        Local Supabase stack config (least-privilege defaults)
  seed.sql           Local seed notes (demo data via scripts/seed-demo.mjs)
scripts/             gen-db-types.mjs (offline type generation), seed-demo.mjs
tests/e2e/           Playwright end-to-end tests
docs/                Architecture, ERD, security and permission matrix, RPC/Edge catalogue, frontend, deployment, roadmap
.github/workflows/   CI: DB tests → unit tests + build → E2E on Supabase in Docker → staging deploy
```

## Quick start

**Node:** ≥ 22.22.3 or ≥ 24.15 (Angular 22 requirement). If your system Node is older, use nvm/fnm or a portable Node; this repo was bootstrapped with one in the git-ignored `.tools/` folder (`export PATH="$PWD/.tools/node:$PATH"`).

```bash
npm install && npm install --prefix apps/web

npm run test:db          # 123 database security tests: RLS, tenant/branch isolation, escalation, plan gating, storage, services/staff/customers
npm run web:test         # Angular unit tests (Vitest)
npm run web:build        # production build

# Full local stack (requires Docker Desktop)
npx supabase start       # applies migrations
npx supabase status      # copy the publishable/anon key → apps/web/src/environments/environment.ts
npm run db:seed:demo     # optional demo businesses and staff (see script header for env vars)
npm run web:start        # http://localhost:4200
npm run test:e2e:install && npm run test:e2e
```

## Key commands

| Command | What it does |
|---|---|
| `npm run test:db` | Applies every migration to an in-memory Postgres (PGlite) and runs the security suite |
| `npm run db:types` / `db:types:offline` | Regenerate `database.types.ts` from the local stack, or from migrations without Docker |
| `npm run db:reset` | Re-create the local DB from migrations |
| `npm test` | DB tests + unit tests + production build |

## Security model in one paragraph

Every business row has `tenant_id NOT NULL`, and child rows use composite FKs that keep them in the same tenant. RLS is enabled on every table. Policies call private, `search_path`-pinned helpers that derive permissions from memberships, roles, plan entitlements and subscription status, never from client input or JWT metadata. Grants are explicit and column-scoped, so `tenant_id` and privileged flags can't be changed. Sensitive writes go through audited `SECURITY DEFINER` RPCs with anti-escalation rules. The service-role key never reaches the browser. Details: [docs/03-security-and-permissions.md](docs/03-security-and-permissions.md).

## Documentation

1. [System architecture](docs/01-architecture.md)
2. [Database design and ERD](docs/02-database.md)
3. [Security, RLS and the permission matrix](docs/03-security-and-permissions.md)
4. [RPC and Edge Function catalogue](docs/04-rpc-and-edge-catalogue.md)
5. [Frontend structure, screens and navigation](docs/05-frontend.md)
6. [Environments and deployment (Cloudflare Pages + Supabase)](docs/06-deployment.md)
7. [Roadmap and milestone status](docs/07-roadmap-and-status.md)

## Compliance notes

The VAT defaults (5% standard rate) and the e-invoicing (Fawtara) integration layer must be verified with the Oman Tax Authority before production use. A PDF invoice alone doesn't make the system e-invoicing compliant. Personal-data features follow Oman's PDPL and need legal review before launch.

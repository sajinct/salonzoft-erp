# 07 · Roadmap and milestone status

## Phases

| Phase | Scope | Status |
|---|---|---|
| **1. SaaS foundation** | Angular app, Supabase integration, migrations, auth, tenants, memberships, roles and permissions, RLS, branches, bilingual layout, entitlement foundation, first dashboard | ✅ **Milestone 1 delivered** (see below) |
| 2. Core salon operations | Services and pricing, employees, shifts and leave, customers (consent, duplicates, CSV), appointments with GiST no-double-booking, availability engine, calendar, realtime, staff portal, operational dashboard | Next |
| 3. Revenue operations | POS, VAT invoices (numbering, snapshots), payments (split/partial/deposits), cash sessions, refunds and credit notes, packages, memberships, gift vouchers, invoice PDFs, payment adapter | |
| 4. Business ERP | Inventory ledger, purchasing, consumables, commissions, expenses and petty cash, loyalty | |
| 5. Customer engagement | Public booking portal, WhatsApp/SMS/email, notification queue, campaigns, feedback | |
| 6. SaaS commercialisation | Super-admin, subscription checkout and webhooks, plan changes, tenant billing, platform analytics, advanced reports and exports | |
| 7. Production hardening | Security review and pen test, load tests, backup-restore drills, VAT/Fawtara and PDPL review, monitoring, go-live checklist | |

---

## Milestone 1 report (2026-11-09)

### Implemented features

* Email/password auth with PKCE (sign up, sign in, password reset, email-confirmation callback, safe `next` redirects)
* Self-service onboarding: atomic and idempotent `create_tenant` (trial plan, Oman defaults, five role templates, owner membership, main branch with Sat–Thu 09–22 / Fri 14–22 hours)
* Multi-tenant context: business chooser, remembered tenant and branch (validated, never trusted), branch switcher
* Role-based navigation driven by server-computed permissions × plan entitlements; staff land on their first permitted page
* Settings: business profile, logo upload (private Storage + signed URL), regional (timezone, weekend, week start, Hijri), VAT and invoicing; branches CRUD + weekly hours with split shifts; team invitations (one-time link, WhatsApp/email share), access editing, suspension; roles and permission matrix with anti-escalation; personal profile and password
* Phase 1 dashboard: branches, team, plan/trial, status, setup checklist (real data via `get_dashboard_summary`)
* English/Arabic at runtime with full RTL, light/dark theme, toasts, confirmations, responsive shell
* OMR-safe money library (BigInt baisa, half-up, inclusive/exclusive 5% VAT helpers)

### Database migrations

`0001_foundation` · `0002_tenancy` · `0003_authorization` · `0004_rls_and_grants` · `0005_triggers` · `0006_rpc_tenancy` · `0007_storage`. Covers 22 tables and 12 public RPCs, plus private `app` helpers.

### RLS policies

All 22 public tables have RLS: 35 table policies plus 4 storage policies, backed by 35 private `app` helper/trigger functions. See [03-security-and-permissions.md](03-security-and-permissions.md).

### Edge Functions

None in Phase 1. Every Phase 1 operation is a transactional RPC; see the catalogue for why and when each function arrives.

### Tests executed

| Suite | Command | Result |
|---|---|---|
| Database security and behaviour (PGlite, real migrations) | `npm run test:db` | **57 / 57 passing** |
| Angular unit tests (Vitest) | `npm run web:test` | **33 / 33 passing** (incl. routing regression) |
| Angular production build | `npm run web:build` | **passing** (initial 772 kB raw / ~163 kB transfer) |
| Playwright E2E (`tests/e2e/phase1.spec.ts`) | CI job "E2E against local Supabase (Docker)" | **8 / 8 passing** (desktop + tablet) on real Supabase; migrations verified on real Postgres |

### Known limitations

1. The local security suite runs in PGlite (PostgreSQL 18, WASM) with an `auth`/`storage` shim. CI additionally runs the migrations and E2E tests on the real Supabase stack (PG 17) in Docker, where they pass.
2. PGlite is single-connection, so **concurrency tests** (double-booking, double redemption) must run against real Postgres. Planned in Phase 2 as a Node test that opens parallel connections to the local Supabase DB.
3. Invitation emails are not sent automatically yet. The owner shares the one-time link. Automatic email arrives with `email-send` in Phase 5.
4. Overnight branch hours (e.g. 18:00–02:00) aren't supported. Ranges must end by 24:00.
5. Arabic copy needs review by a native Omani copywriter. The 5% VAT default and VAT number format must be verified with the Oman Tax Authority.
6. CSP in `_headers` has placeholders (Supabase host, inline-script hash) to fill per environment.
7. Ownership transfer, tenant closure/export, and the privacy-request workflows are not built yet (Phase 6/7).
8. Plan prices (15/35/75 OMR) are placeholders.

### Next milestone: Phase 2, part 1 (services, staff, customers)

* Migration `0008_services_staff`: `service_categories`, `services` (bilingual, duration, buffers, VAT category), `service_prices` (branch overrides), `resources`, `employees` (linked optionally to memberships), `employee_services`, `staff_shifts` (split), `staff_leaves`, `branch_holidays`, Ramadan schedule overrides
* Migration `0009_customers`: `customers` (normalised +968 mobile, unique per tenant, trigram search), `customer_consents`, `customer_notes`, duplicate detection RPC, CSV import RPC with tenant validation
* Angular: services catalogue, employee profiles and roster, customer list/profile/search
* Then Phase 2, part 2: `appointments` with btree_gist exclusion constraints, `calculate_availability`, `create_appointment` with locking and idempotency, calendar UI, realtime channels, and **real-Postgres concurrency tests**

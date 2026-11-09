# 07 · Roadmap and milestone status

## Phases

| Phase | Scope | Status |
|---|---|---|
| **1. SaaS foundation** | Angular app, Supabase integration, migrations, auth, tenants, memberships, roles and permissions, RLS, branches, bilingual layout, entitlement foundation, first dashboard | ✅ **Milestone 1 delivered** (see below) |
| 2. Core salon operations | Services and pricing, employees, shifts and leave, customers (consent, duplicates, CSV), appointments with GiST no-double-booking, availability engine, calendar, realtime, staff portal, operational dashboard | ✅ **Delivered** (part 1: services, staff, customers · part 2: appointments, availability, calendar, realtime). Week view, resource booking UI and drag-and-drop follow |
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

---

## Phase 2, part 1 report: services, staff, customers (2026-11-09)

### Implemented

* **Migration `0008_services_staff`**:
  * Tables: `service_categories`, `services` (bilingual; duration and prep/clean-up buffers; fixed, "from" or till pricing; VAT category; audience; online-bookable flag), `service_prices` (per-branch price or "not offered"), `resources` (rooms, chairs, beds), `employees` (optional link to a login, which grants no access by itself), `employee_branches`, `employee_services`, `staff_shifts` (weekly, split, at most one place at a time), `staff_leaves`, `branch_special_periods` + `branch_special_hours` (holidays, closures, Ramadan/Eid hours).
  * Active employees count against the plan's `max_staff`.
  * RPCs: `set_service_branch_prices`, `set_employee_assignments`, `set_employee_shifts`, `save_branch_special_period`.
* **Migration `0009_customers`**:
  * `customers`: mobile normalised to E.164 (+968 default), unique per tenant; trigram search (`pg_trgm`) over English and Arabic names, mobile and email; status active, blocked or archived (no hard delete).
  * `customer_consents`: append-only history per channel and purpose.
  * `customer_notes`: allergy and medical notes require `customers.sensitive`, and the audit log never stores note text.
  * RPCs: `search_customers`, `find_customer_duplicates`, `import_customers` (dry run, a savepoint per row, duplicate and error report, max 2000 rows).
* **Angular**:
  * `/services`: category filter, search, service dialog with branch prices.
  * `/employees`: profile, branches and skills, weekly split shifts, leave.
  * `/customers`: debounced search, duplicate warning on create, CSV import with check-then-import.
  * `/customers/:id`: details, consent matrix with history, pinned and sensitive notes.
  * All screens in English and Arabic (RTL).

### Tests

| Suite | Result |
|---|---|
| `npm run test:db` (PGlite, real migrations) | **80 / 80** (57 Phase 1 + 23 new in `07_services_staff`, `08_customers`) |
| `ng test` | **39 / 39** (6 new CSV parser tests) |
| `ng build --configuration production` | passing, initial 823 kB raw / 169 kB transfer |

### Not in this part (deliberately)

* UI for resources and branch holidays/special hours: the tables, RPCs and tests are in place, and the screens arrive with the calendar, where they're used.
* Availability engine, appointments, calendar, realtime and concurrency tests: Phase 2 part 2.
* Customer erasure/export (PDPL): Phase 6/7, through an audited privacy workflow.

---

## Phase 2, part 2 report: appointments (2026-11-09)

* **Migration `0010_appointments`**: appointments + service lines (snapshots of name, price, duration), `btree_gist` exclusion constraints so one employee (or resource) can never hold two overlapping active bookings, buffers included. Availability is computed with multiranges in the branch timezone from branch hours or holiday/Ramadan periods, shifts, approved leave and bookings. Booking RPCs lock the employee row, so concurrent requests queue; a lost race is `SLOT_UNAVAILABLE`. Idempotency keys make retries safe, even when retries race each other. Apps have read-only RLS: front desk sees the branch, stylists only their own lines; every write is an audited RPC.
* **Angular**: `/appointments` day calendar (see 05-frontend), booking and details dialogs, live updates via Supabase Realtime.
* **Tests**: `npm run test:db` **94 / 94** (14 new); `ng test` **45 / 45** (6 new timezone tests); new `npm run test:concurrency` (12 parallel bookings of one slot ⇒ exactly 1 wins; 8 "any staff" requests ⇒ exactly 2; racing idempotent retries ⇒ one appointment) runs in CI on real Postgres.

### Next milestone: Phase 3 (revenue operations)

POS checkout from a completed appointment, VAT invoices with gap-free numbering and snapshots, split/partial payments, cash sessions, refunds and credit notes. Also pending from Phase 2: week view, resource assignment in booking, drag-and-drop, dashboard "today" card.

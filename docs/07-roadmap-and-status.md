# 07 · Roadmap and milestone status

## Phases

| Phase | Scope | Status |
|---|---|---|
| **1. SaaS foundation** | Angular app, Supabase integration, migrations, auth, tenants, memberships, roles and permissions, RLS, branches, bilingual layout, entitlement foundation, first dashboard | ✅ **Milestone 1 delivered** (see below) |
| 2. Core salon operations | Services and pricing, employees, shifts and leave, customers (consent, duplicates, CSV), appointments with GiST no-double-booking, availability engine, calendar, realtime, staff portal, operational dashboard | ✅ **Delivered** (part 1: services, staff, customers · part 2: appointments, availability, calendar, realtime). Week view, resource booking UI and drag-and-drop follow |
| 3. Revenue operations | POS, VAT invoices (numbering, snapshots), payments (split/partial/deposits), cash sessions, refunds and credit notes, packages, memberships, gift vouchers, invoice PDFs, payment adapter | 🟡 **Parts 1–2 delivered** (POS, invoices, payments, cash drawer, credit notes, print; packages, memberships, gift vouchers, store credit, deposits). Remaining: server PDF, payment gateway |
| 4. Business ERP | Inventory ledger, purchasing, consumables, commissions, expenses and petty cash, loyalty | ✅ **Delivered** (part 1: inventory, purchasing, retail, consumables · part 2: commissions, expenses & petty cash, P&L, loyalty) |
| 5. Customer engagement | Public booking portal, WhatsApp/SMS/email, notification queue, campaigns, feedback | ✅ **Delivered** |
| 6. SaaS commercialisation | Super-admin, subscription checkout and webhooks, plan changes, tenant billing, platform analytics, advanced reports and exports | ✅ **Delivered** (part 1: super-admin console, subscription invoices, plan changes, renewals and dunning, platform analytics · part 2: reports and exports). Gateway webhook follows once a provider is chosen |
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
7. Ownership transfer by the owner themselves (platform admins can transfer it from the console), tenant closure/export, and the privacy-request workflows are not built yet (Phase 6/7).
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

---

## Phase 3, part 1 report: POS & invoicing (2026-11-09)

* **Migration `0011_pos_invoicing`**: cart = draft invoice priced by the server; gap-free numbers per branch and year allocated at posting from a locked counter; posted invoices, their lines and payments are immutable (triggers, even for the DB owner); credit notes are the only correction and refund money already paid; cash drawer sessions with expected cash and variance.
* **Angular**: `/pos` (catalogue tiles, cart with staff per line, server totals, custom items, discount / price only with permission, cash drawer), payment dialog (split, cash change), `/invoices` (today's sales, VAT, by method, unpaid), `/invoices/:id` (bilingual tax invoice / credit note, print), checkout straight from an appointment. Arabic dictionary now lazy-loaded: initial bundle 813 kB (was 850).
* **Tests**: `npm run test:db` **104 / 104** (10 new); `ng test` **46 / 46**.

---

## Phase 3, part 2 report: packages, memberships, vouchers, deposits (2026-11-09)

* **Migration `0012_packages_vouchers`**: everything is sold and redeemed through the invoice engine. Packages create per-service session balances; a service line can be paid with a session (price 0) and the balance is decremented with a guarded update when the invoice is posted, so two tills can never overdraw it. Memberships give an automatic service discount (policy, no `pos.discount` needed). Gift vouchers (sold VAT-free, taxed when spent), store credit (refund method) and booking deposits share one instrument with codes `XXXX-XXXX-XXXX` and a guarded balance. Credit notes give sessions back, void unused vouchers, cancel memberships, and refuse to return used packages / vouchers.
* **Angular**: POS tabs for packages and memberships, gift voucher and deposit, customer wallet with one-tap redemption and credit; voucher payments with suggestions; `/packages` (packages, memberships, voucher lookup); wallet card on customer profiles; "Take deposit" on appointments.
* **Tests**: `npm run test:db` **114 / 114** (10 new); `ng test` **46 / 46**.

---

## Phase 4, part 1 report: inventory & purchasing (2026-11-09)

* **Migration `0013_inventory_purchasing`**: products (retail / salon use / both), append-only stock ledger with a single row-locked writer, weighted average cost per branch, stock counts and opening stock, transfers between branches, suppliers and purchase orders (gap-free `PO-` numbers, partial receipts, no over-receipt). Retail is sold through POS (`product` lines) and leaves stock when the invoice posts — if two tills sell the last units, the second checkout fails cleanly and uses no number. Credit notes return stock at the cost it left with. Services consume their products automatically (never blocking a checkout; shortfalls show as negative stock).
* **Angular**: `/inventory` (stock with value and low-stock flags, counts, transfers, products, movement ledger), `/purchases` (orders: draft → send → receive; suppliers), Products tab in POS with stock on hand, "Products used" on services, "allow negative stock" setting.
* **Tests**: `npm run test:db` **123 / 123** (9 new: weighted average, ledger = balances, concurrency at posting, returns, consumption, transfers, isolation); `ng test` **46 / 46**.

---

## Phase 4, part 2 report: commissions, expenses, loyalty (2026-11-09)

* **Migration `0014_commissions_expenses_loyalty`**: commission rules (employee / service / category / product type; percent of the net line plus a fixed amount; the most specific rule wins) turned into entries when an invoice posts, clawed back pro rata by credit notes, paid out per employee up to a date. Expenses with categories, VAT, an approval flow and petty cash from the drawer (which lowers the drawer's expected cash). Profit & loss summary. Loyalty points earned on net spend (vouchers excluded) at posting, reversed on returns (never below zero), redeemed into store credit with a guarded decrement.
* **Angular**: `/finance` (overview P&L with VAT payable, expenses with approval, commissions report with payouts and rules — stylists see only their own); loyalty settings; points and "Redeem" in the POS wallet; points on customer profiles.
* **Tests**: `npm run test:db` **133 / 133** (10 new); `ng test` **46 / 46**.

---

## Phase 5, part 1 report: online booking & notifications (2026-11-09)

* **Migration `0015_online_booking_notifications`**: public booking through five anon `public_*` functions only (allow-list enforced by the schema test), using the same booking engine (no double-booking), lead time / horizon / self-cancel window, rate limits, customer find-or-create by mobile that never edits an existing profile, consent capture, secret manage token. Consent-based notification queue fed by appointment triggers (confirmation, reminder, cancellation, reschedule), rendered at send time from editable bilingual templates, claimed with SKIP LOCKED, retried with backoff.
* **Edge Function** `notification-worker` (WhatsApp Cloud API, Twilio SMS, Resend email; skipped when not configured). Setup in 06-deployment.
* **Angular**: `/book/:slug` (mobile-first, bilingual: services → staff/day/time → details with opt-in consent → confirmation), `/book/manage/:token` (view / cancel), Settings → Online booking & messages (link, branches, rules, channels, templates with preview, message log).
* **Tests**: `npm run test:db` **145 / 145** (10 new + anon allow-list); `ng test` **46 / 46**.

## Phase 5, part 2 report: campaigns & feedback (2026-11-09)

* **Migration `0016_campaigns_feedback`**: campaigns (segment builder, marketing-consent audience, per-language bodies, schedule, launch / stop, delivery stats) sent through the existing notification queue with an automatic unsubscribe link and plan message limits; post-visit feedback requests (delay setting, single-use 30-day link, 1–5 rating and comment) with a summary by staff.
* **Angular**: `/marketing` (campaigns and feedback tabs), public `/feedback/:token` and `/unsubscribe/:token`, feedback settings and template in Settings → Online booking & messages.
* **Tests**: `npm run test:db` **153 / 153** (8 new); `ng test` **46 / 46**.

## Phase 6, part 1 report: super-admin & subscription billing (2026-11-09)

* **Migration `0017_platform_billing`**: subscription invoices (gap-free `SZ-YYYY-#####`, VAT from platform settings, seller/buyer snapshots, one unpaid invoice per salon); plan changes (pro-rata credited upgrades, scheduled downgrades, limits checked); billing cycle for pg_cron (renewal invoices, past-due grace, suspension, cancellation); service-role gateway entry point; super-admin RPCs with admin / billing / support roles and a platform audit log.
* **Angular**: `/admin` console (overview, businesses, business detail, invoices, plans, settings & admins), Settings → Plan & billing, printable subscription invoice, overdue banner, admin link in the user menu. English is now lazy-loaded like Arabic (initial bundle 798 kB).
* **Tests**: `npm run test:db` **158 / 158** (5 new); `ng test` **46 / 46**.

## Super-admin: add and manage businesses and users (2026-11-12)

* **Migration `0019_admin_tenant_management`**: `admin_create_tenant` (owner added directly, or by a one-time owner invitation when the e-mail has no account), `admin_update_tenant`, and user management for any business (`admin_add_member`, `admin_update_member`, `admin_set_member_status`, `admin_revoke_invitation`, `admin_transfer_ownership`). Admin + support; ownership changes are admin-only; everything lands in the platform audit log. Platform admins still have no RLS access to tenant tables.
* **Console**: *Add business* on `/admin/tenants`; on a business page *Edit*, a Users table (add user, edit roles/branches, suspend/reactivate, make owner, send password reset) and pending invitations with revoke.
* **Tests**: `18_admin_tenant_management`.

## Invoice template & direct printing (2026-11-12)

* **Migration `0020_receipt_template`**: per-salon print template on `tenant_settings` — paper (`a4`, `80mm`, `58mm`), language (`en`, `ar`, `both`), header text in each language, logo on/off, auto print after payment. The footer columns already existed.
* **Frontend**: Settings → *Invoice template* with a live preview and test print. One renderer (`shared/receipt/receipt.ts`) builds the escaped HTML for both the preview and printing; invoices print from an off-screen frame (no preview page) from the invoice page and, when enabled, automatically after a POS payment.
* **No print dialog**: browsers only skip it when started with `--kiosk-printing` (Chrome / Edge); the settings page shows the shortcut to create on the cashier PC. Raw ESC/POS printing (cash-drawer kick, cutter control) is not built.
* **Tests**: `19_receipt_template` (database), `receipt.spec.ts` (renderer).

## Service catalogue import / export (2026-11-12)

* **Migration `0021_import_services`**: `import_services(tenant, rows, dry_run)` — adds services or updates them (matched by code, else by English name), creates missing categories, reports bad rows by line, dry run saves nothing. `services.manage`, SECURITY INVOKER, at most 1000 rows.
* **Frontend**: Services → *Import* (Excel `.xlsx` or CSV, check then import, example file) and *Export Excel* / *CSV*. The export uses the same columns the import reads, so a file can be exported, edited and imported back. Excel support comes from `read-excel-file` / `write-excel-file`, loaded only when used.
* **Not covered**: branch price overrides, colours and consumables are not in the file.
* **Tests**: `20_import_services` (database), `services-io.spec.ts`.

## Employee import / export (2026-11-12)

* **Migration `0022_import_employees`**: `import_employees(tenant, rows, dry_run)` — adds or updates employees (matched by code, else by English name); `branches` (codes or names) and `services` (codes, names or `all`) are lists separated by `;` that replace the current assignment when given; a new employee of a single-branch salon gets that branch. `employees.manage`, SECURITY INVOKER, plan employee limit applies, at most 1000 rows.
* **Frontend**: Employees → *Import* and *Export Excel* / *CSV*. The file handling (`shared/import/table-io.ts`) and the import dialog (`shared/import/import-dialog.ts`) are now shared with the services page.
* **Not covered**: shifts, leave, colours and the link to a login are not in the file.
* **Tests**: `21_import_employees` (database), `employees-io.spec.ts`.

## Phase 6, part 2 report: reports & exports (2026-11-09)

* **Migration `0018_reports`**: `run_report` with nine reports (daily sales, VAT summary, invoice register, payments, services, staff performance, retail products, appointments, top customers), permission- and branch-scoped, credit notes subtracted; audited exports.
* **Angular**: `/reports` (replaces the coming-soon page) with presets, branch filter, totals, Excel-friendly CSV export and print.
* **Tests**: `npm run test:db` **164 / 164** (6 new); `ng test` **49 / 49** (CSV writer).

### Next milestone

Phase 7: production hardening (security review, load tests, backup-restore drill, VAT/Fawtara and PDPL review, monitoring, go-live checklist). Payment gateway webhook once the provider is chosen. Pending from Phase 3: server-side bilingual invoice PDF (Edge Function) and an Oman payment gateway adapter (provider to be chosen). Backlog: calendar week view, resource booking UI, drag-and-drop, dashboard "today" card.

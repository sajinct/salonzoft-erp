# 04 · RPC and Edge Function catalogue

## Error contract

RPC errors arrive in supabase-js as `{ code, message, details }`:

| `code` (SQLSTATE) | Meaning | `message` |
|---|---|---|
| `P0001` | Business rule violation | Stable machine code, e.g. `TENANT_SLUG_TAKEN` |
| `42501` | Not permitted (RLS/grant/explicit check) | `FORBIDDEN`, `ROLE_ESCALATION_FORBIDDEN`, … |
| `28000` | Not signed in | `NOT_AUTHENTICATED` |
| `23505` / `23514` / `23503` | Unique / check / FK violation | Postgres text |

`details` holds an English explanation. The Angular client translates `message` through `enErrors` / `arErrors` (`core/i18n`).

### Error codes in use

`NOT_AUTHENTICATED, FORBIDDEN, NOT_FOUND, INVALID_NAME, INVALID_SLUG, SLUG_RESERVED, TENANT_SLUG_TAKEN, TENANT_LIMIT_REACHED, INVALID_BUSINESS_TYPE, INVALID_LANGUAGE, INVALID_TIMEZONE, INVALID_EMAIL, INVALID_ROLE, INVALID_BRANCH, BRANCH_REQUIRED, ROLE_ESCALATION_FORBIDDEN, BRANCH_ESCALATION_FORBIDDEN, MEMBER_ALREADY_EXISTS, PLAN_LIMIT_STAFF, PLAN_LIMIT_BRANCHES, PLAN_NOT_CONFIGURED, INVITATION_INVALID, INVITATION_EXPIRED, INVITATION_EMAIL_MISMATCH, EMAIL_NOT_CONFIRMED, TENANT_UNAVAILABLE, OWNER_IMMUTABLE, SELF_MODIFICATION_FORBIDDEN, INVALID_JOB_TITLE, INVALID_STATUS, INVALID_WORKING_HOURS, OVERLAPPING_WORKING_HOURS, AUDIT_LOG_IMMUTABLE, PLAN_LIMIT_EMPLOYEES, OVERLAPPING_SHIFTS, INVALID_SHIFTS, SHIFT_BRANCH_NOT_ASSIGNED, INVALID_SERVICE, INVALID_PRICE, INVALID_PERIOD, OVERLAPPING_SPECIAL_PERIODS, INVALID_MOBILE, INVALID_IMPORT, IMPORT_TOO_LARGE`

Per-row import errors (in the `import_customers` result, not raised) also use `INVALID_DATE`, `INVALID_VALUE` and `DUPLICATE`.

## Database RPC functions

| Function | Security | Phase | Status | Notes |
|---|---|:-:|:-:|---|
| `create_tenant(name, slug, type, branch, lang, idempotency_key)` | DEFINER | 1 | ✅ | Atomic provisioning: tenant, settings, 14-day trial, entitlements, roles from templates, owner membership, main branch, Oman default hours. Idempotent per user + key. Max 5 per user |
| `is_slug_available(slug)` | DEFINER | 1 | ✅ | Boolean only |
| `get_my_tenants()` | INVOKER | 1 | ✅ | RLS-driven |
| `get_tenant_context(tenant)` | INVOKER | 1 | ✅ | Permissions, modules, branches, subscription for UI |
| `create_invitation(tenant, email, roles, all_branches, branches)` | DEFINER | 1 | ✅ | `team.manage`, anti-escalation, seat limit, hashed token |
| `revoke_invitation(id)` | DEFINER | 1 | ✅ | |
| `accept_invitation(token)` | DEFINER | 1 | ✅ | Confirmed and matching email, single use, seat check |
| `list_tenant_members(tenant)` | DEFINER | 1 | ✅ | `team.view`; joins auth emails |
| `update_member_access(membership, roles, all_branches, branches, job_title)` | DEFINER | 1 | ✅ | Must outrank current and new access |
| `set_member_status(membership, status)` | DEFINER | 1 | ✅ | Owner and self protected |
| `set_branch_working_hours(branch, hours jsonb)` | INVOKER | 1 | ✅ | Atomic replace; split shifts; overlap check |
| `get_dashboard_summary(tenant, branch?)` | INVOKER | 1 | ✅ (Phase 1 metrics) | Extended each phase |
| `set_service_branch_prices(service, prices jsonb)` | INVOKER | 2 | ✅ | `services.manage`; replaces overrides for accessible branches only |
| `set_employee_assignments(employee, branches[], services[])` | INVOKER | 2 | ✅ | `employees.manage`; branches outside the caller's scope are untouched |
| `set_employee_shifts(employee, shifts jsonb)` | INVOKER | 2 | ✅ | Weekly split shifts; branch must be assigned; overlap check (also enforced by trigger) |
| `save_branch_special_period(branch, period?, kind, names, from, to, hours)` | INVOKER | 2 | ✅ | `branches.manage`; closures and special hours (Ramadan, Eid); no overlapping periods |
| `search_customers(tenant, query, limit, include_archived)` | INVOKER | 2 | ✅ | Name (EN/AR) trigram, partial mobile digits, email |
| `find_customer_duplicates(tenant, mobile, email, first, last, exclude?)` | INVOKER | 2 | ✅ | Same mobile / email, or name similarity ≥ 0.6 |
| `import_customers(tenant, rows jsonb, dry_run)` | INVOKER | 2 | ✅ | `customers.manage`; savepoint per row; duplicates + per-row errors; ≤ 2000 rows |
| `calculate_availability(branch, services[], date, staff?, step, exclude?)` | DEFINER | 2 | ✅ | (Branch hours or special period) ∩ shifts − approved leave − bookings, incl. buffers, branch timezone; returns start times + employee. Needs `appointments.view/manage` at the branch |
| `create_appointment(tenant, branch, customer?, starts_at, items, notes?, source?, idempotency_key?)` | DEFINER | 2 | ✅ | `appointments.manage` + branch; items = services in order with employee or "any"; employee row lock + exclusion constraint ⇒ `SLOT_UNAVAILABLE`; client prices ignored; idempotent (also under concurrent retries) |
| `reschedule_appointment(appointment, starts_at, employee?)` | DEFINER | 2 | ✅ | Atomic move of all lines; booked prices kept |
| `set_appointment_status(appointment, status, reason?)` | DEFINER | 2 | ✅ | booked → confirmed → checked_in → in_service → completed; cancel / no-show free the slot. Stylists may start/complete their own |
| `update_appointment(appointment, customer, notes)` | DEFINER | 2 | ✅ | |
| `get_calendar(branch, from, to)` | DEFINER | 2 | ✅ | ≤ 31 days; employees + working ranges + appointments; stylists get only their own; customer mobile only with `customers.view` |
| `get_appointment_stats(tenant, branch?)` | DEFINER | 2 | ✅ | Today's counts in the tenant timezone |
| `finalize_invoice(invoice, idempotency_key)` | DEFINER | 3 | ⏳ | Numbering, snapshots, stock, commission, ledger |
| `record_payment(invoice, method, amount, idempotency_key)` | DEFINER | 3 | ⏳ | Split/partial payments, cash session |
| `process_refund(invoice, lines, idempotency_key)` | DEFINER | 3 | ⏳ | Credit note + reversal postings |
| `open_cash_session`, `close_cash_session(session, counted)` | DEFINER | 3 | ⏳ | Variance recorded |
| `redeem_package(customer_package, service, qty, idempotency_key)` | DEFINER | 3 | ⏳ | Guarded decrement |
| `post_inventory_movement`, `transfer_inventory`, `receive_purchase` | DEFINER | 4 | ⏳ | Ledger + balances |
| `calculate_commission(period)` | DEFINER | 4 | ⏳ | From immutable invoice lines |
| `award_loyalty_points`, `redeem_loyalty_points` | DEFINER | 4 | ⏳ | |
| `get_sales_report(tenant, from, to, branch?)` and other reports | INVOKER | 4–6 | ⏳ | Permission-gated |
| Booking portal: `public_get_salon(slug)`, `public_availability(…)`, `public_create_booking(…)` | DEFINER (anon) | 5 | ⏳ | Minimal fields, rate-limited via Edge Function + captcha |

## Edge Functions

Phase 1 doesn't need an Edge Function. Onboarding is a single atomic `SECURITY DEFINER` RPC, which is safer than a service-role function doing several writes. Invitations are delivered as one-time links the owner shares (copy, WhatsApp or email link). Automatic invitation emails arrive with `email-send` in Phase 5.

Every function will share `supabase/functions/_shared/` (CORS allow-list, JWT verification via `auth.getUser`, a user-scoped client so RLS applies, input schemas, the error format above, structured logging, idempotency keys, secret access via `Deno.env` / Vault).

| Function | Auth | Phase | Purpose |
|---|---|:-:|---|
| `tenant-invitation` | User JWT, then service role scoped to the invitation | 5 | Create invitation via RPC as the user, then send the email |
| `email-send` | Internal (pg_net from worker) | 5 | Transactional email provider |
| `whatsapp-send` / `whatsapp-webhook` | Internal / Meta signature (`X-Hub-Signature-256`) | 5 | WhatsApp Cloud API, approved templates only |
| `notification-worker` / `scheduled-reminders` | pg_cron + shared secret | 5 | Process `notification_jobs` with retries and backoff |
| `payment-create` / `payment-webhook` | User JWT / gateway HMAC | 3 | Oman gateway adapter (e.g. Thawani, OmanNet, bank PGs). Idempotent by gateway event id |
| `generate-invoice-document` | User JWT | 3 | Bilingual PDF to the private bucket, signed URL |
| `e-invoice-submit` | Internal | 6+ | Fawtara integration layer (disabled until requirements are verified) |
| `subscription-checkout` / `subscription-webhook` | User JWT / provider signature | 6 | Plan purchase and status changes |
| `export-report` | User JWT | 6 | Async CSV/XLSX/PDF exports |
| `platform-admin` | Platform admin JWT + `platform_admins` check | 6 | Tenant suspension, support access (time-boxed, audited) |

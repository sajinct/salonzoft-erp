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
| `import_services(tenant, rows, dry_run?)` | INVOKER | 2 | ✅ | Migration 0021. `services.manage`; add or update by code / name, categories created on the fly; per-row errors (`NAME_REQUIRED`, `DUPLICATE_IN_FILE`, `INVALID_VALUE`); max 1000 rows |
| `import_employees(tenant, rows, dry_run?)` | INVOKER | 2 | ✅ | Migration 0022. `employees.manage`; add or update by code / name; `branches` and `services` lists replace the assignment; per-row errors (`INVALID_BRANCH`, `INVALID_SERVICE`, `INVALID_DATE`, `PLAN_LIMIT_EMPLOYEES`, …); max 1000 rows |
| `get_appointment_share(appointment)` · `get_invoice_share(invoice)` | DEFINER | 5 | ✅ | Migration 0023. Number + ready WhatsApp message + private link; same visibility as the calendar / invoice list; `INVOICE_NOT_POSTED` |
| `public_get_invoice(token)` | DEFINER (anon) | 5 | ✅ | The shared invoice by its secret token: document fields, lines, payment methods and print template only |
| `calculate_availability(branch, services[], date, staff?, step, exclude?)` | DEFINER | 2 | ✅ | (Branch hours or special period) ∩ shifts − approved leave − bookings, incl. buffers, branch timezone; returns start times + employee. Needs `appointments.view/manage` at the branch |
| `create_appointment(tenant, branch, customer?, starts_at, items, notes?, source?, idempotency_key?)` | DEFINER | 2 | ✅ | `appointments.manage` + branch; items = services in order with employee or "any"; employee row lock + exclusion constraint ⇒ `SLOT_UNAVAILABLE`; client prices ignored; idempotent (also under concurrent retries) |
| `reschedule_appointment(appointment, starts_at, employee?)` | DEFINER | 2 | ✅ | Atomic move of all lines; booked prices kept |
| `set_appointment_status(appointment, status, reason?)` | DEFINER | 2 | ✅ | booked → confirmed → checked_in → in_service → completed; cancel / no-show free the slot. Stylists may start/complete their own |
| `update_appointment(appointment, customer, notes)` | DEFINER | 2 | ✅ | |
| `get_calendar(branch, from, to)` | DEFINER | 2 | ✅ | ≤ 31 days; employees + working ranges + appointments; stylists get only their own; customer mobile only with `customers.view` |
| `get_appointment_stats(tenant, branch?)` | DEFINER | 2 | ✅ | Today's counts in the tenant timezone |
| `create_invoice_draft(tenant, branch, customer?, appointment?, key?)` | DEFINER | 3 | ✅ | The cart. From an appointment: its customer, services, staff and booked prices; one live invoice per appointment |
| `save_invoice_draft(invoice, customer, items, notes?)` | DEFINER | 3 | ✅ | Server-side pricing (booked / branch / catalogue price), `pos.discount` for overrides and discounts, per-line VAT (3 dp, half-up) |
| `finalize_invoice(invoice)` | DEFINER | 3 | ✅ | Gap-free number `INV-{branch}-{year}-000001` from a locked counter, VAT re-check, snapshots, completes the appointment; idempotent. Stock, commission and ledger postings arrive in Phase 4 |
| `void_invoice_draft(invoice)` | DEFINER | 3 | ✅ | Drafts only (no number used) |
| `get_invoice(invoice)` · `get_sales_summary(tenant, branch?, from?, to?)` | DEFINER | 3 | ✅ | Document with lines, payments, credit notes · day/period totals, VAT, by method, outstanding |
| `record_payment(invoice, method, amount, reference?, key?)` | DEFINER | 3 | ✅ | Split / partial; no overpayment; cash needs an open session; idempotent |
| `create_credit_note(invoice, lines?, reason, refund_method?, key?)` | DEFINER | 3 | ✅ | `pos.refund`; never more than invoiced; refunds money paid beyond what is still owed; `CN-{branch}-{year}-000001` |
| `open_cash_session(branch, float)`, `close_cash_session(session, counted, notes?)` | DEFINER | 3 | ✅ | One open drawer per branch; expected = float + cash in − cash refunded; variance stored |
| Package redemption (a service line with `customer_package_id`) | DEFINER | 3 | ✅ | Checked when saved, guarded decrement in `finalize_invoice`; reversed by credit notes |
| `get_customer_wallet(customer)` · `lookup_voucher(tenant, code)` · `set_package_items(package, items)` | DEFINER | 3 | ✅ | Packages with balances, membership, vouchers & deposits · voucher status at the till · atomic package contents (`packages.manage`) |
| `adjust_stock(branch, items, note?)` · `transfer_stock(from, to, items, note?)` | DEFINER | 4 | ✅ | Counts / opening stock (`inventory.manage`); transfers at source average cost, both branches must be accessible |
| `save_purchase_order`, `submit_purchase_order` (gap-free `PO-…`), `cancel_purchase_order`, `receive_purchase_order(order, lines, ref?, note?, key?)` | DEFINER | 4 | ✅ | `purchases.manage`; partial receipts, no over-receipt, weighted average cost, idempotent |
| `set_service_product_usage(service, items)` · `get_stock(branch)` | DEFINER | 4 | ✅ | Consumables per service (deducted at checkout, never blocking) · stock with value and low-stock flag |
| Commission entries (posting trigger) · `get_commission_report(tenant, from, to, branch?)` · `pay_commissions(tenant, employee, up_to, method, ref?, note?)` | DEFINER | 4 | ✅ | From posted invoice lines (net of VAT and discounts), claw-back on credit notes; report: all for `commissions.view`/`finance.view`, own for `commissions.own`; payouts need `finance.manage` |
| `record_expense(branch, category, date, amount, vat, description, method, from_drawer?, supplier?, ref?)` · `review_expense(expense, approve, reason?)` · `get_finance_summary(tenant, from, to, branch?)` | DEFINER | 4 | ✅ | Approval flow, petty cash from the drawer, P&L (revenue − COGS − products used − commission − expenses) |
| Loyalty earn / reverse (posting trigger) · `redeem_loyalty_points(customer, points)` · `adjust_loyalty_points(customer, points, note)` | DEFINER | 4 | ✅ | Points per OMR of net spend (vouchers excluded); redeemed into store credit with a guarded decrement; manual adjustments need `loyalty.manage` |
| `get_sales_report(tenant, from, to, branch?)` and other reports | INVOKER | 4–6 | ⏳ | Permission-gated |
| Booking portal: `public_get_salon(slug)`, `public_availability(slug, branch, services, date, staff?)`, `public_create_booking(…, idempotency_key)`, `public_get_booking(token)`, `public_cancel_booking(token)` | DEFINER (anon) | 5 | ✅ | Online branches / services only, lead time and horizon, rate limits per mobile (3/day) and IP (10/h), find-or-create customer by mobile without changing existing profiles, consent capture, self-cancel window |
| `claim_notification_jobs(limit)` · `complete_notification_job(job, outcome, …)` | DEFINER (service role only) | 5 | ✅ | Worker API: SKIP LOCKED claim with rendering; retries 1/2/4/8 min, gives up after 5 |
| `preview_notification(tenant, body)` · `get_notification_defaults()` | DEFINER | 5 | ✅ | Template editor |

## Edge Functions

### Reports (Phase 6, migration 0018)

| RPC | Kind | Permission | Notes |
|---|---|---|---|
| `run_report(tenant, report, from, to, branch?)` | DEFINER, read-only | per report (see 03) + `reports` module | `sales_daily`, `vat`, `invoices`, `payments`, `services`, `staff`, `products`, `appointments`, `customers`. Calendar days in the salon timezone, max 366 days (`INVALID_RANGE`), credit notes subtracted, at most 10,000 rows (`truncated`) |
| `log_report_export(tenant, report, from, to, branch, rows)` | DEFINER | same as the report | Audit entry `report.exported` |

### SaaS billing & super-admin (Phase 6, migration 0017)

| RPC | Kind | Who | Notes |
|---|---|---|---|
| `get_billing_overview(tenant)` | DEFINER | billing.manage (kept while not operational) | Subscription, usage vs limits, public plans, invoices, payment instructions |
| `request_plan_change(tenant, plan, cycle)` | DEFINER | billing.manage | Trial / lapsed: invoice (`new`/`renewal`/`change`). Active upgrade: invoice with pro-rata credit for unused **paid** time. Cheaper plan: scheduled for the period end. `PLAN_NOT_FOUND`, `PLAN_UNCHANGED`, `PLAN_LIMIT_BRANCHES`, `PLAN_LIMIT_EMPLOYEES` |
| `cancel_pending_change(tenant)`, `set_cancel_at_period_end(tenant, bool)` | DEFINER | billing.manage | Undo an unpaid upgrade / scheduled downgrade; stop or resume renewal (`SUBSCRIPTION_NOT_ACTIVE`) |
| `get_subscription_invoice(id)` | DEFINER | billing.manage or platform admin | Printable invoice (`/billing/invoices/:id`) |
| `run_billing_cycle()` | DEFINER | **service role** (pg_cron, daily) | Renewal invoices 7 days ahead (scheduled downgrades apply), `past_due` after the period (still operational), `suspended` after `billing_suspend_after_days`, `cancelled` on request |
| `billing_apply_gateway_payment(invoice, ref, paid_at)` | DEFINER | **service role** | For the future gateway webhook; idempotent on `ref` |
| `admin_whoami`, `admin_overview`, `admin_list_tenants`, `admin_get_tenant`, `admin_list_invoices`, `admin_list_plans`, `admin_list_admins`, `admin_get_settings` | DEFINER | any platform role | MRR/ARR, conversion, plan mix, 12-month sign-ups and revenue, activity, expiring trials |
| `admin_set_tenant_status`, `admin_extend_trial`, `admin_set_module` | DEFINER | admin, support (closing: admin) | Reason required to suspend/close (`REASON_REQUIRED`); trials +1–90 days (`SUBSCRIPTION_NOT_TRIAL`); module override on / off / back to plan |
| `admin_assign_plan`, `admin_create_invoice`, `admin_record_payment`, `admin_void_invoice` | DEFINER | admin, billing | Paying starts the period at trial end (remaining trial kept) or continues it for renewals; `INVOICE_NOT_OPEN` |
| `admin_save_plan`, `admin_set_admin`, `admin_save_settings` | DEFINER | admin | Plan edits resync subscribers' entitlements (overrides kept); the trial plan can't be deactivated (`TRIAL_PLAN_REQUIRED`); `USER_NOT_FOUND`, `ADMIN_SELF` |
| `admin_create_tenant(name, slug, owner_email, type?, language?, plan?, branch?)`, `admin_update_tenant(tenant, patch)` | DEFINER | admin, support | Migration 0019. Provisions a business like `create_tenant` (trial on the chosen plan). An owner e-mail with an account becomes the owner at once; otherwise a one-time **owner invitation** token is returned (`tenant_invitations.make_owner`). Patch keys: `name`, `name_ar`, `legal_name`, `business_type`, `slug` |
| `admin_add_member(tenant, email, roles, all_branches, branches, job_title?, owner?)`, `admin_update_member`, `admin_set_member_status`, `admin_revoke_invitation`, `admin_transfer_ownership(tenant, membership)` | DEFINER | admin, support (ownership and `owner`: admin) | Existing account → membership, else invitation token. Seat limits apply (`PLAN_LIMIT_STAFF`); the owner cannot be edited or suspended (`OWNER_IMMUTABLE`); `OWNER_EXISTS`, `MEMBER_NOT_ACTIVE`. After a transfer the previous owner stays as a member with the Manager role |

### Campaigns & feedback (Phase 5, migration 0016)

| RPC | Kind | Permission | Notes |
|---|---|---|---|
| `preview_campaign_audience(tenant, segment, channel)` | DEFINER | marketing.manage | `{count, sample, consented}`; segment keys: inactive_days, active_days, min_visits, min_spend, tags, gender, home_branch_id, birthday_this_month, members_only |
| `launch_campaign(id)` | DEFINER | marketing.manage | Draft → launched; snapshots recipients, enqueues one job each (dedupe `campaign:<id>:<customer>`), counts `messages` usage; `EMPTY_AUDIENCE`, `PLAN_LIMIT_MESSAGES`, `CAMPAIGN_NOT_DRAFT` |
| `cancel_campaign(id)` | DEFINER | marketing.manage | Cancels queued jobs; `CAMPAIGN_NOT_LAUNCHED` |
| `get_campaign_stats(tenant)` | DEFINER | marketing.manage | queued / sent / failed / skipped / cancelled per campaign |
| `get_feedback_summary(tenant, from, to)` | DEFINER | marketing.manage · reports.view | requested, responses, average, distribution, per staff, recent comments |
| `public_get_feedback(token)`, `public_submit_feedback(token, rating, comment)`, `public_unsubscribe(token)` | DEFINER (anon) | — | Single-use, 30-day feedback link; unsubscribe records a marketing-consent withdrawal |

Completing an appointment cancels its pending reminder and, when feedback is enabled, queues a `feedback_request` after the configured delay.

Phase 1 doesn't need an Edge Function. Onboarding is a single atomic `SECURITY DEFINER` RPC, which is safer than a service-role function doing several writes. Invitations are delivered as one-time links the owner shares (copy, WhatsApp or email link). Automatic invitation emails arrive with `email-send` in Phase 5.

Every function will share `supabase/functions/_shared/` (CORS allow-list, JWT verification via `auth.getUser`, a user-scoped client so RLS applies, input schemas, the error format above, structured logging, idempotency keys, secret access via `Deno.env` / Vault).

| Function | Auth | Phase | Purpose |
|---|---|:-:|---|
| `tenant-invitation` | User JWT, then service role scoped to the invitation | 5 | Create invitation via RPC as the user, then send the email |
| `email-send` | Internal (pg_net from worker) | 5 | Transactional email provider |
| `whatsapp-send` / `whatsapp-webhook` | Internal / Meta signature (`X-Hub-Signature-256`) | 5 | WhatsApp Cloud API, approved templates only |
| `notification-worker` ✅ | pg_cron + shared secret (`NOTIFY_CRON_SECRET`) | 5 | Claims due jobs, sends via WhatsApp Cloud API / Twilio SMS / Resend email, reports outcome (reminders are queued by DB triggers — no separate scheduler) |
| `payment-create` / `payment-webhook` | User JWT / gateway HMAC | 3 | Oman gateway adapter (e.g. Thawani, OmanNet, bank PGs). Idempotent by gateway event id |
| `generate-invoice-document` | User JWT | 3 | Bilingual PDF to the private bucket, signed URL |
| `e-invoice-submit` | Internal | 6+ | Fawtara integration layer (disabled until requirements are verified) |
| `subscription-checkout` / `subscription-webhook` | User JWT / provider signature | 6 | Plan purchase and status changes |
| `export-report` | User JWT | 6 | Async CSV/XLSX/PDF exports |
| `platform-admin` | Platform admin JWT + `platform_admins` check | 6 | Tenant suspension, support access (time-boxed, audited) |

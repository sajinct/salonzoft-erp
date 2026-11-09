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

`NOT_AUTHENTICATED, FORBIDDEN, NOT_FOUND, INVALID_NAME, INVALID_SLUG, SLUG_RESERVED, TENANT_SLUG_TAKEN, TENANT_LIMIT_REACHED, INVALID_BUSINESS_TYPE, INVALID_LANGUAGE, INVALID_TIMEZONE, INVALID_EMAIL, INVALID_ROLE, INVALID_BRANCH, BRANCH_REQUIRED, ROLE_ESCALATION_FORBIDDEN, BRANCH_ESCALATION_FORBIDDEN, MEMBER_ALREADY_EXISTS, PLAN_LIMIT_STAFF, PLAN_LIMIT_BRANCHES, PLAN_NOT_CONFIGURED, INVITATION_INVALID, INVITATION_EXPIRED, INVITATION_EMAIL_MISMATCH, EMAIL_NOT_CONFIRMED, TENANT_UNAVAILABLE, OWNER_IMMUTABLE, SELF_MODIFICATION_FORBIDDEN, INVALID_JOB_TITLE, INVALID_STATUS, INVALID_WORKING_HOURS, OVERLAPPING_WORKING_HOURS, AUDIT_LOG_IMMUTABLE`

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
| `calculate_availability(branch, services[], staff?, date)` | INVOKER | 2 | ⏳ | Shifts − leave − bookings − buffers − branch hours |
| `create_appointment(…, idempotency_key)` | DEFINER | 2 | ⏳ | Locks + GiST exclusion ⇒ `SLOT_UNAVAILABLE` |
| `reschedule_appointment`, `cancel_appointment`, `check_in_appointment`, `mark_no_show` | DEFINER | 2 | ⏳ | |
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

# 03 · Security, RLS and the permission matrix

## Principles

1. **Default deny.** Migration 0001 revokes Supabase's default `ALL` grants for `anon`/`authenticated` on new objects. Every table and function is granted explicitly. `supabase/config.toml` sets `auto_expose_new_tables = false`.
2. **RLS on every table** (automated test: `01_schema_security.test.mjs`). No tenant data policy is `USING (true)`; only non-sensitive catalogues are readable by any signed-in user.
3. **Server-derived authorization.** Policies call `app.*` helpers that read membership, role, entitlement and subscription tables. Nothing comes from the client or from JWT metadata.
4. **Column-scoped grants.** Clients can update only the columns listed in grants. `tenant_id`, `is_owner`, `is_system`, `status` and subscription fields aren't updatable.
5. **Privileged writes through RPC.** Memberships, role assignments, branch access and invitations can't be written directly. Audited `SECURITY DEFINER` RPCs do it, each with an explicit permission check and anti-escalation rules.
6. **Service role never in the browser.** Only Edge Functions hold it, and they first authorize the caller with the user's JWT.

## Authorization helpers (`app` schema, not exposed)

| Helper | Returns |
|---|---|
| `app.my_tenant_ids()` | Tenants with an active membership (tenant not closed) |
| `app.tenant_is_operational(t)` | Tenant active and subscription `trialing` (not expired) / `active` / `past_due` |
| `app.module_enabled(t, module)` | Core module, or enabled and unexpired entitlement |
| `app.permissions_for(t)` | Effective permission codes: owner gets all; otherwise union of role permissions; filtered by module entitlement; reduced to a billing-only set when not operational |
| `app.has_permission(t, p)` / `app.tenants_with_permission(p)` | Boolean / set form for policies |
| `app.accessible_branch_ids()` / `app.has_branch_access(b)` | Branch scope (owner and `all_branches` ⇒ all) |
| `app.branch_ids_with_permission(p)` | Permission AND branch access, for branch-scoped tables |
| `app.require_permission(t, p)` | Raises `FORBIDDEN` (SQLSTATE 42501) |
| `app.storage_path_allowed(path, p)` | Storage object authorization from the path |

All helpers are `SECURITY DEFINER` (so they don't recurse through RLS), `STABLE`, `search_path = ''`, fully qualified, and only describe `auth.uid()`. Policies use the **set-returning** forms inside `IN (SELECT …)`, so Postgres evaluates them once per statement as an InitPlan instead of once per row.

### Policy pattern

```sql
-- tenant-scoped read for any member
using (tenant_id in (select app.my_tenant_ids()))
-- permission-gated write
with check (tenant_id in (select app.tenants_with_permission('branches.manage')))
-- branch-scoped business data (Phase 2+)
using (branch_id in (select app.branch_ids_with_permission('appointments.view')))
-- anti-escalation (role_permissions insert)
with check (tenant_id in (select app.tenants_with_permission('roles.manage'))
            and app.has_permission(tenant_id, permission_code))
```

## Anti-escalation rules (enforced in SQL, tested)

* You can only grant a permission you hold (`role_permissions` policy).
* You can only assign roles whose permissions are a subset of yours, and only for modules in the plan (`app.assert_can_assign`).
* You can only grant access to branches you can access. Only owners or all-branch members can grant all-branch access.
* You can't modify your own access, and nobody can modify or suspend the owner (`OWNER_IMMUTABLE`).
* To edit a member, you must outrank both their current and their new access.

## SECURITY DEFINER checklist (applied to every definer function)

- [x] `REVOKE ALL … FROM public, anon`; `GRANT EXECUTE … TO authenticated` (tested: anon can execute nothing, PUBLIC has no EXECUTE on any definer function)
- [x] `SET search_path = ''` (tested for every definer function)
- [x] Fully qualified object names
- [x] Explicit `app.require_permission` or equivalent at the top
- [x] Input validation with structured error codes
- [x] Audit via `app.audit` or row triggers

## Invitations

Tokens carry 244 bits of CSPRNG randomness and are returned once. Only the SHA-256 hash is stored, and `token_hash` isn't selectable by API roles. Acceptance requires a signed-in user with a **confirmed** email that matches the invitation, an unexpired pending invitation, an active tenant, and an available seat. Tokens are single-use.

## Role and permission matrix (default templates)

✓ = granted by the template. **Owner** holds everything implicitly. Tenants can edit templates and create custom roles (subject to the anti-escalation rules above).

| Permission | Manager | Receptionist | Cashier | Stylist | Accountant |
|---|:-:|:-:|:-:|:-:|:-:|
| dashboard.view | ✓ | ✓ | ✓ | | ✓ |
| settings.view | ✓ | | | | ✓ |
| settings.manage · branches.manage · billing.manage · audit.view · roles.manage | | | | | |
| team.view · team.manage | ✓ | | | | |
| appointments.view · appointments.manage | ✓ | ✓ | view | | |
| appointments.own | ✓ | | | ✓ | |
| customers.view · customers.manage | ✓ | ✓ | view | | |
| customers.export · customers.sensitive | ✓ | | | | |
| services.view | ✓ | ✓ | ✓ | ✓ | |
| services.manage | ✓ | | | | |
| pos.access | ✓ | ✓ | ✓ | | |
| pos.discount · pos.refund | ✓ | | | | |
| pos.cash_session | ✓ | | ✓ | | |
| packages.view | ✓ | ✓ | ✓ | | |
| packages.manage | ✓ | | | | |
| employees.view | ✓ | ✓ | | | |
| employees.manage · attendance.manage | ✓ | | | | |
| commissions.view | ✓ | | | | ✓ |
| commissions.own | ✓ | | | ✓ | |
| inventory.view | ✓ | | | | ✓ |
| inventory.manage | ✓ | | | | |
| purchases.manage | ✓ | | | | ✓ |
| finance.view · finance.manage · expenses.approve | ✓ | | | | ✓ |
| loyalty.manage · marketing.manage · notifications.manage | ✓ | | | | |
| reports.view | ✓ | | | | ✓ |
| reports.financial | ✓ | | | | ✓ |
| online_booking.manage | ✓ | | | | |

## Tested security scenarios (executed: `npm run test:db`, 57 passing)

| Mandatory scenario | Status | Test file |
|---|---|---|
| Tenant A cannot access Tenant B (read/insert/update/delete/RPC, all 14 tenant tables) | ✅ Phase 1 | `02_tenant_isolation` |
| Staff cannot access unauthorized branches | ✅ Phase 1 | `04_team_roles_branches` |
| Subscription restrictions cannot be bypassed | ✅ Phase 1 | `05_subscription_gating` |
| Storage isolation is enforced | ✅ Phase 1 | `06_storage_isolation` |
| Failed transactions leave no partial updates | ✅ for onboarding and working hours | `03_onboarding` |
| OMR precision | ✅ client money library (Vitest) | `money.spec.ts` |
| Arabic RTL | ✅ unit + E2E written (E2E not yet executed) | `i18n.service.spec.ts`, `tests/e2e` |
| Two users can't reserve the same employee/time | ⏳ Phase 2: needs real concurrent connections (PGlite is single-connection) | — |
| Concurrent package redemption / invoice double-post / webhook retries / inventory double-deduct | ⏳ Phases 3–4 | — |
| Realtime events are authorized | ⏳ Phase 2 | — |

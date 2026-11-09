# 05 · Frontend structure, screens and navigation

Angular 22: standalone components, signals, zoneless change detection, `OnPush`, strict TypeScript and strict templates. Tailwind CSS 4 with semantic design tokens (light/dark), Angular CDK (dialogs, menus, clipboard), and Lucide icons. Every feature route is lazy-loaded.

```text
apps/web/src/app/
├── core/
│   ├── auth/              AuthService (PKCE, signals)
│   ├── supabase/          typed client token, AppError/unwrap, database.types.ts (generated)
│   ├── tenant/            TenantContextService (active tenant/branch, permissions, modules)
│   ├── guards/            authGuard, guestGuard, tenantGuard, permissionGuard, landingGuard
│   ├── navigation/        NAV_ITEMS + visibleNav/landingPath (permission × entitlement)
│   ├── i18n/              en.ts (source of keys), ar.ts (typed: compile error if a key is missing), I18nService, t/tx pipes
│   └── services/          ThemeService, ToastService
├── shared/
│   ├── components/ui.ts   PageHeader, ToastOutlet, ConfirmDialog/ConfirmService, StatePanel
│   ├── money/             BigInt minor-unit money maths (OMR 3 dp), VAT helpers
│   └── pipes/             money, localDate (tenant/branch timezone, optional Hijri)
├── layouts/               auth-layout (brand panel), app-shell (sidebar, branch switcher, lang/theme, user menu, trial banner)
└── features/
    ├── auth/              login, signup, forgot/reset password, callback, accept-invite
    ├── onboarding/        create-business (slug check, idempotent), select-tenant
    ├── dashboard/         Phase 1 KPIs + setup checklist + roadmap
    ├── settings/          business, branches (+hours editor), team (invite/edit/suspend), roles (permission matrix), profile
    │   └── data/          data-access services (the only place Supabase is called)
    ├── coming-soon/       honest placeholder for modules scheduled in later phases
    └── errors/            forbidden, not-found
```

**Rules:** components never call Supabase directly; they use `*Service` classes. Business rules are validated server-side, and client validation only improves UX. Money is never computed with floats.

## Navigation

| Item | Permission (any) | Module | Phase |
|---|---|---|:-:|
| Dashboard | dashboard.view | dashboard | ✅ 1 |
| Appointments | appointments.view, appointments.own | appointments | 2 |
| Customers | customers.view | customers | 2 |
| POS | pos.access | pos | 3 |
| Services | services.view | services | 2 |
| Employees | employees.view, commissions.own | employees | 2 |
| Packages | packages.view | packages | 3 |
| Inventory | inventory.view | inventory | 4 |
| Purchases | purchases.manage | purchases | 4 |
| Finance | finance.view | finance | 4 |
| Marketing | marketing.manage, loyalty.manage | marketing | 5 |
| Reports | reports.view, reports.financial | reports | 6 |
| Settings | settings.*, branches.manage, team.view, roles.manage | settings | ✅ 1 |

Items appear only when the user has a listed permission **and** the plan includes the module. Unreleased items show a "Soon" badge and open the roadmap placeholder.

## Screens: Phase 1

| Route | Screen | Guard |
|---|---|---|
| `/auth/login`, `/auth/signup` | Sign in / start trial | guest |
| `/auth/forgot-password`, `/auth/reset-password` | Recovery | – |
| `/auth/callback` | Email confirmation / PKCE landing | – |
| `/accept-invite?token=` | Join a team | – (prompts sign-in) |
| `/onboarding` | Create business | auth |
| `/select-tenant` | Business chooser | auth |
| `/dashboard` | Overview | auth + tenant + dashboard.view |
| `/settings/business` | Profile, logo, regional, VAT and invoicing | settings.view (edit: settings.manage) |
| `/settings/branches` | Branch list + editor + weekly hours (split shifts) | branches.manage or settings.view |
| `/settings/team` | Members, invitations, access editing, suspension | team.view (actions: team.manage) |
| `/settings/roles` | Roles + permission matrix | roles.manage or team.view |
| `/settings/profile` | Personal details, language, password | auth |

## Screens: Phase 2 part 1

| Route | Permission | Contents |
|---|---|---|
| `/services` | `services.view` / `services.manage` | Category chips, search, table; category dialog; service dialog with per-branch price / availability |
| `/employees` | `employees.view` / `employees.manage` / `attendance.manage` | Cards; dialog tabs: profile (+ optional login link), branches & skills, weekly split shifts, leave |
| `/customers` | `customers.view` | Debounced server search (name EN/AR, partial mobile, email); create with duplicate warning; CSV import (client parse → dry run → import) |
| `/customers/:id` | `customers.view` | Details, WhatsApp/call links, consent matrix + history, notes (sensitive kinds gated) |

The CSV parser (`features/customers/data/csv.ts`) accepts comma, semicolon or tab delimiters and English or Arabic header names. It is unit-tested.

## Screens: later phases

Phase 2 (delivered): `/appointments` day calendar in the branch timezone with one column per stylist, off-shift shading, now-line, click-to-book, booking dialog (customer search / quick add / walk-in, services, any or specific staff, live free times), details dialog with status actions and reschedule, realtime refresh; stylists land on their own column ("My day"). Still to come: week view, resource columns, drag-and-drop. Phase 3: POS (touch layout, cart, split payment, receipt), invoice viewer, cash session open/close, packages and memberships. Phase 4: stock, purchase orders, GRN, transfers, commissions, expenses. Phase 5: public booking (`/book/{slug}`), templates, campaigns. Phase 6 part 1 (delivered): `/admin` console outside the tenant shell (overview KPIs, businesses with search/filters and a detail page — status, trial, plan, modules, invoices, history — invoices, plans editor, billing settings and admins), Settings → Plan & billing for salons, printable `/billing/invoices/:id`. Both i18n dictionaries are now lazy chunks loaded by the app initializer. Phase 6 part 2 (delivered): `/reports` — report list by permission, period presets / custom range, the shell branch switcher, totals with exact money arithmetic, CSV export (UTF-8 BOM, formula-guarded) and print.

## Accessibility and UX

Labels on every input; `aria-live` toasts; visible focus rings; dialogs via CDK (focus trap, Esc); confirmations for destructive actions; numbers and phone numbers render LTR inside RTL; the layout is tablet-first (reception desks) and responsive down to phones.

## Installable app (PWA), versions and updates

* **Install**: Chrome / Edge show *Install Salonzoft* in the address bar; on iPhone/iPad use Share → *Add to Home Screen*; on Android, *Install app* from the menu. The manifest (`public/manifest.webmanifest`) sets the name, colours, icons (standard + maskable + Apple touch) and shortcuts to Appointments, POS and Customers. Icons are generated from one design with `scripts/make-icons.mjs`.
* **Offline shell**: the Angular service worker (`ngsw-config.json`, production builds only) caches the app files so it opens instantly; data always comes live from Supabase (never cached).
* **Version**: `apps/web/package.json` holds the version (bump it for notable releases). CI runs `scripts/stamp-version.mjs`, which writes the version, short commit and build time into the bundle and `ngsw.json`; users see it at the bottom of the user menu (*Version 1.0.0 (abc1234) · Check for updates*) and admins in the console header.
* **Auto-update** (`AppUpdateService`): checks on start, every 15 minutes and whenever the app returns to the foreground; a new deploy downloads in the background and is applied on the next page change — never in the middle of a sale or form — or immediately with *Update now* on the banner. A broken cache reloads fresh automatically. Every deploy has a new commit stamp, so every deploy reaches installed apps.

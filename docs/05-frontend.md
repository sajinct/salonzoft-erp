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

## Screens: later phases

Phase 2: calendar (day/week/month, staff and resource columns, drag-and-drop), appointment drawer, walk-in quick add, customer list and profile, services and price lists, employee profiles, shift roster, and the staff portal "My day". Phase 3: POS (touch layout, cart, split payment, receipt), invoice viewer, cash session open/close, packages and memberships. Phase 4: stock, purchase orders, GRN, transfers, commissions, expenses. Phase 5: public booking (`/book/{slug}`), templates, campaigns. Phase 6: `/admin` super-admin and reports.

## Accessibility and UX

Labels on every input; `aria-live` toasts; visible focus rings; dialogs via CDK (focus trap, Esc); confirmations for destructive actions; numbers and phone numbers render LTR inside RTL; the layout is tablet-first (reception desks) and responsive down to phones.

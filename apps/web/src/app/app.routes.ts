import { Type } from '@angular/core';
import { CanActivateFn, Routes } from '@angular/router';

type LoadComponent = () => Promise<Type<unknown>>;
import { authGuard, guestGuard, landingGuard, permissionGuard, tenantGuard } from './core/guards/guards';

export const routes: Routes = [
  // ---- Public / auth ------------------------------------------------------------
  {
    path: 'auth',
    loadComponent: () => import('./layouts/auth-layout').then((m) => m.AuthLayout),
    children: [
      { path: 'login', canActivate: [guestGuard], loadComponent: () => import('./features/auth/login.page').then((m) => m.LoginPage) },
      { path: 'signup', canActivate: [guestGuard], loadComponent: () => import('./features/auth/signup.page').then((m) => m.SignupPage) },
      { path: 'forgot-password', loadComponent: () => import('./features/auth/forgot-password.page').then((m) => m.ForgotPasswordPage) },
      { path: 'reset-password', loadComponent: () => import('./features/auth/reset-password.page').then((m) => m.ResetPasswordPage) },
      { path: 'callback', loadComponent: () => import('./features/auth/callback.page').then((m) => m.CallbackPage) },
      { path: '', pathMatch: 'full', redirectTo: 'login' },
    ],
  },
  // NOTE: each page gets an explicit path. Grouping them under an empty-path
  // layout route would make that route match "/" with an empty outlet and
  // shadow the app shell below (regression-tested in app.routes.spec.ts).
  ...(
    [
      { path: 'accept-invite', guards: [], page: () => import('./features/auth/accept-invite.page').then((m) => m.AcceptInvitePage) },
      { path: 'onboarding', guards: [authGuard], page: () => import('./features/onboarding/create-business.page').then((m) => m.CreateBusinessPage) },
      { path: 'select-tenant', guards: [authGuard], page: () => import('./features/onboarding/select-tenant.page').then((m) => m.SelectTenantPage) },
    ] satisfies { path: string; guards: CanActivateFn[]; page: LoadComponent }[]
  ).map(({ path, guards, page }) => ({
    path,
    loadComponent: () => import('./layouts/auth-layout').then((m) => m.AuthLayout),
    children: [{ path: '', canActivate: guards, loadComponent: page }],
  })),

  // ---- Public online booking (no login; only the public_* RPCs are callable) -----
  { path: 'book/manage/:token', loadComponent: () => import('./features/booking/manage-booking.page').then((m) => m.ManageBookingPage) },
  { path: 'book/:slug', loadComponent: () => import('./features/booking/book.page').then((m) => m.BookPage) },
  { path: 'feedback/:token', loadComponent: () => import('./features/marketing/public-pages').then((m) => m.FeedbackPage) },
  { path: 'unsubscribe/:token', loadComponent: () => import('./features/marketing/public-pages').then((m) => m.UnsubscribePage) },

  // ---- Platform (no tenant context) ---------------------------------------------
  {
    path: 'admin',
    canActivate: [authGuard], // + platformAdminGuard inside ADMIN_ROUTES
    loadChildren: () => import('./features/admin/admin.routes').then((m) => m.ADMIN_ROUTES),
  },
  {
    path: 'billing/invoices/:id',
    canActivate: [authGuard],
    loadComponent: () => import('./features/billing/subscription-invoice.page').then((m) => m.SubscriptionInvoicePage),
  },

  // ---- Salon ERP (authenticated + tenant context) --------------------------------
  {
    path: '',
    canActivate: [authGuard, tenantGuard],
    loadComponent: () => import('./layouts/app-shell').then((m) => m.AppShell),
    children: [
      { path: '', pathMatch: 'full', canActivate: [landingGuard], children: [] },
      {
        path: 'dashboard',
        canActivate: [permissionGuard],
        data: { permissions: ['dashboard.view'] },
        loadComponent: () => import('./features/dashboard/dashboard.page').then((m) => m.DashboardPage),
      },
      {
        path: 'appointments',
        canActivate: [permissionGuard],
        data: { permissions: ['appointments.view', 'appointments.manage', 'appointments.own'], module: 'appointments' },
        loadComponent: () => import('./features/appointments/appointments.page').then((m) => m.AppointmentsPage),
      },
      {
        path: 'pos',
        canActivate: [permissionGuard],
        data: { permissions: ['pos.access'], module: 'pos' },
        loadComponent: () => import('./features/pos/pos.page').then((m) => m.PosPage),
      },
      {
        path: 'invoices',
        canActivate: [permissionGuard],
        data: { permissions: ['pos.access', 'pos.refund', 'pos.cash_session', 'finance.view', 'reports.financial'], module: 'pos' },
        loadComponent: () => import('./features/pos/invoices.page').then((m) => m.InvoicesPage),
      },
      {
        path: 'invoices/:id',
        canActivate: [permissionGuard],
        data: { permissions: ['pos.access', 'pos.refund', 'pos.cash_session', 'finance.view', 'reports.financial'], module: 'pos' },
        loadComponent: () => import('./features/pos/invoice.page').then((m) => m.InvoicePage),
      },
      {
        path: 'marketing',
        canActivate: [permissionGuard],
        data: { permissions: ['marketing.manage', 'reports.view'], module: 'marketing' },
        loadComponent: () => import('./features/marketing/marketing.page').then((m) => m.MarketingPage),
      },
      {
        path: 'finance',
        canActivate: [permissionGuard],
        data: { permissions: ['finance.view', 'finance.manage', 'expenses.approve', 'commissions.view', 'commissions.own', 'reports.financial'], module: 'finance' },
        loadComponent: () => import('./features/finance/finance.page').then((m) => m.FinancePage),
      },
      {
        path: 'inventory',
        canActivate: [permissionGuard],
        data: { permissions: ['inventory.view', 'inventory.manage'], module: 'inventory' },
        loadComponent: () => import('./features/inventory/inventory.page').then((m) => m.InventoryPage),
      },
      {
        path: 'purchases',
        canActivate: [permissionGuard],
        data: { permissions: ['purchases.manage'], module: 'purchases' },
        loadComponent: () => import('./features/inventory/purchases.page').then((m) => m.PurchasesPage),
      },
      {
        path: 'packages',
        canActivate: [permissionGuard],
        data: { permissions: ['packages.view', 'packages.manage'], module: 'packages' },
        loadComponent: () => import('./features/packages/packages.page').then((m) => m.PackagesPage),
      },
      {
        path: 'services',
        canActivate: [permissionGuard],
        data: { permissions: ['services.view', 'services.manage'], module: 'services' },
        loadComponent: () => import('./features/services/services.page').then((m) => m.ServicesPage),
      },
      {
        path: 'employees',
        canActivate: [permissionGuard],
        data: { permissions: ['employees.view', 'employees.manage', 'attendance.manage'], module: 'employees' },
        loadComponent: () => import('./features/employees/employees.page').then((m) => m.EmployeesPage),
      },
      {
        path: 'customers',
        canActivate: [permissionGuard],
        data: { permissions: ['customers.view'], module: 'customers' },
        loadComponent: () => import('./features/customers/customers.page').then((m) => m.CustomersPage),
      },
      {
        path: 'customers/:id',
        canActivate: [permissionGuard],
        data: { permissions: ['customers.view'], module: 'customers' },
        loadComponent: () => import('./features/customers/customer-detail.page').then((m) => m.CustomerDetailPage),
      },
      {
        path: 'settings',
        loadChildren: () => import('./features/settings/settings.routes').then((m) => m.SETTINGS_ROUTES),
      },
      {
        path: 'm/:module',
        loadComponent: () => import('./features/coming-soon/coming-soon.page').then((m) => m.ComingSoonPage),
      },
      { path: 'forbidden', loadComponent: () => import('./features/errors/error.pages').then((m) => m.ForbiddenPage) },
    ],
  },

  { path: '**', loadComponent: () => import('./features/errors/error.pages').then((m) => m.NotFoundPage) },
];

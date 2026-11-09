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

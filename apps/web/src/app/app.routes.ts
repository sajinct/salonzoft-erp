import { Routes } from '@angular/router';
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
  {
    path: '',
    loadComponent: () => import('./layouts/auth-layout').then((m) => m.AuthLayout),
    children: [
      { path: 'accept-invite', loadComponent: () => import('./features/auth/accept-invite.page').then((m) => m.AcceptInvitePage) },
      { path: 'onboarding', canActivate: [authGuard], loadComponent: () => import('./features/onboarding/create-business.page').then((m) => m.CreateBusinessPage) },
      { path: 'select-tenant', canActivate: [authGuard], loadComponent: () => import('./features/onboarding/select-tenant.page').then((m) => m.SelectTenantPage) },
    ],
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

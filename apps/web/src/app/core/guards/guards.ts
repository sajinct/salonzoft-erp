import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../auth/auth.service';
import { landingPath } from '../navigation/nav-items';
import { TenantContextService } from '../tenant/tenant-context.service';

/** Requires a signed-in user. */
export const authGuard: CanActivateFn = async (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  await auth.ready;
  return auth.isSignedIn() ? true : router.createUrlTree(['/auth/login'], { queryParams: { next: state.url } });
};

/** Only for signed-out users (login / sign-up pages). */
export const guestGuard: CanActivateFn = async (route) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  await auth.ready;
  if (!auth.isSignedIn()) return true;
  const next = route.queryParamMap.get('next');
  return router.parseUrl(next && next.startsWith('/') && !next.startsWith('//') ? next : '/');
};

/** Requires an active business context; routes to onboarding / chooser otherwise. */
export const tenantGuard: CanActivateFn = async () => {
  const ctx = inject(TenantContextService);
  const router = inject(Router);
  const result = await ctx.ensure();
  if (result === 'no-tenants') return router.parseUrl('/onboarding');
  if (result === 'choose') return router.parseUrl('/select-tenant');
  return true;
};

/**
 * Route-level permission check: `data: { permissions: ['team.view'], module: 'team' }`.
 * UX only — RLS and RPC checks are the actual enforcement.
 */
export const permissionGuard: CanActivateFn = (route) => {
  const ctx = inject(TenantContextService);
  const router = inject(Router);
  const permissions = (route.data['permissions'] as string[] | undefined) ?? [];
  const module = route.data['module'] as string | undefined;
  const allowed = (permissions.length === 0 || ctx.canAny(permissions)) && (!module || ctx.hasModule(module));
  return allowed ? true : router.parseUrl('/forbidden');
};

/** Redirects the empty path to the first page the user can open. */
export const landingGuard: CanActivateFn = () => {
  const ctx = inject(TenantContextService);
  return inject(Router).parseUrl(landingPath(ctx));
};

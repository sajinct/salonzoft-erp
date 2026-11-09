import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { appConfig } from './app.config';
import { AuthService } from './core/auth/auth.service';
import { SUPABASE } from './core/supabase/supabase.client';
import { TenantContextService } from './core/tenant/tenant-context.service';

/**
 * Regression: an empty-path layout route used to swallow "/" so signed-in
 * users landed on a blank page instead of being redirected to their start page.
 */
function setup(permissions: string[], signedIn = true) {
  const has = (ps: readonly string[]) => ps.some((p) => permissions.includes(p));
  TestBed.configureTestingModule({
    providers: [
      ...appConfig.providers,
      { provide: SUPABASE, useValue: { rpc: async () => ({ data: null, error: null }) } },
      {
        provide: AuthService,
        useValue: { ready: Promise.resolve(), isSignedIn: signal(signedIn), user: signal(null), session: signal(null) },
      },
      {
        provide: TenantContextService,
        useValue: {
          ensure: async () => 'ok',
          can: (p: string) => permissions.includes(p),
          canAny: has,
          hasModule: () => true,
          permissions: signal(new Set(permissions)),
          modules: signal(new Set<string>()),
          context: signal(null),
          tenants: signal(null),
          branches: signal([]),
          branchId: signal(null),
          tenantId: signal(null),
          activeBranch: signal(null),
        },
      },
    ],
  });
}

describe('app routes', () => {
  it('redirects "/" to the dashboard for users who can see it', async () => {
    setup(['dashboard.view']);
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/');
    expect(TestBed.inject(Router).url).toBe('/dashboard');
  });

  it('redirects "/" to the first permitted page for staff without dashboard access', async () => {
    setup(['team.view']);
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/');
    expect(TestBed.inject(Router).url).toBe('/settings/team');
  });

  it('sends signed-out users to login with a return URL', async () => {
    setup([], false);
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/settings/team');
    expect(TestBed.inject(Router).url).toBe('/auth/login?next=%2Fsettings%2Fteam');
  });
});

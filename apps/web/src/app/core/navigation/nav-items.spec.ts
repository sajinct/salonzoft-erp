import { NAV_ITEMS, NavAccess, landingPath, visibleNav } from './nav-items';

const access = (permissions: string[], modules: string[]): NavAccess => ({
  canAny: (ps) => ps.some((p) => permissions.includes(p)),
  hasModule: (m) => modules.includes(m),
});

const ALL_MODULES = [...new Set(NAV_ITEMS.map((i) => i.module))];

describe('role-based navigation', () => {
  it('an owner with every module sees every item', () => {
    const allPerms = NAV_ITEMS.flatMap((i) => i.permissions);
    expect(visibleNav(access(allPerms, ALL_MODULES))).toHaveLength(NAV_ITEMS.length);
  });

  it('a receptionist sees operations only, not finance or settings', () => {
    const keys = visibleNav(
      access(['dashboard.view', 'appointments.manage', 'appointments.view', 'customers.view', 'services.view', 'pos.access'], ALL_MODULES),
    ).map((i) => i.key);
    expect(keys).toContain('nav.appointments');
    expect(keys).toContain('nav.pos');
    expect(keys).not.toContain('nav.finance');
    expect(keys).not.toContain('nav.settings');
  });

  it('hides modules that the plan does not include, even with permission', () => {
    const keys = visibleNav(access(['purchases.manage', 'dashboard.view'], ['dashboard'])).map((i) => i.key);
    expect(keys).toEqual(['nav.dashboard']);
  });

  it('lands staff without dashboard access on an available page', () => {
    expect(landingPath(access(['dashboard.view'], ALL_MODULES))).toBe('/dashboard');
    expect(landingPath(access(['team.view'], ALL_MODULES))).toBe('/settings');
    // Stylists land on their own day in the calendar ("My day").
    expect(landingPath(access(['appointments.own'], ALL_MODULES))).toBe('/appointments');
    // Commission-only staff land on their own commissions.
    expect(landingPath(access(['commissions.own'], ALL_MODULES))).toBe('/finance');
    expect(landingPath(access([], ALL_MODULES))).toBe('/settings/profile');
  });
});

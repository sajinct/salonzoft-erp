import { TranslationKey } from '../i18n/en';

export interface NavItem {
  key: TranslationKey;
  icon: string;
  path: string;
  /** Visible when the user holds ANY of these permissions. */
  permissions: readonly string[];
  /** Module that must be entitled by the subscription plan. */
  module: string;
  section: 'operations' | 'business' | 'admin';
  /** Roadmap phase in which the module ships; omitted = available now. */
  phase?: number;
}

/** Primary navigation (spec §14). Filtering by permission + entitlement happens in `visibleNav`. */
export const NAV_ITEMS: readonly NavItem[] = [
  { key: 'nav.dashboard', icon: 'layout-dashboard', path: '/dashboard', permissions: ['dashboard.view'], module: 'dashboard', section: 'operations' },
  { key: 'nav.appointments', icon: 'calendar-days', path: '/m/appointments', permissions: ['appointments.view', 'appointments.own'], module: 'appointments', section: 'operations', phase: 2 },
  { key: 'nav.customers', icon: 'users', path: '/m/customers', permissions: ['customers.view'], module: 'customers', section: 'operations', phase: 2 },
  { key: 'nav.pos', icon: 'receipt', path: '/m/pos', permissions: ['pos.access'], module: 'pos', section: 'operations', phase: 3 },
  { key: 'nav.services', icon: 'scissors', path: '/m/services', permissions: ['services.view'], module: 'services', section: 'business', phase: 2 },
  { key: 'nav.employees', icon: 'id-card', path: '/m/employees', permissions: ['employees.view', 'commissions.own'], module: 'employees', section: 'business', phase: 2 },
  { key: 'nav.packages', icon: 'gift', path: '/m/packages', permissions: ['packages.view'], module: 'packages', section: 'business', phase: 3 },
  { key: 'nav.inventory', icon: 'package', path: '/m/inventory', permissions: ['inventory.view'], module: 'inventory', section: 'business', phase: 4 },
  { key: 'nav.purchases', icon: 'truck', path: '/m/purchases', permissions: ['purchases.manage'], module: 'purchases', section: 'business', phase: 4 },
  { key: 'nav.finance', icon: 'wallet', path: '/m/finance', permissions: ['finance.view'], module: 'finance', section: 'business', phase: 4 },
  { key: 'nav.marketing', icon: 'megaphone', path: '/m/marketing', permissions: ['marketing.manage', 'loyalty.manage'], module: 'marketing', section: 'business', phase: 5 },
  { key: 'nav.reports', icon: 'chart-column', path: '/m/reports', permissions: ['reports.view', 'reports.financial'], module: 'reports', section: 'admin', phase: 6 },
  {
    key: 'nav.settings', icon: 'settings', path: '/settings',
    permissions: ['settings.view', 'settings.manage', 'branches.manage', 'team.view', 'roles.manage'],
    module: 'settings', section: 'admin',
  },
];

export interface NavAccess {
  canAny(permissions: readonly string[]): boolean;
  hasModule(module: string): boolean;
}

export function visibleNav(access: NavAccess, items: readonly NavItem[] = NAV_ITEMS): NavItem[] {
  return items.filter((i) => access.hasModule(i.module) && access.canAny(i.permissions));
}

/** First page a user may open — staff without dashboard access land elsewhere. */
export function landingPath(access: NavAccess): string {
  const first = visibleNav(access).find((i) => !i.phase);
  return first?.path ?? '/settings/profile';
}

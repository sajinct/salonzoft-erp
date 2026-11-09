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
  { key: 'nav.appointments', icon: 'calendar-days', path: '/appointments', permissions: ['appointments.view', 'appointments.manage', 'appointments.own'], module: 'appointments', section: 'operations' },
  { key: 'nav.customers', icon: 'users', path: '/customers', permissions: ['customers.view'], module: 'customers', section: 'operations' },
  { key: 'nav.pos', icon: 'receipt', path: '/pos', permissions: ['pos.access'], module: 'pos', section: 'operations' },
  { key: 'nav.invoices', icon: 'wallet', path: '/invoices', permissions: ['pos.refund', 'pos.cash_session', 'finance.view', 'reports.financial'], module: 'pos', section: 'business' },
  { key: 'nav.services', icon: 'scissors', path: '/services', permissions: ['services.view', 'services.manage'], module: 'services', section: 'business' },
  { key: 'nav.employees', icon: 'id-card', path: '/employees', permissions: ['employees.view', 'employees.manage', 'attendance.manage'], module: 'employees', section: 'business' },
  { key: 'nav.packages', icon: 'gift', path: '/packages', permissions: ['packages.view', 'packages.manage'], module: 'packages', section: 'business' },
  { key: 'nav.inventory', icon: 'package', path: '/inventory', permissions: ['inventory.view', 'inventory.manage'], module: 'inventory', section: 'business' },
  { key: 'nav.purchases', icon: 'truck', path: '/purchases', permissions: ['purchases.manage'], module: 'purchases', section: 'business' },
  { key: 'nav.finance', icon: 'wallet', path: '/finance', permissions: ['finance.view', 'finance.manage', 'expenses.approve', 'commissions.view', 'commissions.own'], module: 'finance', section: 'business' },
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

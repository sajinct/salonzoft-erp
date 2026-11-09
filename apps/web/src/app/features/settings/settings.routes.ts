import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet, Routes } from '@angular/router';
import { LucideDynamicIcon } from '@lucide/angular';
import { permissionGuard } from '../../core/guards/guards';
import { TranslationKey } from '../../core/i18n/en';
import { I18nService, TranslatePipe } from '../../core/i18n/i18n.service';
import { TenantContextService } from '../../core/tenant/tenant-context.service';
import { PageHeader } from '../../shared/components/ui';

interface SettingsTab {
  path: string;
  key: TranslationKey;
  icon: string;
  permissions: string[];
}

const TABS: SettingsTab[] = [
  { path: 'business', key: 'settings.business', icon: 'store', permissions: ['settings.view', 'settings.manage'] },
  { path: 'branches', key: 'settings.branches', icon: 'building-2', permissions: ['branches.manage', 'settings.view'] },
  { path: 'team', key: 'settings.team', icon: 'users', permissions: ['team.view', 'team.manage'] },
  { path: 'roles', key: 'settings.roles', icon: 'shield-check', permissions: ['roles.manage', 'team.view'] },
  { path: 'online', key: 'settings.online', icon: 'calendar-days', permissions: ['settings.manage', 'branches.manage', 'notifications.manage'] },
  { path: 'billing', key: 'settings.billing', icon: 'credit-card', permissions: ['billing.manage'] },
  { path: 'profile', key: 'settings.profile', icon: 'user-round', permissions: [] },
];

@Component({
  selector: 'sz-settings-shell',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, LucideDynamicIcon, TranslatePipe, PageHeader],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <sz-page-header [heading]="'settings.title' | t" />
    <div class="grid gap-6 lg:grid-cols-[14rem_1fr]">
      <nav class="flex gap-1 overflow-x-auto lg:flex-col" aria-label="Settings">
        @for (tab of tabs(); track tab.path) {
          <a
            [routerLink]="tab.path"
            routerLinkActive="!bg-surface !text-primary shadow-sm border-line"
            class="flex shrink-0 items-center gap-2.5 rounded-xl border border-transparent px-3 py-2 text-sm font-medium text-muted hover:text-ink"
          >
            <svg [lucideIcon]="tab.icon" [size]="16"></svg>{{ tab.key | t }}
          </a>
        }
      </nav>
      <div class="min-w-0"><router-outlet /></div>
    </div>
  `,
})
export class SettingsShell {
  private readonly ctx = inject(TenantContextService);
  private readonly i18n = inject(I18nService);
  protected readonly tabs = computed(() => {
    this.ctx.permissions();
    this.i18n.lang();
    return TABS.filter((t) => t.permissions.length === 0 || this.ctx.canAny(t.permissions));
  });
}

/** Redirect /settings to the first tab the user may open. */
const firstTab = () => {
  const ctx = inject(TenantContextService);
  const tab = TABS.find((t) => t.permissions.length === 0 || ctx.canAny(t.permissions)) ?? TABS[TABS.length - 1];
  return inject(Router).parseUrl(`/settings/${tab.path}`);
};

export const SETTINGS_ROUTES: Routes = [
  {
    path: '',
    component: SettingsShell,
    children: [
      { path: '', pathMatch: 'full', canActivate: [firstTab], children: [] },
      ...TABS.filter((t) => t.path !== 'profile').map((t) => ({
        path: t.path,
        canActivate: [permissionGuard],
        data: { permissions: t.permissions },
        loadComponent: () =>
          ({
            business: () => import('./business.page').then((m) => m.BusinessPage),
            branches: () => import('./branches.page').then((m) => m.BranchesPage),
            team: () => import('./team.page').then((m) => m.TeamPage),
            roles: () => import('./roles.page').then((m) => m.RolesPage),
            online: () => import('./online.page').then((m) => m.OnlineSettingsPage),
            billing: () => import('../billing/billing.page').then((m) => m.BillingPage),
          })[t.path as 'business' | 'branches' | 'team' | 'roles' | 'online' | 'billing'](),
      })),
      { path: 'profile', loadComponent: () => import('./profile.page').then((m) => m.ProfilePage) },
    ],
  },
];

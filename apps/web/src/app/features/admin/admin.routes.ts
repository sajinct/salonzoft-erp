import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { CanActivateFn, Router, RouterLink, RouterLinkActive, RouterOutlet, Routes } from '@angular/router';
import { LucideDynamicIcon } from '@lucide/angular';
import { AuthService } from '../../core/auth/auth.service';
import { TranslationKey } from '../../core/i18n/en';
import { I18nService, TranslateDynamicPipe, TranslatePipe } from '../../core/i18n/i18n.service';
import { AppUpdateService } from '../../core/services/app-update.service';
import { ThemeService } from '../../core/services/theme.service';
import { TenantContextService } from '../../core/tenant/tenant-context.service';
import { AdminService } from './data/admin.service';

/** Platform admins only (UX gate — every admin RPC re-checks the role on the server). */
export const platformAdminGuard: CanActivateFn = async () => {
  const admin = inject(AdminService);
  const router = inject(Router);
  try {
    return (admin.role() ?? (await admin.whoami())) ? true : router.parseUrl('/');
  } catch {
    return router.parseUrl('/');
  }
};

const TABS: { path: string; key: TranslationKey; icon: string; exact: boolean }[] = [
  { path: '/admin', key: 'admin.nav.overview', icon: 'layout-dashboard', exact: true },
  { path: '/admin/tenants', key: 'admin.nav.tenants', icon: 'building-2', exact: false },
  { path: '/admin/invoices', key: 'admin.nav.invoices', icon: 'receipt', exact: false },
  { path: '/admin/plans', key: 'admin.nav.plans', icon: 'package', exact: false },
  { path: '/admin/settings', key: 'admin.nav.settings', icon: 'settings', exact: false },
];

@Component({
  selector: 'sz-admin-shell',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, LucideDynamicIcon, TranslatePipe, TranslateDynamicPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="min-h-screen bg-bg">
      <header class="sticky top-0 z-20 border-b border-line bg-surface/90 backdrop-blur">
        <div class="mx-auto flex h-16 max-w-7xl items-center gap-3 px-4 sm:px-6">
          <span class="grid h-9 w-9 place-items-center rounded-xl bg-ink text-bg"><svg lucideIcon="shield-check" [size]="18"></svg></span>
          <div class="min-w-0">
            <p class="font-[family-name:var(--font-display)] text-lg font-semibold leading-tight">{{ 'app.name' | t }}</p>
            <p class="text-xs text-muted">{{ 'admin.title' | t }} · {{ 'admin.role.' + admin.role() | tx }} · v{{ updates.current.version }} ({{ updates.current.commit }})</p>
          </div>
          <div class="ms-auto flex items-center gap-1">
            <button type="button" class="btn-ghost btn-sm" (click)="i18n.toggle()"><svg lucideIcon="languages" [size]="16"></svg><span class="hidden sm:inline">{{ i18n.lang() === 'en' ? ('common.arabic' | t) : ('common.english' | t) }}</span></button>
            <button type="button" class="btn-icon" (click)="theme.toggle()" [attr.aria-label]="(theme.theme() === 'dark' ? 'shell.lightMode' : 'shell.darkMode') | t"><svg [lucideIcon]="theme.theme() === 'dark' ? 'sun' : 'moon'" [size]="18"></svg></button>
            <a routerLink="/" class="btn-ghost btn-sm"><svg lucideIcon="store" [size]="16"></svg><span class="hidden sm:inline">{{ 'admin.backToApp' | t }}</span></a>
            <button type="button" class="btn-icon" (click)="signOut()" [attr.aria-label]="'shell.signOut' | t"><svg lucideIcon="log-out" [size]="18"></svg></button>
          </div>
        </div>
        <nav class="mx-auto flex max-w-7xl gap-1 overflow-x-auto px-4 pb-2 sm:px-6" aria-label="Admin">
          @for (tab of tabs; track tab.path) {
            <a [routerLink]="tab.path" routerLinkActive="!bg-primary-soft !text-primary" [routerLinkActiveOptions]="{ exact: tab.exact }"
               class="flex shrink-0 items-center gap-2 rounded-xl px-3 py-1.5 text-sm font-medium text-muted hover:text-ink">
              <svg [lucideIcon]="tab.icon" [size]="16"></svg>{{ tab.key | t }}
            </a>
          }
        </nav>
      </header>
      <main class="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6"><router-outlet /></main>
    </div>
  `,
})
export class AdminShell {
  protected readonly admin = inject(AdminService);
  protected readonly i18n = inject(I18nService);
  protected readonly theme = inject(ThemeService);
  protected readonly updates = inject(AppUpdateService);
  private readonly auth = inject(AuthService);
  private readonly ctx = inject(TenantContextService);
  private readonly router = inject(Router);
  protected readonly tabs = TABS;

  protected async signOut(): Promise<void> {
    await this.auth.signOut();
    this.ctx.clear();
    this.admin.role.set(null);
    await this.router.navigateByUrl('/auth/login');
  }
}

export const ADMIN_ROUTES: Routes = [
  {
    path: '',
    component: AdminShell,
    canActivate: [platformAdminGuard],
    children: [
      { path: '', loadComponent: () => import('./overview.page').then((m) => m.AdminOverviewPage) },
      { path: 'tenants', loadComponent: () => import('./tenants.page').then((m) => m.AdminTenantsPage) },
      { path: 'tenants/:id', loadComponent: () => import('./tenant.page').then((m) => m.AdminTenantPage) },
      { path: 'invoices', loadComponent: () => import('./invoices.page').then((m) => m.AdminInvoicesPage) },
      { path: 'plans', loadComponent: () => import('./plans.page').then((m) => m.AdminPlansPage) },
      { path: 'settings', loadComponent: () => import('./settings.page').then((m) => m.AdminSettingsPage) },
    ],
  },
];

import { CdkMenu, CdkMenuItem, CdkMenuTrigger } from '@angular/cdk/menu';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { LucideDynamicIcon } from '@lucide/angular';
import { filter } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { AuthService } from '../core/auth/auth.service';
import { I18nService, TranslateDynamicPipe, TranslatePipe } from '../core/i18n/i18n.service';
import { NavItem, visibleNav } from '../core/navigation/nav-items';
import { ThemeService } from '../core/services/theme.service';
import { TenantContextService } from '../core/tenant/tenant-context.service';

@Component({
  selector: 'sz-app-shell',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, LucideDynamicIcon, TranslatePipe, TranslateDynamicPipe, CdkMenuTrigger, CdkMenu, CdkMenuItem],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="min-h-screen lg:ps-64">
      <!-- Mobile backdrop -->
      @if (menuOpen()) {
        <div class="fixed inset-0 z-30 bg-black/40 lg:hidden" (click)="menuOpen.set(false)"></div>
      }

      <!-- Sidebar -->
      <aside
        class="fixed inset-y-0 start-0 z-40 flex w-64 flex-col border-e border-line bg-surface transition-transform lg:translate-x-0"
        [class.-translate-x-full]="!menuOpen() && !i18n.isRtl()"
        [class.translate-x-full]="!menuOpen() && i18n.isRtl()"
      >
        <div class="flex h-16 items-center gap-3 px-5">
          <span class="grid h-9 w-9 place-items-center rounded-xl bg-primary text-on-primary"><svg lucideIcon="sparkles" [size]="18"></svg></span>
          <div class="min-w-0">
            <p class="font-[family-name:var(--font-display)] text-lg font-semibold leading-tight">{{ 'app.name' | t }}</p>
            <p class="truncate text-xs text-muted">{{ businessName() }}</p>
          </div>
        </div>

        <nav class="flex-1 overflow-y-auto px-3 py-2" aria-label="Main">
          @for (section of sections(); track section.key) {
            <p class="px-3 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-wider text-muted">{{ section.label }}</p>
            @for (item of section.items; track item.path) {
              <a
                [routerLink]="item.path"
                routerLinkActive="!bg-primary-soft !text-primary"
                class="group flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium text-ink/80 hover:bg-surface-2 hover:text-ink"
                [class.opacity-60]="item.phase"
                (click)="menuOpen.set(false)"
              >
                <svg [lucideIcon]="item.icon" [size]="18"></svg>
                <span class="flex-1">{{ item.key | t }}</span>
                @if (item.phase) {
                  <span class="badge-muted">{{ 'common.soon' | t }}</span>
                }
              </a>
            }
          }
        </nav>

        <div class="border-t border-line p-3 text-xs text-muted">
          @if (ctx.context()?.subscription; as sub) {
            <p class="px-2">{{ i18n.pick(sub.plan_name_en, sub.plan_name_ar) }} · {{ 'subscription.' + sub.status | tx }}</p>
          }
        </div>
      </aside>

      <!-- Top bar -->
      <header class="sticky top-0 z-20 flex h-16 items-center gap-2 border-b border-line bg-bg/85 px-4 backdrop-blur sm:px-6">
        <button type="button" class="btn-icon lg:hidden" (click)="menuOpen.set(true)" [attr.aria-label]="'shell.openMenu' | t">
          <svg lucideIcon="menu" [size]="20"></svg>
        </button>

        @if (ctx.branches().length > 1) {
          <label class="flex items-center gap-2 text-sm">
            <svg lucideIcon="store" [size]="16" class="text-muted"></svg>
            <span class="sr-only">{{ 'shell.branch' | t }}</span>
            <select class="input h-9 w-auto min-w-40" [value]="ctx.branchId() ?? ''" (change)="onBranchChange($event)">
              <option value="">{{ 'shell.allBranches' | t }}</option>
              @for (b of ctx.branches(); track b.id) {
                <option [value]="b.id">{{ i18n.pick(b.name_en, b.name_ar) }}</option>
              }
            </select>
          </label>
        } @else if (ctx.branches().length === 1) {
          <span class="flex items-center gap-2 text-sm text-muted">
            <svg lucideIcon="store" [size]="16"></svg> {{ i18n.pick(ctx.branches()[0].name_en, ctx.branches()[0].name_ar) }}
          </span>
        }

        <div class="ms-auto flex items-center gap-1">
          <button type="button" class="btn-ghost btn-sm" (click)="i18n.toggle()" [attr.aria-label]="'shell.language' | t">
            <svg lucideIcon="languages" [size]="16"></svg>
            <span class="hidden sm:inline">{{ i18n.lang() === 'en' ? ('common.arabic' | t) : ('common.english' | t) }}</span>
          </button>
          <button type="button" class="btn-icon" (click)="theme.toggle()" [attr.aria-label]="(theme.theme() === 'dark' ? 'shell.lightMode' : 'shell.darkMode') | t">
            <svg [lucideIcon]="theme.theme() === 'dark' ? 'sun' : 'moon'" [size]="18"></svg>
          </button>
          <button type="button" class="ms-1 flex items-center gap-2 rounded-xl px-2 py-1.5 hover:bg-surface-2" [cdkMenuTriggerFor]="userMenu">
            <span class="grid h-8 w-8 place-items-center rounded-full bg-accent-soft text-sm font-semibold text-accent">{{ initials() }}</span>
            <svg lucideIcon="chevron-down" [size]="14" class="text-muted"></svg>
          </button>
        </div>
      </header>

      <ng-template #userMenu>
        <div cdkMenu class="card mt-1 min-w-56 p-1.5 text-sm shadow-xl">
          <div class="px-3 py-2">
            <p class="font-semibold">{{ displayName() }}</p>
            <p class="truncate text-xs text-muted">{{ auth.user()?.email }}</p>
          </div>
          <a cdkMenuItem routerLink="/settings/profile" class="flex items-center gap-2 rounded-lg px-3 py-2 hover:bg-surface-2">
            <svg lucideIcon="user-round" [size]="16"></svg> {{ 'shell.myProfile' | t }}
          </a>
          @if ((ctx.tenants()?.length ?? 0) > 1) {
            <a cdkMenuItem routerLink="/select-tenant" class="flex items-center gap-2 rounded-lg px-3 py-2 hover:bg-surface-2">
              <svg lucideIcon="building-2" [size]="16"></svg> {{ 'shell.switchBusiness' | t }}
            </a>
          }
          @if (ctx.context()?.is_platform_admin) {
            <a cdkMenuItem routerLink="/admin" class="flex items-center gap-2 rounded-lg px-3 py-2 hover:bg-surface-2">
              <svg lucideIcon="shield-check" [size]="16"></svg> {{ 'shell.platformAdmin' | t }}
            </a>
          }
          <button cdkMenuItem type="button" class="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-danger hover:bg-danger-soft" (click)="signOut()">
            <svg lucideIcon="log-out" [size]="16"></svg> {{ 'shell.signOut' | t }}
          </button>
        </div>
      </ng-template>

      @if (ctx.context(); as c) {
        @if (!c.operational) {
          <div class="border-b border-danger/20 bg-danger-soft px-6 py-2 text-sm text-danger">
            {{ 'shell.notOperational' | t }}
            @if (ctx.can('billing.manage')) { <a routerLink="/settings/billing" class="ms-2 font-semibold underline">{{ 'shell.goToBilling' | t }}</a> }
          </div>
        } @else if (c.subscription?.status === 'past_due') {
          <div class="border-b border-warning/30 bg-warning-soft px-6 py-2 text-sm text-ink">
            {{ 'shell.pastDueBanner' | t }}
            @if (ctx.can('billing.manage')) { <a routerLink="/settings/billing" class="ms-2 font-semibold underline">{{ 'shell.goToBilling' | t }}</a> }
          </div>
        } @else if (trialDaysLeft() !== null) {
          <div class="border-b border-accent/20 bg-accent-soft px-6 py-2 text-sm text-ink">
            {{ 'shell.trialBanner' | t: { days: trialDaysLeft(), plan: i18n.pick(c.subscription?.plan_name_en, c.subscription?.plan_name_ar) } }}
          </div>
        }
      }

      <main class="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:py-8">
        <router-outlet />
      </main>
    </div>
  `,
})
export class AppShell {
  protected readonly ctx = inject(TenantContextService);
  protected readonly auth = inject(AuthService);
  protected readonly i18n = inject(I18nService);
  protected readonly theme = inject(ThemeService);
  private readonly router = inject(Router);

  protected readonly menuOpen = signal(false);

  protected readonly businessName = computed(() => {
    const t = this.ctx.context()?.tenant;
    return t ? this.i18n.pick(t.name, t.name_ar) : '';
  });

  protected readonly displayName = computed(() => {
    const user = this.auth.user();
    return (user?.user_metadata?.['full_name'] as string | undefined) || user?.email || '';
  });

  protected readonly initials = computed(() =>
    this.displayName()
      .split(/[\s@.]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase())
      .join(''),
  );

  protected readonly trialDaysLeft = computed(() => {
    const sub = this.ctx.context()?.subscription;
    if (sub?.status !== 'trialing' || !sub.trial_ends_at) return null;
    return Math.max(0, Math.ceil((new Date(sub.trial_ends_at).getTime() - Date.now()) / 86_400_000));
  });

  protected readonly sections = computed(() => {
    // Read signals the nav depends on so this recomputes on context/lang change.
    this.ctx.permissions();
    this.ctx.modules();
    this.i18n.lang();
    const items = visibleNav(this.ctx);
    const group = (key: NavItem['section'], label: string) => ({ key, label, items: items.filter((i) => i.section === key) });
    return [
      group('operations', this.i18n.t('nav.sectionOperations')),
      group('business', this.i18n.t('nav.sectionBusiness')),
      group('admin', this.i18n.t('nav.sectionAdmin')),
    ].filter((s) => s.items.length > 0);
  });

  constructor() {
    this.router.events
      .pipe(filter((e) => e instanceof NavigationEnd), takeUntilDestroyed())
      .subscribe(() => this.menuOpen.set(false));
  }

  protected onBranchChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.ctx.setBranch(value || null);
  }

  protected async signOut(): Promise<void> {
    await this.auth.signOut();
    this.ctx.clear();
    await this.router.navigateByUrl('/auth/login');
  }
}

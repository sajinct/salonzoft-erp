import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideDynamicIcon } from '@lucide/angular';
import { AuthService } from '../../core/auth/auth.service';
import { I18nService, TranslateDynamicPipe, TranslatePipe } from '../../core/i18n/i18n.service';
import { ToastService } from '../../core/services/toast.service';
import { TenantContextService } from '../../core/tenant/tenant-context.service';
import { StatePanel } from '../../shared/components/ui';
import { DashboardService, DashboardSummary } from './dashboard.service';

type SetupKey = keyof DashboardSummary['setup'];

const SETUP_LINKS: Record<SetupKey, string> = {
  business_profile: '/settings/business',
  vat_configured: '/settings/business',
  logo_uploaded: '/settings/business',
  working_hours: '/settings/branches',
  team_invited: '/settings/team',
};

@Component({
  selector: 'sz-dashboard-page',
  imports: [RouterLink, LucideDynamicIcon, TranslatePipe, TranslateDynamicPipe, StatePanel],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="mb-8">
      <h1 class="page-title">{{ 'dashboard.greeting' | t: { name: firstName() } }}</h1>
      <p class="mt-1 text-sm text-muted">{{ 'dashboard.subtitle' | t: { business: businessName() } }}</p>
    </div>

    @if (loading() && !summary()) {
      <sz-state [loading]="true" />
    } @else if (error() && !summary()) {
      <sz-state icon="circle-alert" [message]="error()!">
        <button type="button" class="btn-secondary" (click)="load()">{{ 'common.retry' | t }}</button>
      </sz-state>
    } @else if (summary(); as s) {
      <!-- KPI row -->
      <section class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div class="card p-5">
          <div class="flex items-center justify-between text-sm text-muted">{{ 'dashboard.branches' | t }} <svg lucideIcon="store" [size]="18"></svg></div>
          <p class="num mt-3 text-3xl font-semibold">{{ s.branches.total }}</p>
          <p class="mt-1 text-xs text-muted">{{ 'dashboard.activeBranches' | t: { count: s.branches.active } }}</p>
        </div>
        <div class="card p-5">
          <div class="flex items-center justify-between text-sm text-muted">{{ 'dashboard.team' | t }} <svg lucideIcon="users" [size]="18"></svg></div>
          @if (s.team) {
            <p class="num mt-3 text-3xl font-semibold">{{ s.team.active_members }}</p>
            <p class="mt-1 text-xs text-muted">{{ 'dashboard.pendingInvites' | t: { count: s.team.pending_invitations } }}</p>
          } @else {
            <p class="mt-3 text-3xl font-semibold text-muted">—</p>
          }
        </div>
        <div class="card p-5">
          <div class="flex items-center justify-between text-sm text-muted">{{ 'dashboard.plan' | t }} <svg lucideIcon="sparkles" [size]="18"></svg></div>
          <p class="mt-3 text-2xl font-semibold">{{ s.subscription ? i18n.pick(s.subscription.plan_name_en, s.subscription.plan_name_ar) : '—' }}</p>
          @if (s.subscription?.trial_days_left !== null && s.subscription?.trial_days_left !== undefined) {
            <p class="mt-1 text-xs text-muted">{{ 'dashboard.trialDaysLeft' | t: { days: s.subscription!.trial_days_left } }}</p>
          }
        </div>
        <div class="card p-5">
          <div class="flex items-center justify-between text-sm text-muted">{{ 'dashboard.status' | t }} <svg lucideIcon="shield-check" [size]="18"></svg></div>
          <p class="mt-3">
            <span [class]="s.operational ? 'badge-success' : 'badge-danger'" class="!text-sm">
              {{ s.subscription ? ('subscription.' + s.subscription.status | tx) : '—' }}
            </span>
          </p>
        </div>
      </section>

      <section class="mt-6 grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <!-- Setup checklist -->
        <div class="card p-6">
          <div class="flex items-end justify-between">
            <div>
              <h2 class="text-lg font-semibold">{{ 'dashboard.setupTitle' | t }}</h2>
              <p class="text-sm text-muted">{{ 'dashboard.setupSubtitle' | t: { done: setupDone(), total: setupItems().length } }}</p>
            </div>
            <span class="num text-sm font-semibold text-primary">{{ setupPercent() }}%</span>
          </div>
          <div class="mt-4 h-2 overflow-hidden rounded-full bg-surface-2">
            <div class="h-full rounded-full bg-primary transition-all" [style.width.%]="setupPercent()"></div>
          </div>
          <ul class="mt-5 divide-y divide-line">
            @for (item of setupItems(); track item.key) {
              <li>
                <a [routerLink]="item.link" class="flex items-center gap-3 py-3 text-sm hover:text-primary">
                  <span class="grid h-6 w-6 place-items-center rounded-full" [class]="item.done ? 'bg-success text-white' : 'border border-line text-transparent'">
                    <svg lucideIcon="check" [size]="14"></svg>
                  </span>
                  <span class="flex-1" [class.line-through]="item.done" [class.text-muted]="item.done">{{ 'dashboard.setup.' + item.key | tx }}</span>
                  <svg lucideIcon="chevron-right" [size]="16" class="text-muted rtl:rotate-180"></svg>
                </a>
              </li>
            }
          </ul>
        </div>

        <!-- Roadmap -->
        <div class="card p-6">
          <h2 class="text-lg font-semibold">{{ 'dashboard.roadmapTitle' | t }}</h2>
          <p class="text-sm text-muted">{{ 'dashboard.roadmapSubtitle' | t }}</p>
          <ol class="mt-5 space-y-4">
            @for (phase of [2, 3, 4]; track phase) {
              <li class="flex gap-3">
                <span class="num grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent-soft text-xs font-bold text-accent">{{ phase }}</span>
                <span class="text-sm">{{ 'dashboard.roadmap.phase' + phase | tx }}</span>
              </li>
            }
          </ol>
        </div>
      </section>
    }
  `,
})
export class DashboardPage {
  private readonly dashboard = inject(DashboardService);
  private readonly ctx = inject(TenantContextService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  protected readonly i18n = inject(I18nService);

  protected readonly summary = signal<DashboardSummary | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly firstName = computed(() => {
    const name = (this.auth.user()?.user_metadata?.['full_name'] as string | undefined) ?? '';
    return name.split(' ')[0] || '';
  });
  protected readonly businessName = computed(() => {
    const t = this.ctx.context()?.tenant;
    return t ? this.i18n.pick(t.name, t.name_ar) : '';
  });
  protected readonly setupItems = computed(() => {
    const setup = this.summary()?.setup;
    if (!setup) return [];
    return (Object.keys(SETUP_LINKS) as SetupKey[]).map((key) => ({ key, done: setup[key], link: SETUP_LINKS[key] }));
  });
  protected readonly setupDone = computed(() => this.setupItems().filter((i) => i.done).length);
  protected readonly setupPercent = computed(() =>
    this.setupItems().length ? Math.round((this.setupDone() / this.setupItems().length) * 100) : 0,
  );

  constructor() {
    // Reload when the business or branch filter changes.
    effect(() => {
      this.ctx.tenantId();
      this.ctx.branchId();
      void this.load();
    });
  }

  async load(): Promise<void> {
    const tenantId = this.ctx.tenantId();
    if (!tenantId) return;
    this.loading.set(true);
    this.error.set(null);
    try {
      this.summary.set(await this.dashboard.summary(tenantId, this.ctx.branchId()));
    } catch (err) {
      this.error.set(this.toast.describe(err));
    } finally {
      this.loading.set(false);
    }
  }
}

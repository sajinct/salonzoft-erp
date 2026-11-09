import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { I18nService, TranslatePipe } from '../../core/i18n/i18n.service';
import { ToastService } from '../../core/services/toast.service';
import { PageHeader, StatePanel } from '../../shared/components/ui';
import { LocalDatePipe, MoneyPipe } from '../../shared/pipes/format.pipes';
import { AdminOverview, AdminService } from './data/admin.service';

@Component({
  selector: 'sz-admin-overview-page',
  imports: [TranslatePipe, PageHeader, StatePanel, LocalDatePipe, MoneyPipe, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <sz-page-header [heading]="'admin.nav.overview' | t" [subtitle]="'admin.overviewSubtitle' | t" />
    @if (loading()) {
      <div class="card"><sz-state [loading]="true" /></div>
    } @else if (o(); as o) {
      <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        @for (k of kpis(); track k.key) {
          <a class="card block p-4 transition hover:border-primary/40" [routerLink]="k.link" [queryParams]="k.query">
            <p class="text-xs text-muted">{{ k.label }}</p>
            <p class="num mt-1 text-2xl font-semibold" [class.text-danger]="k.alert">{{ k.value }}</p>
            @if (k.sub) { <p class="mt-0.5 text-xs text-muted">{{ k.sub }}</p> }
          </a>
        }
      </div>

      <div class="mt-5 grid gap-5 lg:grid-cols-[2fr_1fr]">
        <section class="card overflow-x-auto">
          <h2 class="px-5 pt-5 font-semibold">{{ 'admin.byMonth' | t }}</h2>
          <table class="table mt-2">
            <thead><tr><th>{{ 'admin.month' | t }}</th><th class="text-end">{{ 'admin.signups' | t }}</th><th class="text-end">{{ 'admin.revenue' | t }}</th></tr></thead>
            <tbody>
              @for (m of monthsDesc(); track m.month) {
                <tr><td>{{ monthLabel(m.month) }}</td><td class="num text-end">{{ m.signups }}</td><td class="num text-end">{{ m.revenue | money }}</td></tr>
              }
            </tbody>
          </table>
        </section>
        <div class="space-y-5">
          <section class="card p-5">
            <h2 class="mb-3 font-semibold">{{ 'admin.planMix' | t }}</h2>
            <table class="w-full text-sm">
              <thead><tr class="text-xs text-muted"><th class="pb-1 text-start font-medium">{{ 'billing.plan' | t }}</th><th class="pb-1 text-end font-medium">{{ 'admin.paying' | t }}</th><th class="pb-1 text-end font-medium">{{ 'subscription.trialing' | t }}</th></tr></thead>
              <tbody>
                @for (p of o.plans; track p.code) {
                  <tr><td class="py-1">{{ i18n.pick(p.name_en, p.name_ar) }}</td><td class="num py-1 text-end">{{ p.paying }}</td><td class="num py-1 text-end">{{ p.trialing }}</td></tr>
                }
              </tbody>
            </table>
          </section>
          <section class="card p-5">
            <h2 class="mb-3 font-semibold">{{ 'admin.platformActivity' | t }}</h2>
            <dl class="grid grid-cols-[1fr_auto] gap-y-1.5 text-sm">
              <dt class="text-muted">{{ 'admin.appointments30' | t }}</dt><dd class="num">{{ o.activity.appointments_30d }}</dd>
              <dt class="text-muted">{{ 'admin.invoices30' | t }}</dt><dd class="num">{{ o.activity.invoices_30d }}</dd>
              <dt class="text-muted">{{ 'admin.sales30' | t }}</dt><dd class="num">{{ o.activity.sales_30d | money }}</dd>
              <dt class="text-muted">{{ 'admin.messagesMonth' | t }}</dt><dd class="num">{{ o.activity.messages_month }}</dd>
            </dl>
          </section>
        </div>
      </div>

      <div class="mt-5 grid gap-5 lg:grid-cols-2">
        <section class="card p-5">
          <h2 class="mb-3 font-semibold">{{ 'admin.expiringTrials' | t }}</h2>
          <ul class="divide-y divide-line text-sm">
            @for (t of o.expiring_trials; track t.id) {
              <li class="flex justify-between py-2"><a class="font-medium hover:text-primary" [routerLink]="['/admin/tenants', t.id]">{{ t.name }}</a><span class="text-muted">{{ t.trial_ends_at | localDate }}</span></li>
            } @empty { <li class="py-2 text-muted">{{ 'admin.none' | t }}</li> }
          </ul>
        </section>
        <section class="card p-5">
          <h2 class="mb-3 font-semibold">{{ 'admin.recentSignups' | t }}</h2>
          <ul class="divide-y divide-line text-sm">
            @for (t of o.recent_signups; track t.id) {
              <li class="flex justify-between py-2"><a class="font-medium hover:text-primary" [routerLink]="['/admin/tenants', t.id]">{{ t.name }} <span class="text-xs text-muted" dir="ltr">/{{ t.slug }}</span></a><span class="text-muted">{{ t.created_at | localDate }}</span></li>
            } @empty { <li class="py-2 text-muted">{{ 'admin.none' | t }}</li> }
          </ul>
        </section>
      </div>
    }
  `,
})
export class AdminOverviewPage {
  protected readonly i18n = inject(I18nService);
  private readonly api = inject(AdminService);
  private readonly toast = inject(ToastService);
  private readonly money = new MoneyPipe();
  protected readonly loading = signal(true);
  protected readonly o = signal<AdminOverview | null>(null);

  protected readonly monthsDesc = computed(() => [...(this.o()?.months ?? [])].reverse());

  protected readonly kpis = computed(() => {
    const o = this.o();
    if (!o) return [];
    const t = this.i18n.t.bind(this.i18n);
    const conv = o.conversion.eligible ? Math.round((o.conversion.converted / o.conversion.eligible) * 100) + '%' : '—';
    return [
      { key: 'mrr', label: t('admin.mrr'), value: this.money.transform(o.mrr), sub: t('admin.arr', { value: this.money.transform(o.mrr * 12) }), link: '/admin/tenants', query: { filter: 'active' }, alert: false },
      { key: 'collected', label: t('admin.collectedMonth'), value: this.money.transform(o.collected_month), sub: '', link: '/admin/invoices', query: { status: 'paid' }, alert: false },
      { key: 'open', label: t('admin.openInvoices'), value: String(o.open_invoices.count), sub: t('admin.openLine', { total: this.money.transform(o.open_invoices.total), overdue: o.open_invoices.overdue }), link: '/admin/invoices', query: { status: 'open' }, alert: o.open_invoices.overdue > 0 },
      { key: 'conv', label: t('admin.conversion'), value: conv, sub: t('admin.conversionLine', { n: o.conversion.converted, total: o.conversion.eligible }), link: '/admin/tenants', query: {}, alert: false },
      { key: 'total', label: t('admin.businesses'), value: String(o.tenants.total), sub: t('admin.newLine', { n: o.tenants.new_30d }), link: '/admin/tenants', query: {}, alert: false },
      { key: 'paying', label: t('admin.paying'), value: String(o.tenants.paying), sub: '', link: '/admin/tenants', query: { filter: 'active' }, alert: false },
      { key: 'trials', label: t('admin.trials'), value: String(o.tenants.trialing), sub: t('admin.expiredLine', { n: o.tenants.trial_expired }), link: '/admin/tenants', query: { filter: 'trialing' }, alert: false },
      { key: 'risk', label: t('admin.atRisk'), value: String(o.tenants.past_due + o.tenants.suspended), sub: t('admin.atRiskLine', { due: o.tenants.past_due, suspended: o.tenants.suspended }), link: '/admin/tenants', query: { filter: 'past_due' }, alert: o.tenants.past_due + o.tenants.suspended > 0 },
    ];
  });

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      this.o.set(await this.api.overview());
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.loading.set(false);
    }
  }

  protected monthLabel(month: string): string {
    const [y, m] = month.split('-').map(Number);
    return new Intl.DateTimeFormat(this.i18n.locale(), { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, 1)));
  }
}

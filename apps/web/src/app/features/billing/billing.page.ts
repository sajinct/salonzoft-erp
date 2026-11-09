import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideDynamicIcon } from '@lucide/angular';
import { I18nService, TranslateDynamicPipe, TranslatePipe } from '../../core/i18n/i18n.service';
import { ToastService } from '../../core/services/toast.service';
import { TenantContextService } from '../../core/tenant/tenant-context.service';
import { ConfirmService, StatePanel } from '../../shared/components/ui';
import { LocalDatePipe, MoneyPipe } from '../../shared/pipes/format.pipes';
import { BillingOverview, BillingService, Cycle, ModuleInfo, PlanOption } from './data/billing.service';

/** Settings → Plan & billing (billing.manage; also available while the salon is not operational). */
@Component({
  selector: 'sz-billing-page',
  imports: [TranslatePipe, TranslateDynamicPipe, LucideDynamicIcon, StatePanel, LocalDatePipe, MoneyPipe, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (loading()) {
      <div class="card"><sz-state [loading]="true" /></div>
    } @else if (data(); as d) {
      <div class="space-y-5">
        <!-- Current plan -->
        <section class="card p-5">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p class="text-xs text-muted">{{ 'billing.currentPlan' | t }}</p>
              <h2 class="mt-1 flex flex-wrap items-center gap-2 text-xl font-semibold">
                {{ planName(d.subscription?.plan_code) }}
                @if (d.subscription; as s) {
                  <span [class]="statusClass(s.status)">{{ 'subscription.' + s.status | tx }}</span>
                  @if (s.status !== 'trialing') { <span class="badge-muted">{{ 'billing.cycle.' + s.billing_cycle | tx }}</span> }
                }
              </h2>
              <p class="mt-1 text-sm text-muted">{{ statusLine() }}</p>
              @if (d.subscription?.scheduled_plan_code; as next) {
                <p class="mt-2 text-sm">
                  {{ 'billing.scheduledLine' | t: { plan: planName(next), cycle: ('billing.cycle.' + d.subscription!.scheduled_cycle | tx), date: (d.subscription!.current_period_end | localDate) } }}
                  <button type="button" class="btn-ghost btn-sm" (click)="cancelPending()">{{ 'billing.keepPlan' | t }}</button>
                </p>
              }
            </div>
            @if (d.subscription?.status === 'active') {
              @if (d.subscription!.cancel_at_period_end) {
                <button type="button" class="btn-secondary" [disabled]="busy()" (click)="setCancel(false)">{{ 'billing.resume' | t }}</button>
              } @else {
                <button type="button" class="btn-ghost text-danger" [disabled]="busy()" (click)="setCancel(true)">{{ 'billing.cancelRenewal' | t }}</button>
              }
            }
          </div>

          <div class="mt-5 grid gap-3 sm:grid-cols-3">
            @for (m of meters(); track m.key) {
              <div class="rounded-xl bg-surface-2 px-4 py-3">
                <p class="text-xs text-muted">{{ m.key | tx }}</p>
                <p class="num mt-1 font-semibold">{{ m.used }} / {{ m.max ?? ('billing.unlimited' | t) }}</p>
                @if (m.max) {
                  <div class="mt-2 h-1.5 overflow-hidden rounded-full bg-line"><div class="h-full rounded-full" [class]="m.used >= m.max ? 'bg-danger' : 'bg-primary'" [style.width.%]="pct(m.used, m.max)"></div></div>
                }
              </div>
            }
          </div>
        </section>

        <!-- Invoice waiting for payment -->
        @if (openInvoice(); as inv) {
          <section class="card border-accent/40 bg-accent-soft/40 p-5">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 class="font-semibold">{{ 'billing.toPay' | t: { number: inv.number } }}</h2>
                <p class="mt-1 text-sm">{{ 'billing.toPayLine' | t: { total: (inv.total | money), plan: i18n.pick(inv.plan_name_en, inv.plan_name_ar), date: (inv.due_at | localDate) } }}</p>
              </div>
              <div class="flex gap-2">
                @if (inv.kind !== 'renewal') { <button type="button" class="btn-ghost btn-sm" (click)="cancelPending()">{{ 'billing.cancelRequest' | t }}</button> }
                <a class="btn-secondary btn-sm" [routerLink]="['/billing/invoices', inv.id]"><svg lucideIcon="printer" [size]="15"></svg>{{ 'billing.viewInvoice' | t }}</a>
              </div>
            </div>
            @if (d.payment.bank_details) {
              <div class="mt-3 rounded-xl bg-surface px-4 py-3 text-sm">
                <p class="label mb-1">{{ 'billing.howToPay' | t }}</p>
                <p class="whitespace-pre-line">{{ d.payment.bank_details }}</p>
                <p class="hint mt-1">{{ 'billing.payRef' | t: { number: inv.number } }}</p>
              </div>
            } @else {
              <p class="hint mt-2">{{ 'billing.contactToPay' | t }}</p>
            }
          </section>
        }

        <!-- Plans -->
        <section>
          <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 class="font-semibold">{{ 'billing.plans' | t }}</h2>
            <div class="flex gap-1 rounded-xl bg-surface-2 p-1" role="radiogroup">
              @for (c of cycles; track c) {
                <button type="button" role="radio" [attr.aria-checked]="cycle() === c" [class]="cycle() === c ? 'btn-primary btn-sm' : 'btn-ghost btn-sm'" (click)="cycle.set(c)">{{ 'billing.cycle.' + c | tx }}</button>
              }
            </div>
          </div>
          <div class="grid gap-4 md:grid-cols-3">
            @for (p of d.plans; track p.code) {
              <article class="card flex flex-col p-5" [class.ring-2]="isCurrent(p)" [class.ring-primary]="isCurrent(p)">
                <h3 class="text-lg font-semibold">{{ i18n.pick(p.name_en, p.name_ar) }}</h3>
                <p class="mt-1 min-h-10 text-sm text-muted">{{ i18n.pick(p.description_en, p.description_ar) }}</p>
                <p class="mt-3"><span class="num text-2xl font-semibold">{{ price(p) | money }}</span> <span class="text-sm text-muted">/ {{ 'billing.per.' + cycle() | tx }}</span></p>
                @if (d.payment.vat_rate > 0) { <p class="hint">{{ 'billing.plusVat' | t: { rate: d.payment.vat_rate } }}</p> }
                <ul class="mt-4 flex-1 space-y-1.5 text-sm">
                  <li class="flex gap-2"><svg lucideIcon="check" [size]="16" class="mt-0.5 text-success"></svg>{{ limit(p.max_branches, 'billing.branchesN', 'billing.branchesUnlimited') }}</li>
                  <li class="flex gap-2"><svg lucideIcon="check" [size]="16" class="mt-0.5 text-success"></svg>{{ limit(p.max_staff, 'billing.staffN', 'billing.staffUnlimited') }}</li>
                  <li class="flex gap-2"><svg lucideIcon="check" [size]="16" class="mt-0.5 text-success"></svg>{{ limit(p.max_monthly_messages, 'billing.messagesN', 'billing.messagesUnlimited') }}</li>
                  @if (missing(p); as miss) {
                    <li class="flex gap-2 text-muted"><svg lucideIcon="x" [size]="16" class="mt-0.5"></svg>{{ 'billing.notIncluded' | t: { modules: miss } }}</li>
                  } @else {
                    <li class="flex gap-2"><svg lucideIcon="check" [size]="16" class="mt-0.5 text-success"></svg>{{ 'billing.allModules' | t }}</li>
                  }
                </ul>
                @if (isCurrent(p)) {
                  <button type="button" class="btn-secondary mt-5" disabled>{{ 'billing.yourPlan' | t }}</button>
                } @else {
                  <button type="button" class="btn-primary mt-5" [disabled]="busy()" (click)="choose(p)">{{ 'billing.choose' | t }}</button>
                }
              </article>
            }
          </div>
        </section>

        <!-- Invoices -->
        <section class="card overflow-x-auto">
          <h2 class="px-5 pt-5 font-semibold">{{ 'billing.invoices' | t }}</h2>
          <table class="table mt-2">
            <thead><tr><th>{{ 'billing.number' | t }}</th><th>{{ 'billing.issued' | t }}</th><th>{{ 'billing.plan' | t }}</th><th class="text-end">{{ 'billing.total' | t }}</th><th>{{ 'common.status' | t }}</th><th></th></tr></thead>
            <tbody>
              @for (inv of d.invoices; track inv.id) {
                <tr>
                  <td class="num">{{ inv.number }}</td>
                  <td>{{ inv.issued_at | localDate }}</td>
                  <td>{{ i18n.pick(inv.plan_name_en, inv.plan_name_ar) }} · {{ 'billing.cycle.' + inv.billing_cycle | tx }}</td>
                  <td class="num text-end">{{ inv.total | money }}</td>
                  <td><span [class]="inv.status === 'paid' ? 'badge-success' : inv.status === 'open' ? 'badge-warning' : 'badge-muted'">{{ 'billing.status.' + inv.status | tx }}</span></td>
                  <td class="text-end"><a class="btn-ghost btn-sm" [routerLink]="['/billing/invoices', inv.id]">{{ 'billing.view' | t }}</a></td>
                </tr>
              } @empty {
                <tr><td colspan="6" class="py-8 text-center text-muted">{{ 'billing.noInvoices' | t }}</td></tr>
              }
            </tbody>
          </table>
        </section>
      </div>
    }
  `,
})
export class BillingPage {
  private readonly ctx = inject(TenantContextService);
  protected readonly i18n = inject(I18nService);
  private readonly api = inject(BillingService);
  private readonly toast = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  private readonly localDate = new LocalDatePipe();

  protected readonly cycles: Cycle[] = ['monthly', 'yearly'];
  protected readonly loading = signal(true);
  protected readonly busy = signal(false);
  protected readonly data = signal<BillingOverview | null>(null);
  protected readonly moduleList = signal<ModuleInfo[]>([]);
  protected readonly cycle = signal<Cycle>('monthly');

  protected readonly openInvoice = computed(() => this.data()?.invoices.find((i) => i.status === 'open') ?? null);
  protected readonly currentPlan = computed(() => this.data()?.plans.find((p) => p.code === this.data()?.subscription?.plan_code) ?? null);

  protected readonly meters = computed(() => {
    const d = this.data();
    const p = this.currentPlan();
    if (!d) return [];
    return [
      { key: 'billing.usage.branches', used: d.usage.branches, max: p?.max_branches ?? null },
      { key: 'billing.usage.staff', used: d.usage.staff, max: p?.max_staff ?? null },
      { key: 'billing.usage.messages', used: d.usage.messages, max: p?.max_monthly_messages ?? null },
    ];
  });

  protected readonly statusLine = computed(() => {
    const s = this.data()?.subscription;
    if (!s) return this.i18n.t('billing.noSubscription');
    const date = (v: string | null) => this.localDate.transform(v);
    switch (s.status) {
      case 'trialing':
        return s.trial_ends_at && new Date(s.trial_ends_at).getTime() > Date.now()
          ? this.i18n.t('billing.trialEnds', { date: date(s.trial_ends_at) })
          : this.i18n.t('billing.trialEnded');
      case 'active':
        return this.i18n.t(s.cancel_at_period_end ? 'billing.cancelsOn' : 'billing.renewsOn', { date: date(s.current_period_end) });
      case 'past_due':
        return this.i18n.t('billing.pastDueLine', { date: date(s.current_period_end) });
      case 'suspended':
        return this.i18n.t('billing.suspendedLine');
      default:
        return this.i18n.t('billing.cancelledLine');
    }
  });

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    const tenantId = this.ctx.tenantId();
    if (!tenantId) return;
    try {
      const [data, modules] = await Promise.all([this.api.overview(tenantId), this.api.modules()]);
      this.data.set(data);
      this.moduleList.set(modules);
      if (data.subscription?.status === 'active') this.cycle.set(data.subscription.billing_cycle);
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.loading.set(false);
    }
  }

  protected planName(code: string | null | undefined): string {
    const p = this.data()?.plans.find((x) => x.code === code);
    return p ? this.i18n.pick(p.name_en, p.name_ar) : (code ?? '—');
  }

  protected statusClass(status: string): string {
    return status === 'active' ? 'badge-success' : status === 'trialing' ? 'badge-muted' : status === 'past_due' ? 'badge-warning' : 'badge-danger';
  }

  protected isCurrent(p: PlanOption): boolean {
    const s = this.data()?.subscription;
    return !!s && s.status === 'active' && s.plan_code === p.code && s.billing_cycle === this.cycle();
  }

  protected price(p: PlanOption): number {
    return this.cycle() === 'yearly' ? p.price_yearly : p.price_monthly;
  }

  protected pct(used: number, max: number): number {
    return Math.min(100, Math.round((used / max) * 100));
  }

  protected limit(n: number | null, key: 'billing.branchesN' | 'billing.staffN' | 'billing.messagesN', unlimited: 'billing.branchesUnlimited' | 'billing.staffUnlimited' | 'billing.messagesUnlimited'): string {
    return n === null ? this.i18n.t(unlimited) : this.i18n.t(key, { n });
  }

  /** Names of the paid modules a plan leaves out ('' = everything included). */
  protected missing(p: PlanOption): string {
    return this.moduleList()
      .filter((m) => !m.is_core && !p.modules.includes(m.code))
      .map((m) => this.i18n.pick(m.name_en, m.name_ar))
      .join(', ');
  }

  async choose(p: PlanOption): Promise<void> {
    const tenantId = this.ctx.tenantId();
    if (!tenantId) return;
    const name = this.i18n.pick(p.name_en, p.name_ar);
    const cycle = this.i18n.tx('billing.cycle.' + this.cycle());
    const ok = await this.confirm.ask({
      title: this.i18n.t('billing.switchTo', { plan: name }),
      message: this.i18n.t('billing.confirmChange', { plan: name, cycle }),
      confirmLabel: this.i18n.t('billing.choose'),
    });
    if (!ok) return;
    this.busy.set(true);
    try {
      const r = await this.api.requestChange(tenantId, p.code, this.cycle());
      this.toast.success(
        r.scheduled
          ? this.i18n.t('billing.scheduledToast', { date: this.localDate.transform(r.effective_at ?? null) })
          : this.i18n.t('billing.invoiceToast', { number: r.number ?? '' }),
      );
      await this.load();
    } catch (err) {
      const code = (err as { code?: string }).code;
      // Plan limits here mean the salon is bigger than the chosen plan allows.
      this.toast.error(code === 'PLAN_LIMIT_BRANCHES' || code === 'PLAN_LIMIT_EMPLOYEES' ? { message: code === 'PLAN_LIMIT_BRANCHES' ? 'DOWNGRADE_BRANCHES' : 'DOWNGRADE_EMPLOYEES' } : err);
    } finally {
      this.busy.set(false);
    }
  }

  async cancelPending(): Promise<void> {
    const tenantId = this.ctx.tenantId();
    if (!tenantId) return;
    try {
      await this.api.cancelPending(tenantId);
      await this.load();
    } catch (err) {
      this.toast.error(err);
    }
  }

  async setCancel(cancel: boolean): Promise<void> {
    const tenantId = this.ctx.tenantId();
    if (!tenantId) return;
    if (cancel) {
      const ok = await this.confirm.ask({
        title: this.i18n.t('billing.cancelRenewal'),
        message: this.i18n.t('billing.confirmCancel', { date: this.localDate.transform(this.data()?.subscription?.current_period_end ?? null) }),
        confirmLabel: this.i18n.t('billing.cancelRenewal'),
        danger: true,
      });
      if (!ok) return;
    }
    this.busy.set(true);
    try {
      await this.api.setCancelAtPeriodEnd(tenantId, cancel);
      await this.load();
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.busy.set(false);
    }
  }
}

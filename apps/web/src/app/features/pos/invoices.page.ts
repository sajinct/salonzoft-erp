import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { LucideDynamicIcon } from '@lucide/angular';
import { I18nService, TranslateDynamicPipe, TranslatePipe } from '../../core/i18n/i18n.service';
import { ToastService } from '../../core/services/toast.service';
import { TenantContextService } from '../../core/tenant/tenant-context.service';
import { PageHeader, StatePanel } from '../../shared/components/ui';
import { LocalDatePipe, MoneyPipe } from '../../shared/pipes/format.pipes';
import { InvoiceRow, PosService, SalesSummary } from './data/pos.service';

type Period = 'today' | 'week' | 'month';
type Filter = 'all' | 'unpaid' | 'drafts';

@Component({
  selector: 'sz-invoices-page',
  imports: [TranslatePipe, TranslateDynamicPipe, LucideDynamicIcon, PageHeader, StatePanel, MoneyPipe, LocalDatePipe, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <sz-page-header [heading]="'pos.invoices' | t" [subtitle]="'pos.invoicesSubtitle' | t">
      @if (ctx.can('pos.access')) {
        <a routerLink="/pos" class="btn-primary"><svg lucideIcon="plus" [size]="16"></svg>{{ 'pos.newSale' | t }}</a>
      }
    </sz-page-header>

    @if (summary(); as s) {
      <div class="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div class="card p-4"><p class="text-xs text-muted">{{ 'pos.salesToday' | t }}</p><p class="num mt-1 text-xl font-semibold">{{ s.gross_sales | money }}</p><p class="text-xs text-muted">{{ 'pos.invoiceCount' | t: { n: s.invoices } }}</p></div>
        <div class="card p-4"><p class="text-xs text-muted">{{ 'pos.vatToday' | t }}</p><p class="num mt-1 text-xl font-semibold">{{ s.vat | money }}</p></div>
        <div class="card p-4"><p class="text-xs text-muted">{{ 'pos.byMethod' | t }}</p>
          <p class="mt-1 space-x-2 text-sm rtl:space-x-reverse">@for (m of methodsOf(s); track m[0]) { <span>{{ 'pos.method.' + m[0] | tx }} <strong class="num">{{ m[1] | money }}</strong></span> } @empty { — }</p></div>
        <div class="card p-4"><p class="text-xs text-muted">{{ 'pos.outstanding' | t }}</p><p class="num mt-1 text-xl font-semibold" [class.text-warning]="s.outstanding > 0">{{ s.outstanding | money }}</p></div>
      </div>
    }

    <div class="mb-4 flex flex-wrap items-center gap-2">
      @for (f of filters; track f) {
        <button type="button" [class]="filter() === f ? 'btn-primary btn-sm' : 'btn-secondary btn-sm'" (click)="filter.set(f)">{{ 'pos.filter.' + f | tx }}</button>
      }
      @if (filter() !== 'drafts') {
        <select class="input ms-auto w-40" [value]="period()" (change)="period.set($any($event.target).value)" [attr.aria-label]="'pos.period' | t">
          @for (p of periods; track p) { <option [value]="p">{{ 'pos.periodName.' + p | tx }}</option> }
        </select>
      }
    </div>

    <div class="card overflow-x-auto">
      @if (loading()) {
        <sz-state [loading]="true" />
      } @else if (rows().length === 0) {
        <sz-state icon="receipt" [heading]="'pos.noInvoices' | t" />
      } @else {
        <table class="table">
          <thead><tr>
            <th>{{ 'pos.number' | t }}</th><th>{{ 'appointments.date' | t }}</th><th>{{ 'appointments.customer' | t }}</th>
            <th class="text-end">{{ 'pos.total' | t }}</th><th></th>
          </tr></thead>
          <tbody>
            @for (r of rows(); track r.id) {
              <tr class="cursor-pointer hover:bg-surface-2" tabindex="0" (click)="open(r)" (keydown.enter)="open(r)">
                <td class="num font-medium" dir="ltr">{{ r.number ?? ('pos.draft' | t) }}</td>
                <td class="text-muted">{{ (r.issued_at ?? r.created_at) | localDate: 'datetime' }}</td>
                <td>{{ r.customer_name ?? '—' }}</td>
                <td class="num text-end" [class.text-danger]="r.kind === 'credit_note'">{{ r.kind === 'credit_note' ? '−' : '' }}{{ r.total | money }}</td>
                <td class="text-end">
                  @if (r.kind === 'credit_note') { <span class="badge-danger">{{ 'pos.creditNote' | t }}</span> }
                  @else if (r.status === 'draft') { <span class="badge-muted">{{ 'pos.draft' | t }}</span> }
                  @else { <span [class]="r.payment_status === 'paid' ? 'badge-success' : r.payment_status === 'partial' ? 'badge-warning' : 'badge-danger'">{{ 'pos.paymentStatus.' + r.payment_status | tx }}</span> }
                </td>
              </tr>
            }
          </tbody>
        </table>
      }
    </div>
  `,
})
export class InvoicesPage {
  protected readonly ctx = inject(TenantContextService);
  protected readonly i18n = inject(I18nService);
  private readonly pos = inject(PosService);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);

  protected readonly filters: Filter[] = ['all', 'unpaid', 'drafts'];
  protected readonly periods: Period[] = ['today', 'week', 'month'];
  protected readonly filter = signal<Filter>('all');
  protected readonly period = signal<Period>('today');
  protected readonly rows = signal<InvoiceRow[]>([]);
  protected readonly summary = signal<SalesSummary | null>(null);
  protected readonly loading = signal(true);
  private readonly branchId = computed(() => this.ctx.branchId());

  constructor() {
    effect(() => {
      const f = this.filter();
      const p = this.period();
      const b = this.branchId();
      untracked(() => void this.load(f, p, b));
    });
  }

  protected methodsOf(s: SalesSummary): [string, number][] {
    return Object.entries(s.by_method).filter(([, v]) => !!v) as [string, number][];
  }

  private async load(filter: Filter, period: Period, branchId: string | null): Promise<void> {
    const tenantId = this.ctx.tenantId();
    if (!tenantId) return;
    this.loading.set(true);
    const days = period === 'today' ? 0 : period === 'week' ? 6 : 29;
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    from.setDate(from.getDate() - days);
    try {
      const [rows, summary] = await Promise.all([
        this.pos.list(tenantId, { from, branchId, status: filter }),
        this.pos.summary(tenantId, branchId).catch(() => null),
      ]);
      this.rows.set(rows);
      this.summary.set(summary);
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.loading.set(false);
    }
  }

  protected open(r: InvoiceRow): void {
    if (r.status === 'draft') void this.router.navigate(['/pos'], { queryParams: { invoice: r.id } });
    else void this.router.navigate(['/invoices', r.id]);
  }
}

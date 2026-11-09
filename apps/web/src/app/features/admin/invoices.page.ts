import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideDynamicIcon } from '@lucide/angular';
import { I18nService, TranslateDynamicPipe, TranslatePipe } from '../../core/i18n/i18n.service';
import { ToastService } from '../../core/services/toast.service';
import { PageHeader, StatePanel } from '../../shared/components/ui';
import { LocalDatePipe, MoneyPipe } from '../../shared/pipes/format.pipes';
import { AdminInvoice, AdminService } from './data/admin.service';
import { InvoiceActions } from './invoice-actions';

const PAGE = 100;
type StatusFilter = '' | 'open' | 'overdue' | 'paid' | 'void';

@Component({
  selector: 'sz-admin-invoices-page',
  imports: [TranslatePipe, TranslateDynamicPipe, LucideDynamicIcon, PageHeader, StatePanel, LocalDatePipe, MoneyPipe, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <sz-page-header [heading]="'admin.nav.invoices' | t" [subtitle]="'admin.invoicesSubtitle' | t" />
    <div class="mb-4 flex flex-wrap gap-2">
      <label class="relative min-w-60 flex-1">
        <svg lucideIcon="search" [size]="16" class="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-muted"></svg>
        <input class="input ps-9" type="search" [placeholder]="'admin.searchInvoices' | t" [value]="search()" (input)="onSearch($any($event.target).value)" />
      </label>
      <select class="input w-44" [value]="filter()" (change)="setFilter($any($event.target).value)" [attr.aria-label]="'common.status' | t">
        @for (f of filters; track f) { <option [value]="f" [selected]="f === filter()">{{ 'admin.invoiceFilter.' + (f || 'all') | tx }}</option> }
      </select>
    </div>
    <div class="card overflow-x-auto">
      @if (loading()) {
        <sz-state [loading]="true" />
      } @else {
        <table class="table">
          <thead><tr><th>{{ 'billing.number' | t }}</th><th>{{ 'admin.business' | t }}</th><th>{{ 'billing.plan' | t }}</th><th>{{ 'billing.issued' | t }}</th><th>{{ 'billing.due' | t }}</th><th class="text-end">{{ 'billing.total' | t }}</th><th>{{ 'common.status' | t }}</th><th></th></tr></thead>
          <tbody>
            @for (inv of rows(); track inv.id) {
              <tr>
                <td class="num">{{ inv.number }}</td>
                <td><a class="font-medium hover:text-primary" [routerLink]="['/admin/tenants', inv.tenant_id]">{{ inv.tenant_name }}</a></td>
                <td>{{ i18n.pick(inv.plan_name_en, inv.plan_name_ar) }} · {{ 'billing.cycle.' + inv.billing_cycle | tx }}</td>
                <td>{{ inv.issued_at | localDate }}</td>
                <td [class.text-danger]="overdue(inv)">{{ inv.due_at | localDate }}</td>
                <td class="num text-end">{{ inv.total | money }}</td>
                <td>
                  <span [class]="inv.status === 'paid' ? 'badge-success' : inv.status === 'open' ? (overdue(inv) ? 'badge-danger' : 'badge-warning') : 'badge-muted'">{{ (overdue(inv) ? 'admin.invoiceFilter.overdue' : 'billing.status.' + inv.status) | tx }}</span>
                  @if (inv.status === 'paid') { <p class="text-xs text-muted">{{ 'billing.method.' + inv.payment_method | tx }} · {{ inv.paid_at | localDate }}</p> }
                </td>
                <td class="whitespace-nowrap text-end">
                  @if (inv.status === 'open' && api.canBilling()) {
                    <button type="button" class="btn-ghost btn-sm" (click)="pay(inv)">{{ 'admin.markPaid' | t }}</button>
                    <button type="button" class="btn-ghost btn-sm text-danger" (click)="voidInv(inv)">{{ 'admin.void' | t }}</button>
                  }
                  <a class="btn-ghost btn-sm" [routerLink]="['/billing/invoices', inv.id]">{{ 'billing.view' | t }}</a>
                </td>
              </tr>
            } @empty {
              <tr><td colspan="8"><sz-state icon="receipt" [heading]="'billing.noInvoices' | t" /></td></tr>
            }
          </tbody>
        </table>
        @if (total() > PAGE) {
          <div class="flex items-center justify-end gap-2 border-t border-line px-4 py-3 text-sm">
            <span class="text-muted">{{ offset() + 1 }}–{{ offset() + rows().length }} / {{ total() }}</span>
            <button type="button" class="btn-secondary btn-sm" [disabled]="offset() === 0" (click)="page(-1)">{{ 'admin.prev' | t }}</button>
            <button type="button" class="btn-secondary btn-sm" [disabled]="offset() + PAGE >= total()" (click)="page(1)">{{ 'admin.next' | t }}</button>
          </div>
        }
      }
    </div>
  `,
})
export class AdminInvoicesPage implements OnInit {
  /** ?status= from the overview cards. */
  readonly status = input<string>();
  protected readonly i18n = inject(I18nService);
  protected readonly api = inject(AdminService);
  private readonly toast = inject(ToastService);
  private readonly actions = inject(InvoiceActions);

  protected readonly PAGE = PAGE;
  protected readonly filters: StatusFilter[] = ['', 'open', 'overdue', 'paid', 'void'];
  protected readonly filter = signal<StatusFilter>('');
  protected readonly search = signal('');
  protected readonly offset = signal(0);
  protected readonly total = signal(0);
  protected readonly rows = signal<AdminInvoice[]>([]);
  protected readonly loading = signal(true);
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    inject(DestroyRef).onDestroy(() => clearTimeout(this.timer));
  }

  ngOnInit(): void {
    const s = this.status() as StatusFilter | undefined;
    if (s && this.filters.includes(s)) this.filter.set(s);
    void this.load();
  }

  protected overdue(inv: AdminInvoice): boolean {
    return inv.status === 'open' && new Date(inv.due_at).getTime() < Date.now();
  }

  protected onSearch(value: string): void {
    this.search.set(value);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.offset.set(0);
      void this.load();
    }, 300);
  }

  protected setFilter(value: StatusFilter): void {
    this.filter.set(value);
    this.offset.set(0);
    void this.load();
  }

  protected page(dir: 1 | -1): void {
    this.offset.update((o) => Math.max(0, o + dir * PAGE));
    void this.load();
  }

  async pay(inv: AdminInvoice): Promise<void> {
    if (await this.actions.recordPayment(inv)) await this.load();
  }

  async voidInv(inv: AdminInvoice): Promise<void> {
    if (await this.actions.void(inv)) await this.load();
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    try {
      const r = await this.api.invoices(this.filter() || null, this.search().trim(), PAGE, this.offset());
      this.total.set(r.total);
      this.rows.set(r.rows);
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.loading.set(false);
    }
  }
}

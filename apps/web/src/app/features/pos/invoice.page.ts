import { Dialog } from '@angular/cdk/dialog';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { LucideDynamicIcon } from '@lucide/angular';
import { I18nService, TranslateDynamicPipe, TranslatePipe } from '../../core/i18n/i18n.service';
import { ToastService } from '../../core/services/toast.service';
import { TenantContextService } from '../../core/tenant/tenant-context.service';
import { StatePanel } from '../../shared/components/ui';
import { LocalDatePipe, MoneyPipe } from '../../shared/pipes/format.pipes';
import { InvoiceDoc, PosService } from './data/pos.service';
import { CreditNoteDialog, PaymentDialog } from './pos-dialogs';

/** Invoice / credit note: bilingual tax document, payments, refunds. Prints cleanly. */
@Component({
  selector: 'sz-invoice-page',
  imports: [TranslatePipe, TranslateDynamicPipe, LucideDynamicIcon, StatePanel, MoneyPipe, LocalDatePipe, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="no-print mb-4 flex flex-wrap items-center gap-2">
      <a routerLink="/invoices" class="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
        <svg lucideIcon="arrow-left" [size]="15" class="rtl:rotate-180"></svg>{{ 'pos.invoices' | t }}
      </a>
      @if (doc(); as d) {
        <div class="ms-auto flex flex-wrap gap-2">
          @if (d.kind === 'invoice' && d.balance_due > 0 && ctx.can('pos.access')) {
            <button type="button" class="btn-primary" (click)="takePayment(d)"><svg lucideIcon="wallet" [size]="16"></svg>{{ 'pos.takePayment' | t }}</button>
          }
          @if (d.kind === 'invoice' && d.credited_total < d.total && ctx.can('pos.refund')) {
            <button type="button" class="btn-secondary" (click)="credit(d)">{{ 'pos.creditNote' | t }}</button>
          }
          <button type="button" class="btn-secondary" (click)="print()"><svg lucideIcon="printer" [size]="16"></svg>{{ 'pos.print' | t }}</button>
        </div>
      }
    </div>

    @if (loading()) {
      <div class="card"><sz-state [loading]="true" /></div>
    } @else if (doc(); as d) {
      <article class="card mx-auto max-w-3xl p-6 sm:p-10 print:max-w-none print:p-0">
        <header class="flex flex-wrap items-start justify-between gap-6 border-b border-line pb-6">
          <div>
            <p class="text-xl font-semibold">{{ d.seller_name }}</p>
            @if (d.seller_name_ar) { <p dir="rtl" lang="ar">{{ d.seller_name_ar }}</p> }
            @if (d.seller_legal_name) { <p class="text-sm text-muted">{{ d.seller_legal_name }}</p> }
            <p class="mt-1 text-sm text-muted">{{ d.branch_name }}@if (d.branch_address) { · {{ d.branch_address }} }</p>
            @if (d.branch_phone) { <p class="num text-sm text-muted" dir="ltr">{{ d.branch_phone }}</p> }
            @if (d.vat_number) { <p class="mt-1 text-sm">{{ 'pos.vatNumber' | t }}: <span class="num" dir="ltr">{{ d.vat_number }}</span></p> }
          </div>
          <div class="text-end">
            <p class="text-lg font-semibold">{{ title(d) }}</p>
            <p class="text-sm text-muted" dir="rtl" lang="ar">{{ titleAr(d) }}</p>
            <p class="num mt-2 font-medium" dir="ltr">{{ d.number ?? ('pos.draft' | t) }}</p>
            @if (d.issued_at) { <p class="text-sm text-muted">{{ d.issued_at | localDate: 'datetime' }}</p> }
            @if (d.original) { <p class="mt-1 text-sm">{{ 'pos.creditFor' | t }} <a class="num text-primary" dir="ltr" [routerLink]="['/invoices', d.original.id]">{{ d.original.number }}</a></p> }
          </div>
        </header>

        <section class="grid gap-1 py-4 text-sm">
          <p><span class="text-muted">{{ 'appointments.customer' | t }}:</span> {{ d.customer_name ?? ('appointments.walkIn' | t) }}
            @if (d.customer_mobile) { <span class="num text-muted" dir="ltr">· {{ d.customer_mobile }}</span> }</p>
          @if (d.reason) { <p><span class="text-muted">{{ 'appointments.reason' | t }}:</span> {{ d.reason }}</p> }
        </section>

        <table class="table">
          <thead><tr>
            <th>{{ 'pos.description' | t }}</th><th class="text-end">{{ 'pos.quantity' | t }}</th><th class="text-end">{{ 'pos.unitPrice' | t }}</th>
            <th class="text-end">{{ 'pos.vat' | t }}</th><th class="text-end">{{ 'pos.lineTotal' | t }}</th>
          </tr></thead>
          <tbody>
            @for (it of d.items; track it.id) {
              <tr>
                <td>{{ it.description_en }}@if (it.description_ar) { <span class="block text-xs text-muted" dir="rtl" lang="ar">{{ it.description_ar }}</span> }
                  @if (it.discount_amount > 0) { <span class="block text-xs text-muted">{{ 'pos.discount' | t }} −{{ it.discount_amount | money: false }}</span> }</td>
                <td class="num text-end">{{ it.quantity }}</td>
                <td class="num text-end">{{ it.unit_price | money: false }}</td>
                <td class="num text-end">{{ it.vat_rate }}% · {{ it.vat_amount | money: false }}</td>
                <td class="num text-end">{{ it.total_amount | money: false }}</td>
              </tr>
            }
          </tbody>
        </table>

        <dl class="ms-auto mt-4 grid max-w-xs grid-cols-2 gap-y-1 text-sm">
          @if (d.discount_total > 0) { <dt class="text-muted">{{ 'pos.discount' | t }}</dt><dd class="num text-end">−{{ d.discount_total | money }}</dd> }
          <dt class="text-muted">{{ 'pos.subtotal' | t }}</dt><dd class="num text-end">{{ d.subtotal | money }}</dd>
          <dt class="text-muted">{{ 'pos.vat' | t }}</dt><dd class="num text-end">{{ d.vat_total | money }}</dd>
          <dt class="text-base font-semibold">{{ 'pos.total' | t }}</dt><dd class="num text-end text-base font-semibold">{{ d.total | money }}</dd>
          @if (d.kind === 'invoice') {
            @if (d.credited_total > 0) { <dt class="text-muted">{{ 'pos.credited' | t }}</dt><dd class="num text-end">−{{ d.credited_total | money }}</dd> }
            <dt class="text-muted">{{ 'pos.paid' | t }}</dt><dd class="num text-end">{{ d.paid_total - d.refunded_total | money }}</dd>
            <dt class="font-semibold">{{ 'pos.balanceDue' | t }}</dt><dd class="num text-end font-semibold">{{ d.balance_due > 0 ? d.balance_due : 0 | money }}</dd>
          } @else if (d.paid_total > 0) {
            <dt class="text-muted">{{ 'pos.refunded' | t }}</dt><dd class="num text-end">{{ d.paid_total | money }}</dd>
          }
        </dl>
        <p class="mt-2 text-xs text-muted">{{ (d.prices_include_vat ? 'pos.vatIncludedNote' : 'pos.vatExcludedNote') | t }}</p>

        @if (d.payments.length > 0) {
          <section class="mt-6 border-t border-line pt-4 text-sm">
            <h2 class="mb-2 font-semibold">{{ 'pos.payments' | t }}</h2>
            <ul class="space-y-1">
              @for (p of d.payments; track p.id) {
                <li class="flex justify-between gap-3">
                  <span>{{ p.received_at | localDate: 'datetime' }} · {{ 'pos.method.' + p.method | tx }}@if (p.direction === 'out') { · <span class="text-danger">{{ 'pos.refund' | t }}</span> }@if (p.reference) { · <span class="num" dir="ltr">{{ p.reference }}</span> }</span>
                  <span class="num">{{ p.direction === 'out' ? '−' : '' }}{{ p.amount | money }}</span>
                </li>
              }
            </ul>
          </section>
        }
        @if (d.credit_notes.length > 0) {
          <section class="no-print mt-4 text-sm">
            <h2 class="mb-1 font-semibold">{{ 'pos.creditNotes' | t }}</h2>
            @for (c of d.credit_notes; track c.id) {
              <a class="block text-primary" [routerLink]="['/invoices', c.id]"><span class="num" dir="ltr">{{ c.number }}</span> · {{ c.total | money }} · {{ c.reason }}</a>
            }
          </section>
        }
        @if (d.footer_en || d.footer_ar) {
          <footer class="mt-8 border-t border-line pt-4 text-center text-xs text-muted">
            @if (d.footer_en) { <p>{{ d.footer_en }}</p> }
            @if (d.footer_ar) { <p dir="rtl" lang="ar">{{ d.footer_ar }}</p> }
          </footer>
        }
      </article>
    } @else {
      <div class="card"><sz-state icon="receipt" [heading]="'errors.notFoundTitle' | t" /></div>
    }
  `,
})
export class InvoicePage {
  readonly id = input.required<string>();

  protected readonly ctx = inject(TenantContextService);
  protected readonly i18n = inject(I18nService);
  private readonly pos = inject(PosService);
  private readonly dialog = inject(Dialog);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);

  protected readonly doc = signal<InvoiceDoc | null>(null);
  protected readonly loading = signal(true);

  constructor() {
    effect(() => {
      const id = this.id();
      untracked(() => void this.load(id));
    });
  }

  private async load(id: string): Promise<void> {
    this.loading.set(true);
    try {
      const doc = await this.pos.get(id);
      if (doc.status === 'draft') {
        void this.router.navigate(['/pos'], { queryParams: { invoice: id } });
        return;
      }
      this.doc.set(doc);
    } catch {
      this.doc.set(null);
    } finally {
      this.loading.set(false);
    }
  }

  protected title(d: InvoiceDoc): string {
    if (d.kind === 'credit_note') return 'Credit Note';
    return d.vat_registered ? 'Tax Invoice' : 'Invoice';
  }

  protected titleAr(d: InvoiceDoc): string {
    if (d.kind === 'credit_note') return 'إشعار دائن';
    return d.vat_registered ? 'فاتورة ضريبية' : 'فاتورة';
  }

  protected print(): void {
    window.print();
  }

  takePayment(d: InvoiceDoc): void {
    this.dialog.open<boolean, InvoiceDoc>(PaymentDialog, { data: d, disableClose: true }).closed.subscribe(() => void this.load(d.id));
  }

  credit(d: InvoiceDoc): void {
    this.dialog.open<string, InvoiceDoc>(CreditNoteDialog, { data: d }).closed.subscribe((cnId) => {
      if (cnId) void this.load(d.id);
    });
  }
}

import { Location } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, inject, input, signal } from '@angular/core';
import { LucideDynamicIcon } from '@lucide/angular';
import { I18nService, TranslateDynamicPipe, TranslatePipe } from '../../core/i18n/i18n.service';
import { StatePanel } from '../../shared/components/ui';
import { LocalDatePipe, MoneyPipe } from '../../shared/pipes/format.pipes';
import { BillingService, PrintableInvoice } from './data/billing.service';

/** Printable Salonzoft subscription invoice — for the salon (billing.manage) and platform admins. */
@Component({
  selector: 'sz-subscription-invoice-page',
  imports: [TranslatePipe, TranslateDynamicPipe, LucideDynamicIcon, StatePanel, LocalDatePipe, MoneyPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="min-h-screen bg-bg px-4 py-6 print:bg-white print:p-0">
      <div class="no-print mx-auto mb-4 flex max-w-3xl items-center gap-2">
        <button type="button" class="btn-ghost btn-sm" (click)="back()"><svg lucideIcon="arrow-left" [size]="16" class="rtl:rotate-180"></svg>{{ 'common.back' | t }}</button>
        <button type="button" class="btn-ghost btn-sm ms-auto" (click)="i18n.toggle()">{{ i18n.lang() === 'en' ? 'العربية' : 'English' }}</button>
        @if (inv()) { <button type="button" class="btn-secondary btn-sm" (click)="print()"><svg lucideIcon="printer" [size]="15"></svg>{{ 'pos.print' | t }}</button> }
      </div>
      @if (loading()) {
        <div class="card mx-auto max-w-3xl"><sz-state [loading]="true" /></div>
      } @else if (inv(); as i) {
        <article class="card mx-auto max-w-3xl p-6 sm:p-10 print:max-w-none print:border-0 print:p-0 print:shadow-none">
          <header class="flex flex-wrap items-start justify-between gap-4 border-b border-line pb-5">
            <div>
              <p class="font-[family-name:var(--font-display)] text-2xl font-semibold">{{ i.seller_name }}</p>
              @if (i.seller_vat_number) { <p class="text-sm text-muted">{{ 'billing.vatNo' | t }} <span class="num" dir="ltr">{{ i.seller_vat_number }}</span></p> }
            </div>
            <div class="text-end">
              <p class="text-lg font-semibold">{{ (i.vat_amount > 0 ? 'billing.taxInvoice' : 'billing.invoice') | t }}</p>
              <p class="num" dir="ltr">{{ i.number }}</p>
              <span [class]="i.status === 'paid' ? 'badge-success' : i.status === 'open' ? 'badge-warning' : 'badge-muted'">{{ 'billing.status.' + i.status | tx }}</span>
            </div>
          </header>

          <section class="grid gap-4 border-b border-line py-5 text-sm sm:grid-cols-2">
            <div>
              <p class="label mb-1">{{ 'billing.billTo' | t }}</p>
              <p class="font-medium">{{ i.buyer_legal_name || i.buyer_name }}</p>
              @if (i.buyer_legal_name) { <p class="text-muted">{{ i.buyer_name }}</p> }
              @if (i.buyer_vat_number) { <p class="text-muted">{{ 'billing.vatNo' | t }} <span class="num" dir="ltr">{{ i.buyer_vat_number }}</span></p> }
            </div>
            <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 sm:justify-self-end">
              <dt class="text-muted">{{ 'billing.issued' | t }}</dt><dd>{{ i.issued_at | localDate }}</dd>
              <dt class="text-muted">{{ 'billing.due' | t }}</dt><dd>{{ i.due_at | localDate }}</dd>
              @if (i.paid_at) { <dt class="text-muted">{{ 'billing.paidOn' | t }}</dt><dd>{{ i.paid_at | localDate }}</dd> }
            </dl>
          </section>

          <table class="table mt-2">
            <thead><tr><th>{{ 'billing.description' | t }}</th><th class="text-end">{{ 'billing.amount' | t }}</th></tr></thead>
            <tbody>
              <tr>
                <td>
                  <p class="font-medium">{{ 'billing.lineItem' | t: { plan: i18n.pick(i.plan_name_en, i.plan_name_ar), cycle: ('billing.cycle.' + i.billing_cycle | tx) } }}</p>
                  @if (i.period_start && i.period_end) { <p class="text-xs text-muted">{{ i.period_start | localDate }} – {{ i.period_end | localDate }}</p> }
                </td>
                <td class="num text-end">{{ i.amount | money }}</td>
              </tr>
              @if (i.credit > 0) {
                <tr><td>{{ 'billing.credit' | t }}</td><td class="num text-end">−{{ i.credit | money }}</td></tr>
              }
            </tbody>
          </table>
          <dl class="ms-auto mt-4 grid w-full max-w-xs grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-sm">
            <dt class="text-muted">{{ 'billing.subtotal' | t }}</dt><dd class="num text-end">{{ i.subtotal | money }}</dd>
            <dt class="text-muted">{{ 'billing.vatLine' | t: { rate: i.vat_rate } }}</dt><dd class="num text-end">{{ i.vat_amount | money }}</dd>
            <dt class="border-t border-line pt-2 font-semibold">{{ 'billing.total' | t }}</dt><dd class="num border-t border-line pt-2 text-end font-semibold">{{ i.total | money }}</dd>
          </dl>

          @if (i.status === 'paid') {
            <p class="mt-6 text-sm text-muted">{{ 'billing.paidWith' | t: { method: ('billing.method.' + i.payment_method | tx) } }}@if (i.payment_ref) { · <span class="num" dir="ltr">{{ i.payment_ref }}</span> }</p>
          } @else if (i.status === 'open' && i.bank_details) {
            <section class="mt-6 rounded-xl bg-surface-2 px-4 py-3 text-sm">
              <p class="label mb-1">{{ 'billing.howToPay' | t }}</p>
              <p class="whitespace-pre-line">{{ i.bank_details }}</p>
              <p class="hint mt-1">{{ 'billing.payRef' | t: { number: i.number } }}</p>
            </section>
          } @else if (i.status === 'void') {
            <p class="mt-6 text-sm text-danger">{{ 'billing.voided' | t }}@if (i.void_reason) { · {{ i.void_reason }} }</p>
          }
        </article>
      } @else {
        <div class="card mx-auto max-w-3xl"><sz-state icon="circle-alert" [heading]="'errors.notFoundTitle' | t" /></div>
      }
    </div>
  `,
})
export class SubscriptionInvoicePage implements OnInit {
  readonly id = input.required<string>();
  protected readonly i18n = inject(I18nService);
  private readonly api = inject(BillingService);
  private readonly location = inject(Location);
  protected readonly loading = signal(true);
  protected readonly inv = signal<PrintableInvoice | null>(null);

  async ngOnInit(): Promise<void> {
    try {
      this.inv.set(await this.api.invoice(this.id()));
    } catch {
      this.inv.set(null);
    } finally {
      this.loading.set(false);
    }
  }

  protected back(): void {
    this.location.back();
  }

  protected print(): void {
    window.print();
  }
}

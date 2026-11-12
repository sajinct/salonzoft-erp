import { ChangeDetectionStrategy, Component, ElementRef, OnInit, computed, effect, inject, input, signal, viewChild } from '@angular/core';
import { LucideDynamicIcon } from '@lucide/angular';
import { TranslatePipe } from '../../core/i18n/i18n.service';
import { unwrap } from '../../core/supabase/app-error';
import { SUPABASE } from '../../core/supabase/supabase.client';
import { StatePanel } from '../../shared/components/ui';
import { ReceiptDoc, ReceiptSettings, printHtml, renderReceiptHtml, templateFromSettings, writeFrame } from '../../shared/receipt/receipt';

type PublicInvoice = ReceiptDoc & { template: ReceiptSettings | null };

/** Narrow screens get the receipt layout, wide ones the A4 layout. */
const NARROW = 700;

/** The customer's copy of an invoice: /i/:token (the token is the secret, no login). */
@Component({
  selector: 'sz-public-invoice-page',
  imports: [TranslatePipe, LucideDynamicIcon, StatePanel],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="min-h-screen bg-bg">
      <main class="mx-auto max-w-4xl px-3 py-6">
        @if (loading()) {
          <div class="card"><sz-state [loading]="true" /></div>
        } @else if (doc()) {
          <div class="mb-3 flex justify-end">
            <button type="button" class="btn-secondary btn-sm" (click)="print()"><svg lucideIcon="printer" [size]="15"></svg>{{ 'pos.printOrSave' | t }}</button>
          </div>
          <div class="overflow-x-auto rounded-2xl bg-surface-2 p-3">
            <iframe #frame class="mx-auto block border border-line bg-white" [style.width]="narrow ? '80mm' : '100%'" [style.min-height.px]="320" [attr.title]="'pos.invoiceDoc' | t"></iframe>
          </div>
        } @else {
          <div class="card"><sz-state icon="receipt" [heading]="'pos.invoiceLinkInvalid' | t" /></div>
        }
      </main>
    </div>
  `,
})
export class PublicInvoicePage implements OnInit {
  readonly token = input.required<string>();

  private readonly sb = inject(SUPABASE);
  protected readonly narrow = window.innerWidth < NARROW;
  protected readonly loading = signal(true);
  protected readonly doc = signal<PublicInvoice | null>(null);
  private readonly frame = viewChild<ElementRef<HTMLIFrameElement>>('frame');

  private html(paper: 'a4' | '80mm'): string {
    const d = this.doc();
    if (!d) return '';
    const settings: ReceiptSettings = d.template ?? {
      receipt_paper: paper, receipt_language: 'both', receipt_header_en: null, receipt_header_ar: null,
      receipt_show_logo: false, currency_decimals: 3, timezone: 'Asia/Muscat',
    };
    return renderReceiptHtml(d, { ...templateFromSettings(settings), paper, showLogo: false });
  }
  private readonly screenHtml = computed(() => this.html(this.narrow ? '80mm' : 'a4'));

  constructor() {
    effect(() => {
      const frame = this.frame()?.nativeElement;
      const html = this.screenHtml();
      if (!frame || !html) return;
      const d = writeFrame(frame, html);
      frame.style.height = `${(d?.documentElement.scrollHeight ?? 320) + 2}px`;
    });
  }

  async ngOnInit(): Promise<void> {
    try {
      this.doc.set(unwrap(await this.sb.rpc('public_get_invoice', { p_token: this.token() })) as unknown as PublicInvoice);
    } catch {
      this.doc.set(null);
    } finally {
      this.loading.set(false);
    }
  }

  /** Always a full page: the browser's print dialog also offers "Save as PDF". */
  protected print(): void {
    void printHtml(this.html('a4'));
  }
}

import { ChangeDetectionStrategy, Component, ElementRef, OnInit, computed, effect, inject, signal, viewChild } from '@angular/core';
import { LucideDynamicIcon } from '@lucide/angular';
import { I18nService, TranslateDynamicPipe, TranslatePipe } from '../../core/i18n/i18n.service';
import { ToastService } from '../../core/services/toast.service';
import { TenantContextService } from '../../core/tenant/tenant-context.service';
import { StatePanel } from '../../shared/components/ui';
import { ReceiptPrintService } from '../../shared/receipt/receipt-print.service';
import { ReceiptDoc, ReceiptLanguage, ReceiptPaper, ReceiptTemplate, printHtml, renderReceiptHtml, writeFrame } from '../../shared/receipt/receipt';
import { BusinessSettingsService } from './data/settings.services';

const PAPERS: ReceiptPaper[] = ['80mm', '58mm', 'a4'];
const LANGUAGES: ReceiptLanguage[] = ['both', 'en', 'ar'];
/** Preview widths: the roll width, or the card width for A4. */
const FRAME_WIDTH: Record<ReceiptPaper, string> = { '80mm': '80mm', '58mm': '58mm', a4: '100%' };

interface ReceiptForm {
  paper: ReceiptPaper;
  language: ReceiptLanguage;
  headerEn: string;
  headerAr: string;
  footerEn: string;
  footerAr: string;
  showLogo: boolean;
  autoPrint: boolean;
}

/** Invoice / receipt template of the salon, with a live preview of exactly what prints. */
@Component({
  selector: 'sz-receipt-settings-page',
  imports: [TranslatePipe, TranslateDynamicPipe, LucideDynamicIcon, StatePanel],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (loading()) {
      <div class="card"><sz-state [loading]="true" /></div>
    } @else {
      @if (!canEdit()) {
        <p class="mb-4 rounded-xl bg-surface-2 px-4 py-3 text-sm text-muted">{{ 'common.readOnly' | t }}</p>
      }
      <div class="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <form class="space-y-6" (submit)="$event.preventDefault(); save()" novalidate>
          <fieldset class="card space-y-5 p-6" [disabled]="!canEdit()">
            <h2 class="text-base font-semibold">{{ 'receipt.layout' | t }}</h2>
            <div class="grid gap-4 sm:grid-cols-2">
              <div class="field">
                <label class="label" for="rc-paper">{{ 'receipt.paper' | t }}</label>
                <select id="rc-paper" class="input" [value]="f().paper" (change)="set('paper', $any($event.target).value)">
                  @for (p of papers; track p) { <option [value]="p" [selected]="p === f().paper">{{ 'receipt.paper.' + p | tx }}</option> }
                </select>
              </div>
              <div class="field">
                <label class="label" for="rc-lang">{{ 'receipt.language' | t }}</label>
                <select id="rc-lang" class="input" [value]="f().language" (change)="set('language', $any($event.target).value)">
                  @for (l of languages; track l) { <option [value]="l" [selected]="l === f().language">{{ 'receipt.language.' + l | tx }}</option> }
                </select>
              </div>
            </div>
            <label class="flex items-center gap-2 text-sm"><input type="checkbox" class="checkbox" [checked]="f().showLogo" (change)="set('showLogo', $any($event.target).checked)" />{{ 'receipt.showLogo' | t }}</label>
          </fieldset>

          <fieldset class="card space-y-5 p-6" [disabled]="!canEdit()">
            <div>
              <h2 class="text-base font-semibold">{{ 'receipt.header' | t }}</h2>
              <p class="hint">{{ 'receipt.headerHint' | t }}</p>
            </div>
            <div class="grid gap-4 sm:grid-cols-2">
              <div class="field"><label class="label" for="rc-hen">{{ 'receipt.english' | t }}</label><textarea id="rc-hen" rows="4" maxlength="500" class="input" [value]="f().headerEn" (input)="set('headerEn', $any($event.target).value)"></textarea></div>
              <div class="field"><label class="label" for="rc-har">{{ 'receipt.arabic' | t }}</label><textarea id="rc-har" rows="4" maxlength="500" class="input" dir="rtl" lang="ar" [value]="f().headerAr" (input)="set('headerAr', $any($event.target).value)"></textarea></div>
            </div>
            <div>
              <h2 class="text-base font-semibold">{{ 'receipt.footer' | t }}</h2>
              <p class="hint">{{ 'receipt.footerHint' | t }}</p>
            </div>
            <div class="grid gap-4 sm:grid-cols-2">
              <div class="field"><label class="label" for="rc-fen">{{ 'receipt.english' | t }}</label><textarea id="rc-fen" rows="3" maxlength="500" class="input" [value]="f().footerEn" (input)="set('footerEn', $any($event.target).value)"></textarea></div>
              <div class="field"><label class="label" for="rc-far">{{ 'receipt.arabic' | t }}</label><textarea id="rc-far" rows="3" maxlength="500" class="input" dir="rtl" lang="ar" [value]="f().footerAr" (input)="set('footerAr', $any($event.target).value)"></textarea></div>
            </div>
          </fieldset>

          <fieldset class="card space-y-3 p-6" [disabled]="!canEdit()">
            <h2 class="text-base font-semibold">{{ 'receipt.printing' | t }}</h2>
            <label class="flex items-center gap-2 text-sm"><input type="checkbox" class="checkbox" [checked]="f().autoPrint" (change)="set('autoPrint', $any($event.target).checked)" />{{ 'receipt.autoPrint' | t }}</label>
            <div class="rounded-xl bg-surface-2 px-4 py-3 text-sm text-muted">
              <p class="font-medium text-ink">{{ 'receipt.silentTitle' | t }}</p>
              <p class="mt-1">{{ 'receipt.silentLine' | t }}</p>
              <p class="mt-2 break-all font-mono text-xs" dir="ltr">chrome.exe --kiosk-printing --app={{ origin }}</p>
              <p class="mt-2">{{ 'receipt.silentThermal' | t }}</p>
            </div>
          </fieldset>

          @if (canEdit()) {
            <div class="flex justify-end">
              <button type="submit" class="btn-primary" [disabled]="saving()">{{ saving() ? ('common.saving' | t) : ('common.save' | t) }}</button>
            </div>
          }
        </form>

        <section class="card p-6">
          <div class="mb-4 flex items-center justify-between gap-2">
            <h2 class="text-base font-semibold">{{ 'receipt.preview' | t }}</h2>
            <button type="button" class="btn-secondary btn-sm" (click)="testPrint()"><svg lucideIcon="printer" [size]="15"></svg>{{ 'receipt.testPrint' | t }}</button>
          </div>
          <div class="overflow-x-auto rounded-xl bg-surface-2 p-4">
            <iframe #frame class="mx-auto block border border-line bg-white" [style.width]="frameWidth()" [style.min-height.px]="320" [attr.title]="'receipt.preview' | t"></iframe>
          </div>
        </section>
      </div>
    }
  `,
})
export class ReceiptSettingsPage implements OnInit {
  private readonly service = inject(BusinessSettingsService);
  private readonly receipts = inject(ReceiptPrintService);
  private readonly ctx = inject(TenantContextService);
  private readonly toast = inject(ToastService);
  private readonly i18n = inject(I18nService);

  protected readonly papers = PAPERS;
  protected readonly languages = LANGUAGES;
  protected readonly origin = location.origin;
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly canEdit = computed(() => this.ctx.can('settings.manage'));
  protected readonly f = signal<ReceiptForm>({ paper: 'a4', language: 'both', headerEn: '', headerAr: '', footerEn: '', footerAr: '', showLogo: true, autoPrint: false });
  protected readonly frameWidth = computed(() => FRAME_WIDTH[this.f().paper]);

  private readonly frame = viewChild<ElementRef<HTMLIFrameElement>>('frame');
  private readonly logoUrl = signal<string | null>(null);

  private readonly template = computed<ReceiptTemplate>(() => {
    const f = this.f();
    const s = this.ctx.context()?.settings;
    return {
      paper: f.paper, language: f.language, headerEn: f.headerEn.trim() || null, headerAr: f.headerAr.trim() || null,
      showLogo: f.showLogo, decimals: s?.currency_decimals ?? 3, timezone: s?.timezone ?? 'Asia/Muscat',
    };
  });
  private readonly html = computed(() => renderReceiptHtml(this.sample(), this.template(), this.logoUrl()));

  constructor() {
    effect(() => {
      const frame = this.frame()?.nativeElement;
      const html = this.html();
      if (!frame) return;
      const d = writeFrame(frame, html);
      // Grow the frame to the receipt so the preview never scrolls inside itself.
      const fit = () => (frame.style.height = `${(d?.documentElement.scrollHeight ?? 320) + 2}px`);
      fit();
      setTimeout(fit, 300); // again once the logo has loaded
    });
  }

  async ngOnInit(): Promise<void> {
    const tenantId = this.ctx.tenantId();
    if (!tenantId) return;
    try {
      const { settings: s } = await this.service.load(tenantId);
      this.f.set({
        paper: s.receipt_paper as ReceiptPaper,
        language: s.receipt_language as ReceiptLanguage,
        headerEn: s.receipt_header_en ?? '',
        headerAr: s.receipt_header_ar ?? '',
        footerEn: s.receipt_footer_en ?? '',
        footerAr: s.receipt_footer_ar ?? '',
        showLogo: s.receipt_show_logo,
        autoPrint: s.receipt_auto_print,
      });
      this.logoUrl.set(await this.receipts.logoUrl());
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.loading.set(false);
    }
  }

  protected set<K extends keyof ReceiptForm>(key: K, value: ReceiptForm[K]): void {
    this.f.update((f) => ({ ...f, [key]: value }));
  }

  /** A made-up sale, so the preview shows every part of the template. */
  private sample(): ReceiptDoc {
    const c = this.ctx.context();
    const s = c?.settings;
    const f = this.f();
    const branch = this.ctx.activeBranch() ?? this.ctx.branches()[0];
    const rate = s?.vat_registered ? Number(s.default_vat_rate) : 0;
    const total = 23;
    const vat = Number((total - total / (1 + rate / 100)).toFixed(3));
    return {
      kind: 'invoice', number: `${s?.invoice_prefix ?? 'INV'}-2026-00042`, issued_at: new Date().toISOString(),
      currency_code: s?.currency_code ?? 'OMR', prices_include_vat: true, vat_registered: s?.vat_registered ?? false, vat_number: s?.vat_number ?? null,
      seller_name: c?.tenant.name ?? 'Salon', seller_name_ar: c?.tenant.name_ar ?? null, seller_legal_name: c?.tenant.legal_name ?? null,
      branch_name: branch?.name_en ?? null, branch_name_ar: branch?.name_ar ?? null, branch_address: null, branch_phone: null,
      customer_name: 'Aisha Al Balushi', customer_mobile: '+96890000000',
      footer_en: f.footerEn.trim() || null, footer_ar: f.footerAr.trim() || null,
      discount_total: 2, subtotal: total - vat, vat_total: vat, total, paid_total: total, credited_total: 0, refunded_total: 0, balance_due: 0, reason: null,
      items: [
        { description_en: 'Haircut & blow-dry', description_ar: 'قص وتصفيف الشعر', quantity: 1, unit_price: 12, discount_amount: 2, vat_rate: rate, vat_amount: Number((vat * 10 / total).toFixed(3)), total_amount: 10 },
        { description_en: 'Manicure', description_ar: 'مانيكير', quantity: 2, unit_price: 6.5, discount_amount: 0, vat_rate: rate, vat_amount: Number((vat * 13 / total).toFixed(3)), total_amount: 13 },
      ],
      payments: [{ method: 'cash', direction: 'in', amount: 10, reference: null }, { method: 'card', direction: 'in', amount: 13, reference: '4821' }],
      original: null,
    };
  }

  protected testPrint(): void {
    void printHtml(this.html());
  }

  async save(): Promise<void> {
    const tenantId = this.ctx.tenantId();
    if (!tenantId) return;
    const f = this.f();
    this.saving.set(true);
    try {
      await this.service.saveSettings(tenantId, {
        receipt_paper: f.paper,
        receipt_language: f.language,
        receipt_header_en: f.headerEn.trim() || null,
        receipt_header_ar: f.headerAr.trim() || null,
        receipt_footer_en: f.footerEn.trim() || null,
        receipt_footer_ar: f.footerAr.trim() || null,
        receipt_show_logo: f.showLogo,
        receipt_auto_print: f.autoPrint,
      });
      await this.ctx.refresh();
      this.toast.success(this.i18n.t('common.saved'));
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.saving.set(false);
    }
  }
}

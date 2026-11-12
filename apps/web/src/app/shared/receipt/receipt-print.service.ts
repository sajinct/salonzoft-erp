import { Injectable, computed, inject } from '@angular/core';
import { SUPABASE } from '../../core/supabase/supabase.client';
import { TenantContextService } from '../../core/tenant/tenant-context.service';
import { ReceiptDoc, ReceiptTemplate, printHtml, renderReceiptHtml, templateFromSettings } from './receipt';

const LOGO_TTL_SECONDS = 3600;

/** Prints invoices with the active salon's receipt template, without opening a preview page. */
@Injectable({ providedIn: 'root' })
export class ReceiptPrintService {
  private readonly sb = inject(SUPABASE);
  private readonly ctx = inject(TenantContextService);

  readonly template = computed<ReceiptTemplate | null>(() => {
    const s = this.ctx.context()?.settings;
    return s ? templateFromSettings(s) : null;
  });
  /** Print the receipt straight after a payment at the POS. */
  readonly autoPrint = computed(() => this.ctx.context()?.settings.receipt_auto_print ?? false);

  private logo: { path: string; url: string; expires: number } | null = null;

  /** Signed URL of the salon's logo (cached), or null when there is none or it cannot be read. */
  async logoUrl(): Promise<string | null> {
    const path = this.ctx.context()?.settings.logo_path;
    if (!path) return null;
    if (this.logo && this.logo.path === path && this.logo.expires > Date.now()) return this.logo.url;
    try {
      const { data, error } = await this.sb.storage.from('tenant-assets').createSignedUrl(path, LOGO_TTL_SECONDS);
      if (error || !data) return null;
      this.logo = { path, url: data.signedUrl, expires: Date.now() + (LOGO_TTL_SECONDS - 300) * 1000 };
      return data.signedUrl;
    } catch {
      return null;
    }
  }

  async html(doc: ReceiptDoc, template?: ReceiptTemplate): Promise<string> {
    const tpl = template ?? this.template();
    if (!tpl) throw new Error('No active business');
    return renderReceiptHtml(doc, tpl, tpl.showLogo ? await this.logoUrl() : null);
  }

  /** Send the document to the printer. Resolves when printing has been handed to the browser. */
  async print(doc: ReceiptDoc): Promise<void> {
    await printHtml(await this.html(doc));
  }
}

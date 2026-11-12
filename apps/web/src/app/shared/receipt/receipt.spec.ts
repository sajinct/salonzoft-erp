import { describe, expect, it } from 'vitest';
import { ReceiptDoc, ReceiptTemplate, escapeHtml, renderReceiptHtml, templateFromSettings } from './receipt';

const doc: ReceiptDoc = {
  kind: 'invoice',
  number: 'INV-2026-00012',
  issued_at: '2026-11-12T10:30:00Z',
  currency_code: 'OMR',
  prices_include_vat: true,
  vat_registered: true,
  vat_number: 'OM1100123456',
  seller_name: 'Glow <Spa>',
  seller_name_ar: 'جلو سبا',
  seller_legal_name: 'Glow LLC',
  branch_name: 'Al Mouj',
  branch_name_ar: null,
  branch_address: 'Muscat',
  branch_phone: '+96890000000',
  customer_name: 'Aisha',
  customer_mobile: null,
  footer_en: 'Thank you',
  footer_ar: 'شكراً لكم',
  discount_total: 1,
  subtotal: 9.524,
  vat_total: 0.476,
  total: 10,
  paid_total: 10,
  credited_total: 0,
  refunded_total: 0,
  balance_due: 0,
  reason: null,
  items: [{ description_en: 'Haircut', description_ar: 'قص شعر', quantity: 2, unit_price: 5.5, discount_amount: 1, vat_rate: 5, vat_amount: 0.476, total_amount: 10 }],
  payments: [{ method: 'cash', direction: 'in', amount: 10, reference: null }],
  original: null,
};

const tpl = (over: Partial<ReceiptTemplate> = {}): ReceiptTemplate => ({
  paper: '80mm', language: 'both', headerEn: 'CR 123\nTel 2400', headerAr: 'س.ت 123', showLogo: true, decimals: 3, timezone: 'Asia/Muscat', ...over,
});

describe('renderReceiptHtml', () => {
  it('escapes every value', () => {
    const html = renderReceiptHtml(doc, tpl());
    expect(html).toContain('Glow &lt;Spa&gt;');
    expect(html).not.toContain('<Spa>');
    expect(escapeHtml(`"a" & 'b'`)).toBe('&quot;a&quot; &amp; &#39;b&#39;');
  });

  it('prints both languages, the header, footer and amounts', () => {
    const html = renderReceiptHtml(doc, tpl());
    expect(html).toContain('Tax Invoice');
    expect(html).toContain('فاتورة ضريبية');
    expect(html).toContain('CR 123\nTel 2400');
    expect(html).toContain('س.ت 123');
    expect(html).toContain('Haircut');
    expect(html).toContain('قص شعر');
    expect(html).toContain('OMR 10.000');
    expect(html).toContain('2 × 5.500');
    expect(html).toContain('Thank you');
    expect(html).toContain('شكراً لكم');
    expect(html).toContain('12/11/2026, 14:30'); // Muscat is UTC+4
    expect(html).toContain('class="p80"');
    expect(html).toContain('@page{margin:0}');
  });

  it('follows the language setting', () => {
    const en = renderReceiptHtml(doc, tpl({ language: 'en' }));
    expect(en).not.toContain('فاتورة ضريبية');
    expect(en).not.toContain('قص شعر');
    expect(en).toContain('dir="ltr"');

    const ar = renderReceiptHtml(doc, tpl({ language: 'ar' }));
    expect(ar).toContain('<html lang="ar" dir="rtl">');
    expect(ar).not.toContain('Tax Invoice');
    expect(ar).not.toContain('Haircut');
    expect(ar).toContain('Al Mouj'); // no Arabic branch name: falls back to English
  });

  it('uses a table on A4 and shows the logo only when asked', () => {
    const a4 = renderReceiptHtml(doc, tpl({ paper: 'a4' }), 'https://x.test/logo.png');
    expect(a4).toContain('<table>');
    expect(a4).toContain('@page{size:A4;margin:12mm}');
    expect(a4).toContain('src="https://x.test/logo.png"');
    expect(renderReceiptHtml(doc, tpl({ showLogo: false }), 'https://x.test/logo.png')).not.toContain('<img');
  });

  it('labels credit notes and unpaid balances', () => {
    const cn = renderReceiptHtml({ ...doc, kind: 'credit_note', original: { number: 'INV-1' }, reason: 'Refund' }, tpl({ language: 'en' }));
    expect(cn).toContain('Credit Note');
    expect(cn).toContain('For invoice');
    expect(cn).toContain('Refunded');
    const due = renderReceiptHtml({ ...doc, paid_total: 4, balance_due: 6 }, tpl({ language: 'en' }));
    expect(due).toContain('Balance due');
  });
});

describe('templateFromSettings', () => {
  it('falls back to A4 / both for unknown values', () => {
    const t = templateFromSettings({
      receipt_paper: 'letter', receipt_language: 'fr', receipt_header_en: null, receipt_header_ar: null,
      receipt_show_logo: false, currency_decimals: 3, timezone: 'Asia/Muscat',
    });
    expect(t.paper).toBe('a4');
    expect(t.language).toBe('both');
  });
});

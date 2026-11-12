/**
 * Printable invoice / receipt, rendered as a self-contained HTML document from
 * the salon's template (paper, language, header, footer, logo).
 *
 * The same HTML is used for the settings preview and for printing (in a hidden
 * frame), so what the salon sees is what the printer gets. Every value is
 * HTML-escaped here: nothing in the document is trusted markup.
 */
export type ReceiptPaper = 'a4' | '80mm' | '58mm';
export type ReceiptLanguage = 'en' | 'ar' | 'both';

export interface ReceiptTemplate {
  paper: ReceiptPaper;
  language: ReceiptLanguage;
  headerEn: string | null;
  headerAr: string | null;
  showLogo: boolean;
  decimals: number;
  timezone: string;
}

export interface ReceiptItem {
  description_en: string;
  description_ar: string | null;
  quantity: number;
  unit_price: number;
  discount_amount: number;
  vat_rate: number;
  vat_amount: number;
  total_amount: number;
}

export interface ReceiptPayment {
  method: string;
  direction: string;
  amount: number;
  reference: string | null;
}

export interface ReceiptDoc {
  kind: string;
  number: string | null;
  issued_at: string | null;
  currency_code: string;
  prices_include_vat: boolean;
  vat_registered: boolean;
  vat_number: string | null;
  seller_name: string | null;
  seller_name_ar: string | null;
  seller_legal_name: string | null;
  branch_name: string | null;
  branch_name_ar: string | null;
  branch_address: string | null;
  branch_phone: string | null;
  customer_name: string | null;
  customer_mobile: string | null;
  footer_en: string | null;
  footer_ar: string | null;
  discount_total: number;
  subtotal: number;
  vat_total: number;
  total: number;
  paid_total: number;
  credited_total: number;
  refunded_total: number;
  balance_due: number;
  reason: string | null;
  items: ReceiptItem[];
  payments: ReceiptPayment[];
  original: { number: string } | null;
}

/** The subset of tenant_settings the template is built from. */
export interface ReceiptSettings {
  receipt_paper: string;
  receipt_language: string;
  receipt_header_en: string | null;
  receipt_header_ar: string | null;
  receipt_show_logo: boolean;
  currency_decimals: number;
  timezone: string;
}

export function templateFromSettings(s: ReceiptSettings): ReceiptTemplate {
  return {
    paper: s.receipt_paper === '80mm' || s.receipt_paper === '58mm' ? s.receipt_paper : 'a4',
    language: s.receipt_language === 'en' || s.receipt_language === 'ar' ? s.receipt_language : 'both',
    headerEn: s.receipt_header_en,
    headerAr: s.receipt_header_ar,
    showLogo: s.receipt_show_logo,
    decimals: s.currency_decimals,
    timezone: s.timezone,
  };
}

type Label = readonly [en: string, ar: string];

const L = {
  taxInvoice: ['Tax Invoice', 'فاتورة ضريبية'],
  invoice: ['Invoice', 'فاتورة'],
  creditNote: ['Credit Note', 'إشعار دائن'],
  vatNo: ['VAT No.', 'الرقم الضريبي'],
  number: ['No.', 'رقم'],
  date: ['Date', 'التاريخ'],
  customer: ['Customer', 'العميل'],
  walkIn: ['Walk-in', 'عميل نقدي'],
  forInvoice: ['For invoice', 'للفاتورة'],
  reason: ['Reason', 'السبب'],
  item: ['Item', 'الصنف'],
  qty: ['Qty', 'الكمية'],
  price: ['Price', 'السعر'],
  amount: ['Amount', 'المبلغ'],
  discount: ['Discount', 'الخصم'],
  subtotal: ['Subtotal', 'المجموع قبل الضريبة'],
  vat: ['VAT', 'الضريبة'],
  total: ['Total', 'الإجمالي'],
  credited: ['Credited', 'مُرتجع'],
  paid: ['Paid', 'المدفوع'],
  refunded: ['Refunded', 'المسترد'],
  balance: ['Balance due', 'المتبقي'],
  vatIncluded: ['Prices include VAT', 'الأسعار شاملة الضريبة'],
  vatExcluded: ['Prices exclude VAT', 'الأسعار غير شاملة الضريبة'],
} satisfies Record<string, Label>;

const METHODS: Record<string, Label> = {
  cash: ['Cash', 'نقداً'],
  card: ['Card', 'بطاقة'],
  bank_transfer: ['Bank transfer', 'تحويل بنكي'],
  voucher: ['Voucher', 'قسيمة'],
  other: ['Other', 'أخرى'],
};
const OTHER_METHOD: Label = ['Other', 'أخرى'];

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:#fff;color:#000}
body{font-family:"Segoe UI",Tahoma,Arial,"Noto Sans Arabic",sans-serif;font-size:12px;line-height:1.35;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.c{text-align:center}.b{font-weight:700}.lg{font-size:1.25em}.xl{font-size:1.4em}.sm{font-size:.9em}
.pre{white-space:pre-line}
.n{font-variant-numeric:tabular-nums;white-space:nowrap}
.logo{display:block;margin:0 auto 4px;max-width:60%;max-height:22mm;object-fit:contain}
hr{border:0;border-top:1px dashed #000;margin:6px 0}
.row{display:flex;justify-content:space-between;gap:8px;align-items:baseline}
.row>:last-child{text-align:end}
.it{padding:3px 0}
.g{display:inline-flex;gap:5px;align-items:baseline}
.tot{font-size:1.2em;font-weight:700}
table{width:100%;border-collapse:collapse}
th,td{padding:5px 6px;text-align:start;vertical-align:top}
th{border-bottom:1px solid #000;font-size:.9em}
td{border-bottom:1px solid #ddd}
th.e,td.e{text-align:end}
.sum{margin-inline-start:auto;width:60%;margin-top:8px}
body.p80{width:72mm;padding:2mm 1mm 6mm}
body.p58{width:48mm;padding:2mm 0 6mm;font-size:11px}
body.pa4{font-size:13px}
body.pa4 hr{border-top-style:solid;border-top-color:#999;margin:12px 0}
body.pa4 .sum{width:45%}
@media screen{body{margin:0 auto}body.pa4{padding:10mm;max-width:210mm}}
`;

/** Build the whole printable document. `logoUrl` is only used when the template shows the logo. */
export function renderReceiptHtml(doc: ReceiptDoc, tpl: ReceiptTemplate, logoUrl: string | null = null): string {
  const lang = tpl.language;
  const rtl = lang === 'ar';
  const thermal = tpl.paper !== 'a4';
  const en = lang !== 'ar';
  const ar = lang !== 'en';

  const ars = (text: string) => `<bdi dir="rtl" lang="ar">${escapeHtml(text)}</bdi>`;
  /** A label in the template's language(s). */
  const lbl = (l: Label) => (lang === 'en' ? escapeHtml(l[0]) : lang === 'ar' ? ars(l[1]) : `${escapeHtml(l[0])} / ${ars(l[1])}`);
  /** Content that exists in two languages: one block per language shown (Arabic falls back to English and vice versa). */
  const pair = (enText: string | null, arText: string | null, cls = '', docSide = false) => {
    const side = docSide ? ` style="text-align:${rtl ? 'right' : 'left'}"` : '';
    const e = (enText ?? '').trim();
    const a = (arText ?? '').trim();
    const out: string[] = [];
    if (e && (en || !a)) out.push(`<div class="${cls}" dir="ltr"${side}>${escapeHtml(e)}</div>`);
    if (a && (ar || !e)) out.push(`<div class="${cls}" dir="rtl" lang="ar"${side}>${escapeHtml(a)}</div>`);
    return out.join('');
  };
  const money = (v: number, sign = '') => `<span class="n" dir="ltr">${sign}${escapeHtml(Number(v ?? 0).toFixed(tpl.decimals))}</span>`;
  const moneyCur = (v: number) => `<span class="n" dir="ltr">${escapeHtml(doc.currency_code)} ${escapeHtml(Number(v ?? 0).toFixed(tpl.decimals))}</span>`;
  const qty = (v: number) => escapeHtml(String(Number(v)));
  const ltr = (text: string | null) => `<span class="n" dir="ltr">${escapeHtml(text)}</span>`;
  const row = (label: string, value: string, cls = '') => `<div class="row ${cls}"><span>${label}</span><span>${value}</span></div>`;

  const title = doc.kind === 'credit_note' ? L.creditNote : doc.vat_registered ? L.taxInvoice : L.invoice;
  const isInvoice = doc.kind !== 'credit_note';

  const head: string[] = [];
  if (tpl.showLogo && logoUrl) head.push(`<img class="logo" src="${escapeHtml(logoUrl)}" alt="">`);
  head.push(pair(doc.seller_name, doc.seller_name_ar, 'c b lg'));
  if (doc.seller_legal_name && !thermal) head.push(`<div class="c sm">${escapeHtml(doc.seller_legal_name)}</div>`);
  head.push(pair(tpl.headerEn, tpl.headerAr, 'c pre'));
  head.push(pair(doc.branch_name, doc.branch_name_ar, 'c'));
  if (doc.branch_address) head.push(`<div class="c sm">${escapeHtml(doc.branch_address)}</div>`);
  if (doc.branch_phone) head.push(`<div class="c">${ltr(doc.branch_phone)}</div>`);
  if (doc.vat_number) head.push(`<div class="c">${lbl(L.vatNo)}: ${ltr(doc.vat_number)}</div>`);

  const meta: string[] = [`<div class="c b ${thermal ? 'lg' : 'xl'}">${lbl(title)}</div>`];
  if (doc.number) meta.push(row(lbl(L.number), ltr(doc.number)));
  if (doc.issued_at) meta.push(row(lbl(L.date), ltr(formatDate(doc.issued_at, tpl.timezone))));
  meta.push(row(lbl(L.customer), doc.customer_name ? escapeHtml(doc.customer_name) : lbl(L.walkIn)));
  if (doc.customer_mobile) meta.push(row('', ltr(doc.customer_mobile)));
  if (doc.original) meta.push(row(lbl(L.forInvoice), ltr(doc.original.number)));
  if (doc.reason) meta.push(row(lbl(L.reason), escapeHtml(doc.reason)));

  let items: string;
  if (thermal) {
    items = doc.items
      .map(
        (it) =>
          `<div class="it">${pair(it.description_en, it.description_ar, '', true)}` +
          row(`<span class="n" dir="ltr">${qty(it.quantity)} × ${Number(it.unit_price).toFixed(tpl.decimals)}</span>`, money(it.total_amount)) +
          (it.discount_amount > 0 ? row(`<span class="sm">${lbl(L.discount)}</span>`, `<span class="sm">${money(it.discount_amount, '−')}</span>`) : '') +
          `</div>`,
      )
      .join('');
  } else {
    items =
      `<table><thead><tr><th>${lbl(L.item)}</th><th class="e">${lbl(L.qty)}</th><th class="e">${lbl(L.price)}</th><th class="e">${lbl(L.vat)}</th><th class="e">${lbl(L.amount)}</th></tr></thead><tbody>` +
      doc.items
        .map(
          (it) =>
            `<tr><td>${pair(it.description_en, it.description_ar, '', true)}${it.discount_amount > 0 ? `<div class="sm">${lbl(L.discount)} ${money(it.discount_amount, '−')}</div>` : ''}</td>` +
            `<td class="e n">${qty(it.quantity)}</td><td class="e">${money(it.unit_price)}</td>` +
            `<td class="e"><span class="n" dir="ltr">${qty(it.vat_rate)}%</span> · ${money(it.vat_amount)}</td><td class="e">${money(it.total_amount)}</td></tr>`,
        )
        .join('') +
      `</tbody></table>`;
  }

  const sums: string[] = [];
  if (doc.discount_total > 0) sums.push(row(lbl(L.discount), money(doc.discount_total, '−')));
  sums.push(row(lbl(L.subtotal), money(doc.subtotal)));
  sums.push(row(lbl(L.vat), money(doc.vat_total)));
  sums.push(row(lbl(L.total), moneyCur(doc.total), 'tot'));
  if (isInvoice) {
    if (doc.credited_total > 0) sums.push(row(lbl(L.credited), money(doc.credited_total, '−')));
    sums.push(row(lbl(L.paid), money(doc.paid_total - doc.refunded_total)));
    if (doc.balance_due > 0) sums.push(row(lbl(L.balance), money(doc.balance_due), 'b'));
  } else if (doc.paid_total > 0) {
    sums.push(row(lbl(L.refunded), money(doc.paid_total)));
  }

  const pays = doc.payments
    .map((p) => {
      const m = METHODS[p.method] ?? OTHER_METHOD;
      const label = `<span class="g"><span>${lbl(m)}</span>${p.reference ? ltr(p.reference) : ''}</span>`;
      return row(label, money(p.amount, p.direction === 'out' ? '−' : ''), 'sm');
    })
    .join('');

  const foot: string[] = [];
  if (doc.vat_registered) foot.push(`<div class="c sm">${lbl(doc.prices_include_vat ? L.vatIncluded : L.vatExcluded)}</div>`);
  foot.push(pair(doc.footer_en, doc.footer_ar, 'c pre'));

  const page = thermal ? '@page{margin:0}' : '@page{size:A4;margin:12mm}';
  const cls = tpl.paper === '80mm' ? 'p80' : tpl.paper === '58mm' ? 'p58' : 'pa4';
  return (
    `<!doctype html><html lang="${rtl ? 'ar' : 'en'}" dir="${rtl ? 'rtl' : 'ltr'}"><head><meta charset="utf-8">` +
    `<title>${escapeHtml(doc.number ?? '')}</title><style>${page}${CSS}</style></head>` +
    `<body class="${cls}">` +
    head.join('') +
    `<hr>` +
    meta.join('') +
    `<hr>` +
    items +
    (thermal ? `<hr>` : '') +
    `<div class="${thermal ? '' : 'sum'}">${sums.join('')}</div>` +
    (pays ? `<hr><div class="${thermal ? '' : 'sum'}">${pays}</div>` : '') +
    (foot.join('') ? `<hr>${foot.join('')}` : '') +
    `</body></html>`
  );
}

function formatDate(iso: string, timeZone: string): string {
  const opts: Intl.DateTimeFormatOptions = { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false };
  try {
    return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat('en-GB', opts).format(new Date(iso));
  }
}

/** Replace a frame's document (settings preview and printing). */
export function writeFrame(frame: HTMLIFrameElement, html: string): Document | null {
  const d = frame.contentDocument;
  if (!d) return null;
  d.open();
  d.write(html);
  d.close();
  return d;
}

/**
 * Print an HTML document without opening it: it is written to an off-screen
 * frame and that frame is printed. Whether the browser's print dialog appears
 * is up to the browser — started with `--kiosk-printing` (Chrome / Edge) it
 * prints to the default printer immediately.
 */
export function printHtml(html: string): Promise<void> {
  return new Promise((resolve) => {
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:0;height:0;border:0';
    document.body.appendChild(frame);
    const win = frame.contentWindow;
    const d = writeFrame(frame, html);
    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      frame.remove();
      resolve();
    };
    if (!win || !d) return cleanup();

    const images = Array.from(d.images).filter((img) => !img.complete);
    const loaded = Promise.all(images.map((img) => new Promise<void>((r) => { img.onload = img.onerror = () => r(); })));
    const cap = new Promise<void>((r) => setTimeout(r, 3000));
    void Promise.race([loaded, cap]).then(() => {
      win.addEventListener('afterprint', () => setTimeout(cleanup, 500));
      setTimeout(cleanup, 120_000); // browsers that never fire afterprint
      try {
        win.focus();
        win.print();
      } catch {
        cleanup();
      }
    });
  });
}

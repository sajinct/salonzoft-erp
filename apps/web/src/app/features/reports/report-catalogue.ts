import { ReportKey } from './data/reports.service';

export type ColType = 'date' | 'datetime' | 'month' | 'text' | 'name' | 'int' | 'qty' | 'money' | 'rate' | 'rating' | 'bool' | 'enum';

export interface ReportColumn {
  key: string;
  type: ColType;
  /** Translation key suffix: reports.col.<label>. Defaults to the column key. */
  label?: string;
  /** Sum in the totals row. */
  sum?: boolean;
  /** 'name' columns: the Arabic counterpart column. */
  ar?: string;
  /** 'enum' columns: translation prefix for values. */
  prefix?: string;
}

export interface ReportDef {
  key: ReportKey;
  group: 'financial' | 'operational';
  icon: string;
  /** Permission set: any of these. */
  permissions: string[];
  /** Additionally required. */
  requires?: string;
  columns: ReportColumn[];
}

const money = (key: string, sum = true): ReportColumn => ({ key, type: 'money', sum });
const int = (key: string, sum = true): ReportColumn => ({ key, type: 'int', sum });
const FIN = ['reports.financial'];
const OPS = ['reports.view', 'reports.financial'];

export const REPORTS: ReportDef[] = [
  {
    key: 'sales_daily', group: 'financial', icon: 'chart-column', permissions: FIN,
    columns: [
      { key: 'date', type: 'date' }, int('invoices'), money('discounts'), money('credit_notes'), money('net_sales'), money('vat'), money('total'),
      { key: 'cash', type: 'money', sum: true, label: 'cash' }, money('card'), money('bank_transfer'), money('other'),
    ],
  },
  {
    key: 'vat', group: 'financial', icon: 'receipt', permissions: FIN,
    columns: [
      { key: 'month', type: 'month' }, { key: 'vat_category', type: 'enum', prefix: 'reports.vatCategory.' }, { key: 'vat_rate', type: 'rate' },
      money('sales_net'), money('sales_vat'), money('credits_net'), money('credits_vat'), money('taxable'), money('vat_due'),
    ],
  },
  {
    key: 'invoices', group: 'financial', icon: 'clipboard-list', permissions: FIN,
    columns: [
      { key: 'number', type: 'text' }, { key: 'issued_at', type: 'datetime' }, { key: 'kind', type: 'enum', prefix: 'reports.kind.' },
      { key: 'branch', type: 'text' }, { key: 'customer_name', type: 'text', label: 'customer' }, { key: 'original_number', type: 'text' },
      money('subtotal', false), money('vat', false), money('total', false), money('paid_total', false), money('balance', false),
      { key: 'payment_status', type: 'enum', prefix: 'pos.paymentStatus.' },
    ],
  },
  {
    key: 'payments', group: 'financial', icon: 'wallet', permissions: FIN,
    columns: [
      { key: 'received_at', type: 'datetime' }, { key: 'invoice_number', type: 'text' }, { key: 'branch', type: 'text' },
      { key: 'method', type: 'enum', prefix: 'pos.method.' }, money('amount'), { key: 'reference', type: 'text' },
    ],
  },
  {
    key: 'services', group: 'operational', icon: 'scissors', permissions: OPS,
    columns: [{ key: 'name_en', type: 'name', ar: 'name_ar', label: 'service' }, { key: 'quantity', type: 'qty', sum: true }, int('from_packages'), money('revenue'), money('average', false)],
  },
  {
    key: 'staff', group: 'operational', icon: 'users', permissions: OPS,
    columns: [
      { key: 'name_en', type: 'name', ar: 'name_ar', label: 'employee' }, { key: 'services', type: 'qty', sum: true }, money('service_revenue'),
      money('product_revenue'), int('appointments'), int('no_shows'), { key: 'rating', type: 'rating' }, int('ratings'),
    ],
  },
  {
    key: 'products', group: 'operational', icon: 'package', permissions: OPS,
    columns: [{ key: 'sku', type: 'text' }, { key: 'name_en', type: 'name', ar: 'name_ar', label: 'product' }, { key: 'quantity', type: 'qty', sum: true }, money('revenue'), money('cost'), money('margin')],
  },
  {
    key: 'appointments', group: 'operational', icon: 'calendar-days', permissions: OPS,
    columns: [{ key: 'date', type: 'date' }, int('total'), int('completed'), int('cancelled'), int('no_show'), int('online'), int('walk_in'), int('customers', false)],
  },
  {
    key: 'customers', group: 'operational', icon: 'user-round', permissions: OPS, requires: 'customers.view',
    columns: [
      { key: 'name', type: 'name', ar: 'name_ar', label: 'customer' }, { key: 'mobile', type: 'text' }, int('visits'), money('spend'),
      money('average', false), { key: 'last_visit', type: 'date' }, { key: 'is_new', type: 'bool' },
    ],
  },
];

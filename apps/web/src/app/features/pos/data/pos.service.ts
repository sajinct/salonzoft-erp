import { Injectable, inject } from '@angular/core';
import { Tables } from '../../../core/supabase/database.types';
import { unwrap } from '../../../core/supabase/app-error';
import { SUPABASE } from '../../../core/supabase/supabase.client';

export type InvoiceRow = Tables<'invoices'>;
export type InvoiceItem = Tables<'invoice_items'>;
export type Payment = Tables<'payments'>;
export type CashSession = Tables<'cash_sessions'>;
export type PaymentMethod = 'cash' | 'card' | 'bank_transfer' | 'voucher' | 'other';
export const PAYMENT_METHODS: PaymentMethod[] = ['cash', 'card', 'bank_transfer', 'voucher', 'other'];

/** Full document as returned by get_invoice / save_invoice_draft / finalize_invoice. */
export interface InvoiceDoc extends InvoiceRow {
  balance_due: number;
  items: InvoiceItem[];
  payments: Payment[];
  credit_notes: { id: string; number: string; issued_at: string; total: number; reason: string | null }[];
  original: { id: string; number: string } | null;
}

/** A cart line as sent to save_invoice_draft. Prices are decided by the server. */
export interface CartLine {
  kind: 'service' | 'custom' | 'package' | 'membership' | 'voucher' | 'product';
  product_id?: string;
  package_id?: string;
  membership_id?: string;
  /** Service line paid with a session of this customer package. */
  customer_package_id?: string | null;
  /** Voucher line sold as a deposit for this appointment. */
  appointment_id?: string | null;
  service_id?: string;
  employee_id?: string | null;
  appointment_service_id?: string | null;
  description?: string;
  quantity: number;
  unit_price?: number | null;
  discount_amount?: number;
}

export interface WalletVoucher {
  id: string;
  kind: 'gift' | 'store_credit' | 'deposit';
  balance: number;
  initial_amount: number;
  expires_at: string | null;
  appointment_id: string | null;
  code: string | null;
}

export interface Wallet {
  packages: {
    id: string;
    name_en: string;
    name_ar: string | null;
    expires_at: string | null;
    balances: { service_id: string; service_name_en: string; service_name_ar: string | null; total: number; remaining: number }[];
  }[];
  membership: { name_en: string; name_ar: string | null; discount_percent: number; ends_at: string } | null;
  vouchers: WalletVoucher[];
  loyalty: { points: number; point_value: number; min_redeem: number } | null;
}

export interface SalesSummary {
  invoices: number;
  gross_sales: number;
  vat: number;
  by_method: Partial<Record<PaymentMethod, number>>;
  outstanding: number;
}

@Injectable({ providedIn: 'root' })
export class PosService {
  private readonly sb = inject(SUPABASE);

  async createDraft(tenantId: string, branchId: string, opts: { customerId?: string | null; appointmentId?: string | null; key?: string } = {}): Promise<string> {
    const res = unwrap(
      await this.sb.rpc('create_invoice_draft', {
        p_tenant: tenantId,
        p_branch_id: branchId,
        p_customer_id: opts.customerId ?? undefined,
        p_appointment_id: opts.appointmentId ?? undefined,
        p_idempotency_key: opts.key,
      }),
    ) as unknown as { invoice_id: string };
    return res.invoice_id;
  }

  async get(invoiceId: string): Promise<InvoiceDoc> {
    return unwrap(await this.sb.rpc('get_invoice', { p_invoice_id: invoiceId })) as unknown as InvoiceDoc;
  }

  async save(invoiceId: string, customerId: string | null, lines: CartLine[], notes: string | null): Promise<InvoiceDoc> {
    return unwrap(
      await this.sb.rpc('save_invoice_draft', {
        p_invoice_id: invoiceId,
        p_customer_id: customerId as string,
        p_items: lines as unknown as never,
        p_notes: notes ?? undefined,
      }),
    ) as unknown as InvoiceDoc;
  }

  async finalize(invoiceId: string): Promise<InvoiceDoc> {
    return unwrap(await this.sb.rpc('finalize_invoice', { p_invoice_id: invoiceId })) as unknown as InvoiceDoc;
  }

  async discard(invoiceId: string): Promise<void> {
    unwrap(await this.sb.rpc('void_invoice_draft', { p_invoice_id: invoiceId }));
  }

  async pay(invoiceId: string, method: PaymentMethod, amount: number, reference: string | null, key: string): Promise<{ balance_due: number; payment_status: string }> {
    return unwrap(
      await this.sb.rpc('record_payment', { p_invoice_id: invoiceId, p_method: method, p_amount: amount, p_reference: reference ?? undefined, p_idempotency_key: key }),
    ) as unknown as { balance_due: number; payment_status: string };
  }

  async creditNote(invoiceId: string, items: { item_id: string; quantity: number }[] | null, reason: string, refundMethod: PaymentMethod | null, key: string) {
    return unwrap(
      await this.sb.rpc('create_credit_note', {
        p_invoice_id: invoiceId,
        p_items: items as unknown as never,
        p_reason: reason,
        p_refund_method: refundMethod ?? undefined,
        p_idempotency_key: key,
      }),
    ) as unknown as { credit_note_id: string; number: string; total: number; refunded: number; store_credit_code: string | null };
  }

  async list(tenantId: string, opts: { from: Date; branchId: string | null; status: 'all' | 'unpaid' | 'drafts' }): Promise<InvoiceRow[]> {
    let query = this.sb.from('invoices').select('*').eq('tenant_id', tenantId).order('created_at', { ascending: false }).limit(200);
    if (opts.branchId) query = query.eq('branch_id', opts.branchId);
    if (opts.status === 'drafts') query = query.eq('status', 'draft');
    else {
      query = query.eq('status', 'posted').gte('issued_at', opts.from.toISOString());
      if (opts.status === 'unpaid') query = query.eq('kind', 'invoice').neq('payment_status', 'paid');
    }
    return unwrap(await query);
  }

  async openSession(branchId: string): Promise<CashSession | null> {
    const rows = unwrap(await this.sb.from('cash_sessions').select('*').eq('branch_id', branchId).eq('status', 'open').limit(1));
    return rows[0] ?? null;
  }

  async openCash(branchId: string, float: number): Promise<void> {
    unwrap(await this.sb.rpc('open_cash_session', { p_branch_id: branchId, p_opening_float: float }));
  }

  async closeCash(sessionId: string, counted: number, notes: string | null): Promise<{ expected_cash: number; counted_cash: number; variance: number }> {
    return unwrap(
      await this.sb.rpc('close_cash_session', { p_session_id: sessionId, p_counted_cash: counted, p_notes: notes ?? undefined }),
    ) as unknown as { expected_cash: number; counted_cash: number; variance: number };
  }

  async wallet(customerId: string): Promise<Wallet> {
    return unwrap(await this.sb.rpc('get_customer_wallet', { p_customer_id: customerId })) as unknown as Wallet;
  }

  async lookupVoucher(tenantId: string, code: string): Promise<{ code: string; balance: number; status: string; expires_at: string | null }> {
    return unwrap(await this.sb.rpc('lookup_voucher', { p_tenant: tenantId, p_code: code })) as unknown as { code: string; balance: number; status: string; expires_at: string | null };
  }

  async summary(tenantId: string, branchId: string | null): Promise<SalesSummary> {
    return unwrap(await this.sb.rpc('get_sales_summary', { p_tenant: tenantId, p_branch_id: branchId ?? undefined })) as unknown as SalesSummary;
  }
}

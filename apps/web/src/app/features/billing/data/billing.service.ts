import { Injectable, inject } from '@angular/core';
import { Tables } from '../../../core/supabase/database.types';
import { unwrap } from '../../../core/supabase/app-error';
import { SUPABASE } from '../../../core/supabase/supabase.client';

export type SubscriptionInvoice = Tables<'subscription_invoices'>;
export type Cycle = 'monthly' | 'yearly';

export interface PlanOption {
  code: string;
  name_en: string;
  name_ar: string;
  description_en: string | null;
  description_ar: string | null;
  currency_code: string;
  price_monthly: number;
  price_yearly: number;
  max_branches: number | null;
  max_staff: number | null;
  max_monthly_messages: number | null;
  modules: string[];
}

export interface BillingOverview {
  subscription: {
    status: 'trialing' | 'active' | 'past_due' | 'suspended' | 'cancelled' | 'expired';
    billing_cycle: Cycle;
    trial_ends_at: string | null;
    current_period_start: string | null;
    current_period_end: string | null;
    cancel_at_period_end: boolean;
    plan_code: string;
    scheduled_plan_code: string | null;
    scheduled_cycle: Cycle | null;
  } | null;
  usage: { branches: number; staff: number; messages: number };
  plans: PlanOption[];
  invoices: SubscriptionInvoice[];
  payment: { company: string; vat_number: string | null; vat_rate: number; bank_details: string | null };
}

export type PrintableInvoice = SubscriptionInvoice & { bank_details: string | null; tenant_slug: string };

export interface ModuleInfo {
  code: string;
  name_en: string;
  name_ar: string;
  is_core: boolean;
}

@Injectable({ providedIn: 'root' })
export class BillingService {
  private readonly sb = inject(SUPABASE);

  async overview(tenantId: string): Promise<BillingOverview> {
    return unwrap(await this.sb.rpc('get_billing_overview', { p_tenant: tenantId })) as unknown as BillingOverview;
  }

  async modules(): Promise<ModuleInfo[]> {
    return unwrap(await this.sb.from('modules').select('code, name_en, name_ar, is_core').order('sort_order'));
  }

  async requestChange(tenantId: string, plan: string, cycle: Cycle): Promise<{ scheduled: boolean; effective_at?: string; number?: string; invoice_id?: string }> {
    return unwrap(await this.sb.rpc('request_plan_change', { p_tenant: tenantId, p_plan_code: plan, p_cycle: cycle })) as unknown as {
      scheduled: boolean;
      effective_at?: string;
      number?: string;
      invoice_id?: string;
    };
  }

  async cancelPending(tenantId: string): Promise<void> {
    unwrap(await this.sb.rpc('cancel_pending_change', { p_tenant: tenantId }));
  }

  async setCancelAtPeriodEnd(tenantId: string, cancel: boolean): Promise<void> {
    unwrap(await this.sb.rpc('set_cancel_at_period_end', { p_tenant: tenantId, p_cancel: cancel }));
  }

  async invoice(id: string): Promise<PrintableInvoice> {
    return unwrap(await this.sb.rpc('get_subscription_invoice', { p_invoice: id })) as unknown as PrintableInvoice;
  }
}

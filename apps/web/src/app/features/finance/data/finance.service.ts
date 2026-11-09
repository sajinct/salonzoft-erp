import { Injectable, inject } from '@angular/core';
import { Database, Tables, TablesInsert } from '../../../core/supabase/database.types';
import { unwrap } from '../../../core/supabase/app-error';
import { SUPABASE } from '../../../core/supabase/supabase.client';

export type CommissionRule = Tables<'commission_rules'>;
export type CommissionRuleInput = Omit<TablesInsert<'commission_rules'>, 'id' | 'tenant_id' | 'created_at' | 'updated_at'>;
export type CommissionRow = Database['public']['Functions']['get_commission_report']['Returns'][number];
export type ExpenseCategory = Tables<'expense_categories'>;
export type Expense = Tables<'expenses'>;

export interface FinanceSummary {
  revenue: number;
  vat_collected: number;
  cost_of_goods: number;
  products_used: number;
  gross_profit: number;
  commissions: number;
  expenses: number;
  vat_paid: number;
  net_profit: number;
  expenses_by_category: { category_id: string; name_en: string; name_ar: string | null; amount: number }[];
}

export interface ExpenseInput {
  branchId: string;
  categoryId: string;
  date: string;
  amount: number;
  vat: number;
  description: string;
  method: string;
  fromDrawer: boolean;
  reference: string | null;
}

@Injectable({ providedIn: 'root' })
export class FinanceService {
  private readonly sb = inject(SUPABASE);

  async summary(tenantId: string, from: string, to: string, branchId: string | null): Promise<FinanceSummary> {
    return unwrap(await this.sb.rpc('get_finance_summary', { p_tenant: tenantId, p_from: from, p_to: to, p_branch_id: branchId ?? undefined })) as unknown as FinanceSummary;
  }

  // ---- commissions -----------------------------------------------------------
  async commissionReport(tenantId: string, from: string, to: string, branchId: string | null): Promise<CommissionRow[]> {
    return unwrap(await this.sb.rpc('get_commission_report', { p_tenant: tenantId, p_from: from, p_to: to, p_branch_id: branchId ?? undefined })) ?? [];
  }

  async payCommissions(tenantId: string, employeeId: string, upTo: string, method: string, reference: string | null): Promise<{ total: number }> {
    return unwrap(
      await this.sb.rpc('pay_commissions', { p_tenant: tenantId, p_employee_id: employeeId, p_up_to: upTo, p_method: method, p_reference: reference ?? undefined }),
    ) as unknown as { total: number };
  }

  async rules(tenantId: string): Promise<CommissionRule[]> {
    return unwrap(await this.sb.from('commission_rules').select('*').eq('tenant_id', tenantId).order('created_at'));
  }

  async saveRule(tenantId: string, id: string | null, input: CommissionRuleInput): Promise<void> {
    if (id) unwrap(await this.sb.from('commission_rules').update(input).eq('id', id).select('*').single());
    else unwrap(await this.sb.from('commission_rules').insert({ ...input, tenant_id: tenantId }).select('*').single());
  }

  async deleteRule(id: string): Promise<void> {
    unwrap(await this.sb.from('commission_rules').delete().eq('id', id));
  }

  // ---- expenses --------------------------------------------------------------
  async categories(tenantId: string): Promise<ExpenseCategory[]> {
    return unwrap(await this.sb.from('expense_categories').select('*').eq('tenant_id', tenantId).order('sort_order').order('name_en'));
  }

  async addCategory(tenantId: string, nameEn: string, nameAr: string | null): Promise<ExpenseCategory> {
    return unwrap(await this.sb.from('expense_categories').insert({ tenant_id: tenantId, name_en: nameEn, name_ar: nameAr }).select('*').single());
  }

  async expenses(tenantId: string, from: string, to: string, branchId: string | null): Promise<Expense[]> {
    let query = this.sb.from('expenses').select('*').eq('tenant_id', tenantId).gte('expense_date', from).lte('expense_date', to).order('expense_date', { ascending: false }).limit(300);
    if (branchId) query = query.eq('branch_id', branchId);
    return unwrap(await query);
  }

  async recordExpense(e: ExpenseInput): Promise<{ status: string }> {
    return unwrap(
      await this.sb.rpc('record_expense', {
        p_branch_id: e.branchId,
        p_category_id: e.categoryId,
        p_date: e.date,
        p_amount: e.amount,
        p_vat_amount: e.vat,
        p_description: e.description,
        p_method: e.method,
        p_from_drawer: e.fromDrawer,
        p_reference: e.reference ?? undefined,
      }),
    ) as unknown as { status: string };
  }

  async reviewExpense(id: string, approve: boolean, reason: string | null): Promise<void> {
    unwrap(await this.sb.rpc('review_expense', { p_expense_id: id, p_approve: approve, p_reason: reason ?? undefined }));
  }

  // ---- loyalty -----------------------------------------------------------------
  async redeemPoints(customerId: string, points: number): Promise<{ code: string; amount: number }> {
    return unwrap(await this.sb.rpc('redeem_loyalty_points', { p_customer_id: customerId, p_points: points })) as unknown as { code: string; amount: number };
  }
}

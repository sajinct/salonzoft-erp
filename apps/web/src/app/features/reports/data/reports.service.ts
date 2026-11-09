import { Injectable, inject } from '@angular/core';
import { unwrap } from '../../../core/supabase/app-error';
import { SUPABASE } from '../../../core/supabase/supabase.client';

export type ReportKey = 'sales_daily' | 'vat' | 'invoices' | 'payments' | 'services' | 'staff' | 'products' | 'appointments' | 'customers';
export type ReportRow = Record<string, string | number | boolean | null>;

export interface ReportResult {
  report: ReportKey;
  from: string;
  to: string;
  timezone: string;
  truncated: boolean;
  rows: ReportRow[];
}

@Injectable({ providedIn: 'root' })
export class ReportsService {
  private readonly sb = inject(SUPABASE);

  async run(tenantId: string, report: ReportKey, from: string, to: string, branchId: string | null): Promise<ReportResult> {
    return unwrap(
      await this.sb.rpc('run_report', { p_tenant: tenantId, p_report: report, p_from: from, p_to: to, p_branch: branchId as string }),
    ) as unknown as ReportResult;
  }

  async logExport(tenantId: string, report: ReportKey, from: string, to: string, branchId: string | null, rows: number): Promise<void> {
    unwrap(
      await this.sb.rpc('log_report_export', { p_tenant: tenantId, p_report: report, p_from: from, p_to: to, p_branch: branchId as string, p_rows: rows }),
    );
  }
}

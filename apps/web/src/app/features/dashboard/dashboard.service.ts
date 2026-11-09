import { Injectable, inject } from '@angular/core';
import { unwrap } from '../../core/supabase/app-error';
import { SUPABASE } from '../../core/supabase/supabase.client';

/** Shape of public.get_dashboard_summary (Phase 1). Extended as modules ship. */
export interface DashboardSummary {
  generated_at: string;
  timezone: string;
  currency_code: string;
  operational: boolean;
  subscription: {
    status: string;
    plan_code: string;
    plan_name_en: string;
    plan_name_ar: string;
    trial_ends_at: string | null;
    trial_days_left: number | null;
    max_branches: number | null;
    max_staff: number | null;
  } | null;
  branches: { total: number; active: number };
  team: { active_members: number; pending_invitations: number } | null;
  setup: Record<'business_profile' | 'vat_configured' | 'logo_uploaded' | 'working_hours' | 'team_invited', boolean>;
}

@Injectable({ providedIn: 'root' })
export class DashboardService {
  private readonly sb = inject(SUPABASE);

  async summary(tenantId: string, branchId: string | null): Promise<DashboardSummary> {
    const data = unwrap(
      await this.sb.rpc('get_dashboard_summary', { p_tenant: tenantId, ...(branchId ? { p_branch_id: branchId } : {}) }),
    );
    return data as unknown as DashboardSummary;
  }
}

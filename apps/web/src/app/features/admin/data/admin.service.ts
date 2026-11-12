import { Injectable, computed, inject, signal } from '@angular/core';
import { unwrap } from '../../../core/supabase/app-error';
import { SUPABASE } from '../../../core/supabase/supabase.client';
import { environment } from '../../../../environments/environment';
import { Cycle, SubscriptionInvoice } from '../../billing/data/billing.service';

export type AdminRole = 'admin' | 'billing' | 'support';
export type TenantFilter = 'all' | 'trialing' | 'expired' | 'active' | 'past_due' | 'suspended' | 'cancelled' | 'tenant_suspended' | 'closed';

export interface AdminOverview {
  tenants: { total: number; operational: number; trialing: number; trial_expired: number; paying: number; past_due: number; suspended: number; new_30d: number };
  mrr: number;
  collected_month: number;
  open_invoices: { count: number; total: number; overdue: number };
  conversion: { eligible: number; converted: number };
  plans: { code: string; name_en: string; name_ar: string; trialing: number; paying: number }[];
  months: { month: string; signups: number; revenue: number }[];
  activity: { appointments_30d: number; sales_30d: number; invoices_30d: number; messages_month: number };
  expiring_trials: { id: string; name: string; slug: string; trial_ends_at: string }[];
  recent_signups: { id: string; name: string; slug: string; created_at: string }[];
}

export interface TenantRow {
  id: string;
  slug: string;
  name: string;
  name_ar: string | null;
  status: 'active' | 'suspended' | 'closed';
  created_at: string;
  sub_status: string | null;
  billing_cycle: Cycle | null;
  trial_ends_at: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean | null;
  plan_code: string | null;
  plan_name_en: string | null;
  plan_name_ar: string | null;
  mrr: number;
  owner_email: string | null;
  branches: number;
  staff: number;
  last_activity: string | null;
}

export interface TenantDetail {
  tenant: { id: string; slug: string; name: string; name_ar: string | null; legal_name: string | null; business_type: string; status: string; created_at: string };
  settings: { default_language: string; timezone: string; vat_registered: boolean; vat_number: string | null; currency_code: string } | null;
  subscription: {
    id: string;
    status: string;
    billing_cycle: Cycle;
    trial_ends_at: string | null;
    current_period_start: string | null;
    current_period_end: string | null;
    cancel_at_period_end: boolean;
    plan_code: string;
    plan_name_en: string;
    plan_name_ar: string;
    scheduled_plan_code: string | null;
    scheduled_cycle: Cycle | null;
    operational: boolean;
  } | null;
  usage: { branches: number; staff: number; members: number; customers: number; appointments_30d: number; sales_30d: number; messages_month: number; last_activity: string | null };
  modules: { code: string; name_en: string; name_ar: string; is_core: boolean; enabled: boolean; source: string | null; is_enabled: boolean | null; valid_until: string | null }[];
  roles: TenantRole[];
  branches: TenantBranch[];
  members: TenantMember[];
  invitations: { id: string; email: string; make_owner: boolean; expires_at: string; created_at: string }[];
  invoices: SubscriptionInvoice[];
  history: { action: string; data: Record<string, unknown>; created_at: string; actor: string | null }[];
}

export interface TenantRole { id: string; code: string; name_en: string; name_ar: string | null }
export interface TenantBranch { id: string; code: string; name_en: string; name_ar: string | null; is_main: boolean; is_active: boolean }
export interface TenantMember {
  membership_id: string;
  user_id: string;
  email: string;
  full_name: string | null;
  is_owner: boolean;
  status: 'active' | 'suspended';
  job_title: string | null;
  all_branches: boolean;
  joined_at: string;
  role_ids: string[];
  branch_ids: string[];
}

/** One-time invitation link for a person who has no account yet. */
export interface AdminInvitation { invitation_id: string; token: string; email: string; expires_at: string; url: string }

export interface NewTenantInput { name: string; slug: string; ownerEmail: string; businessType: string; language: string; planCode: string }
export interface MemberAccessInput { roleIds: string[]; allBranches: boolean; branchIds: string[]; jobTitle: string | null }
export type TenantPatch = Partial<Record<'name' | 'name_ar' | 'legal_name' | 'business_type' | 'slug', string>>;

type RawInvitation = Omit<AdminInvitation, 'url'> | null;
const withUrl = (inv: RawInvitation): AdminInvitation | null =>
  inv ? { ...inv, url: `${environment.appUrl}/accept-invite?token=${inv.token}` } : null;

export type AdminInvoice = SubscriptionInvoice & { tenant_name: string; tenant_slug: string };

export interface AdminPlan {
  id: string;
  code: string;
  name_en: string;
  name_ar: string;
  description_en: string | null;
  description_ar: string | null;
  price_monthly: number;
  price_yearly: number | null;
  max_branches: number | null;
  max_staff: number | null;
  max_monthly_messages: number | null;
  trial_days: number;
  is_public: boolean;
  is_active: boolean;
  sort_order: number;
  modules: string[];
  subscribers: number;
}

export interface PlatformAdmin {
  user_id: string;
  email: string;
  full_name: string | null;
  role: AdminRole;
  created_at: string;
}

export type BillingSettings = Record<'billing_company' | 'billing_vat_number' | 'billing_vat_rate' | 'billing_bank_details' | 'billing_suspend_after_days', string>;

@Injectable({ providedIn: 'root' })
export class AdminService {
  private readonly sb = inject(SUPABASE);

  /** The caller's platform role (null = not a platform admin). Drives UI only; every RPC re-checks. */
  readonly role = signal<AdminRole | null>(null);
  readonly canBilling = computed(() => this.role() === 'admin' || this.role() === 'billing');
  readonly canSupport = computed(() => this.role() === 'admin' || this.role() === 'support');
  readonly isAdmin = computed(() => this.role() === 'admin');

  private async rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
    // The admin RPCs return jsonb; the generated types add nothing here.
    const call = this.sb.rpc.bind(this.sb) as unknown as (f: string, a?: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
    return unwrap(await call(fn, args)) as T;
  }

  async whoami(): Promise<AdminRole | null> {
    const r = await this.rpc<{ role: AdminRole | null }>('admin_whoami');
    this.role.set(r.role);
    return r.role;
  }

  overview(): Promise<AdminOverview> {
    return this.rpc('admin_overview');
  }

  tenants(search: string, filter: TenantFilter, limit: number, offset: number): Promise<{ total: number; rows: TenantRow[] }> {
    return this.rpc('admin_list_tenants', { p_search: search || null, p_filter: filter, p_limit: limit, p_offset: offset });
  }

  tenant(id: string): Promise<TenantDetail> {
    return this.rpc('admin_get_tenant', { p_tenant: id });
  }

  /** Provision a business. The owner is added directly if the e-mail has an account, otherwise an invitation link comes back. */
  async createTenant(input: NewTenantInput): Promise<{ tenant_id: string; slug: string; owner_added: boolean; invitation: AdminInvitation | null }> {
    const r = await this.rpc<{ tenant_id: string; slug: string; owner_added: boolean; invitation: RawInvitation }>('admin_create_tenant', {
      p_name: input.name, p_slug: input.slug, p_owner_email: input.ownerEmail, p_business_type: input.businessType,
      p_default_language: input.language, p_plan_code: input.planCode,
    });
    return { ...r, invitation: withUrl(r.invitation) };
  }

  updateTenant(id: string, patch: TenantPatch): Promise<void> {
    return this.rpc('admin_update_tenant', { p_tenant: id, p_patch: patch });
  }

  async addMember(id: string, email: string, access: MemberAccessInput, owner = false): Promise<{ added: boolean; email: string; invitation: AdminInvitation | null }> {
    const r = await this.rpc<{ added: boolean; email: string; invitation: RawInvitation }>('admin_add_member', {
      p_tenant: id, p_email: email, p_role_ids: access.roleIds, p_all_branches: access.allBranches,
      p_branch_ids: access.allBranches ? [] : access.branchIds, p_job_title: access.jobTitle, p_owner: owner,
    });
    return { ...r, invitation: withUrl(r.invitation) };
  }

  updateMember(membershipId: string, access: MemberAccessInput): Promise<void> {
    return this.rpc('admin_update_member', {
      p_membership_id: membershipId, p_role_ids: access.roleIds, p_all_branches: access.allBranches,
      p_branch_ids: access.allBranches ? [] : access.branchIds, p_job_title: access.jobTitle ?? '',
    });
  }

  setMemberStatus(membershipId: string, status: 'active' | 'suspended'): Promise<void> {
    return this.rpc('admin_set_member_status', { p_membership_id: membershipId, p_status: status });
  }

  transferOwnership(id: string, membershipId: string): Promise<void> {
    return this.rpc('admin_transfer_ownership', { p_tenant: id, p_membership_id: membershipId });
  }

  revokeInvitation(invitationId: string): Promise<void> {
    return this.rpc('admin_revoke_invitation', { p_invitation_id: invitationId });
  }

  setTenantStatus(id: string, status: string, reason: string | null): Promise<void> {
    return this.rpc('admin_set_tenant_status', { p_tenant: id, p_status: status, p_reason: reason });
  }

  extendTrial(id: string, days: number): Promise<string> {
    return this.rpc('admin_extend_trial', { p_tenant: id, p_days: days });
  }

  assignPlan(id: string, plan: string, cycle: Cycle, periodEnd: string | null): Promise<void> {
    return this.rpc('admin_assign_plan', { p_tenant: id, p_plan_code: plan, p_cycle: cycle, p_period_end: periodEnd });
  }

  setModule(id: string, module: string, enabled: boolean | null, validUntil: string | null): Promise<void> {
    return this.rpc('admin_set_module', { p_tenant: id, p_module: module, p_enabled: enabled, p_valid_until: validUntil });
  }

  createInvoice(id: string, plan: string, cycle: Cycle, kind: string): Promise<{ number: string }> {
    return this.rpc('admin_create_invoice', { p_tenant: id, p_plan_code: plan, p_cycle: cycle, p_kind: kind });
  }

  recordPayment(invoiceId: string, method: string, ref: string | null, paidAt: string | null): Promise<{ number: string; period_end: string }> {
    return this.rpc('admin_record_payment', { p_invoice: invoiceId, p_method: method, p_ref: ref, p_paid_at: paidAt });
  }

  voidInvoice(invoiceId: string, reason: string): Promise<void> {
    return this.rpc('admin_void_invoice', { p_invoice: invoiceId, p_reason: reason });
  }

  invoices(status: string | null, search: string, limit: number, offset: number): Promise<{ total: number; rows: AdminInvoice[] }> {
    return this.rpc('admin_list_invoices', { p_status: status, p_search: search || null, p_limit: limit, p_offset: offset });
  }

  plans(): Promise<AdminPlan[]> {
    return this.rpc('admin_list_plans');
  }

  savePlan(plan: Partial<AdminPlan>): Promise<string> {
    return this.rpc('admin_save_plan', { p_plan: plan });
  }

  admins(): Promise<PlatformAdmin[]> {
    return this.rpc('admin_list_admins');
  }

  setAdmin(email: string, role: AdminRole | null): Promise<void> {
    return this.rpc('admin_set_admin', { p_email: email, p_role: role });
  }

  settings(): Promise<BillingSettings> {
    return this.rpc('admin_get_settings');
  }

  saveSettings(settings: Partial<BillingSettings>): Promise<void> {
    return this.rpc('admin_save_settings', { p_settings: settings });
  }
}

import { Database, Tables } from '../supabase/database.types';

export type MyTenant = Database['public']['Functions']['get_my_tenants']['Returns'][number];
export type TenantSettings = Tables<'tenant_settings'>;

export interface ContextBranch {
  id: string;
  code: string;
  name_en: string;
  name_ar: string | null;
  is_main: boolean;
  is_active: boolean;
  timezone: string;
}

export interface ContextSubscription {
  status: 'trialing' | 'active' | 'past_due' | 'suspended' | 'cancelled' | 'expired';
  plan_code: string;
  plan_name_en: string;
  plan_name_ar: string;
  trial_ends_at: string | null;
  current_period_end: string | null;
  max_branches: number | null;
  max_staff: number | null;
}

/** Shape returned by public.get_tenant_context (see migration 0006). */
export interface TenantContext {
  tenant: Omit<Tables<'tenants'>, 'creation_key' | 'created_by'>;
  settings: TenantSettings;
  membership: { id: string; is_owner: boolean; all_branches: boolean; job_title: string | null };
  roles: { id: string; code: string; name_en: string; name_ar: string | null }[];
  permissions: string[];
  modules: string[];
  branches: ContextBranch[];
  subscription: ContextSubscription | null;
  operational: boolean;
  is_platform_admin: boolean;
}

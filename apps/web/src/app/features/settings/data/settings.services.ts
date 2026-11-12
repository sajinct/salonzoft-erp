import { Injectable, inject } from '@angular/core';
import { Tables, TablesInsert, TablesUpdate } from '../../../core/supabase/database.types';
import { AppError, unwrap } from '../../../core/supabase/app-error';
import { SUPABASE } from '../../../core/supabase/supabase.client';

export type Tenant = Tables<'tenants'>;
export type TenantSettings = Tables<'tenant_settings'>;
export type Branch = Tables<'branches'>;
export type WorkingHours = Tables<'branch_working_hours'>;
export type Role = Tables<'roles'>;
export type Permission = Tables<'permissions'>;
export type Module = Tables<'modules'>;
export type Profile = Tables<'profiles'>;

export type TenantProfileUpdate = Pick<TablesUpdate<'tenants'>, 'name' | 'name_ar' | 'legal_name' | 'business_type'>;
export type TenantSettingsUpdate = Omit<TablesUpdate<'tenant_settings'>, 'tenant_id' | 'currency_code' | 'updated_at'>;
export type BranchInput = Omit<TablesInsert<'branches'>, 'id' | 'tenant_id' | 'created_at' | 'updated_at' | 'is_main'>;
export interface HoursRange {
  day_of_week: number;
  opens_at: string;
  closes_at: string;
}

const ALLOWED_LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_LOGO_BYTES = 5 * 1024 * 1024;

@Injectable({ providedIn: 'root' })
export class BusinessSettingsService {
  private readonly sb = inject(SUPABASE);

  async load(tenantId: string): Promise<{ tenant: Tenant; settings: TenantSettings }> {
    const [tenant, settings] = await Promise.all([
      this.sb.from('tenants').select('*').eq('id', tenantId).single(),
      this.sb.from('tenant_settings').select('*').eq('tenant_id', tenantId).single(),
    ]);
    return { tenant: unwrap(tenant), settings: unwrap(settings) };
  }

  async save(tenantId: string, profile: TenantProfileUpdate, settings: TenantSettingsUpdate): Promise<void> {
    unwrap(await this.sb.from('tenants').update(profile).eq('id', tenantId).select('id').single());
    unwrap(await this.sb.from('tenant_settings').update(settings).eq('tenant_id', tenantId).select('tenant_id').single());
  }

  async saveSettings(tenantId: string, settings: TenantSettingsUpdate): Promise<void> {
    unwrap(await this.sb.from('tenant_settings').update(settings).eq('tenant_id', tenantId).select('tenant_id').single());
  }

  /** Upload to tenants/{tenantId}/branding/… (Storage RLS checks settings.manage). */
  async uploadLogo(tenantId: string, file: File): Promise<string> {
    if (!ALLOWED_LOGO_TYPES.includes(file.type)) throw new AppError('INVALID_FILE_TYPE', 'PNG, JPG or WebP only');
    if (file.size > MAX_LOGO_BYTES) throw new AppError('FILE_TOO_LARGE', 'Maximum 5 MB');
    const ext = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg';
    const path = `tenants/${tenantId}/branding/logo-${Date.now()}.${ext}`;
    unwrap(await this.sb.storage.from('tenant-assets').upload(path, file, { contentType: file.type, upsert: false }));
    unwrap(await this.sb.from('tenant_settings').update({ logo_path: path }).eq('tenant_id', tenantId).select('tenant_id').single());
    return path;
  }

  /** Short-lived signed URL for private assets. */
  async signedUrl(path: string, expiresInSeconds = 600): Promise<string> {
    const data = unwrap(await this.sb.storage.from('tenant-assets').createSignedUrl(path, expiresInSeconds));
    return data.signedUrl;
  }
}

@Injectable({ providedIn: 'root' })
export class BranchesService {
  private readonly sb = inject(SUPABASE);

  async list(tenantId: string): Promise<Branch[]> {
    return unwrap(
      await this.sb.from('branches').select('*').eq('tenant_id', tenantId).order('is_main', { ascending: false }).order('sort_order').order('name_en'),
    );
  }

  async hours(branchId: string): Promise<WorkingHours[]> {
    return unwrap(
      await this.sb.from('branch_working_hours').select('*').eq('branch_id', branchId).order('day_of_week').order('opens_at'),
    );
  }

  async create(tenantId: string, input: BranchInput): Promise<Branch> {
    return unwrap(await this.sb.from('branches').insert({ ...input, tenant_id: tenantId }).select('*').single());
  }

  async update(branchId: string, input: Partial<BranchInput> & { is_main?: boolean }): Promise<Branch> {
    return unwrap(await this.sb.from('branches').update(input).eq('id', branchId).select('*').single());
  }

  async saveHours(branchId: string, ranges: HoursRange[]): Promise<void> {
    unwrap(await this.sb.rpc('set_branch_working_hours', { p_branch_id: branchId, p_hours: ranges as unknown as never }));
  }
}

@Injectable({ providedIn: 'root' })
export class RolesService {
  private readonly sb = inject(SUPABASE);

  async load(tenantId: string): Promise<{
    roles: Role[];
    rolePermissions: { role_id: string; permission_code: string }[];
    permissions: Permission[];
    modules: Module[];
  }> {
    const [roles, rp, permissions, modules] = await Promise.all([
      this.sb.from('roles').select('*').eq('tenant_id', tenantId).order('is_system', { ascending: false }).order('name_en'),
      this.sb.from('role_permissions').select('role_id, permission_code').eq('tenant_id', tenantId),
      this.sb.from('permissions').select('*').order('sort_order'),
      this.sb.from('modules').select('*').order('sort_order'),
    ]);
    return { roles: unwrap(roles), rolePermissions: unwrap(rp), permissions: unwrap(permissions), modules: unwrap(modules) };
  }

  async createRole(tenantId: string, input: { code: string; name_en: string; name_ar: string | null }): Promise<Role> {
    return unwrap(await this.sb.from('roles').insert({ ...input, tenant_id: tenantId }).select('*').single());
  }

  async deleteRole(roleId: string): Promise<void> {
    const rows = unwrap(await this.sb.from('roles').delete().eq('id', roleId).select('id'));
    if (rows.length === 0) throw new AppError('FORBIDDEN', 'Role cannot be deleted');
  }

  async grant(tenantId: string, roleId: string, permission: string): Promise<void> {
    unwrap(await this.sb.from('role_permissions').insert({ tenant_id: tenantId, role_id: roleId, permission_code: permission }));
  }

  async revoke(roleId: string, permission: string): Promise<void> {
    const rows = unwrap(
      await this.sb.from('role_permissions').delete().eq('role_id', roleId).eq('permission_code', permission).select('role_id'),
    );
    if (rows.length === 0) throw new AppError('FORBIDDEN', 'Permission cannot be removed');
  }
}

@Injectable({ providedIn: 'root' })
export class ProfileService {
  private readonly sb = inject(SUPABASE);

  async load(userId: string): Promise<Profile> {
    return unwrap(await this.sb.from('profiles').select('*').eq('id', userId).single());
  }

  async save(userId: string, input: Pick<Profile, 'full_name' | 'phone' | 'preferred_language'>): Promise<void> {
    unwrap(await this.sb.from('profiles').update(input).eq('id', userId).select('id').single());
    // Keep the display name in auth metadata in sync (display only, never used for authorization).
    await this.sb.auth.updateUser({ data: { full_name: input.full_name } });
  }
}

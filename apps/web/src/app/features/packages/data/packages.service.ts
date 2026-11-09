import { Injectable, inject } from '@angular/core';
import { Tables, TablesInsert } from '../../../core/supabase/database.types';
import { unwrap } from '../../../core/supabase/app-error';
import { SUPABASE } from '../../../core/supabase/supabase.client';

export type Package = Tables<'packages'>;
export type PackageItem = Tables<'package_items'>;
export type Membership = Tables<'memberships'>;
export type GiftVoucher = Tables<'gift_vouchers'>;
export type PackageInput = Omit<TablesInsert<'packages'>, 'id' | 'tenant_id' | 'created_at' | 'updated_at'>;
export type MembershipInput = Omit<TablesInsert<'memberships'>, 'id' | 'tenant_id' | 'created_at' | 'updated_at'>;

@Injectable({ providedIn: 'root' })
export class PackagesService {
  private readonly sb = inject(SUPABASE);

  async catalogue(tenantId: string): Promise<{ packages: Package[]; items: PackageItem[]; memberships: Membership[] }> {
    const [packages, items, memberships] = await Promise.all([
      this.sb.from('packages').select('*').eq('tenant_id', tenantId).order('sort_order').order('name_en'),
      this.sb.from('package_items').select('*').eq('tenant_id', tenantId),
      this.sb.from('memberships').select('*').eq('tenant_id', tenantId).order('sort_order').order('name_en'),
    ]);
    return { packages: unwrap(packages), items: unwrap(items), memberships: unwrap(memberships) };
  }

  async savePackage(tenantId: string, id: string | null, input: PackageInput, items: { service_id: string; sessions: number }[]): Promise<void> {
    const row: Package = id
      ? unwrap(await this.sb.from('packages').update(input).eq('id', id).select('*').single())
      : unwrap(await this.sb.from('packages').insert({ ...input, tenant_id: tenantId }).select('*').single());
    unwrap(await this.sb.rpc('set_package_items', { p_package_id: row.id, p_items: items as unknown as never }));
  }

  async saveMembership(tenantId: string, id: string | null, input: MembershipInput): Promise<void> {
    if (id) unwrap(await this.sb.from('memberships').update(input).eq('id', id).select('id').single());
    else unwrap(await this.sb.from('memberships').insert({ ...input, tenant_id: tenantId }).select('id').single());
  }

  async vouchers(tenantId: string, search: string): Promise<GiftVoucher[]> {
    let query = this.sb.from('gift_vouchers').select('*').eq('tenant_id', tenantId).order('created_at', { ascending: false }).limit(100);
    const code = search.trim().toUpperCase();
    if (code) query = query.ilike('code', `%${code.replace(/[%_]/g, '')}%`);
    return unwrap(await query);
  }

  /** Customer of an appointment (for deposits taken at the till). */
  async appointmentCustomer(appointmentId: string): Promise<string | null> {
    const row: Tables<'appointments'> = unwrap(await this.sb.from('appointments').select('*').eq('id', appointmentId).single());
    return row.customer_id;
  }
}

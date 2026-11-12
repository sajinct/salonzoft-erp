import { Injectable, inject } from '@angular/core';
import { Tables, TablesInsert } from '../../../core/supabase/database.types';
import { unwrap } from '../../../core/supabase/app-error';
import { SUPABASE } from '../../../core/supabase/supabase.client';
import type { ServiceImportResult, ServiceImportRow } from './services-io';

export type ServiceCategory = Tables<'service_categories'>;
export type Service = Tables<'services'>;
export type ServicePrice = Tables<'service_prices'>;

export type CategoryInput = Pick<TablesInsert<'service_categories'>, 'name_en' | 'name_ar' | 'sort_order' | 'is_active'>;
export type ServiceInput = Omit<TablesInsert<'services'>, 'id' | 'tenant_id' | 'created_at' | 'updated_at'>;

export interface BranchPriceInput {
  branch_id: string;
  /** null = use the service's base price */
  price: string | null;
  is_available: boolean;
}

/** Data access for the service catalogue. RLS decides what each user may read or write. */
@Injectable({ providedIn: 'root' })
export class ServicesService {
  private readonly sb = inject(SUPABASE);

  async load(tenantId: string): Promise<{ categories: ServiceCategory[]; services: Service[]; prices: ServicePrice[] }> {
    const [categories, services, prices] = await Promise.all([
      this.sb.from('service_categories').select('*').eq('tenant_id', tenantId).order('sort_order').order('name_en'),
      this.sb.from('services').select('*').eq('tenant_id', tenantId).order('sort_order').order('name_en'),
      this.sb.from('service_prices').select('*').eq('tenant_id', tenantId),
    ]);
    return { categories: unwrap(categories), services: unwrap(services), prices: unwrap(prices) };
  }

  async createCategory(tenantId: string, input: CategoryInput): Promise<ServiceCategory> {
    return unwrap(await this.sb.from('service_categories').insert({ ...input, tenant_id: tenantId }).select('*').single());
  }

  async updateCategory(id: string, input: Partial<CategoryInput>): Promise<ServiceCategory> {
    return unwrap(await this.sb.from('service_categories').update(input).eq('id', id).select('*').single());
  }

  async deleteCategory(id: string): Promise<void> {
    unwrap(await this.sb.from('service_categories').delete().eq('id', id).select('id').single());
  }

  async createService(tenantId: string, input: ServiceInput): Promise<Service> {
    return unwrap(await this.sb.from('services').insert({ ...input, tenant_id: tenantId }).select('*').single());
  }

  async updateService(id: string, input: Partial<ServiceInput>): Promise<Service> {
    return unwrap(await this.sb.from('services').update(input).eq('id', id).select('*').single());
  }

  /** Add or update services from an imported file; a dry run only validates. */
  async import(tenantId: string, rows: ServiceImportRow[], dryRun: boolean): Promise<ServiceImportResult> {
    const result = unwrap(await this.sb.rpc('import_services', { p_tenant: tenantId, p_rows: rows as unknown as never, p_dry_run: dryRun }));
    return result as unknown as ServiceImportResult;
  }

  /** Replace the branch overrides of a service (only branches the user can access). */
  async setBranchPrices(serviceId: string, rows: BranchPriceInput[]): Promise<void> {
    unwrap(await this.sb.rpc('set_service_branch_prices', { p_service_id: serviceId, p_prices: rows as unknown as never }));
  }
}

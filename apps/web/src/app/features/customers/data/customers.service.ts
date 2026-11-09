import { Injectable, inject } from '@angular/core';
import { Database, Tables, TablesInsert } from '../../../core/supabase/database.types';
import { unwrap } from '../../../core/supabase/app-error';
import { SUPABASE } from '../../../core/supabase/supabase.client';

export type Customer = Tables<'customers'>;
export type CustomerNote = Tables<'customer_notes'>;
export type CustomerConsent = Tables<'customer_consents'>;
export type DuplicateMatch = Database['public']['Functions']['find_customer_duplicates']['Returns'][number];
export type CustomerInput = Omit<TablesInsert<'customers'>, 'id' | 'tenant_id' | 'created_at' | 'updated_at' | 'created_by' | 'search_text'>;
export type ConsentChannel = 'whatsapp' | 'sms' | 'email';
export type ConsentPurpose = 'marketing' | 'reminders';

/** One parsed CSV row as sent to import_customers (all values are strings). */
export type ImportRow = Partial<
  Record<'first_name' | 'last_name' | 'name_ar' | 'mobile' | 'email' | 'gender' | 'date_of_birth' | 'preferred_language' | 'tags' | 'external_ref' | 'note' | 'whatsapp_marketing', string>
>;

export interface ImportResult {
  dry_run: boolean;
  total: number;
  inserted: number;
  duplicates: { row: number; existing_id: string | null; mobile: string | null }[];
  errors: { row: number; code: string; detail: string }[];
}

@Injectable({ providedIn: 'root' })
export class CustomersService {
  private readonly sb = inject(SUPABASE);

  async search(tenantId: string, query: string, includeArchived = false, limit = 50): Promise<Customer[]> {
    return (
      unwrap(
        await this.sb.rpc('search_customers', { p_tenant: tenantId, p_query: query, p_limit: limit, p_include_archived: includeArchived }),
      ) ?? []
    );
  }

  async get(id: string): Promise<Customer> {
    return unwrap(await this.sb.from('customers').select('*').eq('id', id).single());
  }

  async create(tenantId: string, input: CustomerInput): Promise<Customer> {
    return unwrap(await this.sb.from('customers').insert({ ...input, tenant_id: tenantId }).select('*').single());
  }

  async update(id: string, input: Partial<CustomerInput>): Promise<Customer> {
    return unwrap(await this.sb.from('customers').update(input).eq('id', id).select('*').single());
  }

  async duplicates(
    tenantId: string,
    input: { mobile?: string | null; email?: string | null; first_name: string; last_name?: string | null },
    excludeId: string | null,
  ): Promise<DuplicateMatch[]> {
    return (
      unwrap(
        await this.sb.rpc('find_customer_duplicates', {
          p_tenant: tenantId,
          p_mobile: input.mobile ?? '',
          p_email: input.email ?? '',
          p_first_name: input.first_name,
          p_last_name: input.last_name ?? undefined,
          p_exclude_id: excludeId ?? undefined,
        }),
      ) ?? []
    );
  }

  async notes(customerId: string): Promise<CustomerNote[]> {
    return unwrap(
      await this.sb.from('customer_notes').select('*').eq('customer_id', customerId).order('is_pinned', { ascending: false }).order('created_at', { ascending: false }),
    );
  }

  async addNote(tenantId: string, customerId: string, input: Pick<CustomerNote, 'kind' | 'body' | 'is_pinned'>): Promise<void> {
    unwrap(await this.sb.from('customer_notes').insert({ ...input, tenant_id: tenantId, customer_id: customerId }));
  }

  async setNotePinned(id: string, isPinned: boolean): Promise<void> {
    unwrap(await this.sb.from('customer_notes').update({ is_pinned: isPinned }).eq('id', id).select('id').single());
  }

  async deleteNote(id: string): Promise<void> {
    unwrap(await this.sb.from('customer_notes').delete().eq('id', id).select('id').single());
  }

  async consents(customerId: string): Promise<CustomerConsent[]> {
    return unwrap(await this.sb.from('customer_consents').select('*').eq('customer_id', customerId).order('recorded_at', { ascending: false }));
  }

  async recordConsent(
    tenantId: string,
    customerId: string,
    channel: ConsentChannel,
    purpose: ConsentPurpose,
    granted: boolean,
    source: CustomerConsent['source'] = 'in_person',
  ): Promise<void> {
    unwrap(await this.sb.from('customer_consents').insert({ tenant_id: tenantId, customer_id: customerId, channel, purpose, granted, source }));
  }

  async import(tenantId: string, rows: ImportRow[], dryRun: boolean): Promise<ImportResult> {
    const result = unwrap(await this.sb.rpc('import_customers', { p_tenant: tenantId, p_rows: rows as unknown as never, p_dry_run: dryRun }));
    return result as unknown as ImportResult;
  }
}

/** Current consent per channel + purpose (latest record wins). */
export function currentConsents(history: CustomerConsent[]): Map<string, CustomerConsent> {
  const map = new Map<string, CustomerConsent>();
  const sorted = [...history].sort((a, b) => b.recorded_at.localeCompare(a.recorded_at));
  for (const c of sorted) {
    const key = `${c.channel}:${c.purpose}`;
    if (!map.has(key)) map.set(key, c);
  }
  return map;
}

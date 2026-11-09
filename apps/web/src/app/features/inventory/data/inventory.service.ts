import { Injectable, inject } from '@angular/core';
import { Database, Tables, TablesInsert } from '../../../core/supabase/database.types';
import { unwrap } from '../../../core/supabase/app-error';
import { SUPABASE } from '../../../core/supabase/supabase.client';

export type Product = Tables<'products'>;
export type ProductInput = Omit<TablesInsert<'products'>, 'id' | 'tenant_id' | 'created_at' | 'updated_at'>;
export type StockRow = Database['public']['Functions']['get_stock']['Returns'][number];
export type Movement = Tables<'inventory_movements'>;
export type Supplier = Tables<'suppliers'>;
export type SupplierInput = Omit<TablesInsert<'suppliers'>, 'id' | 'tenant_id' | 'created_at' | 'updated_at'>;
export type PurchaseOrder = Tables<'purchase_orders'>;
export type PurchaseOrderItem = Tables<'purchase_order_items'>;
export type UsageRow = Tables<'service_product_usage'>;

@Injectable({ providedIn: 'root' })
export class InventoryService {
  private readonly sb = inject(SUPABASE);

  // ---- products & stock ------------------------------------------------------
  async products(tenantId: string): Promise<Product[]> {
    return unwrap(await this.sb.from('products').select('*').eq('tenant_id', tenantId).order('name_en'));
  }

  async saveProduct(tenantId: string, id: string | null, input: ProductInput): Promise<Product> {
    return id
      ? unwrap(await this.sb.from('products').update(input).eq('id', id).select('*').single())
      : unwrap(await this.sb.from('products').insert({ ...input, tenant_id: tenantId }).select('*').single());
  }

  async stock(branchId: string): Promise<StockRow[]> {
    return unwrap(await this.sb.rpc('get_stock', { p_branch_id: branchId })) ?? [];
  }

  async movements(branchId: string, productId: string | null): Promise<Movement[]> {
    let query = this.sb.from('inventory_movements').select('*').eq('branch_id', branchId).order('id', { ascending: false }).limit(200);
    if (productId) query = query.eq('product_id', productId);
    return unwrap(await query);
  }

  async adjust(branchId: string, items: { product_id: string; counted?: number; delta?: number; unit_cost?: number }[], note: string | null): Promise<number> {
    return unwrap(await this.sb.rpc('adjust_stock', { p_branch_id: branchId, p_items: items as unknown as never, p_note: note ?? undefined })) as number;
  }

  async transfer(from: string, to: string, items: { product_id: string; quantity: number }[], note: string | null): Promise<void> {
    unwrap(await this.sb.rpc('transfer_stock', { p_from_branch: from, p_to_branch: to, p_items: items as unknown as never, p_note: note ?? undefined }));
  }

  async usage(serviceId: string): Promise<UsageRow[]> {
    return unwrap(await this.sb.from('service_product_usage').select('*').eq('service_id', serviceId));
  }

  async setUsage(serviceId: string, items: { product_id: string; quantity: number }[]): Promise<void> {
    unwrap(await this.sb.rpc('set_service_product_usage', { p_service_id: serviceId, p_items: items as unknown as never }));
  }

  // ---- purchasing ------------------------------------------------------------
  async suppliers(tenantId: string): Promise<Supplier[]> {
    return unwrap(await this.sb.from('suppliers').select('*').eq('tenant_id', tenantId).order('name'));
  }

  async saveSupplier(tenantId: string, id: string | null, input: SupplierInput): Promise<void> {
    if (id) unwrap(await this.sb.from('suppliers').update(input).eq('id', id).select('*').single());
    else unwrap(await this.sb.from('suppliers').insert({ ...input, tenant_id: tenantId }).select('*').single());
  }

  async orders(tenantId: string): Promise<PurchaseOrder[]> {
    return unwrap(await this.sb.from('purchase_orders').select('*').eq('tenant_id', tenantId).order('created_at', { ascending: false }).limit(200));
  }

  async orderItems(orderId: string): Promise<PurchaseOrderItem[]> {
    return unwrap(await this.sb.from('purchase_order_items').select('*').eq('purchase_order_id', orderId).order('sort_order'));
  }

  async saveOrder(tenantId: string, branchId: string, id: string | null, supplierId: string, items: { product_id: string; quantity: number; unit_cost: number }[], expectedOn: string | null, notes: string | null): Promise<string> {
    return unwrap(
      await this.sb.rpc('save_purchase_order', {
        p_tenant: tenantId,
        p_branch_id: branchId,
        p_order_id: id as string,
        p_supplier_id: supplierId,
        p_items: items as unknown as never,
        p_expected_on: expectedOn ?? undefined,
        p_notes: notes ?? undefined,
      }),
    ) as string;
  }

  async submitOrder(id: string): Promise<string> {
    return unwrap(await this.sb.rpc('submit_purchase_order', { p_order_id: id })) as string;
  }

  async cancelOrder(id: string): Promise<void> {
    unwrap(await this.sb.rpc('cancel_purchase_order', { p_order_id: id }));
  }

  async receive(id: string, lines: { item_id: string; quantity: number; unit_cost?: number }[], reference: string | null, key: string): Promise<{ status: string; total_cost: number }> {
    return unwrap(
      await this.sb.rpc('receive_purchase_order', {
        p_order_id: id,
        p_lines: lines as unknown as never,
        p_supplier_reference: reference ?? undefined,
        p_idempotency_key: key,
      }),
    ) as unknown as { status: string; total_cost: number };
  }
}

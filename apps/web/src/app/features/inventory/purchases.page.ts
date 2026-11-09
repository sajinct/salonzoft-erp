import { Dialog, DialogRef, DIALOG_DATA } from '@angular/cdk/dialog';
import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { LucideDynamicIcon } from '@lucide/angular';
import { I18nService, TranslateDynamicPipe, TranslatePipe } from '../../core/i18n/i18n.service';
import { ToastService } from '../../core/services/toast.service';
import { TenantContextService } from '../../core/tenant/tenant-context.service';
import { ConfirmService, PageHeader, StatePanel } from '../../shared/components/ui';
import { LocalDatePipe, MoneyPipe } from '../../shared/pipes/format.pipes';
import { parseAmount } from '../pos/pos-dialogs';
import { InventoryService, Product, PurchaseOrder, PurchaseOrderItem, Supplier } from './data/inventory.service';

type Tab = 'orders' | 'suppliers';

// ---------------------------------------------------------------------------
// Supplier dialog
// ---------------------------------------------------------------------------
@Component({
  selector: 'sz-supplier-dialog',
  imports: [ReactiveFormsModule, TranslatePipe, LucideDynamicIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form class="card w-[min(32rem,calc(100vw-2rem))] p-6" [formGroup]="form" (ngSubmit)="save()" novalidate role="dialog" aria-modal="true">
      <div class="mb-4 flex items-center justify-between">
        <h2 class="text-lg font-semibold">{{ (data ? 'purchases.editSupplier' : 'purchases.addSupplier') | t }}</h2>
        <button type="button" class="btn-icon" (click)="ref.close()" [attr.aria-label]="'common.close' | t"><svg lucideIcon="x" [size]="18"></svg></button>
      </div>
      <div class="grid gap-4 sm:grid-cols-2">
        <div class="field sm:col-span-2"><label class="label" for="sname">{{ 'purchases.supplierName' | t }}</label><input id="sname" class="input" formControlName="name" /></div>
        <div class="field"><label class="label" for="scontact">{{ 'purchases.contact' | t }}</label><input id="scontact" class="input" formControlName="contact_name" /></div>
        <div class="field"><label class="label" for="sphone">{{ 'common.mobile' | t }}</label><input id="sphone" class="input" formControlName="phone" dir="ltr" /></div>
        <div class="field"><label class="label" for="semail">{{ 'common.email' | t }}</label><input id="semail" class="input" formControlName="email" dir="ltr" /></div>
        <div class="field"><label class="label" for="svat">{{ 'pos.vatNumber' | t }}</label><input id="svat" class="input uppercase" formControlName="vat_number" dir="ltr" /></div>
        <div class="field sm:col-span-2"><label class="label" for="snotes">{{ 'appointments.notes' | t }}</label><input id="snotes" class="input" formControlName="notes" maxlength="500" /></div>
      </div>
      <label class="mt-4 flex items-center gap-2 text-sm"><input type="checkbox" class="checkbox" formControlName="is_active" />{{ 'common.active' | t }}</label>
      <div class="mt-6 flex justify-end gap-2">
        <button type="button" class="btn-secondary" (click)="ref.close()">{{ 'common.cancel' | t }}</button>
        <button type="submit" class="btn-primary" [disabled]="saving()">{{ 'common.save' | t }}</button>
      </div>
    </form>
  `,
})
export class SupplierDialog {
  protected readonly ref = inject<DialogRef<boolean>>(DialogRef);
  protected readonly data = inject<Supplier | null>(DIALOG_DATA);
  private readonly api = inject(InventoryService);
  private readonly ctx = inject(TenantContextService);
  private readonly toast = inject(ToastService);
  private readonly i18n = inject(I18nService);
  protected readonly saving = signal(false);
  protected readonly form = inject(NonNullableFormBuilder).group({
    name: [this.data?.name ?? '', [Validators.required, Validators.minLength(2)]],
    contact_name: [this.data?.contact_name ?? ''],
    phone: [this.data?.phone ?? '', Validators.pattern(/^\+?[0-9]{6,15}$/)],
    email: [this.data?.email ?? '', Validators.email],
    vat_number: [this.data?.vat_number ?? '', Validators.pattern(/^[A-Za-z0-9]{5,20}$/)],
    notes: [this.data?.notes ?? ''],
    is_active: [this.data?.is_active ?? true],
  });

  async save(): Promise<void> {
    const tenantId = this.ctx.tenantId();
    if (!tenantId || this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const v = this.form.getRawValue();
    this.saving.set(true);
    try {
      await this.api.saveSupplier(tenantId, this.data?.id ?? null, {
        name: v.name.trim(),
        contact_name: v.contact_name.trim() || null,
        phone: v.phone.replace(/\s/g, '') || null,
        email: v.email.trim().toLowerCase() || null,
        vat_number: v.vat_number.trim().toUpperCase() || null,
        notes: v.notes.trim() || null,
        is_active: v.is_active,
      });
      this.toast.success(this.i18n.t('common.saved'));
      this.ref.close(true);
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.saving.set(false);
    }
  }
}

// ---------------------------------------------------------------------------
// Order editor (draft) and receiving
// ---------------------------------------------------------------------------
export interface OrderDialogData {
  mode: 'edit' | 'receive';
  order: PurchaseOrder | null;
  items: PurchaseOrderItem[];
  suppliers: Supplier[];
  products: Product[];
  branchId: string;
}

interface Row {
  item_id?: string;
  product_id: string;
  quantity: string;
  unit_cost: string;
  remaining?: number;
}

@Component({
  selector: 'sz-order-dialog',
  imports: [TranslatePipe, LucideDynamicIcon, MoneyPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="card flex max-h-[92vh] w-[min(44rem,calc(100vw-2rem))] flex-col" role="dialog" aria-modal="true">
      <header class="flex items-center justify-between border-b border-line px-6 py-4">
        <h2 class="text-lg font-semibold">
          {{ (data.mode === 'receive' ? 'purchases.receive' : data.order ? 'purchases.editOrder' : 'purchases.newOrder') | t }}
          @if (data.order?.number) { <span class="num text-muted" dir="ltr">· {{ data.order!.number }}</span> }
        </h2>
        <button type="button" class="btn-icon" (click)="ref.close()" [attr.aria-label]="'common.close' | t"><svg lucideIcon="x" [size]="18"></svg></button>
      </header>
      <div class="flex-1 space-y-4 overflow-y-auto px-6 py-5 text-sm">
        @if (data.mode === 'edit') {
          <div class="grid gap-3 sm:grid-cols-2">
            <div class="field">
              <label class="label" for="osup">{{ 'purchases.supplier' | t }}</label>
              <select id="osup" class="input" [value]="supplier()" (change)="supplier.set($any($event.target).value)">
                <option value="">—</option>
                @for (s of activeSuppliers(); track s.id) { <option [value]="s.id">{{ s.name }}</option> }
              </select>
            </div>
            <div class="field"><label class="label" for="oexp">{{ 'purchases.expectedOn' | t }}</label><input id="oexp" class="input" type="date" dir="ltr" [value]="expected()" (change)="expected.set($any($event.target).value)" /></div>
          </div>
        } @else {
          <div class="field"><label class="label" for="oref">{{ 'purchases.supplierReference' | t }}</label><input id="oref" class="input" dir="ltr" maxlength="80" [value]="reference()" (input)="reference.set($any($event.target).value)" /></div>
        }

        <table class="w-full">
          <thead><tr class="text-xs text-muted">
            <th class="pb-2 text-start font-semibold">{{ 'inventory.product' | t }}</th>
            <th class="pb-2 text-end font-semibold">{{ (data.mode === 'receive' ? 'purchases.receivedNow' : 'pos.quantity') | t }}</th>
            <th class="pb-2 text-end font-semibold">{{ 'inventory.unitCost' | t }}</th><th></th>
          </tr></thead>
          <tbody>
            @for (r of rows(); track $index; let i = $index) {
              <tr>
                <td class="py-1 pe-2">
                  @if (data.mode === 'edit') {
                    <select class="input h-9" [value]="r.product_id" (change)="setRow(i, 'product_id', $any($event.target).value)" [attr.aria-label]="'inventory.product' | t">
                      <option value="">—</option>
                      @for (p of data.products; track p.id) { <option [value]="p.id">{{ i18n.pick(p.name_en, p.name_ar) }}</option> }
                    </select>
                  } @else {
                    {{ productName(r.product_id) }} <span class="text-xs text-muted">({{ 'purchases.open' | t }} {{ r.remaining }})</span>
                  }
                </td>
                <td class="py-1"><input class="input num h-9 w-24 text-end" inputmode="decimal" dir="ltr" [value]="r.quantity" (input)="setRow(i, 'quantity', $any($event.target).value)" [attr.aria-label]="'pos.quantity' | t" /></td>
                <td class="py-1 ps-2"><input class="input num h-9 w-24 text-end" inputmode="decimal" dir="ltr" [value]="r.unit_cost" (input)="setRow(i, 'unit_cost', $any($event.target).value)" [attr.aria-label]="'inventory.unitCost' | t" /></td>
                <td class="py-1 ps-1">
                  @if (data.mode === 'edit') { <button type="button" class="btn-icon h-8 w-8" (click)="removeRow(i)" [attr.aria-label]="'common.remove' | t"><svg lucideIcon="trash-2" [size]="14"></svg></button> }
                </td>
              </tr>
            }
          </tbody>
        </table>
        @if (data.mode === 'edit') {
          <button type="button" class="btn-ghost btn-sm" (click)="addRow()"><svg lucideIcon="plus" [size]="14"></svg>{{ 'purchases.addLine' | t }}</button>
          <div class="field"><label class="label" for="onotes">{{ 'appointments.notes' | t }}</label><input id="onotes" class="input" maxlength="500" [value]="notes()" (input)="notes.set($any($event.target).value)" /></div>
        }
        <p class="text-end font-semibold">{{ 'pos.total' | t }}: <span class="num">{{ total() | money }}</span></p>
      </div>
      <footer class="flex justify-end gap-2 border-t border-line px-6 py-4">
        <button type="button" class="btn-secondary" (click)="ref.close()">{{ 'common.cancel' | t }}</button>
        @if (data.mode === 'edit') {
          <button type="button" class="btn-secondary" [disabled]="busy()" (click)="save(false)">{{ 'purchases.saveDraft' | t }}</button>
          <button type="button" class="btn-primary" [disabled]="busy()" (click)="save(true)">{{ 'purchases.saveAndSend' | t }}</button>
        } @else {
          <button type="button" class="btn-primary" [disabled]="busy()" (click)="receive()">{{ 'purchases.receive' | t }}</button>
        }
      </footer>
    </div>
  `,
})
export class OrderDialog {
  protected readonly ref = inject<DialogRef<boolean>>(DialogRef);
  protected readonly data = inject<OrderDialogData>(DIALOG_DATA);
  protected readonly i18n = inject(I18nService);
  private readonly api = inject(InventoryService);
  private readonly ctx = inject(TenantContextService);
  private readonly toast = inject(ToastService);

  protected readonly supplier = signal(this.data.order?.supplier_id ?? '');
  protected readonly expected = signal(this.data.order?.expected_on ?? '');
  protected readonly notes = signal(this.data.order?.notes ?? '');
  protected readonly reference = signal('');
  protected readonly busy = signal(false);
  private readonly key = crypto.randomUUID();
  protected readonly activeSuppliers = computed(() => this.data.suppliers.filter((s) => s.is_active));
  protected readonly rows = signal<Row[]>(
    this.data.mode === 'receive'
      ? this.data.items
          .filter((i) => i.received_quantity < i.quantity)
          .map((i) => ({ item_id: i.id, product_id: i.product_id, quantity: String(i.quantity - i.received_quantity), unit_cost: String(i.unit_cost), remaining: i.quantity - i.received_quantity }))
      : this.data.items.length
        ? this.data.items.map((i) => ({ product_id: i.product_id, quantity: String(i.quantity), unit_cost: String(i.unit_cost) }))
        : [{ product_id: '', quantity: '1', unit_cost: '' }],
  );
  protected readonly total = computed(() =>
    this.rows().reduce((sum, r) => sum + (parseAmount(r.quantity) ?? 0) * (parseAmount(r.unit_cost) ?? 0), 0),
  );

  protected productName(id: string): string {
    const p = this.data.products.find((x) => x.id === id);
    return p ? this.i18n.pick(p.name_en, p.name_ar) : '—';
  }
  protected addRow(): void {
    this.rows.update((r) => [...r, { product_id: '', quantity: '1', unit_cost: '' }]);
  }
  protected removeRow(i: number): void {
    this.rows.update((r) => r.filter((_, j) => j !== i));
  }
  protected setRow(i: number, field: keyof Row, value: string): void {
    this.rows.update((r) =>
      r.map((row, j) => {
        if (j !== i) return row;
        const next = { ...row, [field]: value };
        // Pre-fill the last known cost when a product is picked.
        if (field === 'product_id' && !row.unit_cost) next.unit_cost = String(this.data.products.find((p) => p.id === value)?.cost_price ?? '');
        return next;
      }),
    );
  }

  async save(send: boolean): Promise<void> {
    const tenantId = this.ctx.tenantId();
    const items = this.rows()
      .filter((r) => r.product_id)
      .map((r) => ({ product_id: r.product_id, quantity: parseAmount(r.quantity) ?? NaN, unit_cost: parseAmount(r.unit_cost) ?? NaN }));
    if (!tenantId || !this.supplier() || items.length === 0 || items.some((i) => !(i.quantity > 0) || Number.isNaN(i.unit_cost))) {
      this.toast.error({ message: 'INVALID_ITEMS' });
      return;
    }
    this.busy.set(true);
    try {
      const id = await this.api.saveOrder(tenantId, this.data.order?.branch_id ?? this.data.branchId, this.data.order?.id ?? null, this.supplier(), items, this.expected() || null, this.notes().trim() || null);
      if (send) {
        const number = await this.api.submitOrder(id);
        this.toast.success(this.i18n.t('purchases.sent', { number }));
      } else {
        this.toast.success(this.i18n.t('common.saved'));
      }
      this.ref.close(true);
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.busy.set(false);
    }
  }

  async receive(): Promise<void> {
    const order = this.data.order;
    if (!order) return;
    const lines = this.rows()
      .map((r) => ({ item_id: r.item_id!, quantity: parseAmount(r.quantity) ?? NaN, unit_cost: parseAmount(r.unit_cost) ?? NaN }))
      .filter((l) => l.quantity !== 0);
    if (lines.length === 0 || lines.some((l) => Number.isNaN(l.quantity) || Number.isNaN(l.unit_cost))) {
      this.toast.error({ message: 'INVALID_QUANTITY' });
      return;
    }
    this.busy.set(true);
    try {
      await this.api.receive(order.id, lines, this.reference().trim() || null, this.key);
      this.toast.success(this.i18n.t('purchases.received'));
      this.ref.close(true);
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.busy.set(false);
    }
  }
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
@Component({
  selector: 'sz-purchases-page',
  imports: [TranslatePipe, TranslateDynamicPipe, LucideDynamicIcon, PageHeader, StatePanel, MoneyPipe, LocalDatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <sz-page-header [heading]="'nav.purchases' | t" [subtitle]="'purchases.subtitle' | t">
      @if (canManage()) {
        @if (tab() === 'orders') {
          <button type="button" class="btn-primary" (click)="openOrder(null, 'edit')" [disabled]="suppliers().length === 0"><svg lucideIcon="plus" [size]="16"></svg>{{ 'purchases.newOrder' | t }}</button>
        } @else {
          <button type="button" class="btn-primary" (click)="openSupplier(null)"><svg lucideIcon="plus" [size]="16"></svg>{{ 'purchases.addSupplier' | t }}</button>
        }
      }
    </sz-page-header>

    <div class="mb-4 flex gap-2">
      @for (t of tabs; track t) {
        <button type="button" [class]="tab() === t ? 'btn-primary btn-sm' : 'btn-secondary btn-sm'" (click)="tab.set(t)">{{ 'purchases.tab.' + t | tx }}</button>
      }
    </div>

    @if (loading()) {
      <div class="card"><sz-state [loading]="true" /></div>
    } @else if (tab() === 'orders') {
      @if (suppliers().length === 0) { <p class="mb-3 text-sm text-muted">{{ 'purchases.addSupplierFirst' | t }}</p> }
      <div class="card overflow-x-auto">
        <table class="table">
          <thead><tr>
            <th>{{ 'pos.number' | t }}</th><th>{{ 'purchases.supplier' | t }}</th><th>{{ 'common.status' | t }}</th>
            <th class="text-end">{{ 'pos.total' | t }}</th><th class="hidden md:table-cell">{{ 'appointments.date' | t }}</th><th></th>
          </tr></thead>
          <tbody>
            @for (o of orders(); track o.id) {
              <tr>
                <td class="num font-medium" dir="ltr">{{ o.number ?? ('pos.draft' | t) }}</td>
                <td>{{ supplierName(o.supplier_id) }}</td>
                <td><span [class]="statusClass(o.status)">{{ 'purchases.status.' + o.status | tx }}</span></td>
                <td class="num text-end">{{ o.total_cost | money }}</td>
                <td class="hidden text-muted md:table-cell">{{ (o.ordered_at ?? o.created_at) | localDate }}</td>
                <td class="whitespace-nowrap text-end">
                  @if (canManage()) {
                    @if (o.status === 'draft') { <button type="button" class="btn-ghost btn-sm" (click)="openOrder(o, 'edit')">{{ 'common.edit' | t }}</button> }
                    @if (o.status === 'ordered' || o.status === 'partially_received') { <button type="button" class="btn-primary btn-sm" (click)="openOrder(o, 'receive')">{{ 'purchases.receive' | t }}</button> }
                    @if (o.status === 'draft' || o.status === 'ordered') { <button type="button" class="btn-ghost btn-sm text-danger" (click)="cancel(o)">{{ 'common.cancel' | t }}</button> }
                  }
                </td>
              </tr>
            } @empty {
              <tr><td colspan="6"><sz-state icon="truck" [heading]="'purchases.noOrders' | t" /></td></tr>
            }
          </tbody>
        </table>
      </div>
    } @else {
      <div class="card overflow-x-auto">
        <table class="table">
          <thead><tr><th>{{ 'purchases.supplierName' | t }}</th><th>{{ 'purchases.contact' | t }}</th><th>{{ 'common.mobile' | t }}</th><th></th></tr></thead>
          <tbody>
            @for (s of suppliers(); track s.id) {
              <tr [class.opacity-60]="!s.is_active" [class.cursor-pointer]="canManage()" (click)="canManage() && openSupplier(s)">
                <td class="font-medium">{{ s.name }}</td><td class="text-muted">{{ s.contact_name ?? '—' }}</td>
                <td class="num text-muted" dir="ltr">{{ s.phone ?? '—' }}</td>
                <td class="text-end">@if (!s.is_active) { <span class="badge-warning">{{ 'common.inactive' | t }}</span> }</td>
              </tr>
            } @empty {
              <tr><td colspan="4"><sz-state icon="truck" [heading]="'purchases.noSuppliers' | t" /></td></tr>
            }
          </tbody>
        </table>
      </div>
    }
  `,
})
export class PurchasesPage implements OnInit {
  private readonly api = inject(InventoryService);
  private readonly ctx = inject(TenantContextService);
  private readonly dialog = inject(Dialog);
  private readonly toast = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  protected readonly i18n = inject(I18nService);

  protected readonly tabs: Tab[] = ['orders', 'suppliers'];
  protected readonly tab = signal<Tab>('orders');
  protected readonly loading = signal(true);
  protected readonly orders = signal<PurchaseOrder[]>([]);
  protected readonly suppliers = signal<Supplier[]>([]);
  protected readonly products = signal<Product[]>([]);
  protected readonly canManage = computed(() => this.ctx.can('purchases.manage'));

  ngOnInit(): void {
    void this.load();
  }

  async load(): Promise<void> {
    const tenantId = this.ctx.tenantId();
    if (!tenantId) return;
    try {
      const [orders, suppliers, products] = await Promise.all([this.api.orders(tenantId), this.api.suppliers(tenantId), this.api.products(tenantId)]);
      this.orders.set(orders);
      this.suppliers.set(suppliers);
      this.products.set(products.filter((p) => p.is_active));
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.loading.set(false);
    }
  }

  protected supplierName(id: string): string {
    return this.suppliers().find((s) => s.id === id)?.name ?? '—';
  }

  protected statusClass(status: string): string {
    return status === 'received' ? 'badge-success' : status === 'cancelled' ? 'badge-danger' : status === 'draft' ? 'badge-muted' : 'badge-warning';
  }

  openSupplier(s: Supplier | null): void {
    this.dialog.open<boolean, Supplier | null>(SupplierDialog, { data: s }).closed.subscribe((changed) => changed && void this.load());
  }

  async openOrder(order: PurchaseOrder | null, mode: 'edit' | 'receive'): Promise<void> {
    const branchId = this.ctx.branchId() ?? this.ctx.branches().at(0)?.id;
    if (!branchId) return;
    try {
      const items = order ? await this.api.orderItems(order.id) : [];
      const data: OrderDialogData = { mode, order, items, suppliers: this.suppliers(), products: this.products(), branchId };
      this.dialog.open<boolean, OrderDialogData>(OrderDialog, { data }).closed.subscribe((changed) => changed && void this.load());
    } catch (err) {
      this.toast.error(err);
    }
  }

  async cancel(o: PurchaseOrder): Promise<void> {
    const ok = await this.confirm.ask({
      title: this.i18n.t('purchases.cancelOrder'),
      message: this.i18n.t('purchases.confirmCancel'),
      confirmLabel: this.i18n.t('purchases.cancelOrder'),
      danger: true,
    });
    if (!ok) return;
    try {
      await this.api.cancelOrder(o.id);
      void this.load();
    } catch (err) {
      this.toast.error(err);
    }
  }
}

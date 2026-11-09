import { Dialog, DialogRef, DIALOG_DATA } from '@angular/cdk/dialog';
import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { LucideDynamicIcon } from '@lucide/angular';
import { I18nService, TranslateDynamicPipe, TranslatePipe } from '../../core/i18n/i18n.service';
import { ToastService } from '../../core/services/toast.service';
import { TenantContextService } from '../../core/tenant/tenant-context.service';
import { PageHeader, StatePanel } from '../../shared/components/ui';
import { LocalDatePipe, MoneyPipe } from '../../shared/pipes/format.pipes';
import { parseAmount } from '../pos/pos-dialogs';
import { InventoryService, Movement, Product, StockRow } from './data/inventory.service';

const MONEY = /^\d{1,9}(\.\d{1,3})?$/;
type Tab = 'stock' | 'products' | 'movements';

// ---------------------------------------------------------------------------
// Product dialog
// ---------------------------------------------------------------------------
@Component({
  selector: 'sz-product-dialog',
  imports: [ReactiveFormsModule, TranslatePipe, TranslateDynamicPipe, LucideDynamicIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="card flex max-h-[92vh] w-[min(40rem,calc(100vw-2rem))] flex-col" role="dialog" aria-modal="true">
      <header class="flex items-center justify-between border-b border-line px-6 py-4">
        <h2 class="text-lg font-semibold">{{ (data ? 'inventory.editProduct' : 'inventory.addProduct') | t }}</h2>
        <button type="button" class="btn-icon" (click)="ref.close()" [attr.aria-label]="'common.close' | t"><svg lucideIcon="x" [size]="18"></svg></button>
      </header>
      <form [formGroup]="form" id="product-form" class="grid flex-1 gap-4 overflow-y-auto px-6 py-5 sm:grid-cols-2" (ngSubmit)="save()" novalidate>
        <div class="field"><label class="label" for="pnen">{{ 'common.nameEn' | t }}</label><input id="pnen" class="input" formControlName="name_en" maxlength="120" /></div>
        <div class="field"><label class="label" for="pnar">{{ 'common.nameAr' | t }}</label><input id="pnar" class="input" formControlName="name_ar" dir="rtl" lang="ar" maxlength="120" /></div>
        <div class="field"><label class="label" for="psku">{{ 'inventory.sku' | t }}</label><input id="psku" class="input" formControlName="sku" dir="ltr" maxlength="40" /></div>
        <div class="field"><label class="label" for="pbar">{{ 'inventory.barcode' | t }}</label><input id="pbar" class="input" formControlName="barcode" dir="ltr" maxlength="40" /></div>
        <div class="field"><label class="label" for="pbrand">{{ 'inventory.brand' | t }}</label><input id="pbrand" class="input" formControlName="brand" maxlength="80" /></div>
        <div class="field">
          <label class="label" for="pkind">{{ 'inventory.kind' | t }}</label>
          <select id="pkind" class="input" formControlName="kind">
            @for (k of kinds; track k) { <option [value]="k">{{ 'inventory.kindName.' + k | tx }}</option> }
          </select>
        </div>
        <div class="field">
          <label class="label" for="punit">{{ 'inventory.unit' | t }}</label>
          <select id="punit" class="input" formControlName="unit">
            @for (u of units; track u) { <option [value]="u">{{ 'inventory.unitName.' + u | tx }}</option> }
          </select>
        </div>
        <div class="field"><label class="label" for="preorder">{{ 'inventory.reorderLevel' | t }}</label><input id="preorder" class="input num" inputmode="decimal" dir="ltr" formControlName="reorder_level" /></div>
        <div class="field"><label class="label" for="pprice">{{ 'inventory.salePrice' | t }}</label><input id="pprice" class="input num" inputmode="decimal" dir="ltr" formControlName="sale_price" /></div>
        <div class="field"><label class="label" for="pcost">{{ 'inventory.costPrice' | t }}</label><input id="pcost" class="input num" inputmode="decimal" dir="ltr" formControlName="cost_price" /></div>
        <div class="field">
          <label class="label" for="pvat">{{ 'services.vatCategory' | t }}</label>
          <select id="pvat" class="input" formControlName="vat_category">
            @for (v of vats; track v) { <option [value]="v">{{ 'services.vat.' + v | tx }}</option> }
          </select>
        </div>
        <div class="flex flex-wrap items-center gap-x-6 gap-y-2 sm:col-span-2">
          <label class="flex items-center gap-2 text-sm"><input type="checkbox" class="checkbox" formControlName="track_stock" />{{ 'inventory.trackStock' | t }}</label>
          <label class="flex items-center gap-2 text-sm"><input type="checkbox" class="checkbox" formControlName="is_active" />{{ 'common.active' | t }}</label>
        </div>
      </form>
      <footer class="flex justify-end gap-2 border-t border-line px-6 py-4">
        <button type="button" class="btn-secondary" (click)="ref.close()">{{ 'common.cancel' | t }}</button>
        <button type="submit" form="product-form" class="btn-primary" [disabled]="saving()">{{ 'common.save' | t }}</button>
      </footer>
    </div>
  `,
})
export class ProductDialog {
  protected readonly ref = inject<DialogRef<boolean>>(DialogRef);
  protected readonly data = inject<Product | null>(DIALOG_DATA);
  private readonly api = inject(InventoryService);
  private readonly ctx = inject(TenantContextService);
  private readonly toast = inject(ToastService);
  private readonly i18n = inject(I18nService);
  protected readonly kinds = ['retail', 'consumable', 'both'] as const;
  protected readonly units = ['pcs', 'ml', 'g', 'l', 'kg', 'box', 'set'] as const;
  protected readonly vats = ['standard', 'zero', 'exempt'] as const;
  protected readonly saving = signal(false);

  private readonly p = this.data;
  protected readonly form = inject(NonNullableFormBuilder).group({
    name_en: [this.p?.name_en ?? '', [Validators.required, Validators.minLength(2)]],
    name_ar: [this.p?.name_ar ?? ''],
    sku: [this.p?.sku ?? '', Validators.pattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/)],
    barcode: [this.p?.barcode ?? '', Validators.pattern(/^[0-9A-Za-z-]{4,40}$/)],
    brand: [this.p?.brand ?? ''],
    kind: [this.p?.kind ?? 'retail'],
    unit: [this.p?.unit ?? 'pcs'],
    sale_price: [this.p ? String(this.p.sale_price) : '0', [Validators.required, Validators.pattern(MONEY)]],
    cost_price: [this.p ? String(this.p.cost_price) : '0', [Validators.required, Validators.pattern(MONEY)]],
    reorder_level: [this.p ? String(this.p.reorder_level) : '0', [Validators.required, Validators.pattern(/^\d{1,9}(\.\d{1,3})?$/)]],
    vat_category: [this.p?.vat_category ?? 'standard'],
    track_stock: [this.p?.track_stock ?? true],
    is_active: [this.p?.is_active ?? true],
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
      await this.api.saveProduct(tenantId, this.p?.id ?? null, {
        name_en: v.name_en.trim(),
        name_ar: v.name_ar.trim() || null,
        sku: v.sku.trim() || null,
        barcode: v.barcode.trim() || null,
        brand: v.brand.trim() || null,
        kind: v.kind,
        unit: v.unit,
        sale_price: v.sale_price as unknown as number,
        cost_price: v.cost_price as unknown as number,
        reorder_level: v.reorder_level as unknown as number,
        vat_category: v.vat_category,
        track_stock: v.track_stock,
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
// Stock count / transfer dialog
// ---------------------------------------------------------------------------
export interface StockDialogData {
  mode: 'count' | 'transfer';
  branchId: string;
  rows: StockRow[];
}

@Component({
  selector: 'sz-stock-dialog',
  imports: [TranslatePipe, LucideDynamicIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="card flex max-h-[92vh] w-[min(40rem,calc(100vw-2rem))] flex-col" role="dialog" aria-modal="true">
      <header class="flex items-center justify-between border-b border-line px-6 py-4">
        <h2 class="text-lg font-semibold">{{ (data.mode === 'count' ? 'inventory.countStock' : 'inventory.transfer') | t }}</h2>
        <button type="button" class="btn-icon" (click)="ref.close()" [attr.aria-label]="'common.close' | t"><svg lucideIcon="x" [size]="18"></svg></button>
      </header>
      <div class="flex-1 space-y-4 overflow-y-auto px-6 py-5 text-sm">
        <p class="hint">{{ (data.mode === 'count' ? 'inventory.countHint' : 'inventory.transferHint') | t }}</p>
        @if (data.mode === 'transfer') {
          <div class="field">
            <label class="label" for="tto">{{ 'inventory.toBranch' | t }}</label>
            <select id="tto" class="input" [value]="to()" (change)="to.set($any($event.target).value)">
              <option value="">—</option>
              @for (b of otherBranches(); track b.id) { <option [value]="b.id">{{ i18n.pick(b.name_en, b.name_ar) }}</option> }
            </select>
          </div>
        }
        <input type="search" class="input" [placeholder]="'inventory.searchProducts' | t" [value]="filter()" (input)="filter.set($any($event.target).value)" />
        <ul class="divide-y divide-line rounded-xl border border-line">
          @for (r of visible(); track r.product_id) {
            <li class="flex items-center gap-3 px-3 py-2">
              <span class="flex-1">{{ i18n.pick(r.name_en, r.name_ar) }} <span class="text-xs text-muted">{{ r.sku }}</span></span>
              <span class="num w-20 text-end text-muted" dir="ltr">{{ r.quantity }} {{ r.unit }}</span>
              <input class="input num h-9 w-24" inputmode="decimal" dir="ltr" [value]="values()[r.product_id] ?? ''"
                     [placeholder]="data.mode === 'count' ? ('inventory.counted' | t) : '0'" (input)="set(r.product_id, $any($event.target).value)"
                     [attr.aria-label]="(data.mode === 'count' ? 'inventory.counted' : 'pos.quantity') | t" />
            </li>
          }
        </ul>
        <div class="field">
          <label class="label" for="snote">{{ 'appointments.notes' | t }}</label>
          <input id="snote" class="input" maxlength="300" [value]="note()" (input)="note.set($any($event.target).value)" />
        </div>
      </div>
      <footer class="flex justify-end gap-2 border-t border-line px-6 py-4">
        <button type="button" class="btn-secondary" (click)="ref.close()">{{ 'common.cancel' | t }}</button>
        <button type="button" class="btn-primary" [disabled]="busy() || changes().length === 0 || (data.mode === 'transfer' && !to())" (click)="submit()">
          {{ (data.mode === 'count' ? 'inventory.saveCount' : 'inventory.transfer') | t }} ({{ changes().length }})
        </button>
      </footer>
    </div>
  `,
})
export class StockDialog {
  protected readonly ref = inject<DialogRef<boolean>>(DialogRef);
  protected readonly data = inject<StockDialogData>(DIALOG_DATA);
  protected readonly i18n = inject(I18nService);
  private readonly ctx = inject(TenantContextService);
  private readonly api = inject(InventoryService);
  private readonly toast = inject(ToastService);

  protected readonly filter = signal('');
  protected readonly note = signal('');
  protected readonly to = signal('');
  protected readonly busy = signal(false);
  protected readonly values = signal<Record<string, string>>({});
  protected readonly otherBranches = computed(() => this.ctx.branches().filter((b) => b.id !== this.data.branchId));
  protected readonly visible = computed(() => {
    const f = this.filter().trim().toLowerCase();
    return this.data.rows.filter((r) => !f || [r.name_en, r.name_ar, r.sku, r.brand].some((v) => v?.toLowerCase().includes(f)));
  });
  /** Only rows the user actually changed are sent. */
  protected readonly changes = computed(() =>
    Object.entries(this.values())
      .map(([product_id, raw]) => ({ product_id, value: parseAmount(raw) }))
      .filter((c) => c.value !== null && (this.data.mode === 'count' ? c.value !== this.current(c.product_id) : c.value > 0)) as { product_id: string; value: number }[],
  );

  private current(productId: string): number {
    return this.data.rows.find((r) => r.product_id === productId)?.quantity ?? 0;
  }

  protected set(productId: string, value: string): void {
    this.values.update((v) => ({ ...v, [productId]: value }));
  }

  async submit(): Promise<void> {
    this.busy.set(true);
    try {
      if (this.data.mode === 'count') {
        await this.api.adjust(this.data.branchId, this.changes().map((c) => ({ product_id: c.product_id, counted: c.value })), this.note().trim() || null);
      } else {
        await this.api.transfer(this.data.branchId, this.to(), this.changes().map((c) => ({ product_id: c.product_id, quantity: c.value })), this.note().trim() || null);
      }
      this.toast.success(this.i18n.t('common.saved'));
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
  selector: 'sz-inventory-page',
  imports: [TranslatePipe, TranslateDynamicPipe, LucideDynamicIcon, PageHeader, StatePanel, MoneyPipe, LocalDatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <sz-page-header [heading]="'nav.inventory' | t" [subtitle]="branchName()">
      @if (canManage()) {
        @if (tab() === 'products') {
          <button type="button" class="btn-primary" (click)="openProduct(null)"><svg lucideIcon="plus" [size]="16"></svg>{{ 'inventory.addProduct' | t }}</button>
        } @else {
          @if (ctx.branches().length > 1) {
            <button type="button" class="btn-secondary" (click)="openStock('transfer')"><svg lucideIcon="truck" [size]="16"></svg>{{ 'inventory.transfer' | t }}</button>
          }
          <button type="button" class="btn-primary" (click)="openStock('count')"><svg lucideIcon="clipboard-list" [size]="16"></svg>{{ 'inventory.countStock' | t }}</button>
        }
      }
    </sz-page-header>

    <div class="mb-4 flex flex-wrap items-center gap-2">
      @if (ctx.branches().length > 1) {
        <select class="input w-48" [value]="branchId() ?? ''" (change)="ctx.setBranch($any($event.target).value)" [attr.aria-label]="'employees.branch' | t">
          @for (b of ctx.branches(); track b.id) { <option [value]="b.id">{{ i18n.pick(b.name_en, b.name_ar) }}</option> }
        </select>
      }
      @for (t of tabs; track t) {
        <button type="button" [class]="tab() === t ? 'btn-primary btn-sm' : 'btn-secondary btn-sm'" (click)="tab.set(t)">{{ 'inventory.tab.' + t | tx }}</button>
      }
      @if (tab() !== 'movements') {
        <input type="search" class="input ms-auto max-w-xs" [placeholder]="'inventory.searchProducts' | t" [value]="query()" (input)="query.set($any($event.target).value)" />
      }
    </div>

    @if (tab() === 'stock') {
      <div class="mb-4 grid gap-3 sm:grid-cols-3">
        <div class="card p-4"><p class="text-xs text-muted">{{ 'inventory.stockValue' | t }}</p><p class="num mt-1 text-xl font-semibold">{{ stockValue() | money }}</p></div>
        <div class="card p-4"><p class="text-xs text-muted">{{ 'inventory.lowStock' | t }}</p><p class="num mt-1 text-xl font-semibold" [class.text-warning]="lowCount() > 0">{{ lowCount() }}</p></div>
        <div class="card p-4"><p class="text-xs text-muted">{{ 'inventory.products' | t }}</p><p class="num mt-1 text-xl font-semibold">{{ stock().length }}</p></div>
      </div>
      <div class="card overflow-x-auto">
        @if (loading()) { <sz-state [loading]="true" /> } @else {
          <table class="table">
            <thead><tr>
              <th>{{ 'inventory.product' | t }}</th><th class="text-end">{{ 'inventory.onHand' | t }}</th>
              <th class="hidden text-end md:table-cell">{{ 'inventory.avgCost' | t }}</th><th class="text-end">{{ 'inventory.value' | t }}</th><th></th>
            </tr></thead>
            <tbody>
              @for (r of visibleStock(); track r.product_id) {
                <tr>
                  <td><p class="font-medium">{{ i18n.pick(r.name_en, r.name_ar) }}</p><p class="text-xs text-muted">{{ r.brand }} {{ r.sku }}</p></td>
                  <td class="num text-end" [class.text-danger]="r.quantity < 0" dir="ltr">{{ r.quantity }} {{ r.unit }}</td>
                  <td class="num hidden text-end text-muted md:table-cell">{{ r.avg_cost | money: false }}</td>
                  <td class="num text-end">{{ r.stock_value | money: false }}</td>
                  <td class="text-end">@if (r.low) { <span class="badge-warning">{{ 'inventory.reorder' | t }}</span> }</td>
                </tr>
              } @empty {
                <tr><td colspan="5"><sz-state icon="package" [heading]="'inventory.empty' | t" [message]="'inventory.emptyHint' | t" /></td></tr>
              }
            </tbody>
          </table>
        }
      </div>
    } @else if (tab() === 'products') {
      <div class="card overflow-x-auto">
        <table class="table">
          <thead><tr>
            <th>{{ 'inventory.product' | t }}</th><th>{{ 'inventory.kind' | t }}</th><th class="text-end">{{ 'inventory.salePrice' | t }}</th>
            <th class="hidden text-end md:table-cell">{{ 'inventory.costPrice' | t }}</th><th></th>
          </tr></thead>
          <tbody>
            @for (p of visibleProducts(); track p.id) {
              <tr [class.opacity-60]="!p.is_active" [class.cursor-pointer]="canManage()" (click)="canManage() && openProduct(p)">
                <td><p class="font-medium">{{ i18n.pick(p.name_en, p.name_ar) }}</p><p class="text-xs text-muted" dir="ltr">{{ p.sku }} {{ p.barcode }}</p></td>
                <td><span class="badge-muted">{{ 'inventory.kindName.' + p.kind | tx }}</span></td>
                <td class="num text-end">{{ p.kind === 'consumable' ? '—' : (p.sale_price | money) }}</td>
                <td class="num hidden text-end text-muted md:table-cell">{{ p.cost_price | money }}</td>
                <td class="text-end">@if (!p.is_active) { <span class="badge-warning">{{ 'common.inactive' | t }}</span> }</td>
              </tr>
            } @empty {
              <tr><td colspan="5"><sz-state icon="package" [heading]="'inventory.noProducts' | t" /></td></tr>
            }
          </tbody>
        </table>
      </div>
    } @else {
      <div class="mb-3">
        <select class="input w-64" [value]="movementProduct() ?? ''" (change)="movementProduct.set($any($event.target).value || null)" [attr.aria-label]="'inventory.product' | t">
          <option value="">{{ 'inventory.allProducts' | t }}</option>
          @for (p of products(); track p.id) { <option [value]="p.id">{{ i18n.pick(p.name_en, p.name_ar) }}</option> }
        </select>
      </div>
      <div class="card overflow-x-auto">
        <table class="table">
          <thead><tr>
            <th>{{ 'appointments.date' | t }}</th><th>{{ 'inventory.product' | t }}</th><th>{{ 'inventory.reason' | t }}</th>
            <th class="text-end">{{ 'pos.quantity' | t }}</th><th class="hidden text-end md:table-cell">{{ 'inventory.unitCost' | t }}</th><th class="text-end">{{ 'inventory.balance' | t }}</th>
          </tr></thead>
          <tbody>
            @for (m of movements(); track m.id) {
              <tr>
                <td class="text-muted">{{ m.created_at | localDate: 'datetime' }}</td>
                <td>{{ productName(m.product_id) }}</td>
                <td><span class="badge-muted">{{ 'inventory.reasonName.' + m.reason | tx }}</span>@if (m.note) { <span class="block text-xs text-muted">{{ m.note }}</span> }</td>
                <td class="num text-end" [class.text-success]="m.quantity > 0" [class.text-danger]="m.quantity < 0" dir="ltr">{{ m.quantity > 0 ? '+' : '' }}{{ m.quantity }}</td>
                <td class="num hidden text-end text-muted md:table-cell">{{ m.unit_cost | money: false }}</td>
                <td class="num text-end" dir="ltr">{{ m.balance_after }}</td>
              </tr>
            } @empty {
              <tr><td colspan="6" class="py-8 text-center text-muted">{{ 'inventory.noMovements' | t }}</td></tr>
            }
          </tbody>
        </table>
      </div>
    }
  `,
})
export class InventoryPage {
  protected readonly ctx = inject(TenantContextService);
  protected readonly i18n = inject(I18nService);
  private readonly api = inject(InventoryService);
  private readonly dialog = inject(Dialog);
  private readonly toast = inject(ToastService);

  protected readonly tabs: Tab[] = ['stock', 'products', 'movements'];
  protected readonly tab = signal<Tab>('stock');
  protected readonly query = signal('');
  protected readonly loading = signal(true);
  protected readonly stock = signal<StockRow[]>([]);
  protected readonly products = signal<Product[]>([]);
  protected readonly movements = signal<Movement[]>([]);
  protected readonly movementProduct = signal<string | null>(null);
  protected readonly canManage = computed(() => this.ctx.can('inventory.manage'));
  protected readonly branchId = computed<string | null>(() => this.ctx.branchId() ?? this.ctx.branches().at(0)?.id ?? null);
  protected readonly branchName = computed(() => {
    const b = this.ctx.branches().find((x) => x.id === this.branchId());
    return b ? this.i18n.pick(b.name_en, b.name_ar) : '';
  });
  protected readonly stockValue = computed(() => this.stock().reduce((s, r) => s + Number(r.stock_value), 0));
  protected readonly lowCount = computed(() => this.stock().filter((r) => r.low).length);
  private readonly match = (fields: (string | null)[]) => {
    const q = this.query().trim().toLowerCase();
    return !q || fields.some((v) => v?.toLowerCase().includes(q));
  };
  protected readonly visibleStock = computed(() => this.stock().filter((r) => this.match([r.name_en, r.name_ar, r.sku, r.brand])));
  protected readonly visibleProducts = computed(() => this.products().filter((p) => this.match([p.name_en, p.name_ar, p.sku, p.brand, p.barcode])));

  constructor() {
    effect(() => {
      const branch = this.branchId();
      untracked(() => void this.load(branch));
    });
    effect(() => {
      const branch = this.branchId();
      const product = this.movementProduct();
      if (this.tab() === 'movements' && branch) untracked(() => void this.loadMovements(branch, product));
    });
  }

  async load(branchId: string | null): Promise<void> {
    const tenantId = this.ctx.tenantId();
    if (!tenantId || !branchId) return;
    this.loading.set(true);
    try {
      const [stock, products] = await Promise.all([this.api.stock(branchId), this.api.products(tenantId)]);
      this.stock.set(stock);
      this.products.set(products);
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.loading.set(false);
    }
  }

  private async loadMovements(branchId: string, productId: string | null): Promise<void> {
    try {
      this.movements.set(await this.api.movements(branchId, productId));
    } catch (err) {
      this.toast.error(err);
    }
  }

  protected productName(id: string): string {
    const p = this.products().find((x) => x.id === id);
    return p ? this.i18n.pick(p.name_en, p.name_ar) : '—';
  }

  openProduct(p: Product | null): void {
    this.dialog.open<boolean, Product | null>(ProductDialog, { data: p }).closed.subscribe((changed) => changed && void this.load(this.branchId()));
  }

  openStock(mode: 'count' | 'transfer'): void {
    const branchId = this.branchId();
    if (!branchId) return;
    const rows = this.stock().filter((r) => mode === 'count' || r.quantity > 0);
    this.dialog.open<boolean, StockDialogData>(StockDialog, { data: { mode, branchId, rows } }).closed.subscribe((changed) => {
      if (changed) {
        void this.load(branchId);
        if (this.tab() === 'movements') void this.loadMovements(branchId, this.movementProduct());
      }
    });
  }
}

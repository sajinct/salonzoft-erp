import { Dialog, DialogRef, DIALOG_DATA } from '@angular/cdk/dialog';
import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { LucideDynamicIcon } from '@lucide/angular';
import { I18nService, TranslateDynamicPipe, TranslatePipe } from '../../core/i18n/i18n.service';
import { ToastService } from '../../core/services/toast.service';
import { TenantContextService } from '../../core/tenant/tenant-context.service';
import { ConfirmService, PageHeader, StatePanel } from '../../shared/components/ui';
import { MoneyPipe } from '../../shared/pipes/format.pipes';
import { InventoryService, Product } from '../inventory/data/inventory.service';
import { downloadCsv, downloadXlsx, servicesToTable } from './data/services-io';
import { BranchPriceInput, Service, ServiceCategory, ServiceInput, ServicePrice, ServicesService } from './data/services.service';
import { ServicesImportDialog } from './services-import.dialog';

const MONEY = /^\d{1,9}(\.\d{1,3})?$/;

// ---------------------------------------------------------------------------
// Category dialog
// ---------------------------------------------------------------------------
@Component({
  selector: 'sz-category-dialog',
  imports: [ReactiveFormsModule, TranslatePipe, LucideDynamicIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form class="card w-[min(28rem,calc(100vw-2rem))] p-6" [formGroup]="form" (ngSubmit)="save()" novalidate role="dialog" aria-modal="true">
      <div class="mb-4 flex items-center justify-between">
        <h2 class="text-lg font-semibold">{{ (category ? 'services.editCategory' : 'services.addCategory') | t }}</h2>
        <button type="button" class="btn-icon" (click)="ref.close()" [attr.aria-label]="'common.close' | t"><svg lucideIcon="x" [size]="18"></svg></button>
      </div>
      <div class="grid gap-4">
        <div class="field"><label class="label" for="cen">{{ 'common.nameEn' | t }}</label><input id="cen" class="input" formControlName="name_en" maxlength="80" /></div>
        <div class="field"><label class="label" for="car">{{ 'common.nameAr' | t }}</label><input id="car" class="input" formControlName="name_ar" dir="rtl" lang="ar" maxlength="80" /></div>
        <div class="field"><label class="label" for="cso">{{ 'common.sortOrder' | t }}</label><input id="cso" class="input w-28" type="number" formControlName="sort_order" /></div>
        <label class="flex items-center gap-2 text-sm"><input type="checkbox" class="checkbox" formControlName="is_active" />{{ 'common.active' | t }}</label>
      </div>
      <div class="mt-6 flex items-center justify-between gap-2">
        @if (category) {
          <button type="button" class="btn-ghost text-danger" (click)="remove()">{{ 'common.delete' | t }}</button>
        } @else {
          <span></span>
        }
        <div class="flex gap-2">
          <button type="button" class="btn-secondary" (click)="ref.close()">{{ 'common.cancel' | t }}</button>
          <button type="submit" class="btn-primary" [disabled]="saving()">{{ 'common.save' | t }}</button>
        </div>
      </div>
    </form>
  `,
})
export class CategoryDialog {
  protected readonly ref = inject<DialogRef<boolean>>(DialogRef);
  protected readonly category = inject<ServiceCategory | null>(DIALOG_DATA);
  private readonly service = inject(ServicesService);
  private readonly ctx = inject(TenantContextService);
  private readonly toast = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  private readonly i18n = inject(I18nService);
  protected readonly saving = signal(false);

  protected readonly form = inject(NonNullableFormBuilder).group({
    name_en: [this.category?.name_en ?? '', [Validators.required, Validators.minLength(2), Validators.maxLength(80)]],
    name_ar: [this.category?.name_ar ?? ''],
    sort_order: [this.category?.sort_order ?? 0],
    is_active: [this.category?.is_active ?? true],
  });

  async save(): Promise<void> {
    const tenantId = this.ctx.tenantId();
    if (!tenantId || this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const v = this.form.getRawValue();
    const input = { name_en: v.name_en.trim(), name_ar: v.name_ar.trim() || null, sort_order: Number(v.sort_order) || 0, is_active: v.is_active };
    this.saving.set(true);
    try {
      if (this.category) await this.service.updateCategory(this.category.id, input);
      else await this.service.createCategory(tenantId, input);
      this.toast.success(this.i18n.t('common.saved'));
      this.ref.close(true);
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.saving.set(false);
    }
  }

  async remove(): Promise<void> {
    if (!this.category) return;
    const ok = await this.confirm.ask({
      title: this.i18n.t('services.deleteCategory'),
      message: this.i18n.t('services.confirmDeleteCategory', { name: this.category.name_en }),
      confirmLabel: this.i18n.t('common.delete'),
      danger: true,
    });
    if (!ok) return;
    try {
      await this.service.deleteCategory(this.category.id);
      this.ref.close(true);
    } catch (err) {
      this.toast.error(err);
    }
  }
}

// ---------------------------------------------------------------------------
// Service dialog
// ---------------------------------------------------------------------------
export interface ServiceDialogData {
  service: Service | null;
  categories: ServiceCategory[];
  prices: ServicePrice[];
  defaultCategoryId: string | null;
  /** Consumable products, for 'products used per service'. */
  consumables: Product[];
}

interface BranchPriceRow {
  branch_id: string;
  name: string;
  price: string;
  is_available: boolean;
}

@Component({
  selector: 'sz-service-dialog',
  imports: [ReactiveFormsModule, TranslatePipe, TranslateDynamicPipe, LucideDynamicIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="card flex max-h-[90vh] w-[min(46rem,calc(100vw-2rem))] flex-col" role="dialog" aria-modal="true">
      <header class="flex items-center justify-between border-b border-line px-6 py-4">
        <h2 class="text-lg font-semibold">{{ (data.service ? 'services.edit' : 'services.add') | t }}</h2>
        <button type="button" class="btn-icon" (click)="ref.close()" [attr.aria-label]="'common.close' | t"><svg lucideIcon="x" [size]="18"></svg></button>
      </header>

      <div class="flex-1 space-y-6 overflow-y-auto px-6 py-5">
        <form [formGroup]="form" id="service-form" class="grid gap-4 sm:grid-cols-2" (ngSubmit)="save()" novalidate>
          <div class="field"><label class="label" for="sen">{{ 'common.nameEn' | t }}</label><input id="sen" class="input" formControlName="name_en" maxlength="120" /></div>
          <div class="field"><label class="label" for="sar">{{ 'common.nameAr' | t }}</label><input id="sar" class="input" formControlName="name_ar" dir="rtl" lang="ar" maxlength="120" /></div>
          <div class="field">
            <label class="label" for="scat">{{ 'services.category' | t }}</label>
            <select id="scat" class="input" formControlName="category_id">
              <option value="">{{ 'services.uncategorised' | t }}</option>
              @for (c of data.categories; track c.id) {
                <option [value]="c.id">{{ i18n.pick(c.name_en, c.name_ar) }}</option>
              }
            </select>
          </div>
          <div class="field">
            <label class="label" for="scode">{{ 'services.code' | t }} <span class="hint">({{ 'common.optional' | t }})</span></label>
            <input id="scode" class="input uppercase" formControlName="code" dir="ltr" maxlength="20" />
          </div>
          <div class="field">
            <label class="label" for="sdur">{{ 'services.duration' | t }}</label>
            <input id="sdur" class="input" type="number" min="5" max="720" step="5" formControlName="duration_minutes" dir="ltr" />
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div class="field"><label class="label" for="sbb">{{ 'services.bufferBefore' | t }}</label><input id="sbb" class="input" type="number" min="0" max="120" formControlName="buffer_before_minutes" dir="ltr" /></div>
            <div class="field"><label class="label" for="sba">{{ 'services.bufferAfter' | t }}</label><input id="sba" class="input" type="number" min="0" max="120" formControlName="buffer_after_minutes" dir="ltr" /></div>
          </div>
          <div class="field">
            <label class="label" for="sprice">{{ 'services.price' | t }}</label>
            <input id="sprice" class="input num" inputmode="decimal" formControlName="price" dir="ltr" placeholder="0.000" />
            @if (form.controls.price.invalid && form.controls.price.touched) { <p class="error-text">{{ 'services.priceInvalid' | t }}</p> }
          </div>
          <div class="field">
            <label class="label" for="sptype">{{ 'services.priceType' | t }}</label>
            <select id="sptype" class="input" formControlName="price_type">
              @for (p of priceTypes; track p) { <option [value]="p">{{ 'services.priceType.' + p | tx }}</option> }
            </select>
          </div>
          <div class="field">
            <label class="label" for="svat">{{ 'services.vatCategory' | t }}</label>
            <select id="svat" class="input" formControlName="vat_category">
              @for (v of vatCategories; track v) { <option [value]="v">{{ 'services.vat.' + v | tx }}</option> }
            </select>
          </div>
          <div class="field">
            <label class="label" for="saud">{{ 'services.audience' | t }}</label>
            <select id="saud" class="input" formControlName="audience">
              @for (a of audiences; track a) { <option [value]="a">{{ 'services.audience.' + a | tx }}</option> }
            </select>
          </div>
          <div class="field sm:col-span-2"><label class="label" for="sden">{{ 'services.descriptionEn' | t }}</label><textarea id="sden" class="input" rows="2" formControlName="description_en" maxlength="1000"></textarea></div>
          <div class="field sm:col-span-2"><label class="label" for="sdar">{{ 'services.descriptionAr' | t }}</label><textarea id="sdar" class="input" rows="2" formControlName="description_ar" dir="rtl" lang="ar" maxlength="1000"></textarea></div>
          <div class="flex flex-wrap items-center gap-x-6 gap-y-2 sm:col-span-2">
            <label class="flex items-center gap-2 text-sm"><input type="checkbox" class="checkbox" formControlName="is_active" />{{ 'common.active' | t }}</label>
            <label class="flex items-center gap-2 text-sm"><input type="checkbox" class="checkbox" formControlName="online_bookable" />{{ 'services.onlineBookable' | t }}</label>
            <label class="flex items-center gap-2 text-sm">
              {{ 'services.color' | t }}<input type="color" class="h-8 w-10 cursor-pointer rounded border border-line" formControlName="color" />
            </label>
          </div>
        </form>

        @if (data.consumables.length > 0) {
          <section>
            <h3 class="font-semibold">{{ 'services.productsUsed' | t }}</h3>
            <p class="hint mb-3">{{ 'services.productsUsedHint' | t }}</p>
            <ul class="space-y-2">
              @for (u of usage(); track $index; let i = $index) {
                <li class="flex items-center gap-2">
                  <select class="input h-9 flex-1" [value]="u.product_id" (change)="setUsage(i, 'product_id', $any($event.target).value)" [attr.aria-label]="'inventory.product' | t">
                    <option value="">—</option>
                    @for (p of data.consumables; track p.id) { <option [value]="p.id">{{ i18n.pick(p.name_en, p.name_ar) }} ({{ p.unit }})</option> }
                  </select>
                  <input class="input num h-9 w-24" inputmode="decimal" dir="ltr" [value]="u.quantity" (input)="setUsage(i, 'quantity', $any($event.target).value)" [attr.aria-label]="'pos.quantity' | t" />
                  <button type="button" class="btn-icon h-8 w-8" (click)="removeUsage(i)" [attr.aria-label]="'common.remove' | t"><svg lucideIcon="trash-2" [size]="14"></svg></button>
                </li>
              }
            </ul>
            <button type="button" class="btn-ghost btn-sm mt-2" (click)="addUsage()"><svg lucideIcon="plus" [size]="14"></svg>{{ 'services.addProduct' | t }}</button>
          </section>
        }

        @if (branchRows().length > 1) {
          <section>
            <h3 class="font-semibold">{{ 'services.branchPrices' | t }}</h3>
            <p class="hint mb-3">{{ 'services.branchPricesHint' | t }}</p>
            <div class="divide-y divide-line rounded-xl border border-line">
              @for (b of branchRows(); track b.branch_id; let i = $index) {
                <div class="flex flex-wrap items-center gap-3 px-4 py-2.5">
                  <span class="min-w-32 flex-1 text-sm font-medium">{{ b.name }}</span>
                  <input class="input num h-9 w-32" inputmode="decimal" dir="ltr" [placeholder]="form.controls.price.value || '0.000'"
                         [value]="b.price" (input)="setBranch(i, 'price', $event)" [disabled]="!b.is_available"
                         [attr.aria-label]="'services.price' | t" />
                  <label class="flex items-center gap-2 text-sm">
                    <input type="checkbox" class="checkbox" [checked]="b.is_available" (change)="setBranch(i, 'is_available', $event)" />{{ 'services.offeredHere' | t }}
                  </label>
                </div>
              }
            </div>
          </section>
        }
      </div>

      <footer class="flex justify-end gap-2 border-t border-line px-6 py-4">
        <button type="button" class="btn-secondary" (click)="ref.close()">{{ 'common.cancel' | t }}</button>
        <button type="submit" form="service-form" class="btn-primary" [disabled]="saving()">{{ saving() ? ('common.saving' | t) : ('common.save' | t) }}</button>
      </footer>
    </div>
  `,
})
export class ServiceDialog {
  protected readonly ref = inject<DialogRef<boolean>>(DialogRef);
  protected readonly data = inject<ServiceDialogData>(DIALOG_DATA);
  protected readonly i18n = inject(I18nService);
  private readonly service = inject(ServicesService);
  private readonly ctx = inject(TenantContextService);
  private readonly toast = inject(ToastService);

  protected readonly priceTypes = ['fixed', 'from', 'variable'] as const;
  protected readonly vatCategories = ['standard', 'zero', 'exempt'] as const;
  protected readonly audiences = ['all', 'female', 'male'] as const;
  protected readonly saving = signal(false);

  private readonly s = this.data.service;
  protected readonly form = inject(NonNullableFormBuilder).group({
    name_en: [this.s?.name_en ?? '', [Validators.required, Validators.minLength(2), Validators.maxLength(120)]],
    name_ar: [this.s?.name_ar ?? ''],
    category_id: [this.s?.category_id ?? this.data.defaultCategoryId ?? ''],
    code: [this.s?.code ?? '', Validators.pattern(/^[A-Za-z0-9][A-Za-z0-9-]{0,19}$/)],
    duration_minutes: [this.s?.duration_minutes ?? 30, [Validators.required, Validators.min(5), Validators.max(720)]],
    buffer_before_minutes: [this.s?.buffer_before_minutes ?? 0, [Validators.min(0), Validators.max(120)]],
    buffer_after_minutes: [this.s?.buffer_after_minutes ?? 0, [Validators.min(0), Validators.max(120)]],
    price: [this.s ? String(this.s.price) : '', [Validators.required, Validators.pattern(MONEY)]],
    price_type: [(this.s?.price_type ?? 'fixed') as string],
    vat_category: [(this.s?.vat_category ?? 'standard') as string],
    audience: [(this.s?.audience ?? 'all') as string],
    description_en: [this.s?.description_en ?? ''],
    description_ar: [this.s?.description_ar ?? ''],
    online_bookable: [this.s?.online_bookable ?? true],
    is_active: [this.s?.is_active ?? true],
    color: [this.s?.color ?? '#b4637a'],
  });

  protected readonly branchRows = signal<BranchPriceRow[]>(
    this.ctx.branches().map((b) => {
      const override = this.data.prices.find((p) => p.service_id === this.s?.id && p.branch_id === b.id);
      return {
        branch_id: b.id,
        name: this.i18n.pick(b.name_en, b.name_ar),
        price: override?.price != null ? String(override.price) : '',
        is_available: override?.is_available ?? true,
      };
    }),
  );

  private readonly inventory = inject(InventoryService);
  private usageLoaded = false;
  protected readonly usage = signal<{ product_id: string; quantity: string }[]>([]);

  constructor() {
    if (this.s && this.data.consumables.length > 0) {
      this.inventory.usage(this.s.id).then(
        (rows) => {
          this.usage.set(rows.map((r) => ({ product_id: r.product_id, quantity: String(r.quantity) })));
          this.usageLoaded = true;
        },
        () => undefined,
      );
    }
  }

  protected addUsage(): void {
    this.usage.update((u) => [...u, { product_id: '', quantity: '1' }]);
  }
  protected removeUsage(i: number): void {
    this.usage.update((u) => u.filter((_, j) => j !== i));
  }
  protected setUsage(i: number, field: 'product_id' | 'quantity', value: string): void {
    this.usage.update((u) => u.map((row, j) => (j === i ? { ...row, [field]: value } : row)));
  }

  protected setBranch(index: number, field: 'price' | 'is_available', event: Event): void {
    const el = event.target as HTMLInputElement;
    const value = field === 'price' ? el.value.trim() : el.checked;
    this.branchRows.update((rows) => rows.map((r, i) => (i === index ? { ...r, [field]: value } : r)));
  }

  async save(): Promise<void> {
    const tenantId = this.ctx.tenantId();
    const badBranchPrice = this.branchRows().some((r) => r.price !== '' && !MONEY.test(r.price));
    if (!tenantId || this.form.invalid || badBranchPrice) {
      this.form.markAllAsTouched();
      if (badBranchPrice) this.toast.error({ message: 'INVALID_PRICE' });
      return;
    }
    const v = this.form.getRawValue();
    const input: ServiceInput = {
      name_en: v.name_en.trim(),
      name_ar: v.name_ar.trim() || null,
      category_id: v.category_id || null,
      code: v.code.trim().toUpperCase() || null,
      duration_minutes: Number(v.duration_minutes),
      buffer_before_minutes: Number(v.buffer_before_minutes) || 0,
      buffer_after_minutes: Number(v.buffer_after_minutes) || 0,
      price: v.price as unknown as number, // numeric: sent as an exact decimal string
      price_type: v.price_type,
      vat_category: v.vat_category,
      audience: v.audience,
      description_en: v.description_en.trim() || null,
      description_ar: v.description_ar.trim() || null,
      online_bookable: v.online_bookable,
      is_active: v.is_active,
      color: v.color || null,
    };
    this.saving.set(true);
    try {
      const saved = this.s ? await this.service.updateService(this.s.id, input) : await this.service.createService(tenantId, input);
      if (this.data.consumables.length > 0 && (this.usageLoaded || this.usage().some((u) => u.product_id))) {
        const items = this.usage().filter((u) => u.product_id && Number(u.quantity) > 0).map((u) => ({ product_id: u.product_id, quantity: Number(u.quantity) }));
        await this.inventory.setUsage(saved.id, items);
      }
      if (this.branchRows().length > 1) {
        const rows: BranchPriceInput[] = this.branchRows().map((r) => ({ branch_id: r.branch_id, price: r.price || null, is_available: r.is_available }));
        await this.service.setBranchPrices(saved.id, rows);
      }
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
// Page
// ---------------------------------------------------------------------------
@Component({
  selector: 'sz-services-page',
  imports: [TranslatePipe, LucideDynamicIcon, PageHeader, StatePanel, MoneyPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <sz-page-header [heading]="'nav.services' | t" [subtitle]="'services.subtitle' | t">
      @if (services().length > 0) {
        <button type="button" class="btn-secondary" (click)="export('xlsx')" [title]="'services.exportHint' | t"><svg lucideIcon="download" [size]="16"></svg>{{ 'services.exportExcel' | t }}</button>
        <button type="button" class="btn-secondary" (click)="export('csv')" [title]="'services.exportHint' | t"><svg lucideIcon="download" [size]="16"></svg>CSV</button>
      }
      @if (canManage()) {
        <button type="button" class="btn-secondary" (click)="openImport()"><svg lucideIcon="upload" [size]="16"></svg>{{ 'services.import' | t }}</button>
        <button type="button" class="btn-secondary" (click)="openCategory(null)"><svg lucideIcon="folder-plus" [size]="16"></svg>{{ 'services.addCategory' | t }}</button>
        <button type="button" class="btn-primary" (click)="openService(null)"><svg lucideIcon="plus" [size]="16"></svg>{{ 'services.add' | t }}</button>
      }
    </sz-page-header>

    <div class="mb-4 flex flex-wrap items-center gap-2">
      <button type="button" class="btn-sm" [class]="category() === null ? 'btn-primary btn-sm' : 'btn-secondary btn-sm'" (click)="category.set(null)">
        {{ 'common.all' | t }} <span class="opacity-70">{{ countIn(null) }}</span>
      </button>
      @for (c of categories(); track c.id) {
        <span class="inline-flex items-center">
          <button type="button" [class]="category() === c.id ? 'btn-primary btn-sm' : 'btn-secondary btn-sm'" (click)="category.set(c.id)">
            {{ i18n.pick(c.name_en, c.name_ar) }} <span class="opacity-70">{{ countIn(c.id) }}</span>
            @if (!c.is_active) { <span class="badge-warning">{{ 'common.inactive' | t }}</span> }
          </button>
          @if (canManage() && category() === c.id) {
            <button type="button" class="btn-icon h-8 w-8" (click)="openCategory(c)" [attr.aria-label]="'common.edit' | t"><svg lucideIcon="pencil" [size]="14"></svg></button>
          }
        </span>
      }
    </div>

    <div class="mb-4 flex flex-wrap items-center gap-3">
      <input type="search" class="input max-w-xs" [placeholder]="'services.search' | t" [value]="query()" (input)="query.set($any($event.target).value)" />
      <label class="flex items-center gap-2 text-sm text-muted"><input type="checkbox" class="checkbox" [checked]="showInactive()" (change)="showInactive.set($any($event.target).checked)" />{{ 'common.showInactive' | t }}</label>
    </div>

    <div class="card overflow-x-auto">
      @if (loading()) {
        <sz-state [loading]="true" />
      } @else if (visible().length === 0) {
        <sz-state icon="scissors" [heading]="'services.emptyTitle' | t" [message]="(canManage() ? 'services.emptyManage' : 'services.empty') | t" />
      } @else {
        <table class="table">
          <thead>
            <tr>
              <th>{{ 'services.service' | t }}</th>
              <th class="hidden md:table-cell">{{ 'services.category' | t }}</th>
              <th>{{ 'services.duration' | t }}</th>
              <th class="text-end">{{ 'services.price' | t }}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            @for (s of visible(); track s.id) {
              <tr [class.opacity-60]="!s.is_active" [class.cursor-pointer]="canManage()" (click)="canManage() && openService(s)">
                <td>
                  <div class="flex items-center gap-2">
                    <span class="h-2.5 w-2.5 shrink-0 rounded-full" [style.background]="s.color || 'var(--sz-primary)'"></span>
                    <span class="font-medium">{{ i18n.pick(s.name_en, s.name_ar) }}</span>
                    @if (s.code) { <span class="badge-muted" dir="ltr">{{ s.code }}</span> }
                  </div>
                </td>
                <td class="hidden text-muted md:table-cell">{{ categoryName(s.category_id) }}</td>
                <td class="num text-muted">{{ 'services.minutes' | t: { n: s.duration_minutes } }}</td>
                <td class="num text-end">
                  @if (s.price_type === 'variable') {
                    <span class="text-muted">{{ 'services.priceType.variable' | t }}</span>
                  } @else {
                    @if (s.price_type === 'from') { <span class="text-xs text-muted">{{ 'services.from' | t }}</span> }
                    {{ s.price | money }}
                  }
                  @if (hasOverrides(s.id)) { <span class="badge-muted ms-1" [title]="'services.branchPrices' | t">±</span> }
                </td>
                <td class="text-end">
                  @if (!s.is_active) { <span class="badge-warning">{{ 'common.inactive' | t }}</span> }
                  @else if (!s.online_bookable) { <span class="badge-muted">{{ 'services.inStoreOnly' | t }}</span> }
                </td>
              </tr>
            }
          </tbody>
        </table>
      }
    </div>
  `,
})
export class ServicesPage implements OnInit {
  private readonly service = inject(ServicesService);
  private readonly ctx = inject(TenantContextService);
  private readonly dialog = inject(Dialog);
  private readonly toast = inject(ToastService);
  protected readonly i18n = inject(I18nService);

  protected readonly loading = signal(true);
  protected readonly categories = signal<ServiceCategory[]>([]);
  protected readonly services = signal<Service[]>([]);
  protected readonly prices = signal<ServicePrice[]>([]);
  protected readonly consumables = signal<Product[]>([]);
  private readonly inventory = inject(InventoryService);
  protected readonly category = signal<string | null>(null);
  protected readonly query = signal('');
  protected readonly showInactive = signal(false);
  protected readonly canManage = computed(() => this.ctx.can('services.manage'));

  protected readonly visible = computed(() => {
    const q = this.query().trim().toLowerCase();
    const cat = this.category();
    return this.services().filter(
      (s) =>
        (this.showInactive() || s.is_active) &&
        (cat === null || s.category_id === cat) &&
        (!q || [s.name_en, s.name_ar, s.code].some((v) => v?.toLowerCase().includes(q))),
    );
  });

  ngOnInit(): void {
    void this.load();
  }

  async load(): Promise<void> {
    const tenantId = this.ctx.tenantId();
    if (!tenantId) return;
    try {
      const data = await this.service.load(tenantId);
      this.categories.set(data.categories);
      this.services.set(data.services);
      this.prices.set(data.prices);
      if (this.ctx.can('inventory.manage') || this.ctx.can('services.manage')) {
        this.inventory.products(tenantId).then((ps) => this.consumables.set(ps.filter((p) => p.is_active && p.kind !== 'retail')), () => undefined);
      }
      if (this.category() && !data.categories.some((c) => c.id === this.category())) this.category.set(null);
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.loading.set(false);
    }
  }

  protected countIn(categoryId: string | null): number {
    return this.services().filter((s) => (this.showInactive() || s.is_active) && (categoryId === null || s.category_id === categoryId)).length;
  }

  protected categoryName(id: string | null): string {
    const c = this.categories().find((x) => x.id === id);
    return c ? this.i18n.pick(c.name_en, c.name_ar) : '—';
  }

  protected hasOverrides(serviceId: string): boolean {
    return this.prices().some((p) => p.service_id === serviceId);
  }

  /** The whole catalogue (not only the filtered list), in the layout the import reads back. */
  protected async export(kind: 'csv' | 'xlsx'): Promise<void> {
    const table = servicesToTable(this.services(), this.categories());
    const name = `services-${new Date().toISOString().slice(0, 10)}`;
    try {
      if (kind === 'csv') downloadCsv(table, `${name}.csv`);
      else await downloadXlsx(table, `${name}.xlsx`);
    } catch (err) {
      this.toast.error(err);
    }
  }

  openImport(): void {
    this.dialog.open<boolean>(ServicesImportDialog, { disableClose: true }).closed.subscribe((imported) => {
      if (imported) void this.load();
    });
  }

  openCategory(category: ServiceCategory | null): void {
    this.dialog.open<boolean, ServiceCategory | null>(CategoryDialog, { data: category }).closed.subscribe((changed) => {
      if (changed) void this.load();
    });
  }

  openService(service: Service | null): void {
    const data: ServiceDialogData = { service, categories: this.categories(), prices: this.prices(), defaultCategoryId: this.category(), consumables: this.consumables() };
    this.dialog.open<boolean, ServiceDialogData>(ServiceDialog, { data }).closed.subscribe((changed) => {
      if (changed) void this.load();
    });
  }
}

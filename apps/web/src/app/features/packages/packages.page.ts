import { Dialog, DialogRef, DIALOG_DATA } from '@angular/cdk/dialog';
import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { LucideDynamicIcon } from '@lucide/angular';
import { I18nService, TranslateDynamicPipe, TranslatePipe } from '../../core/i18n/i18n.service';
import { ToastService } from '../../core/services/toast.service';
import { TenantContextService } from '../../core/tenant/tenant-context.service';
import { PageHeader, StatePanel } from '../../shared/components/ui';
import { LocalDatePipe, MoneyPipe } from '../../shared/pipes/format.pipes';
import { Service, ServicesService } from '../services/data/services.service';
import { GiftVoucher, Membership, Package, PackageItem, PackagesService } from './data/packages.service';

const MONEY = /^\d{1,9}(\.\d{1,3})?$/;
type Tab = 'packages' | 'memberships' | 'vouchers';

// ---------------------------------------------------------------------------
// Package dialog
// ---------------------------------------------------------------------------
interface PackageDialogData {
  pkg: Package | null;
  items: PackageItem[];
  services: Service[];
}

@Component({
  selector: 'sz-package-dialog',
  imports: [ReactiveFormsModule, TranslatePipe, LucideDynamicIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="card flex max-h-[92vh] w-[min(36rem,calc(100vw-2rem))] flex-col" role="dialog" aria-modal="true">
      <header class="flex items-center justify-between border-b border-line px-6 py-4">
        <h2 class="text-lg font-semibold">{{ (data.pkg ? 'packages.editPackage' : 'packages.addPackage') | t }}</h2>
        <button type="button" class="btn-icon" (click)="ref.close()" [attr.aria-label]="'common.close' | t"><svg lucideIcon="x" [size]="18"></svg></button>
      </header>
      <form [formGroup]="form" id="pkg-form" class="flex-1 space-y-4 overflow-y-auto px-6 py-5" (ngSubmit)="save()" novalidate>
        <div class="grid gap-4 sm:grid-cols-2">
          <div class="field"><label class="label" for="pen">{{ 'common.nameEn' | t }}</label><input id="pen" class="input" formControlName="name_en" maxlength="120" /></div>
          <div class="field"><label class="label" for="par">{{ 'common.nameAr' | t }}</label><input id="par" class="input" formControlName="name_ar" dir="rtl" lang="ar" maxlength="120" /></div>
          <div class="field"><label class="label" for="ppr">{{ 'services.price' | t }}</label><input id="ppr" class="input num" inputmode="decimal" dir="ltr" formControlName="price" /></div>
          <div class="field"><label class="label" for="pval">{{ 'packages.validity' | t }}</label><input id="pval" class="input num" type="number" min="1" dir="ltr" formControlName="validity_days" [placeholder]="'packages.noExpiry' | t" /></div>
        </div>
        <section>
          <h3 class="label mb-2">{{ 'packages.includes' | t }}</h3>
          <ul class="space-y-2">
            @for (r of rows(); track $index; let i = $index) {
              <li class="flex items-center gap-2">
                <select class="input flex-1" [value]="r.service_id" (change)="setRow(i, 'service_id', $any($event.target).value)" [attr.aria-label]="'services.service' | t">
                  <option value="">—</option>
                  @for (s of data.services; track s.id) { <option [value]="s.id">{{ i18n.pick(s.name_en, s.name_ar) }}</option> }
                </select>
                <input class="input num w-20" type="number" min="1" max="500" dir="ltr" [value]="r.sessions" (change)="setRow(i, 'sessions', $any($event.target).value)" [attr.aria-label]="'packages.sessions' | t" />
                <span class="text-sm text-muted">{{ 'packages.sessions' | t }}</span>
                <button type="button" class="btn-icon h-8 w-8" (click)="removeRow(i)" [attr.aria-label]="'common.remove' | t"><svg lucideIcon="trash-2" [size]="14"></svg></button>
              </li>
            }
          </ul>
          <button type="button" class="btn-ghost btn-sm mt-2" (click)="addRow()"><svg lucideIcon="plus" [size]="14"></svg>{{ 'packages.addService' | t }}</button>
        </section>
        <label class="flex items-center gap-2 text-sm"><input type="checkbox" class="checkbox" formControlName="is_active" />{{ 'common.active' | t }}</label>
      </form>
      <footer class="flex justify-end gap-2 border-t border-line px-6 py-4">
        <button type="button" class="btn-secondary" (click)="ref.close()">{{ 'common.cancel' | t }}</button>
        <button type="submit" form="pkg-form" class="btn-primary" [disabled]="saving()">{{ 'common.save' | t }}</button>
      </footer>
    </div>
  `,
})
export class PackageDialog {
  protected readonly ref = inject<DialogRef<boolean>>(DialogRef);
  protected readonly data = inject<PackageDialogData>(DIALOG_DATA);
  protected readonly i18n = inject(I18nService);
  private readonly api = inject(PackagesService);
  private readonly ctx = inject(TenantContextService);
  private readonly toast = inject(ToastService);
  protected readonly saving = signal(false);

  protected readonly form = inject(NonNullableFormBuilder).group({
    name_en: [this.data.pkg?.name_en ?? '', [Validators.required, Validators.minLength(2)]],
    name_ar: [this.data.pkg?.name_ar ?? ''],
    price: [this.data.pkg ? String(this.data.pkg.price) : '', [Validators.required, Validators.pattern(MONEY)]],
    validity_days: [this.data.pkg?.validity_days ? String(this.data.pkg.validity_days) : ''],
    is_active: [this.data.pkg?.is_active ?? true],
  });
  protected readonly rows = signal(
    this.data.items.length
      ? this.data.items.map((i) => ({ service_id: i.service_id, sessions: String(i.sessions) }))
      : [{ service_id: '', sessions: '5' }],
  );

  protected addRow(): void {
    this.rows.update((r) => [...r, { service_id: '', sessions: '1' }]);
  }
  protected removeRow(i: number): void {
    this.rows.update((r) => r.filter((_, j) => j !== i));
  }
  protected setRow(i: number, field: 'service_id' | 'sessions', value: string): void {
    this.rows.update((r) => r.map((row, j) => (j === i ? { ...row, [field]: value } : row)));
  }

  async save(): Promise<void> {
    const tenantId = this.ctx.tenantId();
    const items = this.rows().filter((r) => r.service_id).map((r) => ({ service_id: r.service_id, sessions: Number(r.sessions) }));
    if (!tenantId || this.form.invalid || items.length === 0 || items.some((i) => !Number.isInteger(i.sessions) || i.sessions < 1)) {
      this.form.markAllAsTouched();
      if (items.length === 0) this.toast.error({ message: 'INVALID_ITEMS' });
      return;
    }
    const v = this.form.getRawValue();
    this.saving.set(true);
    try {
      await this.api.savePackage(tenantId, this.data.pkg?.id ?? null, {
        name_en: v.name_en.trim(),
        name_ar: v.name_ar.trim() || null,
        price: v.price as unknown as number,
        validity_days: v.validity_days ? Number(v.validity_days) : null,
        is_active: v.is_active,
      }, items);
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
// Membership dialog
// ---------------------------------------------------------------------------
@Component({
  selector: 'sz-membership-dialog',
  imports: [ReactiveFormsModule, TranslatePipe, LucideDynamicIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form class="card w-[min(30rem,calc(100vw-2rem))] p-6" [formGroup]="form" (ngSubmit)="save()" novalidate role="dialog" aria-modal="true">
      <div class="mb-4 flex items-center justify-between">
        <h2 class="text-lg font-semibold">{{ (data ? 'packages.editMembership' : 'packages.addMembership') | t }}</h2>
        <button type="button" class="btn-icon" (click)="ref.close()" [attr.aria-label]="'common.close' | t"><svg lucideIcon="x" [size]="18"></svg></button>
      </div>
      <div class="grid gap-4 sm:grid-cols-2">
        <div class="field"><label class="label" for="men">{{ 'common.nameEn' | t }}</label><input id="men" class="input" formControlName="name_en" /></div>
        <div class="field"><label class="label" for="mar">{{ 'common.nameAr' | t }}</label><input id="mar" class="input" formControlName="name_ar" dir="rtl" lang="ar" /></div>
        <div class="field"><label class="label" for="mpr">{{ 'services.price' | t }}</label><input id="mpr" class="input num" inputmode="decimal" dir="ltr" formControlName="price" /></div>
        <div class="field"><label class="label" for="mdur">{{ 'packages.durationDays' | t }}</label><input id="mdur" class="input num" type="number" min="1" dir="ltr" formControlName="duration_days" /></div>
        <div class="field"><label class="label" for="mpct">{{ 'packages.discountPercent' | t }}</label><input id="mpct" class="input num" type="number" min="0" max="100" step="0.5" dir="ltr" formControlName="service_discount_percent" /></div>
      </div>
      <label class="mt-4 flex items-center gap-2 text-sm"><input type="checkbox" class="checkbox" formControlName="is_active" />{{ 'common.active' | t }}</label>
      <div class="mt-6 flex justify-end gap-2">
        <button type="button" class="btn-secondary" (click)="ref.close()">{{ 'common.cancel' | t }}</button>
        <button type="submit" class="btn-primary" [disabled]="saving()">{{ 'common.save' | t }}</button>
      </div>
    </form>
  `,
})
export class MembershipDialog {
  protected readonly ref = inject<DialogRef<boolean>>(DialogRef);
  protected readonly data = inject<Membership | null>(DIALOG_DATA);
  private readonly api = inject(PackagesService);
  private readonly ctx = inject(TenantContextService);
  private readonly toast = inject(ToastService);
  private readonly i18n = inject(I18nService);
  protected readonly saving = signal(false);

  protected readonly form = inject(NonNullableFormBuilder).group({
    name_en: [this.data?.name_en ?? '', [Validators.required, Validators.minLength(2)]],
    name_ar: [this.data?.name_ar ?? ''],
    price: [this.data ? String(this.data.price) : '', [Validators.required, Validators.pattern(MONEY)]],
    duration_days: [this.data?.duration_days ?? 30, [Validators.required, Validators.min(1)]],
    service_discount_percent: [this.data?.service_discount_percent ?? 10, [Validators.min(0), Validators.max(100)]],
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
      await this.api.saveMembership(tenantId, this.data?.id ?? null, {
        name_en: v.name_en.trim(),
        name_ar: v.name_ar.trim() || null,
        price: v.price as unknown as number,
        duration_days: Number(v.duration_days),
        service_discount_percent: Number(v.service_discount_percent),
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
// Page
// ---------------------------------------------------------------------------
@Component({
  selector: 'sz-packages-page',
  imports: [TranslatePipe, TranslateDynamicPipe, LucideDynamicIcon, PageHeader, StatePanel, MoneyPipe, LocalDatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <sz-page-header [heading]="'nav.packages' | t" [subtitle]="'packages.subtitle' | t">
      @if (canManage() && tab() === 'packages') {
        <button type="button" class="btn-primary" (click)="openPackage(null)"><svg lucideIcon="plus" [size]="16"></svg>{{ 'packages.addPackage' | t }}</button>
      }
      @if (canManage() && tab() === 'memberships') {
        <button type="button" class="btn-primary" (click)="openMembership(null)"><svg lucideIcon="plus" [size]="16"></svg>{{ 'packages.addMembership' | t }}</button>
      }
    </sz-page-header>

    <div class="mb-4 flex gap-2">
      @for (t of tabs; track t) {
        <button type="button" [class]="tab() === t ? 'btn-primary btn-sm' : 'btn-secondary btn-sm'" (click)="setTab(t)">{{ 'packages.tab.' + t | tx }}</button>
      }
    </div>

    @if (loading()) {
      <div class="card"><sz-state [loading]="true" /></div>
    } @else if (tab() === 'packages') {
      <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        @for (p of packages(); track p.id) {
          <article class="card p-5" [class.opacity-60]="!p.is_active">
            <div class="flex items-start justify-between gap-3">
              <div>
                <h3 class="font-semibold">{{ i18n.pick(p.name_en, p.name_ar) }}</h3>
                <p class="num text-sm text-muted">{{ p.price | money }} · {{ p.validity_days ? ('packages.validDays' | t: { n: p.validity_days }) : ('packages.noExpiry' | t) }}</p>
              </div>
              @if (canManage()) { <button type="button" class="btn-icon" (click)="openPackage(p)" [attr.aria-label]="'common.edit' | t"><svg lucideIcon="pencil" [size]="16"></svg></button> }
            </div>
            <ul class="mt-3 space-y-1 text-sm">
              @for (it of itemsOf(p.id); track it.service_id) { <li>{{ it.sessions }} × {{ serviceName(it.service_id) }}</li> }
            </ul>
          </article>
        } @empty {
          <div class="col-span-full card"><sz-state icon="gift" [heading]="'packages.empty' | t" [message]="'packages.emptyHint' | t" /></div>
        }
      </div>
    } @else if (tab() === 'memberships') {
      <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        @for (m of memberships(); track m.id) {
          <article class="card p-5" [class.opacity-60]="!m.is_active">
            <div class="flex items-start justify-between gap-3">
              <div>
                <h3 class="font-semibold">{{ i18n.pick(m.name_en, m.name_ar) }}</h3>
                <p class="num text-sm text-muted">{{ m.price | money }} · {{ 'packages.validDays' | t: { n: m.duration_days } }}</p>
              </div>
              @if (canManage()) { <button type="button" class="btn-icon" (click)="openMembership(m)" [attr.aria-label]="'common.edit' | t"><svg lucideIcon="pencil" [size]="16"></svg></button> }
            </div>
            <p class="mt-3 badge-primary">−{{ m.service_discount_percent }}% {{ 'packages.onServices' | t }}</p>
          </article>
        } @empty {
          <div class="col-span-full card"><sz-state icon="gift" [heading]="'packages.noMemberships' | t" /></div>
        }
      </div>
    } @else {
      <input type="search" class="input mb-4 max-w-xs uppercase" dir="ltr" [placeholder]="'pos.voucherCode' | t" [value]="voucherQuery()" (input)="searchVouchers($any($event.target).value)" />
      <div class="card overflow-x-auto">
        <table class="table">
          <thead><tr><th>{{ 'pos.voucherCode' | t }}</th><th>{{ 'common.status' | t }}</th><th class="text-end">{{ 'packages.balance' | t }}</th><th>{{ 'packages.expires' | t }}</th></tr></thead>
          <tbody>
            @for (v of vouchers(); track v.id) {
              <tr>
                <td class="num font-medium" dir="ltr">{{ v.code }}</td>
                <td><span class="badge-muted">{{ 'pos.voucherKind.' + v.kind | tx }}</span>@if (v.status === 'void') { <span class="badge-danger ms-1">{{ 'packages.void' | t }}</span> }</td>
                <td class="num text-end">{{ v.balance | money }} <span class="text-xs text-muted">/ {{ v.initial_amount | money }}</span></td>
                <td class="text-muted">{{ v.expires_at ? (v.expires_at | localDate) : '—' }}</td>
              </tr>
            } @empty {
              <tr><td colspan="4" class="py-8 text-center text-muted">{{ 'packages.noVouchers' | t }}</td></tr>
            }
          </tbody>
        </table>
      </div>
    }
  `,
})
export class PackagesPage implements OnInit {
  private readonly api = inject(PackagesService);
  private readonly servicesApi = inject(ServicesService);
  private readonly ctx = inject(TenantContextService);
  private readonly dialog = inject(Dialog);
  private readonly toast = inject(ToastService);
  protected readonly i18n = inject(I18nService);

  protected readonly tabs: Tab[] = ['packages', 'memberships', 'vouchers'];
  protected readonly tab = signal<Tab>('packages');
  protected readonly loading = signal(true);
  protected readonly packages = signal<Package[]>([]);
  protected readonly items = signal<PackageItem[]>([]);
  protected readonly memberships = signal<Membership[]>([]);
  protected readonly services = signal<Service[]>([]);
  protected readonly vouchers = signal<GiftVoucher[]>([]);
  protected readonly voucherQuery = signal('');
  protected readonly canManage = computed(() => this.ctx.can('packages.manage'));
  private timer: ReturnType<typeof setTimeout> | undefined;

  ngOnInit(): void {
    void this.load();
  }

  async load(): Promise<void> {
    const tenantId = this.ctx.tenantId();
    if (!tenantId) return;
    try {
      const [cat, svc] = await Promise.all([this.api.catalogue(tenantId), this.servicesApi.load(tenantId)]);
      this.packages.set(cat.packages);
      this.items.set(cat.items);
      this.memberships.set(cat.memberships);
      this.services.set(svc.services);
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.loading.set(false);
    }
  }

  protected setTab(t: Tab): void {
    this.tab.set(t);
    if (t === 'vouchers') void this.loadVouchers();
  }

  protected searchVouchers(q: string): void {
    this.voucherQuery.set(q);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.loadVouchers(), 250);
  }

  private async loadVouchers(): Promise<void> {
    const tenantId = this.ctx.tenantId();
    if (!tenantId) return;
    try {
      this.vouchers.set(await this.api.vouchers(tenantId, this.voucherQuery()));
    } catch (err) {
      this.toast.error(err);
    }
  }

  protected itemsOf(packageId: string): PackageItem[] {
    return this.items().filter((i) => i.package_id === packageId);
  }

  protected serviceName(id: string): string {
    const s = this.services().find((x) => x.id === id);
    return s ? this.i18n.pick(s.name_en, s.name_ar) : '—';
  }

  openPackage(pkg: Package | null): void {
    const data: PackageDialogData = { pkg, items: pkg ? this.itemsOf(pkg.id) : [], services: this.services().filter((s) => s.is_active) };
    this.dialog.open<boolean, PackageDialogData>(PackageDialog, { data }).closed.subscribe((changed) => changed && void this.load());
  }

  openMembership(m: Membership | null): void {
    this.dialog.open<boolean, Membership | null>(MembershipDialog, { data: m }).closed.subscribe((changed) => changed && void this.load());
  }
}

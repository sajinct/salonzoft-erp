import { Dialog, DialogRef, DIALOG_DATA } from '@angular/cdk/dialog';
import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { LucideDynamicIcon } from '@lucide/angular';
import { I18nService, TranslateDynamicPipe, TranslatePipe } from '../../core/i18n/i18n.service';
import { ToastService } from '../../core/services/toast.service';
import { TenantContextService } from '../../core/tenant/tenant-context.service';
import { PageHeader, StatePanel } from '../../shared/components/ui';
import { Branch, BranchesService, HoursRange } from './data/settings.services';

// Display order follows the Omani week (Sunday first).
const DAYS = [0, 1, 2, 3, 4, 5, 6];

interface DayHours {
  day: number;
  ranges: { opens_at: string; closes_at: string }[];
}

@Component({
  selector: 'sz-branch-dialog',
  imports: [ReactiveFormsModule, TranslatePipe, TranslateDynamicPipe, LucideDynamicIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="card flex max-h-[90vh] w-[min(46rem,calc(100vw-2rem))] flex-col" role="dialog" aria-modal="true">
      <header class="flex items-center justify-between border-b border-line px-6 py-4">
        <h2 class="text-lg font-semibold">{{ (branch ? 'branches.edit' : 'branches.add') | t }}</h2>
        <button type="button" class="btn-icon" (click)="ref.close()" [attr.aria-label]="'common.close' | t"><svg lucideIcon="x" [size]="18"></svg></button>
      </header>

      <div class="flex-1 space-y-6 overflow-y-auto px-6 py-5">
        <form [formGroup]="form" class="grid gap-4 sm:grid-cols-2" (ngSubmit)="save()" id="branch-form" novalidate>
          <div class="field">
            <label class="label" for="code">{{ 'branches.code' | t }}</label>
            <input id="code" class="input uppercase" formControlName="code" dir="ltr" maxlength="12" />
            <p class="hint">{{ 'branches.codeHint' | t }}</p>
          </div>
          <div class="field"><label class="label" for="nen">{{ 'branches.nameEn' | t }}</label><input id="nen" class="input" formControlName="name_en" /></div>
          <div class="field"><label class="label" for="nar">{{ 'branches.nameAr' | t }}</label><input id="nar" class="input" formControlName="name_ar" dir="rtl" lang="ar" /></div>
          <div class="field"><label class="label" for="ph">{{ 'branches.phone' | t }}</label><input id="ph" class="input" formControlName="phone" dir="ltr" placeholder="+96824000000" /></div>
          <div class="field"><label class="label" for="em">{{ 'branches.email' | t }}</label><input id="em" class="input" type="email" formControlName="email" dir="ltr" /></div>
          <div class="field"><label class="label" for="city">{{ 'branches.city' | t }}</label><input id="city" class="input" formControlName="city" /></div>
          <div class="field"><label class="label" for="gov">{{ 'branches.governorate' | t }}</label><input id="gov" class="input" formControlName="governorate" /></div>
          <div class="field sm:col-span-2"><label class="label" for="aen">{{ 'branches.addressEn' | t }}</label><input id="aen" class="input" formControlName="address_en" /></div>
          <div class="field sm:col-span-2"><label class="label" for="aar">{{ 'branches.addressAr' | t }}</label><input id="aar" class="input" formControlName="address_ar" dir="rtl" lang="ar" /></div>
          <label class="flex items-center gap-2 text-sm"><input type="checkbox" class="checkbox" formControlName="is_active" />{{ 'branches.active' | t }}</label>
        </form>

        @if (branch) {
          <section>
            <h3 class="font-semibold">{{ 'branches.hours' | t }}</h3>
            <p class="hint mb-3">{{ 'branches.hoursHint' | t }}</p>
            <div class="divide-y divide-line rounded-xl border border-line">
              @for (d of hours(); track d.day; let di = $index) {
                <div class="flex flex-wrap items-start gap-3 px-4 py-3">
                  <span class="w-24 pt-2 text-sm font-medium">{{ 'day.' + d.day | tx }}</span>
                  <div class="flex flex-1 flex-col gap-2">
                    @for (r of d.ranges; track $index; let ri = $index) {
                      <div class="flex items-center gap-2" dir="ltr">
                        <input type="time" class="input h-9 w-32" [value]="r.opens_at" (change)="setTime(di, ri, 'opens_at', $event)" />
                        <span class="text-muted">–</span>
                        <input type="time" class="input h-9 w-32" [value]="r.closes_at" (change)="setTime(di, ri, 'closes_at', $event)" />
                        <button type="button" class="btn-icon h-8 w-8" (click)="removeRange(di, ri)" [attr.aria-label]="'common.remove' | t"><svg lucideIcon="trash-2" [size]="15"></svg></button>
                      </div>
                    } @empty {
                      <span class="pt-2 text-sm text-muted">{{ 'branches.closed' | t }}</span>
                    }
                  </div>
                  <button type="button" class="btn-ghost btn-sm" (click)="addRange(di)" [disabled]="d.ranges.length >= 4">
                    <svg lucideIcon="plus" [size]="14"></svg>{{ 'branches.addRange' | t }}
                  </button>
                </div>
              }
            </div>
            <div class="mt-3 flex justify-end">
              <button type="button" class="btn-secondary" (click)="saveHours()" [disabled]="savingHours()">{{ 'branches.saveHours' | t }}</button>
            </div>
          </section>
        }
      </div>

      <footer class="flex justify-end gap-2 border-t border-line px-6 py-4">
        <button type="button" class="btn-secondary" (click)="ref.close()">{{ 'common.cancel' | t }}</button>
        <button type="submit" form="branch-form" class="btn-primary" [disabled]="saving()">{{ saving() ? ('common.saving' | t) : ('common.save' | t) }}</button>
      </footer>
    </div>
  `,
})
export class BranchDialog implements OnInit {
  protected readonly ref = inject<DialogRef<boolean>>(DialogRef);
  protected readonly branch = inject<Branch | null>(DIALOG_DATA);
  private readonly service = inject(BranchesService);
  private readonly ctx = inject(TenantContextService);
  private readonly toast = inject(ToastService);
  private readonly i18n = inject(I18nService);

  protected readonly saving = signal(false);
  protected readonly savingHours = signal(false);
  protected readonly hours = signal<DayHours[]>(DAYS.map((day) => ({ day, ranges: [] })));

  protected readonly form = inject(NonNullableFormBuilder).group({
    code: [this.branch?.code ?? '', [Validators.required, Validators.pattern(/^[A-Za-z0-9][A-Za-z0-9-]{0,11}$/)]],
    name_en: [this.branch?.name_en ?? '', [Validators.required, Validators.minLength(2), Validators.maxLength(120)]],
    name_ar: [this.branch?.name_ar ?? ''],
    phone: [this.branch?.phone ?? '', Validators.pattern(/^\+?[0-9]{6,15}$/)],
    email: [this.branch?.email ?? '', Validators.email],
    city: [this.branch?.city ?? ''],
    governorate: [this.branch?.governorate ?? ''],
    address_en: [this.branch?.address_en ?? ''],
    address_ar: [this.branch?.address_ar ?? ''],
    is_active: [this.branch?.is_active ?? true],
  });

  async ngOnInit(): Promise<void> {
    if (!this.branch) return;
    try {
      const rows = await this.service.hours(this.branch.id);
      this.hours.set(
        DAYS.map((day) => ({
          day,
          ranges: rows.filter((r) => r.day_of_week === day).map((r) => ({ opens_at: r.opens_at.slice(0, 5), closes_at: r.closes_at.slice(0, 5) })),
        })),
      );
    } catch (err) {
      this.toast.error(err);
    }
  }

  protected addRange(dayIndex: number): void {
    this.hours.update((h) => h.map((d, i) => (i === dayIndex ? { ...d, ranges: [...d.ranges, { opens_at: '09:00', closes_at: '22:00' }] } : d)));
  }

  protected removeRange(dayIndex: number, rangeIndex: number): void {
    this.hours.update((h) => h.map((d, i) => (i === dayIndex ? { ...d, ranges: d.ranges.filter((_, j) => j !== rangeIndex) } : d)));
  }

  protected setTime(dayIndex: number, rangeIndex: number, field: 'opens_at' | 'closes_at', event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.hours.update((h) =>
      h.map((d, i) => (i === dayIndex ? { ...d, ranges: d.ranges.map((r, j) => (j === rangeIndex ? { ...r, [field]: value } : r)) } : d)),
    );
  }

  async saveHours(): Promise<void> {
    if (!this.branch) return;
    const ranges: HoursRange[] = this.hours().flatMap((d) =>
      d.ranges.map((r) => ({ day_of_week: d.day, opens_at: r.opens_at, closes_at: r.closes_at === '00:00' ? '24:00' : r.closes_at })),
    );
    this.savingHours.set(true);
    try {
      await this.service.saveHours(this.branch.id, ranges);
      this.toast.success(this.i18n.t('common.saved'));
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.savingHours.set(false);
    }
  }

  async save(): Promise<void> {
    const tenantId = this.ctx.tenantId();
    if (!tenantId || this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const v = this.form.getRawValue();
    const input = {
      code: v.code.trim().toUpperCase(),
      name_en: v.name_en.trim(),
      name_ar: v.name_ar.trim() || null,
      phone: v.phone.trim() || null,
      email: v.email.trim().toLowerCase() || null,
      city: v.city.trim() || null,
      governorate: v.governorate.trim() || null,
      address_en: v.address_en.trim() || null,
      address_ar: v.address_ar.trim() || null,
      is_active: v.is_active,
    };
    this.saving.set(true);
    try {
      if (this.branch) await this.service.update(this.branch.id, input);
      else await this.service.create(tenantId, input);
      await this.ctx.refresh();
      this.toast.success(this.i18n.t('common.saved'));
      this.ref.close(true);
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.saving.set(false);
    }
  }
}

@Component({
  selector: 'sz-branches-page',
  imports: [TranslatePipe, LucideDynamicIcon, PageHeader, StatePanel],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <sz-page-header [heading]="'settings.branches' | t" [subtitle]="'branches.subtitle' | t">
      @if (canManage()) {
        <button type="button" class="btn-primary" (click)="open(null)" [disabled]="atLimit()"><svg lucideIcon="plus" [size]="16"></svg>{{ 'branches.add' | t }}</button>
      }
    </sz-page-header>
    @if (maxBranches(); as max) {
      <p class="mb-4 text-xs text-muted">{{ 'branches.limit' | t: { max } }}</p>
    }

    @if (loading()) {
      <div class="card"><sz-state [loading]="true" /></div>
    } @else {
      <div class="grid gap-4 md:grid-cols-2">
        @for (b of branches(); track b.id) {
          <article class="card p-5">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <div class="flex flex-wrap items-center gap-2">
                  <h3 class="truncate font-semibold">{{ i18n.pick(b.name_en, b.name_ar) }}</h3>
                  <span class="badge-muted" dir="ltr">{{ b.code }}</span>
                  @if (b.is_main) { <span class="badge-primary">{{ 'branches.main' | t }}</span> }
                  @if (!b.is_active) { <span class="badge-warning">{{ 'common.inactive' | t }}</span> }
                </div>
                <p class="mt-1 text-sm text-muted">{{ location(b) }}</p>
                @if (b.phone) { <p class="num mt-1 text-sm text-muted" dir="ltr">{{ b.phone }}</p> }
              </div>
              @if (canManage()) {
                <button type="button" class="btn-icon" (click)="open(b)" [attr.aria-label]="'common.edit' | t"><svg lucideIcon="pencil" [size]="16"></svg></button>
              }
            </div>
            @if (canManage() && !b.is_main) {
              <button type="button" class="btn-ghost btn-sm mt-3" (click)="makeMain(b)">{{ 'branches.makeMain' | t }}</button>
            }
          </article>
        }
      </div>
    }
  `,
})
export class BranchesPage implements OnInit {
  private readonly service = inject(BranchesService);
  private readonly ctx = inject(TenantContextService);
  private readonly dialog = inject(Dialog);
  private readonly toast = inject(ToastService);
  protected readonly i18n = inject(I18nService);

  protected readonly loading = signal(true);
  protected readonly branches = signal<Branch[]>([]);
  protected readonly canManage = computed(() => this.ctx.can('branches.manage'));
  protected readonly maxBranches = computed(() => this.ctx.context()?.subscription?.max_branches ?? null);
  protected readonly atLimit = computed(() => {
    const max = this.maxBranches();
    return max !== null && this.branches().length >= max;
  });

  ngOnInit(): void {
    void this.load();
  }

  async load(): Promise<void> {
    const tenantId = this.ctx.tenantId();
    if (!tenantId) return;
    try {
      this.branches.set(await this.service.list(tenantId));
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.loading.set(false);
    }
  }

  protected location(b: Branch): string {
    return [b.city, b.governorate].filter((x) => !!x).join(' · ') || '—';
  }

  open(branch: Branch | null): void {
    const ref = this.dialog.open<boolean, Branch | null>(BranchDialog, { data: branch });
    ref.closed.subscribe((changed) => {
      if (changed) void this.load();
    });
  }

  async makeMain(branch: Branch): Promise<void> {
    try {
      await this.service.update(branch.id, { is_main: true });
      await Promise.all([this.load(), this.ctx.refresh()]);
    } catch (err) {
      this.toast.error(err);
    }
  }
}

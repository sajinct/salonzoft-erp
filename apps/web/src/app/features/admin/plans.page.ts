import { Dialog, DialogRef, DIALOG_DATA } from '@angular/cdk/dialog';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { LucideDynamicIcon } from '@lucide/angular';
import { I18nService, TranslatePipe } from '../../core/i18n/i18n.service';
import { ToastService } from '../../core/services/toast.service';
import { PageHeader, StatePanel } from '../../shared/components/ui';
import { MoneyPipe } from '../../shared/pipes/format.pipes';
import { BillingService, ModuleInfo } from '../billing/data/billing.service';
import { AdminPlan, AdminService } from './data/admin.service';

interface PlanDialogData {
  plan: AdminPlan | null;
  modules: ModuleInfo[];
}

const NUM_FIELDS = ['price_monthly', 'price_yearly', 'max_branches', 'max_staff', 'max_monthly_messages', 'trial_days', 'sort_order'] as const;
type NumField = (typeof NUM_FIELDS)[number];

@Component({
  selector: 'sz-plan-dialog',
  imports: [TranslatePipe, LucideDynamicIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="card flex max-h-[94vh] w-[min(42rem,calc(100vw-2rem))] flex-col" role="dialog" aria-modal="true">
      <header class="flex items-center justify-between border-b border-line px-6 py-4">
        <h2 class="text-lg font-semibold">{{ (data.plan ? 'admin.editPlan' : 'admin.newPlan') | t }}</h2>
        <button type="button" class="btn-icon" (click)="ref.close(false)" [attr.aria-label]="'common.close' | t"><svg lucideIcon="x" [size]="18"></svg></button>
      </header>
      <div class="flex-1 space-y-4 overflow-y-auto px-6 py-5 text-sm">
        <div class="grid gap-3 sm:grid-cols-3">
          <div class="field"><label class="label" for="pcode">{{ 'admin.planCode' | t }}</label><input id="pcode" class="input" dir="ltr" [disabled]="!!data.plan" [value]="text('code')" (input)="setText('code', $any($event.target).value)" /></div>
          <div class="field"><label class="label" for="pen">{{ 'admin.nameEn' | t }}</label><input id="pen" class="input" [value]="text('name_en')" (input)="setText('name_en', $any($event.target).value)" /></div>
          <div class="field"><label class="label" for="par">{{ 'admin.nameAr' | t }}</label><input id="par" class="input" dir="rtl" lang="ar" [value]="text('name_ar')" (input)="setText('name_ar', $any($event.target).value)" /></div>
        </div>
        <div class="grid gap-3 sm:grid-cols-2">
          <div class="field"><label class="label" for="pden">{{ 'admin.descriptionEn' | t }}</label><input id="pden" class="input" [value]="text('description_en')" (input)="setText('description_en', $any($event.target).value)" /></div>
          <div class="field"><label class="label" for="pdar">{{ 'admin.descriptionAr' | t }}</label><input id="pdar" class="input" dir="rtl" lang="ar" [value]="text('description_ar')" (input)="setText('description_ar', $any($event.target).value)" /></div>
        </div>
        <div class="grid gap-3 sm:grid-cols-4">
          @for (f of numFields; track f) {
            <div class="field"><label class="label text-xs" [for]="'pn-' + f">{{ labels[f] | t }}</label>
              <input class="input num" type="number" min="0" step="any" dir="ltr" [id]="'pn-' + f" [value]="num(f)" (input)="setNum(f, $any($event.target).value)" /></div>
          }
        </div>
        <p class="hint">{{ 'admin.emptyUnlimited' | t }}</p>
        <div class="flex flex-wrap gap-x-6 gap-y-2">
          <label class="flex items-center gap-2"><input type="checkbox" class="checkbox" [checked]="form().is_active" (change)="setFlag('is_active', $any($event.target).checked)" />{{ 'admin.planActive' | t }}</label>
          <label class="flex items-center gap-2"><input type="checkbox" class="checkbox" [checked]="form().is_public" (change)="setFlag('is_public', $any($event.target).checked)" />{{ 'admin.planPublic' | t }}</label>
        </div>
        <section>
          <h3 class="label mb-2">{{ 'admin.modules' | t }}</h3>
          <div class="grid gap-2 sm:grid-cols-3">
            @for (m of paid; track m.code) {
              <label class="flex items-center gap-2"><input type="checkbox" class="checkbox" [checked]="has(m.code)" (change)="toggle(m.code, $any($event.target).checked)" />{{ i18n.pick(m.name_en, m.name_ar) }}</label>
            }
          </div>
          @if (data.plan?.subscribers) { <p class="hint mt-2">{{ 'admin.planSyncNote' | t: { n: data.plan!.subscribers } }}</p> }
        </section>
      </div>
      <footer class="flex justify-end gap-2 border-t border-line px-6 py-4">
        <button type="button" class="btn-secondary" (click)="ref.close(false)">{{ 'common.cancel' | t }}</button>
        <button type="button" class="btn-primary" [disabled]="busy()" (click)="save()">{{ 'common.save' | t }}</button>
      </footer>
    </div>
  `,
})
export class PlanDialog {
  protected readonly data = inject<PlanDialogData>(DIALOG_DATA);
  protected readonly ref = inject<DialogRef<boolean>>(DialogRef);
  protected readonly i18n = inject(I18nService);
  private readonly api = inject(AdminService);
  private readonly toast = inject(ToastService);

  protected readonly numFields = NUM_FIELDS;
  protected readonly labels = {
    price_monthly: 'admin.priceMonthly', price_yearly: 'admin.priceYearly', max_branches: 'admin.maxBranches', max_staff: 'admin.maxStaff',
    max_monthly_messages: 'admin.maxMessages', trial_days: 'admin.trialDays', sort_order: 'admin.sortOrder',
  } as const;
  protected readonly paid = this.data.modules.filter((m) => !m.is_core);
  protected readonly busy = signal(false);
  protected readonly form = signal<Partial<AdminPlan>>(
    this.data.plan
      ? { ...this.data.plan }
      : { code: '', name_en: '', name_ar: '', price_monthly: 0, trial_days: 14, sort_order: 100, is_active: true, is_public: true, modules: this.paid.map((m) => m.code) },
  );

  protected text(key: 'code' | 'name_en' | 'name_ar' | 'description_en' | 'description_ar'): string {
    return this.form()[key] ?? '';
  }

  protected setText(key: 'code' | 'name_en' | 'name_ar' | 'description_en' | 'description_ar', value: string): void {
    this.form.update((f) => ({ ...f, [key]: value }));
  }

  protected num(key: NumField): string {
    const v = this.form()[key];
    return v === null || v === undefined ? '' : String(v);
  }

  protected setNum(key: NumField, raw: string): void {
    this.form.update((f) => ({ ...f, [key]: raw.trim() === '' ? null : Number(raw) }));
  }

  protected setFlag(key: 'is_active' | 'is_public', value: boolean): void {
    this.form.update((f) => ({ ...f, [key]: value }));
  }

  protected has(code: string): boolean {
    return (this.form().modules ?? []).includes(code);
  }

  protected toggle(code: string, on: boolean): void {
    this.form.update((f) => ({ ...f, modules: on ? [...(f.modules ?? []), code] : (f.modules ?? []).filter((m) => m !== code) }));
  }

  async save(): Promise<void> {
    this.busy.set(true);
    try {
      const { subscribers: _s, id: _id, ...plan } = this.form();
      await this.api.savePlan(plan);
      this.ref.close(true);
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.busy.set(false);
    }
  }
}

@Component({
  selector: 'sz-admin-plans-page',
  imports: [TranslatePipe, LucideDynamicIcon, PageHeader, StatePanel, MoneyPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <sz-page-header [heading]="'admin.nav.plans' | t" [subtitle]="'admin.plansSubtitle' | t">
      @if (api.isAdmin()) { <button type="button" class="btn-primary" (click)="open(null)"><svg lucideIcon="plus" [size]="16"></svg>{{ 'admin.newPlan' | t }}</button> }
    </sz-page-header>
    <div class="card overflow-x-auto">
      @if (loading()) {
        <sz-state [loading]="true" />
      } @else {
        <table class="table">
          <thead><tr><th>{{ 'billing.plan' | t }}</th><th class="text-end">{{ 'admin.priceMonthly' | t }}</th><th class="text-end">{{ 'admin.priceYearly' | t }}</th><th>{{ 'admin.limits' | t }}</th><th class="text-end">{{ 'admin.subscribers' | t }}</th><th></th></tr></thead>
          <tbody>
            @for (p of plans(); track p.id) {
              <tr [class.opacity-60]="!p.is_active">
                <td><p class="font-medium">{{ i18n.pick(p.name_en, p.name_ar) }}</p><p class="text-xs text-muted" dir="ltr">{{ p.code }}@if (!p.is_public) { · private }@if (!p.is_active) { · inactive }</p></td>
                <td class="num text-end">{{ p.price_monthly | money }}</td>
                <td class="num text-end">{{ (p.price_yearly ?? p.price_monthly * 12) | money }}</td>
                <td class="text-xs">{{ 'admin.limitsLine' | t: { branches: p.max_branches ?? '∞', staff: p.max_staff ?? '∞', messages: p.max_monthly_messages ?? '∞' } }}<br />{{ 'admin.modulesN' | t: { n: p.modules.length } }}</td>
                <td class="num text-end">{{ p.subscribers }}</td>
                <td class="text-end">@if (api.isAdmin()) { <button type="button" class="btn-ghost btn-sm" (click)="open(p)">{{ 'common.edit' | t }}</button> }</td>
              </tr>
            }
          </tbody>
        </table>
      }
    </div>
  `,
})
export class AdminPlansPage {
  protected readonly i18n = inject(I18nService);
  protected readonly api = inject(AdminService);
  private readonly billing = inject(BillingService);
  private readonly dialog = inject(Dialog);
  private readonly toast = inject(ToastService);
  protected readonly loading = signal(true);
  protected readonly plans = signal<AdminPlan[]>([]);
  private modules: ModuleInfo[] = [];

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const [plans, modules] = await Promise.all([this.api.plans(), this.modules.length ? Promise.resolve(this.modules) : this.billing.modules()]);
      this.plans.set(plans);
      this.modules = modules;
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.loading.set(false);
    }
  }

  open(plan: AdminPlan | null): void {
    this.dialog
      .open<boolean, PlanDialogData>(PlanDialog, { data: { plan, modules: this.modules } })
      .closed.subscribe((saved) => {
        if (saved) {
          this.toast.success(this.i18n.t('common.saved'));
          void this.load();
        }
      });
  }
}

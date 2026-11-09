import { DialogRef, DIALOG_DATA } from '@angular/cdk/dialog';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { LucideDynamicIcon } from '@lucide/angular';
import { I18nService, TranslateDynamicPipe, TranslatePipe } from '../../core/i18n/i18n.service';
import { ToastService } from '../../core/services/toast.service';
import { TenantContextService } from '../../core/tenant/tenant-context.service';
import { Customer, CustomerInput, CustomersService, DuplicateMatch } from './data/customers.service';

export const CUSTOMER_SOURCES = ['walk_in', 'phone', 'whatsapp', 'instagram', 'referral', 'online', 'import', 'other'] as const;

/** Create or edit a customer. Closes with the saved customer, or undefined. */
@Component({
  selector: 'sz-customer-dialog',
  imports: [ReactiveFormsModule, TranslatePipe, TranslateDynamicPipe, LucideDynamicIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="card flex max-h-[92vh] w-[min(44rem,calc(100vw-2rem))] flex-col" role="dialog" aria-modal="true">
      <header class="flex items-center justify-between border-b border-line px-6 py-4">
        <h2 class="text-lg font-semibold">{{ (customer ? 'customers.edit' : 'customers.add') | t }}</h2>
        <button type="button" class="btn-icon" (click)="ref.close()" [attr.aria-label]="'common.close' | t"><svg lucideIcon="x" [size]="18"></svg></button>
      </header>

      <div class="flex-1 overflow-y-auto px-6 py-5">
        @if (duplicates().length > 0) {
          <div class="mb-5 rounded-xl border border-warning/40 bg-warning-soft p-4 text-sm" role="alert">
            <p class="font-semibold text-warning">{{ 'customers.possibleDuplicates' | t }}</p>
            <ul class="mt-2 space-y-1.5">
              @for (d of duplicates(); track d.id) {
                <li class="flex flex-wrap items-center gap-2">
                  <span class="font-medium">{{ d.first_name }} {{ d.last_name }}</span>
                  <span class="num text-muted" dir="ltr">{{ d.mobile }}</span>
                  <span class="badge-muted">{{ 'customers.match.' + d.reason | tx }}</span>
                  <button type="button" class="btn-ghost btn-sm" (click)="openExisting(d)">{{ 'customers.openExisting' | t }}</button>
                </li>
              }
            </ul>
            @if (!mobileTaken()) {
              <p class="mt-3 text-muted">{{ 'customers.duplicateHint' | t }}</p>
            }
          </div>
        }

        <form [formGroup]="form" id="customer-form" class="grid gap-4 sm:grid-cols-2" (ngSubmit)="save()" novalidate>
          <div class="field"><label class="label" for="cfn">{{ 'customers.firstName' | t }}</label><input id="cfn" class="input" formControlName="first_name" maxlength="80" autocomplete="off" /></div>
          <div class="field"><label class="label" for="cln">{{ 'customers.lastName' | t }}</label><input id="cln" class="input" formControlName="last_name" maxlength="80" autocomplete="off" /></div>
          <div class="field"><label class="label" for="car">{{ 'customers.nameAr' | t }}</label><input id="car" class="input" formControlName="name_ar" dir="rtl" lang="ar" maxlength="120" /></div>
          <div class="field">
            <label class="label" for="cmob">{{ 'common.mobile' | t }}</label>
            <input id="cmob" class="input num" formControlName="mobile" dir="ltr" inputmode="tel" placeholder="9123 4567" autocomplete="off" />
            <p class="hint">{{ 'customers.mobileHint' | t }}</p>
          </div>
          <div class="field"><label class="label" for="cem">{{ 'common.email' | t }}</label><input id="cem" class="input" type="email" formControlName="email" dir="ltr" /></div>
          <div class="field">
            <label class="label" for="cgen">{{ 'common.gender' | t }}</label>
            <select id="cgen" class="input" formControlName="gender">
              <option value="">—</option><option value="female">{{ 'common.female' | t }}</option><option value="male">{{ 'common.male' | t }}</option>
            </select>
          </div>
          <div class="field"><label class="label" for="cdob">{{ 'customers.dateOfBirth' | t }}</label><input id="cdob" class="input" type="date" formControlName="date_of_birth" dir="ltr" /></div>
          <div class="field">
            <label class="label" for="clang">{{ 'customers.language' | t }}</label>
            <select id="clang" class="input" formControlName="preferred_language">
              <option value="">—</option><option value="ar">{{ 'common.arabic' | t }}</option><option value="en">{{ 'common.english' | t }}</option>
            </select>
          </div>
          <div class="field">
            <label class="label" for="cbr">{{ 'customers.homeBranch' | t }}</label>
            <select id="cbr" class="input" formControlName="home_branch_id">
              <option value="">—</option>
              @for (b of ctx.branches(); track b.id) { <option [value]="b.id">{{ i18n.pick(b.name_en, b.name_ar) }}</option> }
            </select>
          </div>
          <div class="field">
            <label class="label" for="csrc">{{ 'customers.source' | t }}</label>
            <select id="csrc" class="input" formControlName="source">
              @for (s of sources; track s) { <option [value]="s">{{ 'customers.sourceName.' + s | tx }}</option> }
            </select>
          </div>
          <div class="field sm:col-span-2">
            <label class="label" for="ctags">{{ 'customers.tags' | t }}</label>
            <input id="ctags" class="input" formControlName="tags" [placeholder]="'customers.tagsHint' | t" />
          </div>
          @if (customer) {
            <div class="field">
              <label class="label" for="cst">{{ 'common.status' | t }}</label>
              <select id="cst" class="input" formControlName="status">
                @for (s of statuses; track s) { <option [value]="s">{{ 'customers.status.' + s | tx }}</option> }
              </select>
            </div>
          }
        </form>
      </div>

      <footer class="flex justify-end gap-2 border-t border-line px-6 py-4">
        <button type="button" class="btn-secondary" (click)="ref.close()">{{ 'common.cancel' | t }}</button>
        <button type="submit" form="customer-form" class="btn-primary" [disabled]="saving() || mobileTaken()">
          {{ saving() ? ('common.saving' | t) : duplicates().length > 0 ? ('customers.saveAnyway' | t) : ('common.save' | t) }}
        </button>
      </footer>
    </div>
  `,
})
export class CustomerDialog {
  protected readonly ref = inject<DialogRef<Customer>>(DialogRef);
  protected readonly customer = inject<Customer | null>(DIALOG_DATA);
  protected readonly ctx = inject(TenantContextService);
  protected readonly i18n = inject(I18nService);
  private readonly service = inject(CustomersService);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);

  protected readonly sources = CUSTOMER_SOURCES;
  protected readonly statuses = ['active', 'blocked', 'archived'] as const;
  protected readonly saving = signal(false);
  protected readonly duplicates = signal<DuplicateMatch[]>([]);
  protected readonly mobileTaken = signal(false);
  /** Fingerprint of the values the user already confirmed despite duplicates. */
  private confirmed: string | null = null;

  private readonly c = this.customer;
  protected readonly form = inject(NonNullableFormBuilder).group({
    first_name: [this.c?.first_name ?? '', [Validators.required, Validators.maxLength(80)]],
    last_name: [this.c?.last_name ?? ''],
    name_ar: [this.c?.name_ar ?? ''],
    mobile: [this.c?.mobile ?? '', Validators.pattern(/^[+0-9\s().-]{6,24}$/)],
    email: [this.c?.email ?? '', Validators.email],
    gender: [this.c?.gender ?? ''],
    date_of_birth: [this.c?.date_of_birth ?? ''],
    preferred_language: [this.c?.preferred_language ?? ''],
    home_branch_id: [this.c?.home_branch_id ?? (this.c ? '' : (this.ctx.branchId() ?? ''))],
    source: [this.c?.source ?? 'walk_in'],
    tags: [(this.c?.tags ?? []).join(', ')],
    status: [this.c?.status ?? 'active'],
  });

  constructor() {
    this.form.valueChanges.subscribe(() => {
      // Editing the identifying fields re-runs the duplicate check on save.
      if (this.duplicates().length) {
        this.duplicates.set([]);
        this.mobileTaken.set(false);
      }
    });
  }

  protected openExisting(match: DuplicateMatch): void {
    this.ref.close();
    void this.router.navigate(['/customers', match.id]);
  }

  async save(): Promise<void> {
    const tenantId = this.ctx.tenantId();
    if (!tenantId || this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const v = this.form.getRawValue();
    const input: CustomerInput = {
      first_name: v.first_name.trim(),
      last_name: v.last_name.trim() || null,
      name_ar: v.name_ar.trim() || null,
      mobile: v.mobile.trim() || null,
      email: v.email.trim().toLowerCase() || null,
      gender: v.gender || null,
      date_of_birth: v.date_of_birth || null,
      preferred_language: v.preferred_language || null,
      home_branch_id: v.home_branch_id || null,
      source: v.source,
      tags: v.tags.split(/[,;]/).map((t) => t.trim()).filter(Boolean),
      ...(this.c ? { status: v.status } : {}),
    };

    this.saving.set(true);
    try {
      const fingerprint = JSON.stringify([input.first_name, input.last_name, input.mobile, input.email]);
      const identityChanged =
        !this.c || this.c.first_name !== input.first_name || this.c.last_name !== input.last_name || (input.mobile ?? '') !== (this.c.mobile ?? '') || input.email !== this.c.email;
      if (identityChanged && this.confirmed !== fingerprint) {
        const matches = await this.service.duplicates(tenantId, input, this.c?.id ?? null);
        if (matches.length > 0) {
          this.duplicates.set(matches);
          this.mobileTaken.set(matches.some((m) => m.reason === 'mobile'));
          this.confirmed = fingerprint;
          return;
        }
      }
      const saved = this.c ? await this.service.update(this.c.id, input) : await this.service.create(tenantId, input);
      this.toast.success(this.i18n.t('common.saved'));
      this.ref.close(saved);
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.saving.set(false);
    }
  }
}

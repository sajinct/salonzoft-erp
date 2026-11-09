import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { LucideDynamicIcon } from '@lucide/angular';
import { I18nService, TranslateDynamicPipe, TranslatePipe } from '../../core/i18n/i18n.service';
import { ToastService } from '../../core/services/toast.service';
import { TenantContextService } from '../../core/tenant/tenant-context.service';
import { StatePanel } from '../../shared/components/ui';
import { BUSINESS_TYPES, BusinessType } from '../onboarding/onboarding.service';
import { BusinessSettingsService } from './data/settings.services';

const TIMEZONES = ['Asia/Muscat', 'Asia/Dubai', 'Asia/Riyadh', 'Asia/Qatar', 'Asia/Bahrain', 'Asia/Kuwait', 'Asia/Kolkata'];
const DAYS = [0, 1, 2, 3, 4, 5, 6];

@Component({
  selector: 'sz-business-page',
  imports: [ReactiveFormsModule, TranslatePipe, TranslateDynamicPipe, LucideDynamicIcon, StatePanel],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (loading()) {
      <div class="card"><sz-state [loading]="true" /></div>
    } @else {
      @if (!canEdit()) {
        <p class="mb-4 rounded-xl bg-surface-2 px-4 py-3 text-sm text-muted">{{ 'common.readOnly' | t }}</p>
      }
      <form [formGroup]="form" (ngSubmit)="save()" class="space-y-6" novalidate>
        <fieldset class="card space-y-5 p-6" [disabled]="!canEdit()">
          <legend class="sr-only">{{ 'business.profile' | t }}</legend>
          <h2 class="text-base font-semibold">{{ 'business.profile' | t }}</h2>

          <div class="flex items-center gap-4">
            <div class="grid h-20 w-20 place-items-center overflow-hidden rounded-2xl border border-line bg-surface-2">
              @if (logoUrl()) {
                <img [src]="logoUrl()" alt="" class="h-full w-full object-contain" />
              } @else {
                <svg lucideIcon="store" [size]="28" class="text-muted"></svg>
              }
            </div>
            <div>
              <label class="btn-secondary btn-sm" [class.pointer-events-none]="!canEdit() || uploading()">
                <svg lucideIcon="upload" [size]="14"></svg>{{ 'business.uploadLogo' | t }}
                <input type="file" class="sr-only" accept="image/png,image/jpeg,image/webp" (change)="uploadLogo($event)" [disabled]="!canEdit()" />
              </label>
              <p class="hint mt-1">{{ 'business.logoHint' | t }}</p>
            </div>
          </div>

          <div class="grid gap-4 sm:grid-cols-2" formGroupName="profile">
            <div class="field"><label class="label" for="name">{{ 'business.name' | t }}</label><input id="name" class="input" formControlName="name" /></div>
            <div class="field"><label class="label" for="nameAr">{{ 'business.nameAr' | t }}</label><input id="nameAr" class="input" formControlName="name_ar" dir="rtl" lang="ar" /></div>
            <div class="field"><label class="label" for="legal">{{ 'business.legalName' | t }}</label><input id="legal" class="input" formControlName="legal_name" /></div>
            <div class="field">
              <label class="label" for="type">{{ 'business.type' | t }}</label>
              <select id="type" class="input" formControlName="business_type">
                @for (type of types; track type) {
                  <option [value]="type">{{ 'businessType.' + type | tx }}</option>
                }
              </select>
            </div>
          </div>
        </fieldset>

        <fieldset class="card space-y-5 p-6" [disabled]="!canEdit()" formGroupName="settings">
          <h2 class="text-base font-semibold">{{ 'business.regional' | t }}</h2>
          <div class="grid gap-4 sm:grid-cols-3">
            <div class="field">
              <label class="label" for="lang">{{ 'business.language' | t }}</label>
              <select id="lang" class="input" formControlName="default_language">
                <option value="en">English</option><option value="ar">العربية</option>
              </select>
            </div>
            <div class="field">
              <label class="label" for="tz">{{ 'business.timezone' | t }}</label>
              <select id="tz" class="input" formControlName="timezone" dir="ltr">
                @for (tz of timezones; track tz) { <option [value]="tz">{{ tz }}</option> }
              </select>
            </div>
            <div class="field"><label class="label" for="cc">{{ 'business.phoneCode' | t }}</label><input id="cc" class="input" formControlName="phone_country_code" dir="ltr" /></div>
            <div class="field">
              <span class="label">{{ 'business.currency' | t }}</span>
              <input class="input" [value]="currency()" disabled dir="ltr" />
            </div>
            <div class="field">
              <label class="label" for="ws">{{ 'business.weekStartsOn' | t }}</label>
              <select id="ws" class="input" formControlName="week_starts_on">
                @for (d of days; track d) { <option [ngValue]="d">{{ 'day.' + d | tx }}</option> }
              </select>
            </div>
          </div>
          <fieldset>
            <legend class="label mb-2">{{ 'business.weekendDays' | t }}</legend>
            <div class="flex flex-wrap gap-2">
              @for (d of days; track d) {
                <label class="flex cursor-pointer items-center gap-2 rounded-xl border border-line px-3 py-1.5 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary-soft">
                  <input type="checkbox" class="checkbox" [checked]="weekend().includes(d)" (change)="toggleWeekend(d)" [disabled]="!canEdit()" />
                  {{ 'day.' + d | tx }}
                </label>
              }
            </div>
          </fieldset>
          <label class="flex items-center gap-2 text-sm"><input type="checkbox" class="checkbox" formControlName="show_hijri_dates" />{{ 'business.showHijri' | t }}</label>
        </fieldset>

        <fieldset class="card space-y-5 p-6" [disabled]="!canEdit()" formGroupName="settings">
          <h2 class="text-base font-semibold">{{ 'business.tax' | t }}</h2>
          <label class="flex items-center gap-2 text-sm"><input type="checkbox" class="checkbox" formControlName="vat_registered" />{{ 'business.vatRegistered' | t }}</label>
          <div class="grid gap-4 sm:grid-cols-3">
            <div class="field">
              <label class="label" for="vatno">{{ 'business.vatNumber' | t }}</label>
              <input id="vatno" class="input" formControlName="vat_number" dir="ltr" placeholder="OM1100XXXXXX" />
              @if (form.controls.settings.controls.vat_number.invalid && form.controls.settings.controls.vat_number.touched) {
                <p class="error-text">{{ 'common.invalid' | t }}</p>
              }
            </div>
            <div class="field">
              <label class="label" for="vatrate">{{ 'business.vatRate' | t }}</label>
              <input id="vatrate" class="input num" type="number" step="0.01" min="0" max="100" formControlName="default_vat_rate" dir="ltr" />
            </div>
            <div class="field">
              <label class="label" for="prefix">{{ 'business.invoicePrefix' | t }}</label>
              <input id="prefix" class="input" formControlName="invoice_prefix" dir="ltr" />
            </div>
          </div>
          <p class="hint">{{ 'business.vatRateHint' | t }}</p>
          <label class="flex items-center gap-2 text-sm"><input type="checkbox" class="checkbox" formControlName="prices_include_vat" />{{ 'business.pricesIncludeVat' | t }}</label>
          <label class="flex items-center gap-2 text-sm"><input type="checkbox" class="checkbox" formControlName="allow_negative_stock" />{{ 'business.allowNegativeStock' | t }}</label>
          <div class="grid gap-4 sm:grid-cols-2">
            <div class="field"><label class="label" for="fen">{{ 'business.footerEn' | t }}</label><textarea id="fen" rows="2" class="input" formControlName="receipt_footer_en"></textarea></div>
            <div class="field"><label class="label" for="far">{{ 'business.footerAr' | t }}</label><textarea id="far" rows="2" class="input" formControlName="receipt_footer_ar" dir="rtl" lang="ar"></textarea></div>
          </div>
        </fieldset>

        @if (canEdit()) {
          <div class="flex justify-end">
            <button type="submit" class="btn-primary" [disabled]="saving()">{{ saving() ? ('common.saving' | t) : ('common.save' | t) }}</button>
          </div>
        }
      </form>
    }
  `,
})
export class BusinessPage implements OnInit {
  private readonly service = inject(BusinessSettingsService);
  private readonly ctx = inject(TenantContextService);
  private readonly toast = inject(ToastService);
  private readonly i18n = inject(I18nService);
  private readonly fb = inject(NonNullableFormBuilder);

  protected readonly types = BUSINESS_TYPES;
  protected timezones = TIMEZONES;
  protected readonly days = DAYS;
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly uploading = signal(false);
  protected readonly logoUrl = signal<string | null>(null);
  protected readonly weekend = signal<number[]>([]);
  protected readonly currency = signal('OMR');
  protected readonly canEdit = computed(() => this.ctx.can('settings.manage'));

  protected readonly form = this.fb.group({
    profile: this.fb.group({
      name: ['', [Validators.required, Validators.minLength(2), Validators.maxLength(120)]],
      name_ar: [''],
      legal_name: [''],
      business_type: ['unisex_salon' as BusinessType],
    }),
    settings: this.fb.group({
      default_language: ['en' as 'en' | 'ar'],
      timezone: ['Asia/Muscat'],
      phone_country_code: ['+968', Validators.pattern(/^\+[0-9]{1,4}$/)],
      week_starts_on: [0],
      show_hijri_dates: [false],
      vat_registered: [false],
      vat_number: ['', Validators.pattern(/^[A-Z0-9]{5,20}$/)],
      default_vat_rate: [5, [Validators.required, Validators.min(0), Validators.max(100)]],
      prices_include_vat: [true],
      allow_negative_stock: [false],
      invoice_prefix: ['INV', [Validators.required, Validators.pattern(/^[A-Z0-9-]{1,10}$/)]],
      receipt_footer_en: [''],
      receipt_footer_ar: [''],
    }),
  });

  async ngOnInit(): Promise<void> {
    const tenantId = this.ctx.tenantId();
    if (!tenantId) return;
    try {
      const { tenant, settings } = await this.service.load(tenantId);
      if (!TIMEZONES.includes(settings.timezone)) this.timezones = [settings.timezone, ...TIMEZONES];
      this.form.setValue({
        profile: {
          name: tenant.name,
          name_ar: tenant.name_ar ?? '',
          legal_name: tenant.legal_name ?? '',
          business_type: tenant.business_type as BusinessType,
        },
        settings: {
          default_language: settings.default_language as 'en' | 'ar',
          timezone: settings.timezone,
          phone_country_code: settings.phone_country_code,
          week_starts_on: settings.week_starts_on,
          show_hijri_dates: settings.show_hijri_dates,
          vat_registered: settings.vat_registered,
          vat_number: settings.vat_number ?? '',
          default_vat_rate: Number(settings.default_vat_rate),
          prices_include_vat: settings.prices_include_vat,
          allow_negative_stock: settings.allow_negative_stock,
          invoice_prefix: settings.invoice_prefix,
          receipt_footer_en: settings.receipt_footer_en ?? '',
          receipt_footer_ar: settings.receipt_footer_ar ?? '',
        },
      });
      this.weekend.set([...settings.weekend_days]);
      this.currency.set(settings.currency_code);
      if (settings.logo_path) this.logoUrl.set(await this.service.signedUrl(settings.logo_path));
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.loading.set(false);
    }
  }

  protected toggleWeekend(day: number): void {
    this.weekend.update((days) => (days.includes(day) ? days.filter((d) => d !== day) : [...days, day].sort()));
  }

  async save(): Promise<void> {
    const tenantId = this.ctx.tenantId();
    if (!tenantId || this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const { profile, settings } = this.form.getRawValue();
    this.saving.set(true);
    try {
      await this.service.save(
        tenantId,
        { ...profile, name: profile.name.trim(), name_ar: profile.name_ar.trim() || null, legal_name: profile.legal_name.trim() || null },
        {
          ...settings,
          vat_number: settings.vat_number.trim().toUpperCase() || null,
          receipt_footer_en: settings.receipt_footer_en.trim() || null,
          receipt_footer_ar: settings.receipt_footer_ar.trim() || null,
          weekend_days: this.weekend(),
        },
      );
      await this.ctx.refresh();
      this.toast.success(this.i18n.t('common.saved'));
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.saving.set(false);
    }
  }

  async uploadLogo(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    const tenantId = this.ctx.tenantId();
    input.value = '';
    if (!file || !tenantId) return;
    this.uploading.set(true);
    try {
      const path = await this.service.uploadLogo(tenantId, file);
      this.logoUrl.set(await this.service.signedUrl(path));
      this.toast.success(this.i18n.t('common.saved'));
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.uploading.set(false);
    }
  }
}

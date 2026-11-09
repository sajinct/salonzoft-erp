import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { LucideDynamicIcon } from '@lucide/angular';
import { debounceTime, distinctUntilChanged } from 'rxjs';
import { I18nService, Lang, TranslateDynamicPipe, TranslatePipe } from '../../core/i18n/i18n.service';
import { ToastService } from '../../core/services/toast.service';
import { TenantContextService } from '../../core/tenant/tenant-context.service';
import { BUSINESS_TYPES, BusinessType, OnboardingService, slugify } from './onboarding.service';

@Component({
  selector: 'sz-create-business-page',
  imports: [ReactiveFormsModule, TranslatePipe, TranslateDynamicPipe, LucideDynamicIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="page-title">{{ 'onboarding.title' | t }}</h1>
    <p class="mt-1 text-sm text-muted">{{ 'onboarding.subtitle' | t }}</p>

    <form class="mt-8 space-y-5" [formGroup]="form" (ngSubmit)="submit()" novalidate>
      <div class="field">
        <label class="label" for="name">{{ 'onboarding.businessName' | t }}</label>
        <input id="name" class="input" formControlName="name" autocomplete="organization" />
      </div>

      <div class="field">
        <label class="label" for="slug">{{ 'onboarding.slug' | t }}</label>
        <div class="flex items-center rounded-xl border border-line bg-surface-2 ps-3 text-sm text-muted focus-within:border-primary" dir="ltr">
          <span class="shrink-0">salonzoft.com/book/</span>
          <input id="slug" class="h-10 w-full bg-surface px-2 text-ink outline-none rounded-e-xl" formControlName="slug" autocapitalize="off" spellcheck="false" (input)="slugEdited = true" />
        </div>
        @if (slugState() === 'available') {
          <p class="flex items-center gap-1 text-xs text-success"><svg lucideIcon="check" [size]="14"></svg>{{ 'onboarding.slugAvailable' | t }}</p>
        } @else if (slugState() === 'taken') {
          <p class="error-text">{{ 'onboarding.slugTaken' | t }}</p>
        } @else {
          <p class="hint">{{ 'onboarding.slugHint' | t: { slug: form.controls.slug.value || '…' } }}</p>
        }
      </div>

      <div class="field">
        <label class="label" for="type">{{ 'onboarding.businessType' | t }}</label>
        <select id="type" class="input" formControlName="businessType">
          @for (type of types; track type) {
            <option [value]="type">{{ 'businessType.' + type | tx }}</option>
          }
        </select>
      </div>

      <div class="field">
        <label class="label" for="branch">{{ 'onboarding.branchName' | t }}</label>
        <input id="branch" class="input" formControlName="branchName" />
        <p class="hint">{{ 'onboarding.branchHint' | t }}</p>
      </div>

      <fieldset class="field">
        <legend class="label mb-1.5">{{ 'onboarding.language' | t }}</legend>
        <div class="grid grid-cols-2 gap-2">
          @for (lang of langs; track lang.value) {
            <label class="flex cursor-pointer items-center gap-2 rounded-xl border border-line px-3 py-2 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary-soft">
              <input type="radio" class="checkbox" formControlName="language" [value]="lang.value" /> {{ lang.label }}
            </label>
          }
        </div>
      </fieldset>

      <button type="submit" class="btn-primary w-full" [disabled]="busy() || slugState() === 'taken'">
        {{ busy() ? ('onboarding.creating' | t) : ('onboarding.create' | t) }}
      </button>
    </form>
  `,
})
export class CreateBusinessPage {
  private readonly onboarding = inject(OnboardingService);
  private readonly ctx = inject(TenantContextService);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  private readonly i18n = inject(I18nService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly types = BUSINESS_TYPES;
  protected readonly langs: { value: Lang; label: string }[] = [
    { value: 'en', label: 'English' },
    { value: 'ar', label: 'العربية' },
  ];
  protected readonly busy = signal(false);
  protected readonly slugState = signal<'unknown' | 'available' | 'taken'>('unknown');
  protected slugEdited = false;
  // One key per page visit: double-clicks / retries can't create two businesses.
  private readonly idempotencyKey = crypto.randomUUID();

  protected readonly form = inject(NonNullableFormBuilder).group({
    name: ['', [Validators.required, Validators.minLength(2), Validators.maxLength(120)]],
    slug: ['', [Validators.required, Validators.pattern(/^[a-z0-9](?:[a-z0-9]|-(?!-)){1,46}[a-z0-9]$/)]],
    businessType: ['unisex_salon' as BusinessType, Validators.required],
    branchName: ['', Validators.maxLength(120)],
    language: [this.i18n.lang() as Lang],
  });

  constructor() {
    this.form.controls.name.valueChanges.pipe(takeUntilDestroyed()).subscribe((name) => {
      if (!this.slugEdited) this.form.controls.slug.setValue(slugify(name), { emitEvent: true });
    });
    this.form.controls.slug.valueChanges
      .pipe(debounceTime(350), distinctUntilChanged(), takeUntilDestroyed(this.destroyRef))
      .subscribe((slug) => void this.checkSlug(slug));
  }

  protected async checkSlug(slug: string): Promise<void> {
    if (this.form.controls.slug.invalid) {
      this.slugState.set('unknown');
      return;
    }
    try {
      this.slugState.set((await this.onboarding.isSlugAvailable(slug)) ? 'available' : 'taken');
    } catch {
      this.slugState.set('unknown');
    }
  }

  async submit(): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.busy.set(true);
    try {
      const v = this.form.getRawValue();
      const result = await this.onboarding.createBusiness({
        name: v.name.trim(),
        slug: v.slug,
        businessType: v.businessType,
        branchName: v.branchName.trim() || v.name.trim(),
        language: v.language,
        idempotencyKey: this.idempotencyKey,
      });
      await this.ctx.loadTenants();
      await this.ctx.select(result.tenant_id);
      await this.router.navigateByUrl('/dashboard');
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.busy.set(false);
    }
  }
}

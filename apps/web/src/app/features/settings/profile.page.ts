import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { AuthService } from '../../core/auth/auth.service';
import { I18nService, Lang, TranslatePipe } from '../../core/i18n/i18n.service';
import { ToastService } from '../../core/services/toast.service';
import { PageHeader, StatePanel } from '../../shared/components/ui';
import { PASSWORD_VALIDATORS } from '../auth/auth-shared';
import { ProfileService } from './data/settings.services';

@Component({
  selector: 'sz-profile-page',
  imports: [ReactiveFormsModule, TranslatePipe, PageHeader, StatePanel],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <sz-page-header [heading]="'settings.profile' | t" [subtitle]="'profile.subtitle' | t" />
    @if (loading()) {
      <div class="card"><sz-state [loading]="true" /></div>
    } @else {
      <form class="card space-y-5 p-6" [formGroup]="form" (ngSubmit)="save()" novalidate>
        <div class="grid gap-4 sm:grid-cols-2">
          <div class="field"><label class="label" for="fn">{{ 'profile.fullName' | t }}</label><input id="fn" class="input" formControlName="full_name" autocomplete="name" /></div>
          <div class="field">
            <label class="label" for="ph">{{ 'profile.phone' | t }}</label>
            <input id="ph" class="input" formControlName="phone" dir="ltr" placeholder="+96890000000" autocomplete="tel" />
            @if (form.controls.phone.invalid && form.controls.phone.touched) { <p class="error-text">{{ 'common.invalid' | t }}</p> }
          </div>
          <div class="field">
            <label class="label" for="lang">{{ 'profile.language' | t }}</label>
            <select id="lang" class="input" formControlName="preferred_language"><option value="en">English</option><option value="ar">العربية</option></select>
          </div>
          <div class="field"><span class="label">{{ 'auth.email' | t }}</span><input class="input" [value]="auth.user()?.email ?? ''" disabled dir="ltr" /></div>
        </div>
        <div class="flex justify-end"><button type="submit" class="btn-primary" [disabled]="saving()">{{ 'common.save' | t }}</button></div>
      </form>

      <form class="card mt-6 space-y-4 p-6" [formGroup]="passwordForm" (ngSubmit)="changePassword()" novalidate>
        <h2 class="text-base font-semibold">{{ 'profile.changePassword' | t }}</h2>
        <div class="field max-w-sm">
          <label class="label" for="pw">{{ 'auth.newPassword' | t }}</label>
          <input id="pw" class="input" type="password" formControlName="password" autocomplete="new-password" dir="ltr" />
          <p class="hint">{{ 'auth.passwordHint' | t }}</p>
        </div>
        <button type="submit" class="btn-secondary" [disabled]="saving()">{{ 'auth.setNewPassword' | t }}</button>
      </form>
    }
  `,
})
export class ProfilePage implements OnInit {
  protected readonly auth = inject(AuthService);
  private readonly profiles = inject(ProfileService);
  private readonly toast = inject(ToastService);
  private readonly i18n = inject(I18nService);
  private readonly fb = inject(NonNullableFormBuilder);

  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly form = this.fb.group({
    full_name: ['', Validators.maxLength(120)],
    phone: ['', Validators.pattern(/^\+?[0-9]{6,15}$/)],
    preferred_language: ['en' as Lang],
  });
  protected readonly passwordForm = this.fb.group({ password: ['', PASSWORD_VALIDATORS] });

  async ngOnInit(): Promise<void> {
    const id = this.auth.user()?.id;
    if (!id) return;
    try {
      const p = await this.profiles.load(id);
      this.form.setValue({ full_name: p.full_name ?? '', phone: p.phone ?? '', preferred_language: p.preferred_language as Lang });
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.loading.set(false);
    }
  }

  async save(): Promise<void> {
    const id = this.auth.user()?.id;
    if (!id || this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const v = this.form.getRawValue();
    this.saving.set(true);
    try {
      await this.profiles.save(id, { full_name: v.full_name.trim() || null, phone: v.phone.trim() || null, preferred_language: v.preferred_language });
      this.i18n.setLang(v.preferred_language);
      this.toast.success(this.i18n.t('common.saved'));
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.saving.set(false);
    }
  }

  async changePassword(): Promise<void> {
    if (this.passwordForm.invalid) {
      this.passwordForm.markAllAsTouched();
      return;
    }
    this.saving.set(true);
    try {
      await this.auth.updatePassword(this.passwordForm.getRawValue().password);
      this.passwordForm.reset();
      this.toast.success(this.i18n.t('auth.passwordUpdated'));
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.saving.set(false);
    }
  }
}

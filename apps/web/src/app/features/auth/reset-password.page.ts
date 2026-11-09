import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { I18nService, TranslatePipe } from '../../core/i18n/i18n.service';
import { ToastService } from '../../core/services/toast.service';
import { PASSWORD_VALIDATORS } from './auth-shared';

/** Landing page of the password-recovery email (session established via PKCE code). */
@Component({
  selector: 'sz-reset-password-page',
  imports: [ReactiveFormsModule, TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="page-title">{{ 'auth.setNewPassword' | t }}</h1>
    @if (ready() && !signedIn()) {
      <p class="mt-6 rounded-xl bg-danger-soft px-3 py-2 text-sm text-danger" role="alert">{{ 'auth.callbackFailed' | t }}</p>
    } @else {
      <form class="mt-8 space-y-4" [formGroup]="form" (ngSubmit)="submit()" novalidate>
        <div class="field">
          <label class="label" for="password">{{ 'auth.newPassword' | t }}</label>
          <input id="password" class="input" type="password" formControlName="password" autocomplete="new-password" dir="ltr" />
          <p class="hint">{{ 'auth.passwordHint' | t }}</p>
        </div>
        <button type="submit" class="btn-primary w-full" [disabled]="busy() || !ready()">{{ 'auth.setNewPassword' | t }}</button>
      </form>
    }
  `,
})
export class ResetPasswordPage {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  private readonly i18n = inject(I18nService);
  protected readonly busy = signal(false);
  protected readonly ready = signal(false);
  protected readonly signedIn = this.auth.isSignedIn;
  protected readonly form = inject(NonNullableFormBuilder).group({ password: ['', PASSWORD_VALIDATORS] });

  constructor() {
    void this.auth.ready.then(() => this.ready.set(true));
  }

  async submit(): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.busy.set(true);
    try {
      await this.auth.updatePassword(this.form.getRawValue().password);
      this.toast.success(this.i18n.t('auth.passwordUpdated'));
      await this.router.navigateByUrl('/');
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.busy.set(false);
    }
  }
}

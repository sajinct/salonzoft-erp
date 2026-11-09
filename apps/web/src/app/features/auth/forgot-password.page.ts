import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { TranslatePipe } from '../../core/i18n/i18n.service';
import { ToastService } from '../../core/services/toast.service';

@Component({
  selector: 'sz-forgot-password-page',
  imports: [ReactiveFormsModule, RouterLink, TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="page-title">{{ 'auth.resetTitle' | t }}</h1>
    <p class="mt-1 text-sm text-muted">{{ 'auth.resetSubtitle' | t }}</p>
    @if (sent()) {
      <div class="mt-8 rounded-2xl bg-success-soft p-5 text-sm text-success" role="status">{{ 'auth.resetSent' | t }}</div>
    } @else {
      <form class="mt-8 space-y-4" [formGroup]="form" (ngSubmit)="submit()" novalidate>
        <div class="field">
          <label class="label" for="email">{{ 'auth.email' | t }}</label>
          <input id="email" class="input" type="email" formControlName="email" autocomplete="email" dir="ltr" />
        </div>
        <button type="submit" class="btn-primary w-full" [disabled]="busy()">{{ 'auth.sendResetLink' | t }}</button>
      </form>
    }
    <p class="mt-6 text-center text-sm"><a routerLink="/auth/login" class="font-semibold text-primary hover:underline">{{ 'common.back' | t }}</a></p>
  `,
})
export class ForgotPasswordPage {
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  protected readonly busy = signal(false);
  protected readonly sent = signal(false);
  protected readonly form = inject(NonNullableFormBuilder).group({ email: ['', [Validators.required, Validators.email]] });

  async submit(): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.busy.set(true);
    try {
      await this.auth.sendPasswordReset(this.form.getRawValue().email.trim());
      this.sent.set(true); // same message whether or not the account exists (no enumeration)
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.busy.set(false);
    }
  }
}

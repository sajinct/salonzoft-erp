import { ChangeDetectionStrategy, Component, inject, input, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { I18nService, TranslatePipe } from '../../core/i18n/i18n.service';
import { ToastService } from '../../core/services/toast.service';
import { PASSWORD_VALIDATORS, safeNext } from './auth-shared';

@Component({
  selector: 'sz-signup-page',
  imports: [ReactiveFormsModule, RouterLink, TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="page-title">{{ 'auth.signUpTitle' | t }}</h1>
    <p class="mt-1 text-sm text-muted">{{ 'auth.signUpSubtitle' | t }}</p>

    @if (awaitingConfirmation()) {
      <div class="mt-8 rounded-2xl bg-success-soft p-5 text-sm text-success" role="status">{{ 'auth.checkEmail' | t }}</div>
    } @else {
      <form class="mt-8 space-y-4" [formGroup]="form" (ngSubmit)="submit()" novalidate>
        <div class="field">
          <label class="label" for="fullName">{{ 'auth.fullName' | t }}</label>
          <input id="fullName" class="input" formControlName="fullName" autocomplete="name" />
        </div>
        <div class="field">
          <label class="label" for="email">{{ 'auth.email' | t }}</label>
          <input id="email" class="input" type="email" formControlName="email" autocomplete="email" dir="ltr" />
        </div>
        <div class="field">
          <label class="label" for="password">{{ 'auth.password' | t }}</label>
          <input id="password" class="input" type="password" formControlName="password" autocomplete="new-password" dir="ltr" />
          <p class="hint" [class.!text-danger]="form.controls.password.touched && form.controls.password.invalid">{{ 'auth.passwordHint' | t }}</p>
        </div>
        @if (error()) {
          <p class="rounded-xl bg-danger-soft px-3 py-2 text-sm text-danger" role="alert">{{ error() }}</p>
        }
        <button type="submit" class="btn-primary w-full" [disabled]="busy()">{{ busy() ? ('common.loading' | t) : ('auth.signUp' | t) }}</button>
      </form>
    }

    <p class="mt-6 text-center text-sm text-muted">
      {{ 'auth.haveAccount' | t }}
      <a [routerLink]="'/auth/login'" [queryParams]="next() ? { next: next() } : {}" class="font-semibold text-primary hover:underline">{{ 'auth.signIn' | t }}</a>
    </p>
  `,
})
export class SignupPage {
  private readonly auth = inject(AuthService);
  private readonly i18n = inject(I18nService);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  readonly next = input<string>();

  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly awaitingConfirmation = signal(false);
  protected readonly form = inject(NonNullableFormBuilder).group({
    fullName: ['', [Validators.required, Validators.maxLength(120)]],
    email: ['', [Validators.required, Validators.email]],
    password: ['', PASSWORD_VALIDATORS],
  });

  async submit(): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    try {
      const { fullName, email, password } = this.form.getRawValue();
      const next = safeNext(this.next(), '/onboarding');
      const signedIn = await this.auth.signUp(email.trim(), password, fullName.trim(), this.i18n.lang(), next);
      if (signedIn) await this.router.navigateByUrl(next);
      else this.awaitingConfirmation.set(true);
    } catch (err) {
      this.error.set(this.toast.describe(err));
    } finally {
      this.busy.set(false);
    }
  }
}

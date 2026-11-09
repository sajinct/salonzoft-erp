import { ChangeDetectionStrategy, Component, inject, input, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { TranslatePipe } from '../../core/i18n/i18n.service';
import { ToastService } from '../../core/services/toast.service';
import { safeNext } from './auth-shared';

@Component({
  selector: 'sz-login-page',
  imports: [ReactiveFormsModule, RouterLink, TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="page-title">{{ 'auth.signInTitle' | t }}</h1>
    <p class="mt-1 text-sm text-muted">{{ 'auth.signInSubtitle' | t }}</p>

    <form class="mt-8 space-y-4" [formGroup]="form" (ngSubmit)="submit()" novalidate>
      <div class="field">
        <label class="label" for="email">{{ 'auth.email' | t }}</label>
        <input id="email" class="input" type="email" formControlName="email" autocomplete="email" dir="ltr" />
      </div>
      <div class="field">
        <div class="flex items-center justify-between">
          <label class="label" for="password">{{ 'auth.password' | t }}</label>
          <a routerLink="/auth/forgot-password" class="text-xs font-medium text-primary hover:underline">{{ 'auth.forgotPassword' | t }}</a>
        </div>
        <input id="password" class="input" type="password" formControlName="password" autocomplete="current-password" dir="ltr" />
      </div>
      @if (error()) {
        <p class="rounded-xl bg-danger-soft px-3 py-2 text-sm text-danger" role="alert">{{ error() }}</p>
      }
      <button type="submit" class="btn-primary w-full" [disabled]="busy()">{{ busy() ? ('common.loading' | t) : ('auth.signIn' | t) }}</button>
    </form>

    <p class="mt-6 text-center text-sm text-muted">
      {{ 'auth.noAccount' | t }}
      <a [routerLink]="'/auth/signup'" [queryParams]="next() ? { next: next() } : {}" class="font-semibold text-primary hover:underline">{{ 'auth.signUp' | t }}</a>
    </p>
  `,
})
export class LoginPage {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  readonly next = input<string>();

  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly form = inject(NonNullableFormBuilder).group({
    email: ['', [Validators.required, Validators.email]],
    password: ['', Validators.required],
  });

  async submit(): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    try {
      const { email, password } = this.form.getRawValue();
      await this.auth.signIn(email.trim(), password);
      await this.router.navigateByUrl(safeNext(this.next()));
    } catch (err) {
      this.error.set(this.toast.describe(err));
    } finally {
      this.busy.set(false);
    }
  }
}

import { Injectable, inject, signal } from '@angular/core';
import { I18nService } from '../i18n/i18n.service';
import { toAppError } from '../supabase/app-error';

export interface Toast {
  id: number;
  kind: 'success' | 'error' | 'info';
  message: string;
}

@Injectable({ providedIn: 'root' })
export class ToastService {
  private readonly i18n = inject(I18nService);
  private nextId = 1;
  readonly toasts = signal<Toast[]>([]);

  success(message: string): void {
    this.push('success', message);
  }

  info(message: string): void {
    this.push('info', message);
  }

  /** Show a translated message for any thrown error. */
  error(err: unknown): void {
    this.push('error', this.describe(err));
  }

  describe(err: unknown): string {
    const e = toAppError(err);
    if (e.code === 'NETWORK') return this.i18n.t('errors.network');
    if (e.code === 'invalid_credentials') return this.i18n.t('auth.invalidCredentials');
    return this.i18n.error(e.code, e.details);
  }

  dismiss(id: number): void {
    this.toasts.update((list) => list.filter((t) => t.id !== id));
  }

  private push(kind: Toast['kind'], message: string): void {
    const id = this.nextId++;
    this.toasts.update((list) => [...list.slice(-3), { id, kind, message }]);
    setTimeout(() => this.dismiss(id), kind === 'error' ? 7000 : 4000);
  }
}

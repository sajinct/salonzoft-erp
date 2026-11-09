import { Dialog, DialogRef, DIALOG_DATA } from '@angular/cdk/dialog';
import { ChangeDetectionStrategy, Component, Injectable, inject, input } from '@angular/core';
import { LucideDynamicIcon } from '@lucide/angular';
import { firstValueFrom } from 'rxjs';
import { TranslatePipe } from '../../core/i18n/i18n.service';
import { ToastService } from '../../core/services/toast.service';

/** Page heading with optional actions slot. */
@Component({
  selector: 'sz-page-header',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 class="page-title">{{ heading() }}</h1>
        @if (subtitle()) {
          <p class="mt-1 text-sm text-muted">{{ subtitle() }}</p>
        }
      </div>
      <div class="flex items-center gap-2"><ng-content /></div>
    </div>
  `,
})
export class PageHeader {
  readonly heading = input.required<string>();
  readonly subtitle = input<string>();
}

/** Global toast stack (mounted once in the root component). */
@Component({
  selector: 'sz-toasts',
  imports: [LucideDynamicIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="pointer-events-none fixed bottom-4 end-4 z-[2000] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2" aria-live="polite">
      @for (toast of toasts.toasts(); track toast.id) {
        <div
          class="pointer-events-auto flex items-start gap-3 rounded-xl border px-4 py-3 text-sm shadow-lg"
          [class]="toast.kind === 'error' ? 'border-danger/30 bg-danger-soft text-danger' : toast.kind === 'success' ? 'border-success/30 bg-success-soft text-success' : 'border-line bg-surface text-ink'"
          role="status"
        >
          <svg [lucideIcon]="toast.kind === 'error' ? 'circle-alert' : 'circle-check'" [size]="18" class="mt-0.5 shrink-0"></svg>
          <span class="flex-1">{{ toast.message }}</span>
          <button type="button" class="opacity-60 hover:opacity-100" (click)="toasts.dismiss(toast.id)" aria-label="Dismiss">
            <svg lucideIcon="x" [size]="16"></svg>
          </button>
        </div>
      }
    </div>
  `,
})
export class ToastOutlet {
  protected readonly toasts = inject(ToastService);
}

export interface ConfirmData {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
}

@Component({
  selector: 'sz-confirm-dialog',
  imports: [TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="card w-[min(28rem,calc(100vw-2rem))] p-6" role="alertdialog" aria-modal="true">
      <h2 class="text-lg font-semibold">{{ data.title }}</h2>
      <p class="mt-2 text-sm text-muted">{{ data.message }}</p>
      <div class="mt-6 flex justify-end gap-2">
        <button type="button" class="btn-secondary" (click)="ref.close(false)">{{ 'common.cancel' | t }}</button>
        <button type="button" [class]="data.danger ? 'btn-danger' : 'btn-primary'" (click)="ref.close(true)" cdkFocusInitial>
          {{ data.confirmLabel }}
        </button>
      </div>
    </div>
  `,
})
export class ConfirmDialog {
  protected readonly data = inject<ConfirmData>(DIALOG_DATA);
  protected readonly ref = inject<DialogRef<boolean>>(DialogRef);
}

@Injectable({ providedIn: 'root' })
export class ConfirmService {
  private readonly dialog = inject(Dialog);

  async ask(data: ConfirmData): Promise<boolean> {
    const ref = this.dialog.open<boolean, ConfirmData>(ConfirmDialog, { data });
    return (await firstValueFrom(ref.closed)) === true;
  }
}

/** Centered state panel for loading / empty / error. */
@Component({
  selector: 'sz-state',
  imports: [LucideDynamicIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
      @if (loading()) {
        <span class="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" aria-hidden="true"></span>
      } @else if (icon()) {
        <span class="grid h-12 w-12 place-items-center rounded-2xl bg-primary-soft text-primary">
          <svg [lucideIcon]="icon()!" [size]="22"></svg>
        </span>
      }
      @if (heading()) {
        <p class="font-semibold">{{ heading() }}</p>
      }
      @if (message()) {
        <p class="max-w-md text-sm text-muted">{{ message() }}</p>
      }
      <ng-content />
    </div>
  `,
})
export class StatePanel {
  readonly loading = input(false);
  readonly icon = input<string>();
  readonly heading = input<string>();
  readonly message = input<string>();
}

import { Dialog, DialogRef, DIALOG_DATA } from '@angular/cdk/dialog';
import { ChangeDetectionStrategy, Component, Injectable, inject, signal } from '@angular/core';
import { LucideDynamicIcon } from '@lucide/angular';
import { firstValueFrom } from 'rxjs';
import { TranslatePipe } from '../../core/i18n/i18n.service';

export interface FormField {
  key: string;
  label: string;
  type: 'text' | 'email' | 'number' | 'select' | 'date' | 'textarea';
  options?: { value: string; label: string }[];
  value?: string;
  required?: boolean;
  hint?: string;
}

export interface FormDialogData {
  title: string;
  message?: string;
  fields: FormField[];
  submitLabel: string;
  danger?: boolean;
}

/** Small labelled form in a dialog; resolves with the values or null. Labels arrive translated. */
@Component({
  selector: 'sz-form-dialog',
  imports: [TranslatePipe, LucideDynamicIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form class="card w-[min(28rem,calc(100vw-2rem))]" role="dialog" aria-modal="true" (submit)="$event.preventDefault(); submit()">
      <header class="flex items-center justify-between border-b border-line px-6 py-4">
        <h2 class="text-lg font-semibold">{{ data.title }}</h2>
        <button type="button" class="btn-icon" (click)="ref.close(null)" [attr.aria-label]="'common.close' | t"><svg lucideIcon="x" [size]="18"></svg></button>
      </header>
      <div class="space-y-4 px-6 py-5 text-sm">
        @if (data.message) { <p class="text-muted">{{ data.message }}</p> }
        @for (f of data.fields; track f.key) {
          <div class="field">
            <label class="label" [for]="'f-' + f.key">{{ f.label }}</label>
            @switch (f.type) {
              @case ('select') {
                <select class="input" [id]="'f-' + f.key" [value]="values()[f.key]" (change)="set(f.key, $any($event.target).value)">
                  @for (o of f.options ?? []; track o.value) { <option [value]="o.value" [selected]="o.value === values()[f.key]">{{ o.label }}</option> }
                </select>
              }
              @case ('textarea') {
                <textarea class="input" rows="3" [id]="'f-' + f.key" [value]="values()[f.key]" (input)="set(f.key, $any($event.target).value)"></textarea>
              }
              @default {
                <input class="input" [id]="'f-' + f.key" [type]="f.type" [attr.dir]="f.type === 'text' ? null : 'ltr'"
                       [value]="values()[f.key]" (input)="set(f.key, $any($event.target).value)" />
              }
            }
            @if (f.hint) { <p class="hint">{{ f.hint }}</p> }
          </div>
        }
      </div>
      <footer class="flex justify-end gap-2 border-t border-line px-6 py-4">
        <button type="button" class="btn-secondary" (click)="ref.close(null)">{{ 'common.cancel' | t }}</button>
        <button type="submit" [class]="data.danger ? 'btn-danger' : 'btn-primary'" [disabled]="!valid()">{{ data.submitLabel }}</button>
      </footer>
    </form>
  `,
})
export class FormDialog {
  protected readonly data = inject<FormDialogData>(DIALOG_DATA);
  protected readonly ref = inject<DialogRef<Record<string, string> | null>>(DialogRef);
  protected readonly values = signal<Record<string, string>>(
    Object.fromEntries(this.data.fields.map((f) => [f.key, f.value ?? (f.type === 'select' ? (f.options?.[0]?.value ?? '') : '')])),
  );

  protected set(key: string, value: string): void {
    this.values.update((v) => ({ ...v, [key]: value }));
  }

  protected valid(): boolean {
    return this.data.fields.every((f) => !f.required || (this.values()[f.key] ?? '').trim() !== '');
  }

  protected submit(): void {
    if (this.valid()) this.ref.close(this.values());
  }
}

@Injectable({ providedIn: 'root' })
export class FormDialogService {
  private readonly dialog = inject(Dialog);

  async open(data: FormDialogData): Promise<Record<string, string> | null> {
    const ref = this.dialog.open<Record<string, string> | null, FormDialogData>(FormDialog, { data });
    return (await firstValueFrom(ref.closed)) ?? null;
  }
}

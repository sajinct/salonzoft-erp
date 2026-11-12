import { Dialog, DialogRef, DIALOG_DATA } from '@angular/cdk/dialog';
import { ChangeDetectionStrategy, Component, Injectable, inject, signal } from '@angular/core';
import { LucideDynamicIcon } from '@lucide/angular';
import { firstValueFrom } from 'rxjs';
import { I18nService, TranslatePipe } from '../../core/i18n/i18n.service';
import { ToastService } from '../../core/services/toast.service';
import { ImportResult, Table, downloadCsv, downloadXlsx, readTableFile } from './table-io';

/** Everything page-specific about an import. Texts arrive translated. */
export interface ImportDialogData<R extends ImportResult = ImportResult> {
  title: string;
  hint: string;
  rules: string;
  chooseFile: string;
  /** Recognised column headers, shown as a list. */
  headers: string[];
  /** Example file offered for download. */
  template: Table;
  templateName: string;
  sheet: string;
  widths: number[];
  maxRows: number;
  /** Sheet → rows for the RPC. Throws IMPORT_NO_NAME_COLUMN when the required column is missing. */
  parse(table: unknown[][]): { rows: Record<string, string>[]; columns: string[] };
  run(rows: Record<string, string>[], dryRun: boolean): Promise<R>;
  /** Summary lines for a result ("3 services will be added", …). */
  summary(result: R): { text: string; muted?: boolean }[];
}

const KNOWN_ERRORS = ['IMPORT_NO_NAME_COLUMN', 'IMPORT_OLD_EXCEL'];
/** Row errors whose server detail names the offending value ("Unknown branch …"). */
const NAMED_ERRORS = ['INVALID_BRANCH', 'INVALID_SERVICE', 'INVALID_DATE'];

/** Import from CSV or Excel: choose file → check (dry run) → import. Closes with true when something was saved. */
@Component({
  selector: 'sz-import-dialog',
  imports: [TranslatePipe, LucideDynamicIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="card flex max-h-[92vh] w-[min(40rem,calc(100vw-2rem))] flex-col" role="dialog" aria-modal="true">
      <header class="flex items-center justify-between border-b border-line px-6 py-4">
        <h2 class="text-lg font-semibold">{{ data.title }}</h2>
        <button type="button" class="btn-icon" (click)="ref.close(imported)" [attr.aria-label]="'common.close' | t"><svg lucideIcon="x" [size]="18"></svg></button>
      </header>
      <div class="flex-1 space-y-4 overflow-y-auto px-6 py-5 text-sm">
        <p class="text-muted">{{ data.hint }}</p>
        <code class="block overflow-x-auto whitespace-nowrap rounded-xl bg-surface-2 px-3 py-2 text-xs" dir="ltr">{{ headers }}</code>
        <p class="text-muted">{{ data.rules }}</p>
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-muted">{{ 'import.template' | t }}</span>
          <button type="button" class="btn-secondary btn-sm" (click)="template('xlsx')"><svg lucideIcon="download" [size]="14"></svg>Excel</button>
          <button type="button" class="btn-secondary btn-sm" (click)="template('csv')"><svg lucideIcon="download" [size]="14"></svg>CSV</button>
        </div>
        <input type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" class="block w-full text-sm"
               (change)="pick($event)" [attr.aria-label]="data.chooseFile" />

        @if (rows().length > 0) {
          <p><strong>{{ rows().length }}</strong> {{ 'customers.rowsFound' | t }} · <span class="text-muted" dir="ltr">{{ columns().join(', ') }}</span></p>
        }

        @if (result(); as r) {
          <div class="rounded-xl border border-line p-4">
            <p class="font-semibold">{{ (r.dry_run ? 'customers.dryRunResult' : 'customers.importResult') | t }}</p>
            <ul class="mt-2 space-y-1">
              @for (line of data.summary(r); track $index) { <li [class]="line.muted ? 'text-muted' : 'text-success'">{{ line.text }}</li> }
              <li [class.text-danger]="r.errors.length > 0">{{ 'customers.rowErrors' | t: { n: r.errors.length } }}</li>
            </ul>
            @if (r.errors.length > 0) {
              <ul class="mt-3 max-h-40 space-y-1 overflow-y-auto text-xs">
                @for (e of r.errors.slice(0, 100); track e.row) {
                  <li><span class="num">{{ 'customers.row' | t: { n: e.row + 1 } }}</span>: {{ describe(e) }}</li>
                }
              </ul>
            }
          </div>
        }
      </div>
      <footer class="flex justify-end gap-2 border-t border-line px-6 py-4">
        <button type="button" class="btn-secondary" (click)="ref.close(imported)">{{ 'common.close' | t }}</button>
        <button type="button" class="btn-secondary" [disabled]="busy() || rows().length === 0" (click)="run(true)">{{ 'customers.checkFile' | t }}</button>
        <button type="button" class="btn-primary" [disabled]="busy() || !canImport()" (click)="run(false)">
          {{ busy() ? ('common.saving' | t) : ('customers.importNow' | t) }}
        </button>
      </footer>
    </div>
  `,
})
export class ImportDialog {
  protected readonly ref = inject<DialogRef<boolean>>(DialogRef);
  protected readonly data = inject<ImportDialogData>(DIALOG_DATA);
  private readonly i18n = inject(I18nService);
  private readonly toast = inject(ToastService);

  protected readonly headers = this.data.headers.join(', ');
  protected readonly rows = signal<Record<string, string>[]>([]);
  protected readonly columns = signal<string[]>([]);
  protected readonly result = signal<ImportResult | null>(null);
  protected readonly busy = signal(false);
  protected imported = false;

  /** Import is offered once the check found something to add or update. */
  protected canImport(): boolean {
    const r = this.result();
    return !!r && r.dry_run && r.inserted + r.updated > 0 && this.rows().length > 0;
  }

  /** Errors that name the offending value (unknown branch, bad date) show that detail; the rest use the dictionary. */
  protected describe(e: ImportResult['errors'][number]): string {
    const named = NAMED_ERRORS.includes(e.code) && !!e.detail && e.detail !== e.code;
    return named ? e.detail : this.i18n.error(e.code, e.detail);
  }

  protected template(kind: 'csv' | 'xlsx'): void {
    const d = this.data;
    if (kind === 'csv') downloadCsv(d.template, `${d.templateName}.csv`);
    else void downloadXlsx(d.template, `${d.templateName}.xlsx`, d.sheet, d.widths).catch((err) => this.toast.error(err));
  }

  async pick(event: Event): Promise<void> {
    const file = (event.target as HTMLInputElement).files?.[0];
    this.result.set(null);
    this.rows.set([]);
    this.columns.set([]);
    if (!file) return;
    try {
      const parsed = this.data.parse(await readTableFile(file));
      if (parsed.rows.length > this.data.maxRows) {
        this.toast.error({ message: 'IMPORT_TOO_LARGE' });
        return;
      }
      this.rows.set(parsed.rows);
      this.columns.set(parsed.columns);
    } catch (err) {
      const code = err instanceof Error && KNOWN_ERRORS.includes(err.message) ? err.message : 'IMPORT_UNREADABLE';
      this.toast.error({ message: code });
    }
  }

  async run(dryRun: boolean): Promise<void> {
    this.busy.set(true);
    try {
      const result = await this.data.run(this.rows(), dryRun);
      this.result.set(result);
      if (!dryRun) {
        this.imported = this.imported || result.inserted + result.updated > 0;
        this.rows.set([]);
      }
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.busy.set(false);
    }
  }
}

@Injectable({ providedIn: 'root' })
export class ImportDialogService {
  private readonly dialog = inject(Dialog);

  /** Resolves true when something was imported. */
  async open<R extends ImportResult>(data: ImportDialogData<R>): Promise<boolean> {
    const ref = this.dialog.open<boolean, ImportDialogData>(ImportDialog, { data: data as unknown as ImportDialogData, disableClose: true });
    return (await firstValueFrom(ref.closed)) === true;
  }
}

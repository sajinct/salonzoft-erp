import { DialogRef } from '@angular/cdk/dialog';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { LucideDynamicIcon } from '@lucide/angular';
import { I18nService, TranslatePipe } from '../../core/i18n/i18n.service';
import { ToastService } from '../../core/services/toast.service';
import { TenantContextService } from '../../core/tenant/tenant-context.service';
import {
  SERVICE_COLUMNS, ServiceImportResult, ServiceImportRow, downloadCsv, downloadXlsx, readTableFile, serviceTemplateTable, tableToServiceRows,
} from './data/services-io';
import { ServicesService } from './data/services.service';

const MAX_IMPORT_ROWS = 1000;
const KNOWN_ERRORS = ['IMPORT_NO_NAME_COLUMN', 'IMPORT_OLD_EXCEL'];

/** Import services from CSV or Excel: choose file → check (dry run) → import. Closes with true when something was saved. */
@Component({
  selector: 'sz-services-import-dialog',
  imports: [TranslatePipe, LucideDynamicIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="card flex max-h-[92vh] w-[min(40rem,calc(100vw-2rem))] flex-col" role="dialog" aria-modal="true">
      <header class="flex items-center justify-between border-b border-line px-6 py-4">
        <h2 class="text-lg font-semibold">{{ 'services.import' | t }}</h2>
        <button type="button" class="btn-icon" (click)="ref.close(imported)" [attr.aria-label]="'common.close' | t"><svg lucideIcon="x" [size]="18"></svg></button>
      </header>
      <div class="flex-1 space-y-4 overflow-y-auto px-6 py-5 text-sm">
        <p class="text-muted">{{ 'services.importHint' | t }}</p>
        <code class="block overflow-x-auto whitespace-nowrap rounded-xl bg-surface-2 px-3 py-2 text-xs" dir="ltr">{{ headers }}</code>
        <p class="text-muted">{{ 'services.importRules' | t }}</p>
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-muted">{{ 'services.template' | t }}</span>
          <button type="button" class="btn-secondary btn-sm" (click)="template('xlsx')"><svg lucideIcon="download" [size]="14"></svg>Excel</button>
          <button type="button" class="btn-secondary btn-sm" (click)="template('csv')"><svg lucideIcon="download" [size]="14"></svg>CSV</button>
        </div>
        <input type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" class="block w-full text-sm"
               (change)="pick($event)" [attr.aria-label]="'services.chooseFile' | t" />

        @if (rows().length > 0) {
          <p><strong>{{ rows().length }}</strong> {{ 'customers.rowsFound' | t }} · <span class="text-muted" dir="ltr">{{ columns().join(', ') }}</span></p>
        }

        @if (result(); as r) {
          <div class="rounded-xl border border-line p-4">
            <p class="font-semibold">{{ (r.dry_run ? 'customers.dryRunResult' : 'customers.importResult') | t }}</p>
            <ul class="mt-2 space-y-1">
              <li class="text-success">{{ (r.dry_run ? 'services.willAdd' : 'services.added') | t: { n: r.inserted } }}</li>
              <li class="text-success">{{ (r.dry_run ? 'services.willUpdate' : 'services.updated') | t: { n: r.updated } }}</li>
              @if (r.categories_created > 0) { <li class="text-muted">{{ 'services.newCategories' | t: { n: r.categories_created } }}</li> }
              <li [class.text-danger]="r.errors.length > 0">{{ 'customers.rowErrors' | t: { n: r.errors.length } }}</li>
            </ul>
            @if (r.errors.length > 0) {
              <ul class="mt-3 max-h-40 space-y-1 overflow-y-auto text-xs">
                @for (e of r.errors.slice(0, 100); track e.row) {
                  <li><span class="num">{{ 'customers.row' | t: { n: e.row + 1 } }}</span>: {{ i18n.error(e.code, e.detail) }}</li>
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
export class ServicesImportDialog {
  protected readonly ref = inject<DialogRef<boolean>>(DialogRef);
  protected readonly i18n = inject(I18nService);
  private readonly service = inject(ServicesService);
  private readonly ctx = inject(TenantContextService);
  private readonly toast = inject(ToastService);

  protected readonly headers = SERVICE_COLUMNS.map((c) => c.header).join(', ');
  protected readonly rows = signal<ServiceImportRow[]>([]);
  protected readonly columns = signal<string[]>([]);
  protected readonly result = signal<ServiceImportResult | null>(null);
  protected readonly busy = signal(false);
  protected imported = false;

  /** Import is offered once the check found something to add or update. */
  protected canImport(): boolean {
    const r = this.result();
    return !!r && r.dry_run && r.inserted + r.updated > 0 && this.rows().length > 0;
  }

  protected template(kind: 'csv' | 'xlsx'): void {
    const table = serviceTemplateTable();
    if (kind === 'csv') downloadCsv(table, 'services-template.csv');
    else void downloadXlsx(table, 'services-template.xlsx').catch((err) => this.toast.error(err));
  }

  async pick(event: Event): Promise<void> {
    const file = (event.target as HTMLInputElement).files?.[0];
    this.result.set(null);
    this.rows.set([]);
    this.columns.set([]);
    if (!file) return;
    try {
      const parsed = tableToServiceRows(await readTableFile(file));
      if (parsed.rows.length > MAX_IMPORT_ROWS) {
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
    const tenantId = this.ctx.tenantId();
    if (!tenantId) return;
    this.busy.set(true);
    try {
      const result = await this.service.import(tenantId, this.rows(), dryRun);
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

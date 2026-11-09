import { Dialog, DialogRef } from '@angular/cdk/dialog';
import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { LucideDynamicIcon } from '@lucide/angular';
import { I18nService, TranslatePipe } from '../../core/i18n/i18n.service';
import { ToastService } from '../../core/services/toast.service';
import { TenantContextService } from '../../core/tenant/tenant-context.service';
import { PageHeader, StatePanel } from '../../shared/components/ui';
import { CustomerDialog } from './customer-dialog';
import { csvToImportRows } from './data/csv';
import { Customer, CustomersService, ImportResult, ImportRow } from './data/customers.service';

const MAX_IMPORT_ROWS = 2000;

// ---------------------------------------------------------------------------
// CSV import dialog: choose file → dry run → import
// ---------------------------------------------------------------------------
@Component({
  selector: 'sz-customer-import-dialog',
  imports: [TranslatePipe, LucideDynamicIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="card flex max-h-[92vh] w-[min(40rem,calc(100vw-2rem))] flex-col" role="dialog" aria-modal="true">
      <header class="flex items-center justify-between border-b border-line px-6 py-4">
        <h2 class="text-lg font-semibold">{{ 'customers.import' | t }}</h2>
        <button type="button" class="btn-icon" (click)="ref.close(imported)" [attr.aria-label]="'common.close' | t"><svg lucideIcon="x" [size]="18"></svg></button>
      </header>
      <div class="flex-1 space-y-4 overflow-y-auto px-6 py-5 text-sm">
        <p class="text-muted">{{ 'customers.importHint' | t }}</p>
        <code class="block overflow-x-auto rounded-xl bg-surface-2 px-3 py-2 text-xs" dir="ltr">first_name,last_name,mobile,email,gender,date_of_birth,tags,whatsapp_marketing,note</code>
        <input type="file" accept=".csv,text/csv" class="block w-full text-sm" (change)="pick($event)" [attr.aria-label]="'customers.chooseFile' | t" />

        @if (rows().length > 0) {
          <p><strong>{{ rows().length }}</strong> {{ 'customers.rowsFound' | t }} · <span class="text-muted">{{ columns().join(', ') }}</span></p>
        }

        @if (result(); as r) {
          <div class="rounded-xl border border-line p-4">
            <p class="font-semibold">{{ (r.dry_run ? 'customers.dryRunResult' : 'customers.importResult') | t }}</p>
            <ul class="mt-2 space-y-1">
              <li class="text-success">{{ (r.dry_run ? 'customers.willImport' : 'customers.imported') | t: { n: r.inserted } }}</li>
              <li class="text-muted">{{ 'customers.skippedDuplicates' | t: { n: r.duplicates.length } }}</li>
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
        <button type="button" class="btn-primary" [disabled]="busy() || !result()?.dry_run || result()!.inserted === 0" (click)="run(false)">
          {{ busy() ? ('common.saving' | t) : ('customers.importNow' | t) }}
        </button>
      </footer>
    </div>
  `,
})
export class CustomerImportDialog {
  protected readonly ref = inject<DialogRef<boolean>>(DialogRef);
  protected readonly i18n = inject(I18nService);
  private readonly service = inject(CustomersService);
  private readonly ctx = inject(TenantContextService);
  private readonly toast = inject(ToastService);

  protected readonly rows = signal<ImportRow[]>([]);
  protected readonly columns = signal<string[]>([]);
  protected readonly result = signal<ImportResult | null>(null);
  protected readonly busy = signal(false);
  protected imported = false;

  async pick(event: Event): Promise<void> {
    const file = (event.target as HTMLInputElement).files?.[0];
    this.result.set(null);
    this.rows.set([]);
    if (!file) return;
    try {
      const parsed = csvToImportRows(await file.text());
      if (parsed.rows.length > MAX_IMPORT_ROWS) {
        this.toast.error({ message: 'IMPORT_TOO_LARGE' });
        return;
      }
      this.rows.set(parsed.rows);
      this.columns.set(parsed.columns);
    } catch (err) {
      this.toast.error(err instanceof Error && err.message === 'CSV_NO_NAME_COLUMN' ? { message: 'CSV_NO_NAME_COLUMN' } : err);
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
        this.imported = result.inserted > 0;
        this.rows.set([]);
      }
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.busy.set(false);
    }
  }
}

// ---------------------------------------------------------------------------
// List page
// ---------------------------------------------------------------------------
@Component({
  selector: 'sz-customers-page',
  imports: [TranslatePipe, LucideDynamicIcon, PageHeader, StatePanel],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <sz-page-header [heading]="'nav.customers' | t" [subtitle]="'customers.subtitle' | t">
      @if (canManage()) {
        <button type="button" class="btn-secondary" (click)="openImport()"><svg lucideIcon="upload" [size]="16"></svg>{{ 'customers.import' | t }}</button>
        <button type="button" class="btn-primary" (click)="openNew()"><svg lucideIcon="user-plus" [size]="16"></svg>{{ 'customers.add' | t }}</button>
      }
    </sz-page-header>

    <div class="mb-4 flex flex-wrap items-center gap-3">
      <div class="relative w-full max-w-md">
        <svg lucideIcon="search" [size]="16" class="pointer-events-none absolute start-3 top-3 text-muted"></svg>
        <input type="search" class="input ps-9" [placeholder]="'customers.search' | t" [value]="query()" (input)="onQuery($any($event.target).value)" autofocus />
      </div>
      <label class="flex items-center gap-2 text-sm text-muted">
        <input type="checkbox" class="checkbox" [checked]="includeArchived()" (change)="includeArchived.set($any($event.target).checked); search()" />{{ 'customers.showArchived' | t }}
      </label>
    </div>

    <div class="card overflow-x-auto">
      @if (loading()) {
        <sz-state [loading]="true" />
      } @else if (customers().length === 0) {
        <sz-state icon="users" [heading]="(query() ? 'customers.noMatches' : 'customers.emptyTitle') | t" [message]="(query() ? 'customers.noMatchesHint' : 'customers.empty') | t" />
      } @else {
        <table class="table">
          <thead>
            <tr>
              <th>{{ 'customers.name' | t }}</th>
              <th>{{ 'common.mobile' | t }}</th>
              <th class="hidden md:table-cell">{{ 'common.email' | t }}</th>
              <th class="hidden lg:table-cell">{{ 'customers.tags' | t }}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            @for (c of customers(); track c.id) {
              <tr class="cursor-pointer hover:bg-surface-2" (click)="openCustomer(c)" tabindex="0" (keydown.enter)="openCustomer(c)">
                <td>
                  <p class="font-medium">{{ c.first_name }} {{ c.last_name }}</p>
                  @if (c.name_ar) { <p class="text-xs text-muted" dir="rtl" lang="ar">{{ c.name_ar }}</p> }
                </td>
                <td class="num" dir="ltr">{{ c.mobile || '—' }}</td>
                <td class="hidden text-muted md:table-cell" dir="ltr">{{ c.email || '—' }}</td>
                <td class="hidden lg:table-cell">
                  @for (t of c.tags.slice(0, 3); track t) { <span class="badge-muted me-1">{{ t }}</span> }
                </td>
                <td class="text-end">
                  @if (c.status === 'blocked') { <span class="badge-danger">{{ 'customers.status.blocked' | t }}</span> }
                  @if (c.status === 'archived') { <span class="badge-muted">{{ 'customers.status.archived' | t }}</span> }
                </td>
              </tr>
            }
          </tbody>
        </table>
        @if (customers().length >= limit) {
          <p class="border-t border-line px-4 py-3 text-xs text-muted">{{ 'customers.refineSearch' | t: { n: limit } }}</p>
        }
      }
    </div>
  `,
})
export class CustomersPage implements OnInit {
  private readonly service = inject(CustomersService);
  private readonly ctx = inject(TenantContextService);
  private readonly dialog = inject(Dialog);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);

  protected readonly limit = 50;
  protected readonly loading = signal(true);
  protected readonly customers = signal<Customer[]>([]);
  protected readonly query = signal('');
  protected readonly includeArchived = signal(false);
  protected readonly canManage = computed(() => this.ctx.can('customers.manage'));

  private timer: ReturnType<typeof setTimeout> | undefined;
  private requestId = 0;

  constructor() {
    inject(DestroyRef).onDestroy(() => clearTimeout(this.timer));
  }

  ngOnInit(): void {
    void this.search();
  }

  protected onQuery(value: string): void {
    this.query.set(value);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.search(), 250);
  }

  async search(): Promise<void> {
    const tenantId = this.ctx.tenantId();
    if (!tenantId) return;
    const id = ++this.requestId;
    try {
      const rows = await this.service.search(tenantId, this.query(), this.includeArchived(), this.limit);
      if (id === this.requestId) this.customers.set(rows); // ignore out-of-order responses
    } catch (err) {
      this.toast.error(err);
    } finally {
      if (id === this.requestId) this.loading.set(false);
    }
  }

  protected openCustomer(c: Customer): void {
    void this.router.navigate(['/customers', c.id]);
  }

  openNew(): void {
    this.dialog.open<Customer, Customer | null>(CustomerDialog, { data: null }).closed.subscribe((saved) => {
      if (saved) void this.router.navigate(['/customers', saved.id]);
    });
  }

  openImport(): void {
    this.dialog.open<boolean>(CustomerImportDialog, { disableClose: true }).closed.subscribe((imported) => {
      if (imported) void this.search();
    });
  }
}

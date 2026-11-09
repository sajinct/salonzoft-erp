import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { LucideDynamicIcon } from '@lucide/angular';
import { I18nService, TranslateDynamicPipe, TranslatePipe } from '../../core/i18n/i18n.service';
import { ToastService } from '../../core/services/toast.service';
import { TenantContextService } from '../../core/tenant/tenant-context.service';
import { PageHeader, StatePanel } from '../../shared/components/ui';
import { downloadText, toCsv } from '../../shared/export/csv';
import { addMoney, formatMoney, fromMinor, toMinor } from '../../shared/money/money';
import { addDays, zonedDate } from '../appointments/data/calendar-time';
import { ReportKey, ReportResult, ReportRow, ReportsService } from './data/reports.service';
import { REPORTS, ReportColumn, ReportDef } from './report-catalogue';

type Preset = 'today' | 'yesterday' | 'last7' | 'thisMonth' | 'lastMonth' | 'last30' | 'thisYear' | 'custom';
const PRESETS: Preset[] = ['today', 'yesterday', 'last7', 'thisMonth', 'lastMonth', 'last30', 'thisYear', 'custom'];

function monthStart(date: string): string {
  return date.slice(0, 8) + '01';
}

@Component({
  selector: 'sz-reports-page',
  imports: [TranslatePipe, TranslateDynamicPipe, LucideDynamicIcon, PageHeader, StatePanel],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="no-print">
      <sz-page-header [heading]="'nav.reports' | t" [subtitle]="'reports.subtitle' | t" />
    </div>
    <div class="grid gap-6 lg:grid-cols-[15rem_1fr]">
      <nav class="no-print space-y-4" aria-label="Reports">
        @for (g of groups(); track g.key) {
          <div>
            <p class="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">{{ 'reports.group.' + g.key | tx }}</p>
            @for (r of g.items; track r.key) {
              <button type="button" class="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-start text-sm font-medium"
                      [class]="r.key === active()?.key ? 'bg-primary-soft text-primary' : 'text-ink/80 hover:bg-surface-2'" (click)="select(r.key)">
                <svg [lucideIcon]="r.icon" [size]="16"></svg>{{ 'reports.name.' + r.key | tx }}
              </button>
            }
          </div>
        }
      </nav>

      <section class="min-w-0">
        @if (active(); as def) {
          <div class="mb-1 hidden print:block">
            <p class="text-sm text-muted">{{ business() }}</p>
          </div>
          <div class="mb-4 flex flex-wrap items-end gap-2">
            <div class="me-auto">
              <h2 class="text-lg font-semibold">{{ 'reports.name.' + def.key | tx }}</h2>
              <p class="text-sm text-muted">{{ 'reports.desc.' + def.key | tx }}</p>
              <p class="mt-0.5 text-xs text-muted">{{ periodLabel() }} · {{ branchLabel() }}</p>
            </div>
            <div class="no-print flex flex-wrap items-end gap-2">
              <select class="input w-40" [value]="preset()" (change)="setPreset($any($event.target).value)" [attr.aria-label]="'pos.period' | t">
                @for (p of presets; track p) { <option [value]="p" [selected]="p === preset()">{{ 'reports.preset.' + p | tx }}</option> }
              </select>
              @if (preset() === 'custom') {
                <input class="input w-40" type="date" dir="ltr" [value]="from()" [max]="to()" (change)="setRange($any($event.target).value, to())" [attr.aria-label]="'common.from' | t" />
                <input class="input w-40" type="date" dir="ltr" [value]="to()" [min]="from()" (change)="setRange(from(), $any($event.target).value)" [attr.aria-label]="'common.to' | t" />
              }
              <button type="button" class="btn-secondary" [disabled]="!result()?.rows?.length" (click)="exportCsv()"><svg lucideIcon="download" [size]="15"></svg>{{ 'reports.exportCsv' | t }}</button>
              <button type="button" class="btn-ghost" [disabled]="!result()?.rows?.length" (click)="print()"><svg lucideIcon="printer" [size]="15"></svg>{{ 'pos.print' | t }}</button>
            </div>
          </div>

          @if (result()?.truncated) {
            <p class="mb-3 rounded-xl bg-warning-soft px-4 py-2 text-sm">{{ 'reports.truncated' | t }}</p>
          }

          <div class="card overflow-x-auto print:border-0 print:shadow-none">
            @if (loading()) {
              <sz-state [loading]="true" />
            } @else if (result(); as r) {
              <table class="table text-sm">
                <thead>
                  <tr>@for (c of columns(); track c.key) { <th [class.text-end]="isNumeric(c)">{{ 'reports.col.' + (c.label ?? c.key) | tx }}</th> }</tr>
                </thead>
                <tbody>
                  @for (row of r.rows; track $index) {
                    <tr>@for (c of columns(); track c.key) { <td [class]="cellClass(c, row)">{{ display(c, row) }}</td> }</tr>
                  } @empty {
                    <tr><td [attr.colspan]="columns().length"><sz-state icon="chart-column" [heading]="'reports.empty' | t" /></td></tr>
                  }
                </tbody>
                @if (r.rows.length > 1 && hasTotals()) {
                  <tfoot>
                    <tr class="border-t-2 border-line font-semibold">
                      @for (c of columns(); track c.key; let first = $first) {
                        <td [class.text-end]="isNumeric(c)" class="num">{{ first && !c.sum ? ('reports.total' | t) : totals()[c.key] ?? '' }}</td>
                      }
                    </tr>
                  </tfoot>
                }
              </table>
            }
          </div>
          <p class="no-print mt-2 text-xs text-muted">{{ 'reports.rowsLine' | t: { n: result()?.rows?.length ?? 0 } }}</p>
        } @else {
          <div class="card"><sz-state icon="chart-column" [heading]="'reports.noAccess' | t" /></div>
        }
      </section>
    </div>
  `,
})
export class ReportsPage {
  private readonly ctx = inject(TenantContextService);
  protected readonly i18n = inject(I18nService);
  private readonly api = inject(ReportsService);
  private readonly toast = inject(ToastService);

  protected readonly presets = PRESETS;
  private readonly tz = computed(() => this.ctx.context()?.settings.timezone ?? 'Asia/Muscat');
  protected readonly available = computed(() =>
    REPORTS.filter((r) => this.ctx.canAny(r.permissions) && (!r.requires || this.ctx.can(r.requires))),
  );
  protected readonly groups = computed(() =>
    (['financial', 'operational'] as const)
      .map((key) => ({ key, items: this.available().filter((r) => r.group === key) }))
      .filter((g) => g.items.length > 0),
  );
  private readonly selected = signal<ReportKey | null>(null);
  protected readonly active = computed<ReportDef | null>(() => {
    const list = this.available();
    return list.find((r) => r.key === this.selected()) ?? list[0] ?? null;
  });

  protected readonly preset = signal<Preset>('thisMonth');
  protected readonly from = signal('');
  protected readonly to = signal('');
  protected readonly loading = signal(false);
  protected readonly result = signal<ReportResult | null>(null);

  /** Hide the mobile column when the server withheld it (no customers.export). */
  protected readonly columns = computed(() => {
    const def = this.active();
    if (!def) return [];
    const rows = this.result()?.rows ?? [];
    return def.columns.filter((c) => c.key !== 'mobile' || rows.some((r) => r['mobile'] !== null));
  });
  protected readonly hasTotals = computed(() => this.columns().some((c) => c.sum));
  protected readonly totals = computed<Record<string, string>>(() => {
    const rows = this.result()?.rows ?? [];
    const out: Record<string, string> = {};
    for (const c of this.columns()) {
      if (!c.sum) continue;
      const values = rows.map((r) => r[c.key]).filter((v): v is number | string => v !== null && v !== undefined && typeof v !== 'boolean');
      out[c.key] = c.type === 'money' ? this.money(addMoney(values)) : this.number(values.reduce<number>((s, v) => s + Number(v), 0));
    }
    return out;
  });

  protected readonly business = computed(() => {
    const t = this.ctx.context()?.tenant;
    return t ? this.i18n.pick(t.name, t.name_ar) : '';
  });
  protected readonly branchLabel = computed(() => {
    const b = this.ctx.activeBranch();
    return b ? this.i18n.pick(b.name_en, b.name_ar) : this.i18n.t('shell.allBranches');
  });
  protected readonly periodLabel = computed(() => (this.from() === this.to() ? this.day(this.from()) : `${this.day(this.from())} – ${this.day(this.to())}`));

  constructor() {
    this.setPreset('thisMonth');
    effect(() => {
      const def = this.active();
      const from = this.from();
      const to = this.to();
      const branch = this.ctx.branchId();
      if (def && from && to) untracked(() => void this.load(def.key, from, to, branch));
    });
  }

  protected select(key: ReportKey): void {
    this.result.set(null);
    this.selected.set(key);
  }

  protected setPreset(p: Preset): void {
    this.preset.set(p);
    const today = zonedDate(new Date(), this.tz());
    const ranges: Record<Exclude<Preset, 'custom'>, [string, string]> = {
      today: [today, today],
      yesterday: [addDays(today, -1), addDays(today, -1)],
      last7: [addDays(today, -6), today],
      thisMonth: [monthStart(today), today],
      lastMonth: [monthStart(addDays(monthStart(today), -1)), addDays(monthStart(today), -1)],
      last30: [addDays(today, -29), today],
      thisYear: [today.slice(0, 4) + '-01-01', today],
    };
    if (p !== 'custom') this.setRange(...ranges[p]);
  }

  protected setRange(from: string, to: string): void {
    if (!from || !to) return;
    this.from.set(from <= to ? from : to);
    this.to.set(from <= to ? to : from);
  }

  private async load(report: ReportKey, from: string, to: string, branch: string | null): Promise<void> {
    const tenantId = this.ctx.tenantId();
    if (!tenantId) return;
    this.loading.set(true);
    try {
      this.result.set(await this.api.run(tenantId, report, from, to, branch));
    } catch (err) {
      this.result.set(null);
      this.toast.error(err);
    } finally {
      this.loading.set(false);
    }
  }

  // ---- formatting -----------------------------------------------------------
  protected isNumeric(c: ReportColumn): boolean {
    return ['int', 'qty', 'money', 'rate', 'rating'].includes(c.type);
  }

  protected cellClass(c: ReportColumn, row: ReportRow): string {
    const v = row[c.key];
    const neg = c.type === 'money' && typeof v === 'number' && v < 0;
    return [this.isNumeric(c) ? 'num text-end' : '', neg ? 'text-danger' : '', c.type === 'text' || c.type === 'date' ? 'whitespace-nowrap' : ''].join(' ');
  }

  private money(v: string | number): string {
    return formatMoney(v, {
      currency: this.ctx.context()?.settings.currency_code ?? 'OMR',
      decimals: this.ctx.context()?.settings.currency_decimals ?? 3,
      locale: this.i18n.locale(),
    });
  }

  private number(v: number): string {
    return new Intl.NumberFormat(this.i18n.locale(), { maximumFractionDigits: 3 }).format(v);
  }

  private day(date: string): string {
    if (!date) return '';
    return new Intl.DateTimeFormat(this.i18n.locale(), { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(date + 'T00:00:00Z'));
  }

  private month(ym: string): string {
    return new Intl.DateTimeFormat(this.i18n.locale(), { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(ym + '-01T00:00:00Z'));
  }

  private dateTime(iso: string): string {
    return new Intl.DateTimeFormat(this.i18n.locale(), { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: this.tz() }).format(new Date(iso));
  }

  protected display(c: ReportColumn, row: ReportRow): string {
    const v = row[c.key];
    if (c.type === 'name') return this.i18n.pick(v as string | null, row[c.ar ?? ''] as string | null);
    if (v === null || v === undefined || v === '') return '—';
    switch (c.type) {
      case 'money': return this.money(v as number);
      case 'int': case 'qty': return this.number(Number(v));
      case 'rate': return `${Number(v)}%`;
      case 'rating': return `${Number(v)} ★`;
      case 'date': return this.day(String(v));
      case 'month': return this.month(String(v));
      case 'datetime': return this.dateTime(String(v));
      case 'bool': return this.i18n.t(v ? 'reports.yes' : 'reports.no');
      case 'enum': return this.i18n.tx((c.prefix ?? '') + v);
      default: return String(v);
    }
  }

  /** Machine-friendly values for spreadsheets: ISO dates, plain decimals, translated labels. */
  private csvValue(c: ReportColumn, row: ReportRow): string | number | null {
    const v = row[c.key];
    if (c.type === 'name') return this.i18n.pick(v as string | null, row[c.ar ?? ''] as string | null);
    if (v === null || v === undefined) return null;
    switch (c.type) {
      case 'money': return fromMinor(toMinor(v as number));
      case 'int': case 'qty': case 'rate': case 'rating': return Number(v);
      case 'datetime': {
        const d = new Date(String(v));
        return `${zonedDate(d, this.tz())} ${new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: this.tz() }).format(d)}`;
      }
      case 'bool': return this.i18n.t(v ? 'reports.yes' : 'reports.no');
      case 'enum': return this.i18n.tx((c.prefix ?? '') + v);
      default: return String(v);
    }
  }

  async exportCsv(): Promise<void> {
    const def = this.active();
    const r = this.result();
    const tenantId = this.ctx.tenantId();
    if (!def || !r || !tenantId) return;
    try {
      // Audit first: if the server refuses, nothing is downloaded.
      await this.api.logExport(tenantId, def.key, r.from, r.to, this.ctx.branchId(), r.rows.length);
      const cols = this.columns();
      const csv = toCsv(
        cols.map((c) => this.i18n.tx('reports.col.' + (c.label ?? c.key))),
        r.rows.map((row) => cols.map((c) => this.csvValue(c, row))),
        cols.map((c) => c.type === 'text' || c.type === 'name'),
      );
      downloadText(csv, `salonzoft-${def.key}-${r.from}_${r.to}.csv`);
    } catch (err) {
      this.toast.error(err);
    }
  }

  protected print(): void {
    window.print();
  }
}

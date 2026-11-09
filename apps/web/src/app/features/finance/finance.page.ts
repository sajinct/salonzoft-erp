import { Dialog, DialogRef, DIALOG_DATA } from '@angular/cdk/dialog';
import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { LucideDynamicIcon } from '@lucide/angular';
import { I18nService, TranslateDynamicPipe, TranslatePipe } from '../../core/i18n/i18n.service';
import { ToastService } from '../../core/services/toast.service';
import { TenantContextService } from '../../core/tenant/tenant-context.service';
import { ConfirmService, PageHeader, StatePanel } from '../../shared/components/ui';
import { LocalDatePipe, MoneyPipe } from '../../shared/pipes/format.pipes';
import { addDays, zonedDate } from '../appointments/data/calendar-time';
import { Employee, EmployeesService } from '../employees/data/employees.service';
import { parseAmount } from '../pos/pos-dialogs';
import { Service, ServiceCategory, ServicesService } from '../services/data/services.service';
import { CommissionRow, CommissionRule, Expense, ExpenseCategory, FinanceService, FinanceSummary } from './data/finance.service';

type Tab = 'overview' | 'expenses' | 'commissions';
type Period = 'today' | 'week' | 'month' | 'last30';

// ---------------------------------------------------------------------------
// Expense dialog
// ---------------------------------------------------------------------------
interface ExpenseDialogData {
  branchId: string;
  categories: ExpenseCategory[];
  today: string;
}

@Component({
  selector: 'sz-expense-dialog',
  imports: [TranslatePipe, TranslateDynamicPipe, LucideDynamicIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="card w-[min(32rem,calc(100vw-2rem))] p-6" role="dialog" aria-modal="true">
      <div class="mb-4 flex items-center justify-between">
        <h2 class="text-lg font-semibold">{{ 'finance.addExpense' | t }}</h2>
        <button type="button" class="btn-icon" (click)="ref.close()" [attr.aria-label]="'common.close' | t"><svg lucideIcon="x" [size]="18"></svg></button>
      </div>
      <div class="grid gap-4 sm:grid-cols-2">
        <div class="field">
          <label class="label" for="ecat">{{ 'finance.category' | t }}</label>
          <select id="ecat" class="input" [value]="category()" (change)="category.set($any($event.target).value)">
            <option value="">—</option>
            @for (c of categories(); track c.id) { <option [value]="c.id">{{ i18n.pick(c.name_en, c.name_ar) }}</option> }
            <option value="__new">+ {{ 'finance.newCategory' | t }}</option>
          </select>
          @if (category() === '__new') {
            <input class="input mt-2" [placeholder]="'common.nameEn' | t" [value]="newCategory()" (input)="newCategory.set($any($event.target).value)" />
          }
        </div>
        <div class="field"><label class="label" for="edate">{{ 'appointments.date' | t }}</label><input id="edate" class="input" type="date" dir="ltr" [value]="date()" (change)="date.set($any($event.target).value)" /></div>
        <div class="field sm:col-span-2"><label class="label" for="edesc">{{ 'pos.description' | t }}</label><input id="edesc" class="input" maxlength="300" [value]="description()" (input)="description.set($any($event.target).value)" /></div>
        <div class="field"><label class="label" for="eamt">{{ 'finance.amountPaid' | t }}</label><input id="eamt" class="input num" inputmode="decimal" dir="ltr" [value]="amount()" (input)="amount.set($any($event.target).value)" /></div>
        <div class="field"><label class="label" for="evat">{{ 'finance.vatIncluded' | t }}</label><input id="evat" class="input num" inputmode="decimal" dir="ltr" [value]="vat()" (input)="vat.set($any($event.target).value)" /></div>
        <div class="field">
          <label class="label" for="emethod">{{ 'finance.paidBy' | t }}</label>
          <select id="emethod" class="input" [value]="method()" (change)="method.set($any($event.target).value)">
            @for (m of methods; track m) { <option [value]="m">{{ 'pos.method.' + m | tx }}</option> }
          </select>
        </div>
        <div class="field"><label class="label" for="eref">{{ 'pos.reference' | t }}</label><input id="eref" class="input" dir="ltr" maxlength="100" [value]="reference()" (input)="reference.set($any($event.target).value)" /></div>
        @if (method() === 'cash') {
          <label class="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" class="checkbox" [checked]="fromDrawer()" (change)="fromDrawer.set($any($event.target).checked)" />{{ 'finance.fromDrawer' | t }}</label>
        }
      </div>
      <div class="mt-6 flex justify-end gap-2">
        <button type="button" class="btn-secondary" (click)="ref.close()">{{ 'common.cancel' | t }}</button>
        <button type="button" class="btn-primary" [disabled]="busy()" (click)="save()">{{ 'common.save' | t }}</button>
      </div>
    </div>
  `,
})
export class ExpenseDialog {
  protected readonly ref = inject<DialogRef<boolean>>(DialogRef);
  protected readonly data = inject<ExpenseDialogData>(DIALOG_DATA);
  protected readonly i18n = inject(I18nService);
  private readonly api = inject(FinanceService);
  private readonly ctx = inject(TenantContextService);
  private readonly toast = inject(ToastService);
  protected readonly methods = ['cash', 'card', 'bank_transfer', 'other'] as const;
  protected readonly categories = signal(this.data.categories.filter((c) => c.is_active));
  protected readonly category = signal(this.data.categories.length ? '' : '__new');
  protected readonly newCategory = signal('');
  protected readonly date = signal(this.data.today);
  protected readonly description = signal('');
  protected readonly amount = signal('');
  protected readonly vat = signal('0');
  protected readonly method = signal<string>('cash');
  protected readonly reference = signal('');
  protected readonly fromDrawer = signal(false);
  protected readonly busy = signal(false);

  async save(): Promise<void> {
    const tenantId = this.ctx.tenantId();
    const amount = parseAmount(this.amount());
    const vat = parseAmount(this.vat() || '0');
    if (!tenantId || amount === null || vat === null || !this.description().trim() || !this.category() || (this.category() === '__new' && !this.newCategory().trim())) {
      this.toast.error({ message: 'INVALID_AMOUNT' });
      return;
    }
    this.busy.set(true);
    try {
      let categoryId = this.category();
      if (categoryId === '__new') categoryId = (await this.api.addCategory(tenantId, this.newCategory().trim(), null)).id;
      const res = await this.api.recordExpense({
        branchId: this.data.branchId,
        categoryId,
        date: this.date(),
        amount,
        vat,
        description: this.description().trim(),
        method: this.method(),
        fromDrawer: this.method() === 'cash' && this.fromDrawer(),
        reference: this.reference().trim() || null,
      });
      this.toast.success(this.i18n.t(res.status === 'approved' ? 'finance.expenseApproved' : 'finance.expensePending'));
      this.ref.close(true);
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.busy.set(false);
    }
  }
}

// ---------------------------------------------------------------------------
// Commission rule dialog
// ---------------------------------------------------------------------------
interface RuleDialogData {
  rule: CommissionRule | null;
  employees: Employee[];
  services: Service[];
  categories: ServiceCategory[];
}

@Component({
  selector: 'sz-rule-dialog',
  imports: [TranslatePipe, LucideDynamicIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="card w-[min(30rem,calc(100vw-2rem))] p-6" role="dialog" aria-modal="true">
      <div class="mb-4 flex items-center justify-between">
        <h2 class="text-lg font-semibold">{{ 'finance.commissionRule' | t }}</h2>
        <button type="button" class="btn-icon" (click)="ref.close()" [attr.aria-label]="'common.close' | t"><svg lucideIcon="x" [size]="18"></svg></button>
      </div>
      <div class="grid gap-4">
        <div class="field">
          <label class="label" for="remp">{{ 'finance.forWhom' | t }}</label>
          <select id="remp" class="input" [value]="employee()" (change)="employee.set($any($event.target).value)">
            <option value="">{{ 'finance.everyone' | t }}</option>
            @for (e of data.employees; track e.id) { <option [value]="e.id">{{ i18n.pick(e.name_en, e.name_ar) }}</option> }
          </select>
        </div>
        <div class="field">
          <label class="label" for="rkind">{{ 'finance.appliesTo' | t }}</label>
          <select id="rkind" class="input" [value]="target()" (change)="target.set($any($event.target).value)">
            <option value="any">{{ 'finance.target.any' | t }}</option>
            <option value="service">{{ 'finance.target.service' | t }}</option>
            <option value="product">{{ 'finance.target.product' | t }}</option>
            @for (c of data.categories; track c.id) { <option [value]="'cat:' + c.id">{{ 'services.category' | t }}: {{ i18n.pick(c.name_en, c.name_ar) }}</option> }
            @for (s of data.services; track s.id) { <option [value]="'svc:' + s.id">{{ i18n.pick(s.name_en, s.name_ar) }}</option> }
          </select>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div class="field"><label class="label" for="rrate">{{ 'finance.ratePercent' | t }}</label><input id="rrate" class="input num" inputmode="decimal" dir="ltr" [value]="rate()" (input)="rate.set($any($event.target).value)" /></div>
          <div class="field"><label class="label" for="rfixed">{{ 'finance.fixedPerItem' | t }}</label><input id="rfixed" class="input num" inputmode="decimal" dir="ltr" [value]="fixed()" (input)="fixed.set($any($event.target).value)" /></div>
        </div>
        <p class="hint">{{ 'finance.ruleHint' | t }}</p>
      </div>
      <div class="mt-6 flex items-center justify-between gap-2">
        @if (data.rule) { <button type="button" class="btn-ghost text-danger" (click)="remove()">{{ 'common.delete' | t }}</button> } @else { <span></span> }
        <div class="flex gap-2">
          <button type="button" class="btn-secondary" (click)="ref.close()">{{ 'common.cancel' | t }}</button>
          <button type="button" class="btn-primary" [disabled]="busy()" (click)="save()">{{ 'common.save' | t }}</button>
        </div>
      </div>
    </div>
  `,
})
export class RuleDialog {
  protected readonly ref = inject<DialogRef<boolean>>(DialogRef);
  protected readonly data = inject<RuleDialogData>(DIALOG_DATA);
  protected readonly i18n = inject(I18nService);
  private readonly api = inject(FinanceService);
  private readonly ctx = inject(TenantContextService);
  private readonly toast = inject(ToastService);
  private readonly r = this.data.rule;
  protected readonly employee = signal(this.r?.employee_id ?? '');
  protected readonly target = signal(
    this.r?.service_id ? `svc:${this.r.service_id}` : this.r?.service_category_id ? `cat:${this.r.service_category_id}` : (this.r?.item_kind ?? 'service'),
  );
  protected readonly rate = signal(this.r ? String(this.r.rate_percent) : '10');
  protected readonly fixed = signal(this.r ? String(this.r.fixed_amount) : '0');
  protected readonly busy = signal(false);

  async save(): Promise<void> {
    const tenantId = this.ctx.tenantId();
    const rate = parseAmount(this.rate() || '0');
    const fixed = parseAmount(this.fixed() || '0');
    if (!tenantId || rate === null || fixed === null || rate > 100 || (rate === 0 && fixed === 0)) {
      this.toast.error({ message: 'INVALID_AMOUNT' });
      return;
    }
    const t = this.target();
    this.busy.set(true);
    try {
      await this.api.saveRule(tenantId, this.r?.id ?? null, {
        employee_id: this.employee() || null,
        item_kind: t.startsWith('svc:') || t.startsWith('cat:') ? 'service' : t,
        service_id: t.startsWith('svc:') ? t.slice(4) : null,
        service_category_id: t.startsWith('cat:') ? t.slice(4) : null,
        product_id: null,
        rate_percent: rate,
        fixed_amount: fixed,
        is_active: true,
      });
      this.ref.close(true);
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.busy.set(false);
    }
  }

  async remove(): Promise<void> {
    if (!this.r) return;
    try {
      await this.api.deleteRule(this.r.id);
      this.ref.close(true);
    } catch (err) {
      this.toast.error(err);
    }
  }
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
@Component({
  selector: 'sz-finance-page',
  imports: [TranslatePipe, TranslateDynamicPipe, LucideDynamicIcon, PageHeader, StatePanel, MoneyPipe, LocalDatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <sz-page-header [heading]="'nav.finance' | t" [subtitle]="'finance.subtitle' | t">
      @if (tab() === 'expenses' && ctx.can('finance.manage')) {
        <button type="button" class="btn-primary" (click)="addExpense()"><svg lucideIcon="plus" [size]="16"></svg>{{ 'finance.addExpense' | t }}</button>
      }
      @if (tab() === 'commissions' && ctx.can('employees.manage')) {
        <button type="button" class="btn-secondary" (click)="openRule(null)"><svg lucideIcon="plus" [size]="16"></svg>{{ 'finance.addRule' | t }}</button>
      }
    </sz-page-header>

    <div class="mb-4 flex flex-wrap items-center gap-2">
      @for (t of tabs(); track t) {
        <button type="button" [class]="tab() === t ? 'btn-primary btn-sm' : 'btn-secondary btn-sm'" (click)="tab.set(t)">{{ 'finance.tab.' + t | tx }}</button>
      }
      <select class="input ms-auto w-44" [value]="period()" (change)="period.set($any($event.target).value)" [attr.aria-label]="'pos.period' | t">
        @for (p of periods; track p) { <option [value]="p">{{ 'finance.period.' + p | tx }}</option> }
      </select>
    </div>

    @if (loading()) {
      <div class="card"><sz-state [loading]="true" /></div>
    } @else if (tab() === 'overview') {
      @if (summary(); as s) {
        <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div class="card p-4"><p class="text-xs text-muted">{{ 'finance.revenue' | t }}</p><p class="num mt-1 text-xl font-semibold">{{ s.revenue | money }}</p><p class="text-xs text-muted">{{ 'finance.exclVat' | t }}</p></div>
          <div class="card p-4"><p class="text-xs text-muted">{{ 'finance.grossProfit' | t }}</p><p class="num mt-1 text-xl font-semibold">{{ s.gross_profit | money }}</p></div>
          <div class="card p-4"><p class="text-xs text-muted">{{ 'finance.netProfit' | t }}</p><p class="num mt-1 text-xl font-semibold" [class.text-danger]="s.net_profit < 0" [class.text-success]="s.net_profit > 0">{{ s.net_profit | money }}</p></div>
          <div class="card p-4"><p class="text-xs text-muted">{{ 'finance.vatDue' | t }}</p><p class="num mt-1 text-xl font-semibold">{{ vatDue(s) | money }}</p><p class="text-xs text-muted">{{ 'finance.vatDueHint' | t }}</p></div>
        </div>
        <div class="mt-5 grid gap-5 lg:grid-cols-2">
          <section class="card p-5">
            <h2 class="mb-3 font-semibold">{{ 'finance.profitAndLoss' | t }}</h2>
            <dl class="grid grid-cols-[1fr_auto] gap-y-2 text-sm">
              <dt>{{ 'finance.revenue' | t }}</dt><dd class="num text-end">{{ s.revenue | money }}</dd>
              <dt class="text-muted">− {{ 'finance.costOfGoods' | t }}</dt><dd class="num text-end text-muted">{{ s.cost_of_goods | money }}</dd>
              <dt class="text-muted">− {{ 'finance.productsUsed' | t }}</dt><dd class="num text-end text-muted">{{ s.products_used | money }}</dd>
              <dt class="border-t border-line pt-2 font-semibold">{{ 'finance.grossProfit' | t }}</dt><dd class="num border-t border-line pt-2 text-end font-semibold">{{ s.gross_profit | money }}</dd>
              <dt class="text-muted">− {{ 'finance.commissions' | t }}</dt><dd class="num text-end text-muted">{{ s.commissions | money }}</dd>
              <dt class="text-muted">− {{ 'finance.expenses' | t }}</dt><dd class="num text-end text-muted">{{ s.expenses | money }}</dd>
              <dt class="border-t border-line pt-2 font-semibold">{{ 'finance.netProfit' | t }}</dt><dd class="num border-t border-line pt-2 text-end font-semibold">{{ s.net_profit | money }}</dd>
            </dl>
          </section>
          <section class="card p-5">
            <h2 class="mb-3 font-semibold">{{ 'finance.expensesByCategory' | t }}</h2>
            <ul class="space-y-2 text-sm">
              @for (c of s.expenses_by_category; track c.category_id) {
                <li class="flex justify-between"><span>{{ i18n.pick(c.name_en, c.name_ar) }}</span><span class="num">{{ c.amount | money }}</span></li>
              } @empty { <li class="text-muted">{{ 'finance.noExpenses' | t }}</li> }
            </ul>
          </section>
        </div>
      }
    } @else if (tab() === 'expenses') {
      <div class="card overflow-x-auto">
        <table class="table">
          <thead><tr>
            <th>{{ 'appointments.date' | t }}</th><th>{{ 'pos.description' | t }}</th><th>{{ 'finance.category' | t }}</th>
            <th class="text-end">{{ 'pos.amount' | t }}</th><th>{{ 'common.status' | t }}</th><th></th>
          </tr></thead>
          <tbody>
            @for (e of expenses(); track e.id) {
              <tr>
                <td class="text-muted">{{ e.expense_date | localDate }}</td>
                <td>{{ e.description }}@if (e.cash_session_id) { <span class="badge-muted ms-1">{{ 'finance.pettyCash' | t }}</span> }
                  @if (e.rejection_reason) { <span class="block text-xs text-danger">{{ e.rejection_reason }}</span> }</td>
                <td class="text-muted">{{ categoryName(e.category_id) }}</td>
                <td class="num text-end">{{ e.amount | money }}</td>
                <td><span [class]="e.status === 'approved' ? 'badge-success' : e.status === 'rejected' ? 'badge-danger' : 'badge-warning'">{{ 'finance.status.' + e.status | tx }}</span></td>
                <td class="whitespace-nowrap text-end">
                  @if (e.status === 'pending' && ctx.can('expenses.approve')) {
                    <button type="button" class="btn-primary btn-sm" (click)="review(e, true)">{{ 'finance.approve' | t }}</button>
                    <button type="button" class="btn-ghost btn-sm text-danger" (click)="review(e, false)">{{ 'finance.reject' | t }}</button>
                  }
                </td>
              </tr>
            } @empty {
              <tr><td colspan="6"><sz-state icon="wallet" [heading]="'finance.noExpenses' | t" /></td></tr>
            }
          </tbody>
        </table>
      </div>
    } @else {
      <div class="card overflow-x-auto">
        <table class="table">
          <thead><tr>
            <th>{{ 'finance.employee' | t }}</th><th class="text-end">{{ 'finance.salesBase' | t }}</th>
            <th class="text-end">{{ 'finance.commission' | t }}</th><th class="text-end">{{ 'finance.unpaid' | t }}</th><th></th>
          </tr></thead>
          <tbody>
            @for (r of commissions(); track r.employee_id) {
              <tr>
                <td class="font-medium">{{ i18n.pick(r.name_en, r.name_ar) }} <span class="text-xs text-muted">· {{ 'finance.lines' | t: { n: r.lines } }}</span></td>
                <td class="num text-end text-muted">{{ r.sales_base | money }}</td>
                <td class="num text-end">{{ r.commission | money }}</td>
                <td class="num text-end" [class.font-semibold]="r.unpaid > 0">{{ r.unpaid | money }}</td>
                <td class="text-end">@if (r.unpaid > 0 && ctx.can('finance.manage')) { <button type="button" class="btn-secondary btn-sm" (click)="pay(r)">{{ 'finance.payOut' | t }}</button> }</td>
              </tr>
            } @empty {
              <tr><td colspan="5"><sz-state icon="id-card" [heading]="'finance.noCommissions' | t" /></td></tr>
            }
          </tbody>
        </table>
      </div>
      @if (rules().length > 0) {
        <section class="mt-5">
          <h2 class="mb-2 font-semibold">{{ 'finance.rules' | t }}</h2>
          <ul class="space-y-1.5 text-sm">
            @for (r of rules(); track r.id) {
              <li class="card flex items-center gap-3 px-4 py-2">
                <span class="flex-1">{{ ruleLabel(r) }}</span>
                <span class="num font-medium">{{ r.rate_percent }}%@if (r.fixed_amount > 0) { + {{ r.fixed_amount | money }} }</span>
                @if (ctx.can('employees.manage')) { <button type="button" class="btn-icon h-8 w-8" (click)="openRule(r)" [attr.aria-label]="'common.edit' | t"><svg lucideIcon="pencil" [size]="14"></svg></button> }
              </li>
            }
          </ul>
        </section>
      }
    }
  `,
})
export class FinancePage {
  protected readonly ctx = inject(TenantContextService);
  protected readonly i18n = inject(I18nService);
  private readonly api = inject(FinanceService);
  private readonly employeesApi = inject(EmployeesService);
  private readonly servicesApi = inject(ServicesService);
  private readonly dialog = inject(Dialog);
  private readonly toast = inject(ToastService);
  private readonly confirm = inject(ConfirmService);

  protected readonly periods: Period[] = ['today', 'week', 'month', 'last30'];
  protected readonly period = signal<Period>('month');
  protected readonly loading = signal(true);
  protected readonly summary = signal<FinanceSummary | null>(null);
  protected readonly expenses = signal<Expense[]>([]);
  protected readonly categories = signal<ExpenseCategory[]>([]);
  protected readonly commissions = signal<CommissionRow[]>([]);
  protected readonly rules = signal<CommissionRule[]>([]);
  private readonly employees = signal<Employee[]>([]);
  private readonly services = signal<Service[]>([]);
  private readonly serviceCategories = signal<ServiceCategory[]>([]);

  protected readonly canFinance = computed(() => this.ctx.can('finance.view') || this.ctx.can('reports.financial'));
  protected readonly tabs = computed<Tab[]>(() => [
    ...(this.canFinance() ? (['overview'] as const) : []),
    ...(this.ctx.canAny(['finance.view', 'finance.manage', 'expenses.approve']) ? (['expenses'] as const) : []),
    ...(this.ctx.canAny(['commissions.view', 'commissions.own', 'finance.view']) ? (['commissions'] as const) : []),
  ]);
  protected readonly tab = signal<Tab>('overview');
  private readonly tz = computed(() => this.ctx.context()?.settings.timezone ?? 'Asia/Muscat');
  private readonly branchId = computed(() => this.ctx.branchId());
  protected readonly range = computed(() => {
    const today = zonedDate(new Date(), this.tz());
    switch (this.period()) {
      case 'today':
        return { from: today, to: today };
      case 'week':
        return { from: addDays(today, -6), to: today };
      case 'last30':
        return { from: addDays(today, -29), to: today };
      default:
        return { from: today.slice(0, 8) + '01', to: today };
    }
  });

  constructor() {
    effect(() => {
      const tabs = this.tabs();
      if (tabs.length && !tabs.includes(this.tab())) this.tab.set(tabs[0]);
    });
    effect(() => {
      const tab = this.tab();
      const range = this.range();
      const branch = this.branchId();
      untracked(() => void this.load(tab, range.from, range.to, branch));
    });
  }

  private async load(tab: Tab, from: string, to: string, branch: string | null): Promise<void> {
    const tenantId = this.ctx.tenantId();
    if (!tenantId) return;
    this.loading.set(true);
    try {
      if (tab === 'overview') {
        this.summary.set(await this.api.summary(tenantId, from, to, branch));
      } else if (tab === 'expenses') {
        const [expenses, categories] = await Promise.all([this.api.expenses(tenantId, from, to, branch), this.api.categories(tenantId)]);
        this.expenses.set(expenses);
        this.categories.set(categories);
      } else {
        const [report, rules] = await Promise.all([
          this.api.commissionReport(tenantId, from, to, branch),
          this.ctx.canAny(['employees.manage', 'commissions.view', 'finance.view']) ? this.api.rules(tenantId) : Promise.resolve([]),
        ]);
        this.commissions.set(report);
        this.rules.set(rules);
        if (rules.length && !this.employees().length) await this.loadLookups(tenantId);
      }
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.loading.set(false);
    }
  }

  private reload(): void {
    const r = this.range();
    void this.load(this.tab(), r.from, r.to, this.branchId());
  }

  protected vatDue(s: FinanceSummary): number {
    return Math.round((s.vat_collected - s.vat_paid) * 1000) / 1000;
  }

  protected categoryName(id: string): string {
    const c = this.categories().find((x) => x.id === id);
    return c ? this.i18n.pick(c.name_en, c.name_ar) : '—';
  }

  protected ruleLabel(r: CommissionRule): string {
    const who = r.employee_id ? this.i18n.pick(...this.nameOf(this.employees(), r.employee_id)) : this.i18n.t('finance.everyone');
    const what = r.service_id
      ? this.i18n.pick(...this.nameOf(this.services(), r.service_id))
      : r.service_category_id
        ? `${this.i18n.t('services.category')}: ${this.i18n.pick(...this.nameOf(this.serviceCategories(), r.service_category_id))}`
        : this.i18n.tx('finance.target.' + r.item_kind);
    return `${who} · ${what}`;
  }

  private nameOf(list: { id: string; name_en: string; name_ar: string | null }[], id: string): [string, string | null] {
    const x = list.find((i) => i.id === id);
    return [x?.name_en ?? '—', x?.name_ar ?? null];
  }

  addExpense(): void {
    const branchId = this.ctx.branchId() ?? this.ctx.branches().at(0)?.id;
    if (!branchId) return;
    const data: ExpenseDialogData = { branchId, categories: this.categories(), today: zonedDate(new Date(), this.tz()) };
    this.dialog.open<boolean, ExpenseDialogData>(ExpenseDialog, { data }).closed.subscribe((changed) => changed && this.reload());
  }

  async review(e: Expense, approve: boolean): Promise<void> {
    const reason = approve ? null : prompt(this.i18n.t('finance.rejectReason'));
    if (!approve && !reason?.trim()) return;
    try {
      await this.api.reviewExpense(e.id, approve, reason);
      this.reload();
    } catch (err) {
      this.toast.error(err);
    }
  }

  async pay(r: CommissionRow): Promise<void> {
    const tenantId = this.ctx.tenantId();
    if (!tenantId) return;
    const ok = await this.confirm.ask({
      title: this.i18n.t('finance.payOut'),
      message: this.i18n.t('finance.confirmPay', { name: this.i18n.pick(r.name_en, r.name_ar), amount: r.unpaid.toFixed(3) }),
      confirmLabel: this.i18n.t('finance.payOut'),
    });
    if (!ok) return;
    try {
      const res = await this.api.payCommissions(tenantId, r.employee_id, this.range().to, 'bank_transfer', null);
      this.toast.success(this.i18n.t('finance.paid', { amount: res.total.toFixed(3) }));
      this.reload();
    } catch (err) {
      this.toast.error(err);
    }
  }

  private async loadLookups(tenantId: string): Promise<void> {
    const [emps, catalogue] = await Promise.all([this.employeesApi.list(tenantId), this.servicesApi.load(tenantId)]);
    this.employees.set(emps.employees.filter((e) => e.is_active));
    this.services.set(catalogue.services.filter((s) => s.is_active));
    this.serviceCategories.set(catalogue.categories);
  }

  async openRule(rule: CommissionRule | null): Promise<void> {
    const tenantId = this.ctx.tenantId();
    if (!tenantId) return;
    try {
      if (!this.employees().length) await this.loadLookups(tenantId);
      const data: RuleDialogData = { rule, employees: this.employees(), services: this.services(), categories: this.serviceCategories() };
      this.dialog.open<boolean, RuleDialogData>(RuleDialog, { data }).closed.subscribe((changed) => changed && this.reload());
    } catch (err) {
      this.toast.error(err);
    }
  }
}

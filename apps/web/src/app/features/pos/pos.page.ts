import { Dialog } from '@angular/cdk/dialog';
import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { LucideDynamicIcon } from '@lucide/angular';
import { I18nService, TranslateDynamicPipe, TranslatePipe } from '../../core/i18n/i18n.service';
import { ToastService } from '../../core/services/toast.service';
import { TenantContextService } from '../../core/tenant/tenant-context.service';
import { ReceiptPrintService } from '../../shared/receipt/receipt-print.service';
import { ConfirmService, PageHeader, StatePanel } from '../../shared/components/ui';
import { MoneyPipe } from '../../shared/pipes/format.pipes';
import { Customer, CustomersService } from '../customers/data/customers.service';
import { Employee, EmployeesService } from '../employees/data/employees.service';
import { FinanceService } from '../finance/data/finance.service';
import { InventoryService, StockRow } from '../inventory/data/inventory.service';
import { Membership, Package, PackagesService } from '../packages/data/packages.service';
import { Service, ServiceCategory, ServicesService } from '../services/data/services.service';
import { CartLine, CashSession, InvoiceDoc, PosService, Wallet } from './data/pos.service';
import {
  AmountDialog,
  AmountDialogData,
  CashDrawerDialog,
  CustomItemDialog,
  DrawerDialogData,
  PaymentDialog,
  PaymentDialogData,
  parseAmount,
} from './pos-dialogs';

type Tab = 'services' | 'products' | 'packages' | 'memberships';

interface UiLine {
  kind: CartLine['kind'];
  service_id?: string;
  package_id?: string;
  membership_id?: string;
  product_id?: string;
  customer_package_id: string | null;
  appointment_id: string | null;
  employee_id: string | null;
  appointment_service_id: string | null;
  description: string;
  quantity: string;
  /** Set only when the user typed a price; otherwise the server decides. */
  price: string | null;
  discount: string;
  priceType: string;
  // last values computed by the server
  shownPrice: number | null;
  total: number | null;
  memberPercent: number | null;
}

const blankLine = (patch: Partial<UiLine> & Pick<UiLine, 'kind' | 'description'>): UiLine => ({
  customer_package_id: null,
  appointment_id: null,
  employee_id: null,
  appointment_service_id: null,
  quantity: '1',
  price: null,
  discount: '0',
  priceType: 'fixed',
  shownPrice: null,
  total: null,
  memberPercent: null,
  ...patch,
});

@Component({
  selector: 'sz-pos-page',
  imports: [TranslatePipe, TranslateDynamicPipe, LucideDynamicIcon, PageHeader, StatePanel, MoneyPipe, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <sz-page-header [heading]="'nav.pos' | t" [subtitle]="branchName()">
      <a routerLink="/invoices" class="btn-secondary"><svg lucideIcon="receipt" [size]="16"></svg>{{ 'pos.invoices' | t }}</a>
      @if (canDrawer()) {
        <button type="button" class="btn-secondary" (click)="drawer()">
          <span class="h-2 w-2 rounded-full" [class]="session() ? 'bg-success' : 'bg-muted'"></span>
          {{ (session() ? 'pos.drawerOpen' : 'pos.drawerClosed') | t }}
        </button>
      }
    </sz-page-header>

    <div class="grid gap-5 lg:grid-cols-[1fr_26rem]">
      <!-- Catalogue -->
      <section class="min-w-0">
        <div class="mb-3 flex flex-wrap items-center gap-2">
          @for (t of tabs(); track t) {
            <button type="button" [class]="tab() === t ? 'btn-primary btn-sm' : 'btn-secondary btn-sm'" (click)="tab.set(t)">{{ 'pos.tab.' + t | tx }}</button>
          }
          <span class="mx-1 h-6 w-px bg-line"></span>
          <button type="button" class="btn-secondary btn-sm" (click)="addVoucher(null)"><svg lucideIcon="gift" [size]="14"></svg>{{ 'pos.giftVoucher' | t }}</button>
          <button type="button" class="btn-secondary btn-sm" (click)="addCustom()"><svg lucideIcon="plus" [size]="14"></svg>{{ 'pos.customItem' | t }}</button>
        </div>

        @if (tab() === 'services') {
          <div class="mb-3 flex flex-wrap items-center gap-2">
            <input type="search" class="input max-w-xs" [placeholder]="'services.search' | t" [value]="query()" (input)="query.set($any($event.target).value)" />
            <button type="button" [class]="category() === null ? 'btn-primary btn-sm' : 'btn-secondary btn-sm'" (click)="category.set(null)">{{ 'common.all' | t }}</button>
            @for (c of categories(); track c.id) {
              <button type="button" [class]="category() === c.id ? 'btn-primary btn-sm' : 'btn-secondary btn-sm'" (click)="category.set(c.id)">{{ i18n.pick(c.name_en, c.name_ar) }}</button>
            }
          </div>
          <div class="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
            @for (s of tiles(); track s.id) {
              <button type="button" class="card flex flex-col items-start gap-1 p-3 text-start transition hover:border-primary" [disabled]="busy()" (click)="addService(s)">
                <span class="h-1.5 w-8 rounded-full" [style.background]="s.color || 'var(--sz-primary)'"></span>
                <span class="line-clamp-2 text-sm font-semibold">{{ i18n.pick(s.name_en, s.name_ar) }}</span>
                <span class="num text-xs text-muted">
                  @if (s.price_type === 'variable') { {{ 'services.priceType.variable' | t }} }
                  @else { @if (s.price_type === 'from') { {{ 'services.from' | t }} } {{ s.price | money }} }
                </span>
              </button>
            } @empty {
              <div class="col-span-full card"><sz-state icon="scissors" [heading]="'services.emptyTitle' | t" /></div>
            }
          </div>
        } @else if (tab() === 'products') {
          <div class="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
            @for (p of retail(); track p.product_id) {
              <button type="button" class="card flex flex-col items-start gap-1 p-3 text-start hover:border-primary disabled:opacity-50" [disabled]="p.quantity <= 0" (click)="addProduct(p)">
                <span class="line-clamp-2 text-sm font-semibold">{{ i18n.pick(p.name_en, p.name_ar) }}</span>
                <span class="num text-xs text-muted">{{ p.sale_price | money }} · {{ 'pos.inStock' | t: { n: p.quantity } }}</span>
              </button>
            } @empty {
              <div class="col-span-full card"><sz-state icon="package" [heading]="'inventory.noProducts' | t" /></div>
            }
          </div>
        } @else if (tab() === 'packages') {
          <div class="grid grid-cols-2 gap-2 sm:grid-cols-3">
            @for (p of activePackages(); track p.id) {
              <button type="button" class="card flex flex-col items-start gap-1 p-3 text-start hover:border-primary" (click)="addPackage(p)">
                <span class="text-sm font-semibold">{{ i18n.pick(p.name_en, p.name_ar) }}</span>
                <span class="num text-xs text-muted">{{ p.price | money }}@if (p.validity_days) { · {{ 'packages.validDays' | t: { n: p.validity_days } }} }</span>
              </button>
            } @empty {
              <div class="col-span-full card"><sz-state icon="gift" [heading]="'packages.empty' | t" /></div>
            }
          </div>
        } @else {
          <div class="grid grid-cols-2 gap-2 sm:grid-cols-3">
            @for (m of activeMemberships(); track m.id) {
              <button type="button" class="card flex flex-col items-start gap-1 p-3 text-start hover:border-primary" (click)="addMembership(m)">
                <span class="text-sm font-semibold">{{ i18n.pick(m.name_en, m.name_ar) }}</span>
                <span class="num text-xs text-muted">{{ m.price | money }} · −{{ m.service_discount_percent }}% · {{ 'packages.validDays' | t: { n: m.duration_days } }}</span>
              </button>
            } @empty {
              <div class="col-span-full card"><sz-state icon="gift" [heading]="'packages.noMemberships' | t" /></div>
            }
          </div>
        }
      </section>

      <!-- Cart -->
      <aside class="card flex flex-col self-start lg:sticky lg:top-4">
        <div class="border-b border-line p-4">
          @if (customer(); as c) {
            <div class="flex items-center gap-2">
              <svg lucideIcon="user-round" [size]="16" class="text-muted"></svg>
              <span class="flex-1 truncate font-medium">{{ c.first_name }} {{ c.last_name }}</span>
              <span class="num text-xs text-muted" dir="ltr">{{ c.mobile }}</span>
              <button type="button" class="btn-icon h-7 w-7" (click)="setCustomer(null)" [attr.aria-label]="'common.remove' | t"><svg lucideIcon="x" [size]="14"></svg></button>
            </div>
            @if (wallet(); as w) {
              <div class="mt-2 space-y-1.5 text-xs">
                @if (w.membership; as m) {
                  <p class="badge-primary">{{ i18n.pick(m.name_en, m.name_ar) }} · −{{ m.discount_percent }}%</p>
                }
                @for (p of w.packages; track p.id) {
                  @for (b of p.balances; track b.service_id) {
                    @if (b.remaining > 0) {
                      <div class="flex items-center gap-2 rounded-lg bg-surface-2 px-2 py-1">
                        <span class="flex-1">{{ i18n.pick(p.name_en, p.name_ar) }}: {{ i18n.pick(b.service_name_en, b.service_name_ar) }} <strong>{{ b.remaining }}/{{ b.total }}</strong></span>
                        <button type="button" class="btn-ghost btn-sm h-6" (click)="redeem(p.id, b.service_id, b.service_name_en, b.service_name_ar)">{{ 'pos.use' | t }}</button>
                      </div>
                    }
                  }
                }
                @if (w.loyalty; as l) {
                  <div class="flex items-center gap-2">
                    <span class="flex-1">{{ 'pos.loyaltyPoints' | t: { n: l.points } }}</span>
                    @if (l.points >= l.min_redeem && l.points > 0) {
                      <button type="button" class="btn-ghost btn-sm h-6" (click)="redeemPoints(l.points)">{{ 'pos.redeemPoints' | t: { amount: (l.points * l.point_value | money) } }}</button>
                    }
                  </div>
                }
                @if (walletCredit() > 0) {
                  <p class="text-success">{{ 'pos.creditAvailable' | t: { amount: (walletCredit() | money) } }}</p>
                }
              </div>
            }
          } @else {
            <input type="search" class="input" [placeholder]="'pos.customerSearch' | t" [value]="customerQuery()" (input)="searchCustomers($any($event.target).value)" />
            @if (customerResults().length > 0) {
              <ul class="mt-1 divide-y divide-line rounded-xl border border-line">
                @for (c of customerResults(); track c.id) {
                  <li><button type="button" class="flex w-full justify-between px-3 py-1.5 text-start text-sm hover:bg-surface-2" (click)="setCustomer(c)">
                    <span>{{ c.first_name }} {{ c.last_name }}</span><span class="num text-muted" dir="ltr">{{ c.mobile }}</span></button></li>
                }
              </ul>
            }
          }
        </div>

        <ul class="max-h-[50vh] flex-1 divide-y divide-line overflow-y-auto">
          @for (l of lines(); track $index; let i = $index) {
            <li class="space-y-2 p-3 text-sm">
              <div class="flex items-start gap-2">
                <span class="flex-1 font-medium">{{ l.description }}
                  @if (l.customer_package_id) { <span class="badge-success ms-1">{{ 'pos.fromPackage' | t }}</span> }
                  @if (l.memberPercent) { <span class="badge-primary ms-1">−{{ l.memberPercent }}%</span> }
                </span>
                <span class="num font-semibold">{{ l.total === null ? '…' : (l.total | money) }}</span>
                <button type="button" class="btn-icon h-7 w-7" (click)="remove(i)" [attr.aria-label]="'common.remove' | t"><svg lucideIcon="trash-2" [size]="14"></svg></button>
              </div>
              @if (l.kind !== 'voucher' && l.kind !== 'membership') {
                <div class="flex flex-wrap items-center gap-2">
                  <input class="input num h-8 w-16" inputmode="decimal" dir="ltr" [value]="l.quantity" (change)="edit(i, 'quantity', $any($event.target).value)" [attr.aria-label]="'pos.quantity' | t" />
                  <span class="text-muted">×</span>
                  <input class="input num h-8 w-24" inputmode="decimal" dir="ltr" [value]="l.price ?? l.shownPrice ?? ''" [disabled]="!canEditPrice(l)"
                         (change)="edit(i, 'price', $any($event.target).value)" [attr.aria-label]="'services.price' | t" />
                  @if (canDiscount() && !l.customer_package_id) {
                    <input class="input num h-8 w-20" inputmode="decimal" dir="ltr" [placeholder]="'pos.discount' | t" [value]="l.discount === '0' ? '' : l.discount"
                           (change)="edit(i, 'discount', $any($event.target).value || '0')" [attr.aria-label]="'pos.discount' | t" />
                  }
                  @if (l.kind === 'service') {
                    <select class="input h-8 min-w-0 flex-1" [value]="l.employee_id ?? ''" (change)="edit(i, 'employee', $any($event.target).value)" [attr.aria-label]="'appointments.staff' | t">
                      <option value="">{{ 'pos.noStaff' | t }}</option>
                      @for (e of employees(); track e.id) { <option [value]="e.id">{{ i18n.pick(e.name_en, e.name_ar) }}</option> }
                    </select>
                  }
                </div>
              }
            </li>
          } @empty {
            <li class="p-8 text-center text-sm text-muted">{{ 'pos.emptyCart' | t }}</li>
          }
        </ul>

        <div class="space-y-1 border-t border-line p-4 text-sm">
          @if (doc(); as d) {
            @if (d.discount_total > 0) { <p class="flex justify-between text-muted"><span>{{ 'pos.discount' | t }}</span><span class="num">−{{ d.discount_total | money }}</span></p> }
            <p class="flex justify-between text-muted"><span>{{ 'pos.subtotal' | t }}</span><span class="num">{{ d.subtotal | money }}</span></p>
            <p class="flex justify-between text-muted"><span>{{ 'pos.vat' | t }}@if (d.prices_include_vat && d.vat_total > 0) { ({{ 'pos.included' | t }}) }</span><span class="num">{{ d.vat_total | money }}</span></p>
            <p class="flex justify-between pt-1 text-lg font-semibold"><span>{{ 'pos.total' | t }}</span><span class="num">{{ d.total | money }}</span></p>
          }
          <div class="flex gap-2 pt-3">
            <button type="button" class="btn-secondary" [disabled]="!doc() || busy()" (click)="discard()">{{ 'pos.discard' | t }}</button>
            <button type="button" class="btn-primary flex-1" [disabled]="lines().length === 0 || busy() || saving()" (click)="charge()">
              <svg lucideIcon="receipt" [size]="16"></svg>{{ 'pos.charge' | t }}@if (doc(); as d) { · {{ d.total | money }} }
            </button>
          </div>
        </div>
      </aside>
    </div>
  `,
})
export class PosPage implements OnInit {
  /** ?appointment=… checkout of a visit · ?invoice=… resume a draft · ?deposit=… take a booking deposit. */
  readonly appointment = input<string>();
  readonly invoice = input<string>();
  readonly deposit = input<string>();

  protected readonly ctx = inject(TenantContextService);
  protected readonly i18n = inject(I18nService);
  private readonly pos = inject(PosService);
  private readonly servicesApi = inject(ServicesService);
  private readonly packagesApi = inject(PackagesService);
  private readonly inventoryApi = inject(InventoryService);
  private readonly financeApi = inject(FinanceService);
  private readonly employeesApi = inject(EmployeesService);
  private readonly customersApi = inject(CustomersService);
  private readonly dialog = inject(Dialog);
  private readonly toast = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  private readonly router = inject(Router);
  private readonly receipts = inject(ReceiptPrintService);

  protected readonly services = signal<Service[]>([]);
  protected readonly categories = signal<ServiceCategory[]>([]);
  protected readonly packages = signal<Package[]>([]);
  protected readonly memberships = signal<Membership[]>([]);
  protected readonly stock = signal<StockRow[]>([]);
  protected readonly retail = computed(() => this.stock().filter((p) => p.kind !== 'consumable'));
  protected readonly employees = signal<Employee[]>([]);
  protected readonly tab = signal<Tab>('services');
  protected readonly category = signal<string | null>(null);
  protected readonly query = signal('');
  protected readonly doc = signal<InvoiceDoc | null>(null);
  protected readonly lines = signal<UiLine[]>([]);
  protected readonly customer = signal<Customer | null>(null);
  protected readonly wallet = signal<Wallet | null>(null);
  protected readonly customerQuery = signal('');
  protected readonly customerResults = signal<Customer[]>([]);
  protected readonly session = signal<CashSession | null>(null);
  protected readonly busy = signal(false);
  protected readonly saving = signal(false);

  protected readonly branchId = computed<string | null>(() => this.ctx.branchId() ?? this.ctx.branches().at(0)?.id ?? null);
  protected readonly branchName = computed(() => {
    const b = this.ctx.branches().find((x) => x.id === this.branchId());
    return b ? this.i18n.pick(b.name_en, b.name_ar) : '';
  });
  protected readonly canDiscount = computed(() => this.ctx.can('pos.discount'));
  protected readonly canDrawer = computed(() => this.ctx.can('pos.cash_session'));
  protected readonly activePackages = computed(() => this.packages().filter((p) => p.is_active));
  protected readonly activeMemberships = computed(() => this.memberships().filter((m) => m.is_active));
  protected readonly tabs = computed<Tab[]>(() => [
    'services',
    ...(this.retail().length ? (['products'] as const) : []),
    ...(this.activePackages().length ? (['packages'] as const) : []),
    ...(this.activeMemberships().length ? (['memberships'] as const) : []),
  ]);
  protected readonly walletCredit = computed(() => (this.wallet()?.vouchers ?? []).reduce((sum, v) => sum + v.balance, 0));
  protected readonly tiles = computed(() => {
    const q = this.query().trim().toLowerCase();
    const cat = this.category();
    return this.services().filter(
      (s) => s.is_active && (cat === null || s.category_id === cat) && (!q || [s.name_en, s.name_ar, s.code].some((v) => v?.toLowerCase().includes(q))),
    );
  });

  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private searchTimer: ReturnType<typeof setTimeout> | undefined;
  private saveChain: Promise<void> = Promise.resolve();
  private draftKey = crypto.randomUUID();

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      clearTimeout(this.saveTimer);
      clearTimeout(this.searchTimer);
    });
  }

  async ngOnInit(): Promise<void> {
    const tenantId = this.ctx.tenantId();
    const branchId = this.branchId();
    if (!tenantId || !branchId) return;
    try {
      const [catalogue, packs, staff, session, stock] = await Promise.all([
        this.servicesApi.load(tenantId),
        this.packagesApi.catalogue(tenantId).catch(() => ({ packages: [] as Package[], items: [], memberships: [] as Membership[] })),
        this.employeesApi.list(tenantId).catch(() => ({ employees: [] as Employee[] })),
        this.pos.openSession(branchId),
        this.inventoryApi.stock(branchId).catch(() => [] as StockRow[]),
      ]);
      this.stock.set(stock);
      this.services.set(catalogue.services);
      this.categories.set(catalogue.categories);
      this.packages.set(packs.packages);
      this.memberships.set(packs.memberships);
      this.employees.set(staff.employees.filter((e) => e.is_active));
      this.session.set(session);

      if (this.appointment()) {
        const id = await this.pos.createDraft(tenantId, branchId, { appointmentId: this.appointment() });
        await this.loadInvoice(id);
      } else if (this.invoice()) {
        await this.loadInvoice(this.invoice()!);
      } else if (this.deposit()) {
        const customerId = await this.packagesApi.appointmentCustomer(this.deposit()!);
        if (customerId) await this.setCustomerById(customerId);
        this.addVoucher(this.deposit()!);
      }
    } catch (err) {
      this.toast.error(err);
    }
  }

  private async loadInvoice(id: string): Promise<void> {
    const doc = await this.pos.get(id);
    if (doc.status !== 'draft') {
      void this.router.navigate(['/invoices', id]);
      return;
    }
    this.apply(doc, true);
    if (doc.customer_id) await this.setCustomerById(doc.customer_id, false);
  }

  private async setCustomerById(id: string, save = true): Promise<void> {
    try {
      this.customer.set(await this.customersApi.get(id));
    } catch {
      // The cashier may not see customer profiles: keep the id via a stub.
      this.customer.set({ id, first_name: '—' } as Customer);
    }
    await this.loadWallet();
    if (save) this.scheduleSave();
  }

  private async loadWallet(): Promise<void> {
    const c = this.customer();
    this.wallet.set(null);
    if (!c) return;
    try {
      this.wallet.set(await this.pos.wallet(c.id));
    } catch {
      /* no wallet access */
    }
  }

  /** Take the server's numbers (and, on load, its lines). */
  private apply(doc: InvoiceDoc, replaceLines = false): void {
    this.doc.set(doc);
    if (replaceLines) {
      this.lines.set(
        doc.items.map((it) =>
          blankLine({
            kind: it.kind as UiLine['kind'],
            service_id: it.service_id ?? undefined,
            package_id: it.package_id ?? undefined,
            membership_id: it.membership_id ?? undefined,
            product_id: it.product_id ?? undefined,
            customer_package_id: it.customer_package_id,
            appointment_id: it.deposit_appointment_id,
            employee_id: it.employee_id,
            appointment_service_id: it.appointment_service_id,
            description: this.i18n.pick(it.description_en, it.description_ar),
            quantity: String(it.quantity),
            price: it.kind === 'custom' || it.kind === 'voucher' || (it.unit_price !== it.list_price && !it.customer_package_id) ? String(it.unit_price) : null,
            discount: it.member_discount_percent ? '0' : String(it.discount_amount),
            priceType: this.services().find((s) => s.id === it.service_id)?.price_type ?? 'fixed',
            shownPrice: it.unit_price,
            total: it.total_amount,
            memberPercent: it.member_discount_percent,
          }),
        ),
      );
    } else if (doc.items.length === this.lines().length) {
      this.lines.update((ls) =>
        ls.map((l, i) => ({ ...l, shownPrice: doc.items[i].unit_price, total: doc.items[i].total_amount, memberPercent: doc.items[i].member_discount_percent })),
      );
    }
  }

  protected canEditPrice(l: UiLine): boolean {
    if (l.customer_package_id || l.kind === 'voucher') return false;
    if (l.kind === 'custom') return true;
    if (l.kind === 'package' || l.kind === 'membership' || l.kind === 'product') return this.canDiscount();
    return this.canDiscount() || l.priceType !== 'fixed';
  }

  private push(line: UiLine): void {
    this.lines.update((ls) => [...ls, line]);
    this.scheduleSave();
  }

  protected addService(s: Service): void {
    this.push(blankLine({ kind: 'service', service_id: s.id, description: this.i18n.pick(s.name_en, s.name_ar), priceType: s.price_type }));
  }

  protected addProduct(p: StockRow): void {
    this.push(blankLine({ kind: 'product', product_id: p.product_id, description: this.i18n.pick(p.name_en, p.name_ar) }));
  }

  protected addPackage(p: Package): void {
    if (!this.customer()) this.toast.info(this.i18n.t('pos.customerNeeded'));
    this.push(blankLine({ kind: 'package', package_id: p.id, description: this.i18n.pick(p.name_en, p.name_ar) }));
  }

  protected addMembership(m: Membership): void {
    if (!this.customer()) this.toast.info(this.i18n.t('pos.customerNeeded'));
    this.push(blankLine({ kind: 'membership', membership_id: m.id, description: this.i18n.pick(m.name_en, m.name_ar) }));
  }

  /** Pay a service with a session from one of the customer's packages. */
  protected redeem(customerPackageId: string, serviceId: string, nameEn: string, nameAr: string | null): void {
    this.push(blankLine({ kind: 'service', service_id: serviceId, customer_package_id: customerPackageId, description: this.i18n.pick(nameEn, nameAr), priceType: 'fixed' }));
  }

  /** Turn all points into store credit; it is then offered at payment. */
  protected async redeemPoints(points: number): Promise<void> {
    const c = this.customer();
    if (!c) return;
    try {
      const res = await this.financeApi.redeemPoints(c.id, points);
      this.toast.success(this.i18n.t('pos.pointsRedeemed', { code: res.code }));
      await this.loadWallet();
    } catch (err) {
      this.toast.error(err);
    }
  }

  protected addVoucher(depositFor: string | null): void {
    const data: AmountDialogData = {
      title: this.i18n.t(depositFor ? 'pos.takeDeposit' : 'pos.giftVoucher'),
      hint: this.i18n.t(depositFor ? 'pos.depositHint' : 'pos.voucherHint'),
    };
    this.dialog.open<number, AmountDialogData>(AmountDialog, { data }).closed.subscribe((amount) => {
      if (!amount) return;
      this.push(
        blankLine({
          kind: 'voucher',
          appointment_id: depositFor,
          description: this.i18n.t(depositFor ? 'pos.deposit' : 'pos.giftVoucher'),
          price: String(amount),
          shownPrice: amount,
        }),
      );
    });
  }

  protected addCustom(): void {
    this.dialog.open<{ description: string; unit_price: number }>(CustomItemDialog).closed.subscribe((item) => {
      if (!item) return;
      this.push(blankLine({ kind: 'custom', description: item.description, price: String(item.unit_price), priceType: 'variable', shownPrice: item.unit_price }));
    });
  }

  protected remove(index: number): void {
    this.lines.update((ls) => ls.filter((_, i) => i !== index));
    this.scheduleSave();
  }

  protected edit(index: number, field: 'quantity' | 'price' | 'discount' | 'employee', value: string): void {
    this.lines.update((ls) =>
      ls.map((l, i) => {
        if (i !== index) return l;
        if (field === 'employee') return { ...l, employee_id: value || null };
        if (field === 'price') return { ...l, price: value.trim() === '' ? null : value.trim(), total: null };
        return { ...l, [field]: value.trim(), total: null };
      }),
    );
    this.scheduleSave();
  }

  protected setCustomer(c: Customer | null): void {
    this.customer.set(c);
    this.customerResults.set([]);
    this.customerQuery.set('');
    // Package sessions belong to a customer: drop them when the customer changes.
    this.lines.update((ls) => ls.filter((l) => !l.customer_package_id));
    void this.loadWallet();
    this.scheduleSave();
  }

  protected searchCustomers(value: string): void {
    this.customerQuery.set(value);
    clearTimeout(this.searchTimer);
    const tenantId = this.ctx.tenantId();
    if (!tenantId || value.trim().length < 2) {
      this.customerResults.set([]);
      return;
    }
    this.searchTimer = setTimeout(async () => {
      try {
        this.customerResults.set(await this.customersApi.search(tenantId, value, false, 6));
      } catch (err) {
        this.toast.error(err);
      }
    }, 250);
  }

  private scheduleSave(): void {
    clearTimeout(this.saveTimer);
    this.saving.set(true);
    this.saveTimer = setTimeout(() => void this.flush(), 350);
  }

  /** Save the cart now; saves are serialised so the server sees them in order. */
  private flush(): Promise<void> {
    clearTimeout(this.saveTimer);
    this.saveChain = this.saveChain.then(() => this.saveNow());
    return this.saveChain;
  }

  private async saveNow(): Promise<void> {
    const tenantId = this.ctx.tenantId();
    const branchId = this.branchId();
    if (!tenantId || !branchId) return;
    const snapshot = this.lines();
    const bad = snapshot.find((l) => parseAmount(l.quantity) === null || (l.price !== null && parseAmount(l.price) === null) || parseAmount(l.discount) === null);
    if (bad) {
      this.saving.set(false);
      this.toast.error({ message: 'INVALID_PRICE' });
      return;
    }
    try {
      let id = this.doc()?.id;
      if (!id) {
        if (snapshot.length === 0) return;
        id = await this.pos.createDraft(tenantId, branchId, { customerId: this.customer()?.id ?? null, key: this.draftKey });
      }
      const payload: CartLine[] = snapshot.map((l) => ({
        kind: l.kind,
        service_id: l.service_id,
        package_id: l.package_id,
        membership_id: l.membership_id,
        product_id: l.product_id,
        customer_package_id: l.customer_package_id,
        appointment_id: l.appointment_id,
        employee_id: l.employee_id,
        appointment_service_id: l.appointment_service_id,
        description: l.kind === 'custom' ? l.description : undefined,
        quantity: parseAmount(l.quantity)!,
        unit_price: l.price === null ? null : parseAmount(l.price),
        discount_amount: parseAmount(l.discount)!,
      }));
      const doc = await this.pos.save(id, this.customer()?.id ?? null, payload, null);
      if (this.lines() === snapshot) this.apply(doc);
      else this.doc.set(doc);
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.saving.set(false);
    }
  }

  /** Direct print after checkout: re-read the invoice so the receipt shows the payments just taken. */
  private async printReceipt(invoiceId: string): Promise<void> {
    try {
      const doc = await this.pos.get(invoiceId);
      if (doc.paid_total > 0) await this.receipts.print(doc); // nothing to hand over if no payment was taken
    } catch (err) {
      this.toast.error(err);
    }
  }

  async charge(): Promise<void> {
    this.busy.set(true);
    try {
      await this.flush();
      const id = this.doc()?.id;
      if (!id) return;
      const posted = await this.pos.finalize(id);
      const data: PaymentDialogData = { doc: posted, vouchers: this.wallet()?.vouchers ?? [] };
      this.dialog.open<boolean, PaymentDialogData>(PaymentDialog, { data, disableClose: true }).closed.subscribe(() => {
        if (this.receipts.autoPrint()) void this.printReceipt(posted.id);
        void this.router.navigate(['/invoices', posted.id]);
      });
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.busy.set(false);
    }
  }

  async discard(): Promise<void> {
    const id = this.doc()?.id;
    if (!id) return;
    const ok = await this.confirm.ask({
      title: this.i18n.t('pos.discard'),
      message: this.i18n.t('pos.confirmDiscard'),
      confirmLabel: this.i18n.t('pos.discard'),
      danger: true,
    });
    if (!ok) return;
    try {
      await this.pos.discard(id);
      this.reset();
    } catch (err) {
      this.toast.error(err);
    }
  }

  private reset(): void {
    this.doc.set(null);
    this.lines.set([]);
    this.customer.set(null);
    this.wallet.set(null);
    this.draftKey = crypto.randomUUID();
    if (this.appointment() || this.invoice() || this.deposit()) void this.router.navigate(['/pos']);
  }

  drawer(): void {
    const branchId = this.branchId();
    if (!branchId) return;
    this.dialog.open<boolean, DrawerDialogData>(CashDrawerDialog, { data: { branchId, session: this.session() } }).closed.subscribe(async (changed) => {
      if (changed) this.session.set(await this.pos.openSession(branchId));
    });
  }
}

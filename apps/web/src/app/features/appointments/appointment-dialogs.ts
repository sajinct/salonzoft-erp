import { Dialog, DialogRef, DIALOG_DATA } from '@angular/cdk/dialog';
import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { LucideDynamicIcon } from '@lucide/angular';
import { I18nService, TranslateDynamicPipe, TranslatePipe } from '../../core/i18n/i18n.service';
import { ToastService } from '../../core/services/toast.service';
import { TenantContextService } from '../../core/tenant/tenant-context.service';
import { MoneyPipe } from '../../shared/pipes/format.pipes';
import { CustomerDialog } from '../customers/customer-dialog';
import { Customer, CustomersService } from '../customers/data/customers.service';
import { Service, ServiceCategory, ServicesService } from '../services/data/services.service';
import {
  AppointmentStatus,
  AppointmentsService,
  CalendarAppointment,
  CalendarEmployee,
  NEXT_STATUSES,
  Slot,
} from './data/appointments.service';
import { zonedTime } from './data/calendar-time';

export const BOOKING_SOURCES = ['front_desk', 'phone', 'whatsapp', 'walk_in'] as const;

export interface BookingDialogData {
  branchId: string;
  timezone: string;
  date: string;
  employees: CalendarEmployee[];
  /** Preselected column / time from a click on the calendar. */
  employeeId?: string | null;
  time?: string | null;
  /** Set when rescheduling. */
  appointment?: CalendarAppointment;
}

// ---------------------------------------------------------------------------
// Book / reschedule
// ---------------------------------------------------------------------------
@Component({
  selector: 'sz-booking-dialog',
  imports: [TranslatePipe, TranslateDynamicPipe, LucideDynamicIcon, MoneyPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="card flex max-h-[94vh] w-[min(46rem,calc(100vw-2rem))] flex-col" role="dialog" aria-modal="true">
      <header class="flex items-center justify-between border-b border-line px-6 py-4">
        <h2 class="text-lg font-semibold">{{ (data.appointment ? 'appointments.reschedule' : 'appointments.new') | t }}</h2>
        <button type="button" class="btn-icon" (click)="ref.close()" [attr.aria-label]="'common.close' | t"><svg lucideIcon="x" [size]="18"></svg></button>
      </header>

      <div class="flex-1 space-y-5 overflow-y-auto px-6 py-5">
        <!-- Customer -->
        @if (!data.appointment) {
          <section>
            <h3 class="label mb-2">{{ 'appointments.customer' | t }}</h3>
            @if (customer(); as c) {
              <div class="flex items-center gap-3 rounded-xl border border-line px-3 py-2">
                <svg lucideIcon="user-round" [size]="16" class="text-muted"></svg>
                <span class="flex-1 font-medium">{{ c.first_name }} {{ c.last_name }} <span class="num text-sm text-muted" dir="ltr">{{ c.mobile }}</span></span>
                <button type="button" class="btn-ghost btn-sm" (click)="customer.set(null)">{{ 'appointments.change' | t }}</button>
              </div>
            } @else {
              <div class="flex flex-wrap gap-2">
                <input type="search" class="input min-w-56 flex-1" [placeholder]="'customers.search' | t" [value]="customerQuery()" (input)="searchCustomers($any($event.target).value)" />
                @if (canCreateCustomer()) {
                  <button type="button" class="btn-secondary" (click)="newCustomer()"><svg lucideIcon="user-plus" [size]="15"></svg>{{ 'customers.add' | t }}</button>
                }
              </div>
              @if (customerResults().length > 0) {
                <ul class="mt-2 divide-y divide-line rounded-xl border border-line">
                  @for (c of customerResults(); track c.id) {
                    <li><button type="button" class="flex w-full items-center gap-3 px-3 py-2 text-start text-sm hover:bg-surface-2" (click)="pickCustomer(c)">
                      <span class="flex-1 font-medium">{{ c.first_name }} {{ c.last_name }}</span><span class="num text-muted" dir="ltr">{{ c.mobile }}</span>
                    </button></li>
                  }
                </ul>
              }
              <p class="hint mt-1">{{ 'appointments.walkInHint' | t }}</p>
            }
          </section>
        }

        <!-- Services -->
        <section>
          <h3 class="label mb-2">{{ 'appointments.services' | t }}</h3>
          <div class="flex flex-wrap gap-2">
            @for (s of chosen(); track $index; let i = $index) {
              <span class="badge-primary py-1 text-sm">
                {{ i18n.pick(s.name_en, s.name_ar) }} · {{ 'services.minutes' | t: { n: s.duration_minutes } }}
                @if (!data.appointment) {
                  <button type="button" class="ms-1 opacity-70 hover:opacity-100" (click)="removeService(i)" [attr.aria-label]="'common.remove' | t"><svg lucideIcon="x" [size]="12"></svg></button>
                }
              </span>
            }
          </div>
          @if (!data.appointment) {
            <select class="input mt-2" (change)="addService($any($event.target))" [attr.aria-label]="'appointments.addService' | t">
              <option value="">{{ 'appointments.addService' | t }}…</option>
              @for (g of serviceGroups(); track g.name) {
                <optgroup [label]="g.name">
                  @for (s of g.services; track s.id) { <option [value]="s.id">{{ i18n.pick(s.name_en, s.name_ar) }} · {{ s.duration_minutes }}′</option> }
                </optgroup>
              }
            </select>
          }
          @if (totalMinutes() > 0) { <p class="hint mt-1">{{ 'appointments.totalDuration' | t: { n: totalMinutes() } }}</p> }
        </section>

        <!-- Who and when -->
        <section class="grid gap-3 sm:grid-cols-2">
          <div class="field">
            <label class="label" for="bemp">{{ 'appointments.staff' | t }}</label>
            <select id="bemp" class="input" [value]="employeeId() ?? ''" (change)="employeeId.set($any($event.target).value || null); findSlots()">
              <option value="">{{ 'appointments.anyStaff' | t }}</option>
              @for (e of data.employees; track e.id) { <option [value]="e.id">{{ i18n.pick(e.name_en, e.name_ar) }}</option> }
            </select>
          </div>
          <div class="field">
            <label class="label" for="bdate">{{ 'appointments.date' | t }}</label>
            <input id="bdate" class="input" type="date" dir="ltr" [value]="date()" (change)="date.set($any($event.target).value); findSlots()" />
          </div>
        </section>

        <section>
          <h3 class="label mb-2">{{ 'appointments.availableTimes' | t }}</h3>
          @if (chosen().length === 0) {
            <p class="text-sm text-muted">{{ 'appointments.pickServiceFirst' | t }}</p>
          } @else if (loadingSlots()) {
            <p class="text-sm text-muted">{{ 'common.loading' | t }}</p>
          } @else if (slotOptions().length === 0) {
            <p class="text-sm text-muted">{{ 'appointments.noTimes' | t }}</p>
          } @else {
            <div class="flex max-h-48 flex-wrap gap-1.5 overflow-y-auto">
              @for (s of slotOptions(); track s.starts_at + s.employee_id) {
                <button type="button" class="num rounded-lg border px-2.5 py-1 text-sm" dir="ltr"
                        [class]="slot() === s ? 'border-primary bg-primary text-on-primary' : 'border-line hover:border-primary'"
                        (click)="slot.set(s)" [title]="employeeName(s.employee_id)">{{ label(s.starts_at) }}</button>
              }
            </div>
            @if (slot(); as s) {
              <p class="mt-2 text-sm">{{ 'appointments.withStaff' | t: { time: label(s.starts_at), name: employeeName(s.employee_id) } }}</p>
            }
          }
        </section>

        @if (!data.appointment) {
          <section class="grid gap-3 sm:grid-cols-[12rem_1fr]">
            <div class="field">
              <label class="label" for="bsrc">{{ 'appointments.source' | t }}</label>
              <select id="bsrc" class="input" [value]="source()" (change)="source.set($any($event.target).value)">
                @for (s of sources; track s) { <option [value]="s">{{ 'appointments.sourceName.' + s | tx }}</option> }
              </select>
            </div>
            <div class="field">
              <label class="label" for="bnotes">{{ 'appointments.notes' | t }}</label>
              <input id="bnotes" class="input" maxlength="1000" [value]="notes()" (input)="notes.set($any($event.target).value)" />
            </div>
          </section>
        }
      </div>

      <footer class="flex items-center justify-between gap-2 border-t border-line px-6 py-4">
        <span class="text-sm text-muted">@if (priceTotal() > 0) { {{ priceTotal() | money }} }</span>
        <div class="flex gap-2">
          <button type="button" class="btn-secondary" (click)="ref.close()">{{ 'common.cancel' | t }}</button>
          <button type="button" class="btn-primary" [disabled]="!slot() || saving()" (click)="confirm()">
            {{ saving() ? ('common.saving' | t) : ((data.appointment ? 'appointments.move' : 'appointments.book') | t) }}
          </button>
        </div>
      </footer>
    </div>
  `,
})
export class BookingDialog {
  protected readonly ref = inject<DialogRef<boolean>>(DialogRef);
  protected readonly data = inject<BookingDialogData>(DIALOG_DATA);
  protected readonly i18n = inject(I18nService);
  private readonly ctx = inject(TenantContextService);
  private readonly appointments = inject(AppointmentsService);
  private readonly customers = inject(CustomersService);
  private readonly servicesApi = inject(ServicesService);
  private readonly dialog = inject(Dialog);
  private readonly toast = inject(ToastService);

  protected readonly sources = BOOKING_SOURCES;
  /** One key per dialog: double clicks and network retries can't double-book. */
  private readonly idempotencyKey = crypto.randomUUID();

  protected readonly customer = signal<Customer | null>(null);
  protected readonly customerQuery = signal('');
  protected readonly customerResults = signal<Customer[]>([]);
  protected readonly services = signal<Service[]>([]);
  protected readonly categories = signal<ServiceCategory[]>([]);
  protected readonly chosen = signal<Service[]>([]);
  protected readonly employeeId = signal<string | null>(this.data.employeeId ?? this.singleEmployee());
  protected readonly date = signal(this.data.date);
  protected readonly slots = signal<Slot[]>([]);
  protected readonly slot = signal<Slot | null>(null);
  protected readonly loadingSlots = signal(false);
  protected readonly saving = signal(false);
  protected readonly source = signal<string>('front_desk');
  protected readonly notes = signal('');
  protected readonly canCreateCustomer = computed(() => this.ctx.can('customers.manage'));

  protected readonly totalMinutes = computed(() => this.chosen().reduce((sum, s) => sum + s.duration_minutes, 0));
  protected readonly priceTotal = computed(() => this.chosen().reduce((sum, s) => sum + Number(s.price), 0));
  protected readonly serviceGroups = computed(() => {
    const active = this.services().filter((s) => s.is_active);
    const groups = [...this.categories().map((c) => ({ id: c.id, name: this.i18n.pick(c.name_en, c.name_ar) })), { id: '', name: this.i18n.t('services.uncategorised') }];
    return groups.map((g) => ({ name: g.name, services: active.filter((s) => (s.category_id ?? '') === g.id) })).filter((g) => g.services.length);
  });
  /** With "any staff", show each time once (the first free employee). */
  protected readonly slotOptions = computed(() => {
    if (this.employeeId()) return this.slots();
    const seen = new Set<string>();
    return [...this.slots()].sort((a, b) => a.starts_at.localeCompare(b.starts_at)).filter((s) => !seen.has(s.starts_at) && seen.add(s.starts_at));
  });

  private searchTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    inject(DestroyRef).onDestroy(() => clearTimeout(this.searchTimer));
    void this.init();
  }

  private singleEmployee(): string | null {
    const ids = new Set(this.data.appointment?.lines.map((l) => l.employee_id));
    return ids.size === 1 ? [...ids][0] : null;
  }

  private async init(): Promise<void> {
    const tenantId = this.ctx.tenantId();
    if (!tenantId) return;
    try {
      const catalogue = await this.servicesApi.load(tenantId);
      this.services.set(catalogue.services);
      this.categories.set(catalogue.categories);
      if (this.data.appointment) {
        this.chosen.set(this.data.appointment.lines.map((l) => catalogue.services.find((s) => s.id === l.service_id)).filter((s): s is Service => !!s));
        await this.findSlots();
      }
    } catch (err) {
      this.toast.error(err);
    }
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
        this.customerResults.set(await this.customers.search(tenantId, value, false, 8));
      } catch (err) {
        this.toast.error(err);
      }
    }, 250);
  }

  protected pickCustomer(c: Customer): void {
    this.customer.set(c);
    this.customerResults.set([]);
    this.customerQuery.set('');
  }

  protected newCustomer(): void {
    this.dialog.open<Customer, Customer | null>(CustomerDialog, { data: null }).closed.subscribe((saved) => {
      if (saved) this.pickCustomer(saved);
    });
  }

  protected addService(select: HTMLSelectElement): void {
    const s = this.services().find((x) => x.id === select.value);
    select.value = '';
    if (!s) return;
    this.chosen.update((list) => [...list, s]);
    void this.findSlots();
  }

  protected removeService(index: number): void {
    this.chosen.update((list) => list.filter((_, i) => i !== index));
    void this.findSlots();
  }

  async findSlots(): Promise<void> {
    this.slot.set(null);
    if (this.chosen().length === 0 || !this.date()) {
      this.slots.set([]);
      return;
    }
    this.loadingSlots.set(true);
    try {
      const slots = await this.appointments.availability(
        this.data.branchId,
        this.chosen().map((s) => s.id),
        this.date(),
        this.employeeId(),
        this.data.appointment?.id,
      );
      this.slots.set(slots);
      // Preselect the clicked time when it is free.
      const wanted = this.data.time && this.date() === this.data.date ? this.data.time : null;
      if (wanted) this.slot.set(this.slotOptions().find((s) => this.label(s.starts_at) === wanted) ?? null);
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.loadingSlots.set(false);
    }
  }

  protected label(iso: string): string {
    return zonedTime(iso, this.data.timezone);
  }

  protected employeeName(id: string): string {
    const e = this.data.employees.find((x) => x.id === id);
    return e ? this.i18n.pick(e.name_en, e.name_ar) : '';
  }

  async confirm(): Promise<void> {
    const slot = this.slot();
    const tenantId = this.ctx.tenantId();
    if (!slot || !tenantId) return;
    this.saving.set(true);
    try {
      if (this.data.appointment) {
        await this.appointments.reschedule(this.data.appointment.id, slot.starts_at, slot.employee_id);
      } else {
        await this.appointments.create({
          tenantId,
          branchId: this.data.branchId,
          customerId: this.customer()?.id ?? null,
          startsAt: slot.starts_at,
          items: this.chosen().map((s) => ({ service_id: s.id, employee_id: slot.employee_id })),
          notes: this.notes().trim() || null,
          source: this.source(),
          idempotencyKey: this.idempotencyKey,
        });
      }
      this.toast.success(this.i18n.t(this.data.appointment ? 'appointments.moved' : 'appointments.booked'));
      this.ref.close(true);
    } catch (err) {
      this.toast.error(err);
      // Someone else took the slot meanwhile: refresh the choices.
      void this.findSlots();
    } finally {
      this.saving.set(false);
    }
  }
}

// ---------------------------------------------------------------------------
// Appointment details + status actions
// ---------------------------------------------------------------------------
export interface DetailsDialogData {
  appointment: CalendarAppointment;
  timezone: string;
  employees: CalendarEmployee[];
  canManage: boolean;
  myEmployeeIds: string[];
}
export type DetailsResult = 'changed' | 'reschedule' | 'checkout' | undefined;

@Component({
  selector: 'sz-appointment-details-dialog',
  imports: [TranslatePipe, TranslateDynamicPipe, LucideDynamicIcon, MoneyPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="card flex max-h-[92vh] w-[min(34rem,calc(100vw-2rem))] flex-col" role="dialog" aria-modal="true">
      <header class="flex items-start justify-between gap-3 border-b border-line px-6 py-4">
        <div>
          <h2 class="text-lg font-semibold">{{ customerName() }}</h2>
          <p class="num text-sm text-muted" dir="ltr">{{ time(a.starts_at) }} – {{ time(a.ends_at) }}</p>
        </div>
        <span [class]="statusClass(a.status)">{{ 'appointments.status.' + a.status | tx }}</span>
      </header>
      <div class="flex-1 space-y-4 overflow-y-auto px-6 py-5 text-sm">
        @if (a.customer?.mobile) {
          <p class="flex items-center gap-2"><svg lucideIcon="phone" [size]="14" class="text-muted"></svg><a class="num text-primary" dir="ltr" [href]="'tel:' + a.customer!.mobile">{{ a.customer!.mobile }}</a></p>
        }
        <ul class="divide-y divide-line rounded-xl border border-line">
          @for (l of a.lines; track l.id) {
            <li class="flex items-center gap-3 px-3 py-2">
              <span class="num w-24 text-muted" dir="ltr">{{ time(l.starts_at) }}–{{ time(l.ends_at) }}</span>
              <span class="flex-1"><span class="font-medium">{{ i18n.pick(l.service_name_en, l.service_name_ar) }}</span><span class="block text-xs text-muted">{{ employeeName(l.employee_id) }}</span></span>
              <span class="num">{{ l.price_type === 'variable' ? '—' : (l.price | money) }}</span>
            </li>
          }
        </ul>
        @if (a.notes) { <p><span class="text-muted">{{ 'appointments.notes' | t }}:</span> {{ a.notes }}</p> }
        @if (a.cancel_reason) { <p><span class="text-muted">{{ 'appointments.reason' | t }}:</span> {{ a.cancel_reason }}</p> }
        <p class="text-xs text-muted">{{ 'appointments.source' | t }}: {{ 'appointments.sourceName.' + a.source | tx }}</p>

        @if (askReason()) {
          <div class="field">
            <label class="label" for="reason">{{ 'appointments.reason' | t }} <span class="hint">({{ 'common.optional' | t }})</span></label>
            <input id="reason" class="input" maxlength="300" [value]="reason()" (input)="reason.set($any($event.target).value)" />
          </div>
        }
      </div>
      <footer class="flex flex-wrap justify-end gap-2 border-t border-line px-6 py-4">
        @if (askReason(); as target) {
          <button type="button" class="btn-secondary" (click)="askReason.set(null)">{{ 'common.back' | t }}</button>
          <button type="button" class="btn-danger" [disabled]="busy()" (click)="apply(target)">{{ 'appointments.action.' + target | tx }}</button>
        } @else {
          @if (canCheckout()) {
            <button type="button" class="btn-primary" (click)="ref.close('checkout')"><svg lucideIcon="receipt" [size]="15"></svg>{{ 'pos.checkout' | t }}</button>
          }
          @if (data.canManage && (a.status === 'booked' || a.status === 'confirmed')) {
            <button type="button" class="btn-secondary" (click)="ref.close('reschedule')"><svg lucideIcon="calendar-days" [size]="15"></svg>{{ 'appointments.reschedule' | t }}</button>
          }
          @for (s of actions(); track s) {
            <button type="button" [class]="s === 'cancelled' || s === 'no_show' ? 'btn-ghost text-danger' : 'btn-primary'" [disabled]="busy()"
                    (click)="s === 'cancelled' || s === 'no_show' ? askReason.set(s) : apply(s)">{{ 'appointments.action.' + s | tx }}</button>
          }
        }
      </footer>
    </div>
  `,
})
export class AppointmentDetailsDialog {
  protected readonly ref = inject<DialogRef<DetailsResult>>(DialogRef);
  protected readonly data = inject<DetailsDialogData>(DIALOG_DATA);
  protected readonly i18n = inject(I18nService);
  private readonly appointments = inject(AppointmentsService);
  private readonly toast = inject(ToastService);

  protected readonly a = this.data.appointment;
  private readonly ctx = inject(TenantContextService);
  /** Cashiers can bill any visit that wasn't cancelled (the invoice completes it). */
  protected readonly canCheckout = computed(() => this.ctx.can('pos.access') && !['cancelled', 'no_show'].includes(this.a.status));
  protected readonly busy = signal(false);
  protected readonly askReason = signal<AppointmentStatus | null>(null);
  protected readonly reason = signal('');

  /** Front desk: every allowed transition. Stylist: start / complete own work. */
  protected readonly actions = computed(() => {
    const next = NEXT_STATUSES[this.a.status];
    if (this.data.canManage) return next;
    const mine = this.a.lines.some((l) => this.data.myEmployeeIds.includes(l.employee_id));
    return mine ? next.filter((s) => s === 'in_service' || s === 'completed') : [];
  });

  protected customerName(): string {
    const c = this.a.customer;
    return c ? `${c.first_name} ${c.last_name ?? ''}`.trim() : this.i18n.t('appointments.walkIn');
  }

  protected time(iso: string): string {
    return zonedTime(iso, this.data.timezone);
  }

  protected employeeName(id: string): string {
    const e = this.data.employees.find((x) => x.id === id);
    return e ? this.i18n.pick(e.name_en, e.name_ar) : '';
  }

  protected statusClass(status: AppointmentStatus): string {
    return statusBadge(status);
  }

  async apply(status: AppointmentStatus): Promise<void> {
    this.busy.set(true);
    try {
      await this.appointments.setStatus(this.a.id, status, this.reason().trim() || undefined);
      this.ref.close('changed');
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.busy.set(false);
    }
  }
}

export function statusBadge(status: AppointmentStatus): string {
  switch (status) {
    case 'confirmed':
      return 'badge-primary';
    case 'checked_in':
    case 'in_service':
      return 'badge-warning';
    case 'completed':
      return 'badge-success';
    case 'cancelled':
    case 'no_show':
      return 'badge-danger';
    default:
      return 'badge-muted';
  }
}

import { Dialog } from '@angular/cdk/dialog';
import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { LucideDynamicIcon } from '@lucide/angular';
import { I18nService, TranslateDynamicPipe, TranslatePipe } from '../../core/i18n/i18n.service';
import { ToastService } from '../../core/services/toast.service';
import { TenantContextService } from '../../core/tenant/tenant-context.service';
import { PageHeader, StatePanel } from '../../shared/components/ui';
import { AppointmentDetailsDialog, BookingDialog, BookingDialogData, DetailsDialogData, DetailsResult, statusBadge } from './appointment-dialogs';
import { AppointmentsService, CalendarAppointment, CalendarData, CalendarLine } from './data/appointments.service';
import { addDays, minutesInDay, minutesToLabel, visibleRange, zonedDate, zonedInstant, zonedTime } from './data/calendar-time';

const PX_PER_MIN = 1.2; // 72 px per hour
const SNAP = 15;

interface PlacedLine {
  line: CalendarLine;
  appointment: CalendarAppointment;
  top: number;
  height: number;
}

@Component({
  selector: 'sz-appointments-page',
  imports: [TranslatePipe, TranslateDynamicPipe, LucideDynamicIcon, PageHeader, StatePanel],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <sz-page-header [heading]="'nav.appointments' | t" [subtitle]="subtitle()">
      @if (data()?.can_manage) {
        <button type="button" class="btn-primary" (click)="book(null, null)"><svg lucideIcon="plus" [size]="16"></svg>{{ 'appointments.new' | t }}</button>
      }
    </sz-page-header>

    <div class="mb-4 flex flex-wrap items-center gap-2">
      @if (ctx.branches().length > 1) {
        <select class="input w-48" [value]="branchId() ?? ''" (change)="ctx.setBranch($any($event.target).value)" [attr.aria-label]="'employees.branch' | t">
          @for (b of ctx.branches(); track b.id) { <option [value]="b.id">{{ i18n.pick(b.name_en, b.name_ar) }}</option> }
        </select>
      }
      <div class="flex items-center gap-1">
        <button type="button" class="btn-icon" (click)="shift(-1)" [attr.aria-label]="'appointments.previousDay' | t"><svg lucideIcon="chevron-left" [size]="18" class="rtl:rotate-180"></svg></button>
        <button type="button" class="btn-secondary btn-sm" (click)="goToday()">{{ 'appointments.today' | t }}</button>
        <button type="button" class="btn-icon" (click)="shift(1)" [attr.aria-label]="'appointments.nextDay' | t"><svg lucideIcon="chevron-right" [size]="18" class="rtl:rotate-180"></svg></button>
      </div>
      <input type="date" class="input w-44" dir="ltr" [value]="date()" (change)="date.set($any($event.target).value)" [attr.aria-label]="'appointments.date' | t" />
      <label class="ms-auto flex items-center gap-2 text-sm text-muted">
        <input type="checkbox" class="checkbox" [checked]="showCancelled()" (change)="showCancelled.set($any($event.target).checked)" />{{ 'appointments.showCancelled' | t }}
      </label>
    </div>

    @if (loading() && !data()) {
      <div class="card"><sz-state [loading]="true" /></div>
    } @else if (data(); as d) {
      @if (d.employees.length === 0) {
        <div class="card"><sz-state icon="calendar-days" [heading]="'appointments.noStaffTitle' | t" [message]="'appointments.noStaff' | t" /></div>
      } @else {
        <div class="card overflow-x-auto">
          <div class="grid min-w-full" [style.grid-template-columns]="'3.5rem repeat(' + d.employees.length + ', minmax(9rem, 1fr))'">
            <!-- header row -->
            <div class="sticky top-0 z-10 border-b border-line bg-surface"></div>
            @for (e of d.employees; track e.id) {
              <div class="sticky top-0 z-10 flex items-center gap-2 border-b border-s border-line bg-surface px-3 py-2">
                <span class="h-2.5 w-2.5 shrink-0 rounded-full" [style.background]="e.color || 'var(--sz-primary)'"></span>
                <span class="truncate text-sm font-semibold">{{ i18n.pick(e.name_en, e.name_ar) }}</span>
                <span class="ms-auto text-xs text-muted">{{ countFor(e.id) }}</span>
              </div>
            }

            <!-- time gutter -->
            <div class="relative" [style.height.px]="gridHeight()">
              @for (h of hours(); track h) {
                <span class="num absolute end-2 -translate-y-1/2 text-xs text-muted" dir="ltr" [style.top.px]="(h - range().start) * px">{{ hourLabel(h) }}</span>
              }
            </div>

            <!-- employee columns -->
            @for (e of d.employees; track e.id) {
              <div class="relative border-s border-line bg-surface-2/70" [style.height.px]="gridHeight()"
                   [class.cursor-copy]="d.can_manage" (click)="onColumnClick($event, e.id)">
                @for (w of working()[e.id] ?? []; track $index) {
                  <div class="pointer-events-none absolute inset-x-0 bg-surface" [style.top.px]="w.top" [style.height.px]="w.height"></div>
                }
                @for (h of hours(); track h) {
                  <div class="pointer-events-none absolute inset-x-0 border-t border-line/60" [style.top.px]="(h - range().start) * px"></div>
                }
                @for (p of placed()[e.id] ?? []; track p.line.id) {
                  <button type="button" class="absolute inset-x-1 overflow-hidden rounded-lg border-s-4 px-2 py-1 text-start text-xs shadow-sm transition hover:z-20 hover:shadow-md"
                          [style.top.px]="p.top" [style.height.px]="p.height"
                          [style.border-color]="e.color || 'var(--sz-primary)'"
                          [class]="blockClass(p.appointment)"
                          (click)="$event.stopPropagation(); open(p.appointment)">
                    <span class="num block font-semibold" dir="ltr">{{ time(p.line.starts_at) }}</span>
                    <span class="block truncate font-medium">{{ customerName(p.appointment) }}</span>
                    <span class="block truncate opacity-80">{{ i18n.pick(p.line.service_name_en, p.line.service_name_ar) }}</span>
                  </button>
                }
                @if (nowTop() !== null) {
                  <div class="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-danger" [style.top.px]="nowTop()"></div>
                }
              </div>
            }
          </div>
        </div>
        <p class="mt-3 flex flex-wrap gap-2 text-xs text-muted">
          @for (s of legend; track s) { <span [class]="badge(s)">{{ 'appointments.status.' + s | tx }}</span> }
          <span class="ms-auto">{{ 'appointments.liveHint' | t }}</span>
        </p>
      }
    } @else if (!branchId()) {
      <div class="card"><sz-state icon="building-2" [heading]="'appointments.chooseBranch' | t" /></div>
    }
  `,
})
export class AppointmentsPage {
  protected readonly ctx = inject(TenantContextService);
  protected readonly i18n = inject(I18nService);
  private readonly service = inject(AppointmentsService);
  private readonly dialog = inject(Dialog);
  private readonly toast = inject(ToastService);

  protected readonly px = PX_PER_MIN;
  protected readonly legend = ['booked', 'confirmed', 'checked_in', 'completed', 'cancelled'] as const;
  protected readonly loading = signal(true);
  protected readonly data = signal<CalendarData | null>(null);
  protected readonly showCancelled = signal(false);
  private readonly now = signal(Date.now());

  /** The selected branch, or the first one the user can access. */
  protected readonly branchId = computed<string | null>(() => this.ctx.branchId() ?? this.ctx.branches().at(0)?.id ?? null);
  private readonly timezone = computed(
    () => this.data()?.branch.timezone ?? this.ctx.branches().find((b) => b.id === this.branchId())?.timezone ?? 'Asia/Muscat',
  );
  protected readonly date = signal(zonedDate(new Date(), this.timezone()));

  protected readonly visible = computed(() =>
    (this.data()?.appointments ?? []).filter((a) => this.showCancelled() || (a.status !== 'cancelled' && a.status !== 'no_show')),
  );

  protected readonly range = computed(() => {
    const d = this.data();
    if (!d) return visibleRange([]);
    const tz = this.timezone();
    const blocks = [
      ...d.open.map(([s, e]) => ({ start: minutesInDay(s, this.date(), tz), end: minutesInDay(e, this.date(), tz) })),
      ...this.visible().flatMap((a) => a.lines.map((l) => ({ start: minutesInDay(l.starts_at, this.date(), tz), end: minutesInDay(l.ends_at, this.date(), tz) }))),
    ];
    return visibleRange(blocks);
  });
  protected readonly gridHeight = computed(() => (this.range().end - this.range().start) * PX_PER_MIN);
  protected readonly hours = computed(() => {
    const out: number[] = [];
    for (let m = this.range().start; m < this.range().end; m += 60) out.push(m);
    return out;
  });

  protected readonly working = computed(() => {
    const out: Record<string, { top: number; height: number }[]> = {};
    const tz = this.timezone();
    for (const e of this.data()?.employees ?? []) {
      out[e.id] = e.working.map(([s, end]) => this.box(minutesInDay(s, this.date(), tz), minutesInDay(end, this.date(), tz)));
    }
    return out;
  });

  protected readonly placed = computed(() => {
    const out: Record<string, PlacedLine[]> = {};
    const tz = this.timezone();
    for (const a of this.visible()) {
      for (const line of a.lines) {
        const b = this.box(minutesInDay(line.starts_at, this.date(), tz), minutesInDay(line.ends_at, this.date(), tz));
        (out[line.employee_id] ??= []).push({ line, appointment: a, top: b.top, height: Math.max(b.height, 22) });
      }
    }
    return out;
  });

  protected readonly nowTop = computed(() => {
    const tz = this.timezone();
    if (zonedDate(new Date(this.now()), tz) !== this.date()) return null;
    const m = minutesInDay(new Date(this.now()), this.date(), tz);
    return m < this.range().start || m > this.range().end ? null : (m - this.range().start) * PX_PER_MIN;
  });

  protected readonly subtitle = computed(() => {
    this.i18n.lang();
    const day = zonedInstant(this.date(), '12:00', this.timezone());
    const label = new Intl.DateTimeFormat(this.i18n.locale(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: this.timezone() }).format(day);
    const branch = this.ctx.branches().find((b) => b.id === this.branchId());
    return branch ? `${this.i18n.pick(branch.name_en, branch.name_ar)} · ${label}` : label;
  });

  private requestId = 0;
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    const destroyRef = inject(DestroyRef);
    // Reload whenever the branch or the date changes.
    effect(() => {
      const branch = this.branchId();
      const date = this.date();
      untracked(() => void this.load(branch, date));
    });
    // Live updates for the selected branch.
    effect((onCleanup) => {
      const branch = this.branchId();
      if (!branch) return;
      const stop = untracked(() => this.service.watchBranch(branch, () => this.scheduleReload()));
      onCleanup(stop);
    });
    const clock = setInterval(() => this.now.set(Date.now()), 60_000);
    destroyRef.onDestroy(() => {
      clearInterval(clock);
      clearTimeout(this.reloadTimer);
    });
  }

  private box(start: number, end: number): { top: number; height: number } {
    const s = Math.max(start, this.range().start);
    const e = Math.min(end, this.range().end);
    return { top: (s - this.range().start) * PX_PER_MIN, height: Math.max(0, (e - s) * PX_PER_MIN) };
  }

  private scheduleReload(): void {
    clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => void this.load(this.branchId(), this.date()), 300);
  }

  async load(branchId: string | null, date: string): Promise<void> {
    if (!branchId) {
      this.loading.set(false);
      return;
    }
    const id = ++this.requestId;
    this.loading.set(true);
    try {
      const tz = this.timezone();
      const from = zonedInstant(date, '00:00', tz);
      const to = zonedInstant(addDays(date, 1), '00:00', tz);
      const data = await this.service.calendar(branchId, from, to);
      if (id === this.requestId) this.data.set(data);
    } catch (err) {
      if (id === this.requestId) {
        this.data.set(null);
        this.toast.error(err);
      }
    } finally {
      if (id === this.requestId) this.loading.set(false);
    }
  }

  protected shift(days: number): void {
    this.date.update((d) => addDays(d, days));
  }

  protected goToday(): void {
    this.date.set(zonedDate(new Date(), this.timezone()));
  }

  protected hourLabel(minutes: number): string {
    return minutesToLabel(minutes);
  }

  protected time(iso: string): string {
    return zonedTime(iso, this.timezone());
  }

  protected countFor(employeeId: string): number {
    return new Set((this.placed()[employeeId] ?? []).map((p) => p.appointment.id)).size;
  }

  protected customerName(a: CalendarAppointment): string {
    return a.customer ? `${a.customer.first_name} ${a.customer.last_name ?? ''}`.trim() : this.i18n.t('appointments.walkIn');
  }

  protected badge(status: CalendarAppointment['status']): string {
    return statusBadge(status);
  }

  protected blockClass(a: CalendarAppointment): string {
    switch (a.status) {
      case 'completed':
        return 'bg-success-soft text-ink';
      case 'checked_in':
      case 'in_service':
        return 'bg-warning-soft text-ink';
      case 'cancelled':
      case 'no_show':
        return 'bg-danger-soft text-muted line-through';
      case 'confirmed':
        return 'bg-primary-soft text-ink';
      default:
        return 'bg-surface text-ink border border-line';
    }
  }

  protected onColumnClick(event: MouseEvent, employeeId: string): void {
    if (!this.data()?.can_manage) return;
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const minutes = this.range().start + Math.floor((event.clientY - rect.top) / PX_PER_MIN / SNAP) * SNAP;
    this.book(employeeId, minutesToLabel(minutes));
  }

  book(employeeId: string | null, time: string | null): void {
    const d = this.data();
    const branchId = this.branchId();
    if (!d || !branchId) return;
    const data: BookingDialogData = { branchId, timezone: this.timezone(), date: this.date(), employees: d.employees, employeeId, time };
    this.dialog.open<boolean, BookingDialogData>(BookingDialog, { data }).closed.subscribe((changed) => {
      if (changed) this.scheduleReload();
    });
  }

  open(appointment: CalendarAppointment): void {
    const d = this.data();
    if (!d) return;
    const data: DetailsDialogData = {
      appointment,
      timezone: this.timezone(),
      employees: d.employees,
      canManage: d.can_manage,
      myEmployeeIds: d.my_employee_ids,
    };
    this.dialog.open<DetailsResult, DetailsDialogData>(AppointmentDetailsDialog, { data }).closed.subscribe((result) => {
      if (result === 'changed') this.scheduleReload();
      if (result === 'reschedule') {
        const booking: BookingDialogData = { branchId: d.branch.id, timezone: this.timezone(), date: this.date(), employees: d.employees, appointment };
        this.dialog.open<boolean, BookingDialogData>(BookingDialog, { data: booking }).closed.subscribe((changed) => {
          if (changed) this.scheduleReload();
        });
      }
    });
  }
}

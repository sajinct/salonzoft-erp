import { Dialog, DialogRef, DIALOG_DATA } from '@angular/cdk/dialog';
import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { LucideDynamicIcon } from '@lucide/angular';
import { I18nService, TranslateDynamicPipe, TranslatePipe } from '../../core/i18n/i18n.service';
import { ToastService } from '../../core/services/toast.service';
import { TenantContextService } from '../../core/tenant/tenant-context.service';
import { PageHeader, StatePanel } from '../../shared/components/ui';
import { LocalDatePipe } from '../../shared/pipes/format.pipes';
import { TeamMember, TeamService } from '../settings/data/team.service';
import { Service, ServiceCategory, ServicesService } from '../services/data/services.service';
import { Employee, EmployeeAssignments, EmployeeInput, EmployeesService, ShiftInput, StaffLeave } from './data/employees.service';

const DAYS = [0, 1, 2, 3, 4, 5, 6];
type Tab = 'profile' | 'assignments' | 'shifts' | 'leave';

interface ShiftRow {
  branch_id: string;
  starts_at: string;
  ends_at: string;
}

export interface EmployeeDialogData {
  employee: Employee | null;
  assignments: EmployeeAssignments;
  services: Service[];
  categories: ServiceCategory[];
  members: TeamMember[];
  linkedMembershipIds: string[];
}

@Component({
  selector: 'sz-employee-dialog',
  imports: [ReactiveFormsModule, TranslatePipe, TranslateDynamicPipe, LucideDynamicIcon, LocalDatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="card flex max-h-[92vh] w-[min(52rem,calc(100vw-2rem))] flex-col" role="dialog" aria-modal="true">
      <header class="flex items-center justify-between border-b border-line px-6 py-4">
        <h2 class="text-lg font-semibold">{{ employee() ? i18n.pick(employee()!.name_en, employee()!.name_ar) : ('employees.add' | t) }}</h2>
        <button type="button" class="btn-icon" (click)="ref.close(changed)" [attr.aria-label]="'common.close' | t"><svg lucideIcon="x" [size]="18"></svg></button>
      </header>

      <nav class="flex gap-1 overflow-x-auto border-b border-line px-4" role="tablist">
        @for (t of tabs; track t) {
          <button type="button" role="tab" [attr.aria-selected]="tab() === t" [disabled]="t !== 'profile' && !employee()"
                  class="shrink-0 border-b-2 px-3 py-2.5 text-sm font-medium disabled:opacity-40"
                  [class]="tab() === t ? 'border-primary text-primary' : 'border-transparent text-muted hover:text-ink'"
                  (click)="tab.set(t)">{{ 'employees.tab.' + t | tx }}</button>
        }
      </nav>

      <div class="flex-1 overflow-y-auto px-6 py-5">
        @switch (tab()) {
          @case ('profile') {
            <form [formGroup]="form" id="employee-form" class="grid gap-4 sm:grid-cols-2" (ngSubmit)="saveProfile()" novalidate>
              <div class="field"><label class="label" for="een">{{ 'common.nameEn' | t }}</label><input id="een" class="input" formControlName="name_en" maxlength="80" /></div>
              <div class="field"><label class="label" for="ear">{{ 'common.nameAr' | t }}</label><input id="ear" class="input" formControlName="name_ar" dir="rtl" lang="ar" maxlength="80" /></div>
              <div class="field"><label class="label" for="ejt">{{ 'employees.jobTitle' | t }}</label><input id="ejt" class="input" formControlName="job_title" maxlength="80" /></div>
              <div class="field"><label class="label" for="ecode">{{ 'employees.code' | t }} <span class="hint">({{ 'common.optional' | t }})</span></label><input id="ecode" class="input uppercase" formControlName="code" dir="ltr" maxlength="20" /></div>
              <div class="field"><label class="label" for="eph">{{ 'common.mobile' | t }}</label><input id="eph" class="input" formControlName="phone" dir="ltr" placeholder="+96891234567" /></div>
              <div class="field"><label class="label" for="eem">{{ 'common.email' | t }}</label><input id="eem" class="input" type="email" formControlName="email" dir="ltr" /></div>
              <div class="field">
                <label class="label" for="egen">{{ 'common.gender' | t }}</label>
                <select id="egen" class="input" formControlName="gender">
                  <option value="">—</option><option value="female">{{ 'common.female' | t }}</option><option value="male">{{ 'common.male' | t }}</option>
                </select>
              </div>
              <div class="field"><label class="label" for="ehire">{{ 'employees.hiredOn' | t }}</label><input id="ehire" class="input" type="date" formControlName="hired_on" dir="ltr" /></div>
              @if (data.members.length > 0) {
                <div class="field sm:col-span-2">
                  <label class="label" for="emem">{{ 'employees.login' | t }}</label>
                  <select id="emem" class="input" formControlName="membership_id">
                    <option value="">{{ 'employees.noLogin' | t }}</option>
                    @for (m of availableMembers(); track m.membership_id) {
                      <option [value]="m.membership_id">{{ m.full_name || m.email }} · {{ m.email }}</option>
                    }
                  </select>
                  <p class="hint">{{ 'employees.loginHint' | t }}</p>
                </div>
              }
              <div class="flex flex-wrap items-center gap-x-6 gap-y-2 sm:col-span-2">
                <label class="flex items-center gap-2 text-sm"><input type="checkbox" class="checkbox" formControlName="is_active" />{{ 'common.active' | t }}</label>
                <label class="flex items-center gap-2 text-sm"><input type="checkbox" class="checkbox" formControlName="is_bookable" />{{ 'employees.bookable' | t }}</label>
                <label class="flex items-center gap-2 text-sm">{{ 'services.color' | t }}<input type="color" class="h-8 w-10 cursor-pointer rounded border border-line" formControlName="color" /></label>
              </div>
            </form>
          }

          @case ('assignments') {
            <section class="mb-6">
              <h3 class="font-semibold">{{ 'employees.branches' | t }}</h3>
              <p class="hint mb-3">{{ 'employees.branchesHint' | t }}</p>
              <div class="flex flex-wrap gap-3">
                @for (b of ctx.branches(); track b.id) {
                  <label class="flex items-center gap-2 rounded-xl border border-line px-3 py-2 text-sm">
                    <input type="checkbox" class="checkbox" [checked]="branchIds().has(b.id)" (change)="toggle(branchIds, b.id)" />{{ i18n.pick(b.name_en, b.name_ar) }}
                  </label>
                }
              </div>
            </section>
            <section>
              <div class="mb-3 flex items-center justify-between">
                <div><h3 class="font-semibold">{{ 'employees.skills' | t }}</h3><p class="hint">{{ 'employees.skillsHint' | t }}</p></div>
                <span class="badge-muted">{{ serviceIds().size }} / {{ activeServices().length }}</span>
              </div>
              @for (g of serviceGroups(); track g.id) {
                <div class="mb-3 rounded-xl border border-line">
                  <label class="flex items-center gap-2 border-b border-line bg-surface-2 px-4 py-2 text-sm font-semibold">
                    <input type="checkbox" class="checkbox" [checked]="allChecked(g.services)" (change)="toggleGroup(g.services, $event)" />{{ g.name }}
                  </label>
                  <div class="grid gap-2 px-4 py-3 sm:grid-cols-2">
                    @for (s of g.services; track s.id) {
                      <label class="flex items-center gap-2 text-sm"><input type="checkbox" class="checkbox" [checked]="serviceIds().has(s.id)" (change)="toggle(serviceIds, s.id)" />{{ i18n.pick(s.name_en, s.name_ar) }}</label>
                    }
                  </div>
                </div>
              } @empty {
                <p class="text-sm text-muted">{{ 'employees.noServices' | t }}</p>
              }
            </section>
          }

          @case ('shifts') {
            @if (myBranches().length === 0) {
              <p class="text-sm text-muted">{{ 'employees.assignBranchFirst' | t }}</p>
            } @else {
              <p class="hint mb-3">{{ 'employees.shiftsHint' | t }}</p>
              <div class="divide-y divide-line rounded-xl border border-line">
                @for (d of shifts(); track $index; let di = $index) {
                  <div class="flex flex-wrap items-start gap-3 px-4 py-3">
                    <span class="w-24 pt-2 text-sm font-medium">{{ 'day.' + di | tx }}</span>
                    <div class="flex flex-1 flex-col gap-2">
                      @for (r of d; track $index; let ri = $index) {
                        <div class="flex flex-wrap items-center gap-2">
                          @if (myBranches().length > 1) {
                            <select class="input h-9 w-40" [value]="r.branch_id" (change)="setShift(di, ri, 'branch_id', $event)" [attr.aria-label]="'employees.branch' | t">
                              @for (b of myBranches(); track b.id) { <option [value]="b.id">{{ i18n.pick(b.name_en, b.name_ar) }}</option> }
                            </select>
                          }
                          <span class="flex items-center gap-2" dir="ltr">
                            <input type="time" class="input h-9 w-32" [value]="r.starts_at" (change)="setShift(di, ri, 'starts_at', $event)" />
                            <span class="text-muted">–</span>
                            <input type="time" class="input h-9 w-32" [value]="r.ends_at" (change)="setShift(di, ri, 'ends_at', $event)" />
                          </span>
                          <button type="button" class="btn-icon h-8 w-8" (click)="removeShift(di, ri)" [attr.aria-label]="'common.remove' | t"><svg lucideIcon="trash-2" [size]="15"></svg></button>
                        </div>
                      } @empty {
                        <span class="pt-2 text-sm text-muted">{{ 'employees.dayOff' | t }}</span>
                      }
                    </div>
                    <button type="button" class="btn-ghost btn-sm" (click)="addShift(di)" [disabled]="d.length >= 4"><svg lucideIcon="plus" [size]="14"></svg>{{ 'employees.addShift' | t }}</button>
                  </div>
                }
              </div>
              <div class="mt-3 flex justify-between gap-2">
                <button type="button" class="btn-ghost btn-sm" (click)="copyFirstWorkday()">{{ 'employees.copyToAll' | t }}</button>
              </div>
            }
          }

          @case ('leave') {
            @if (canManageLeave()) {
              <form [formGroup]="leaveForm" class="mb-5 grid gap-3 rounded-xl border border-line p-4 sm:grid-cols-2" (ngSubmit)="addLeave()" novalidate>
                <div class="field">
                  <label class="label" for="ltype">{{ 'employees.leaveType' | t }}</label>
                  <select id="ltype" class="input" formControlName="leave_type">
                    @for (t of leaveTypes; track t) { <option [value]="t">{{ 'employees.leave.' + t | tx }}</option> }
                  </select>
                </div>
                <div class="field"><label class="label" for="lreason">{{ 'employees.reason' | t }}</label><input id="lreason" class="input" formControlName="reason" maxlength="300" /></div>
                <div class="field"><label class="label" for="lfrom">{{ 'common.from' | t }}</label><input id="lfrom" class="input" type="datetime-local" formControlName="starts_at" dir="ltr" /></div>
                <div class="field"><label class="label" for="lto">{{ 'common.to' | t }}</label><input id="lto" class="input" type="datetime-local" formControlName="ends_at" dir="ltr" /></div>
                <div class="sm:col-span-2 flex justify-end"><button type="submit" class="btn-secondary" [disabled]="busy()"><svg lucideIcon="plus" [size]="15"></svg>{{ 'employees.addLeave' | t }}</button></div>
              </form>
            }
            <ul class="divide-y divide-line rounded-xl border border-line">
              @for (l of leaves(); track l.id) {
                <li class="flex flex-wrap items-center gap-3 px-4 py-3 text-sm" [class.opacity-60]="l.status === 'cancelled' || l.status === 'rejected'">
                  <span class="badge-primary">{{ 'employees.leave.' + l.leave_type | tx }}</span>
                  <span class="num flex-1" dir="ltr">{{ l.starts_at | localDate: 'datetime' }} → {{ l.ends_at | localDate: 'datetime' }}</span>
                  @if (l.reason) { <span class="text-muted">{{ l.reason }}</span> }
                  <span class="badge-muted">{{ 'employees.leaveStatus.' + l.status | tx }}</span>
                  @if (canManageLeave() && l.status !== 'cancelled') {
                    <button type="button" class="btn-ghost btn-sm" (click)="cancelLeave(l)">{{ 'common.cancel' | t }}</button>
                  }
                </li>
              } @empty {
                <li class="px-4 py-6 text-center text-sm text-muted">{{ 'employees.noLeave' | t }}</li>
              }
            </ul>
          }
        }
      </div>

      @if (tab() !== 'leave') {
        <footer class="flex justify-end gap-2 border-t border-line px-6 py-4">
          <button type="button" class="btn-secondary" (click)="ref.close(changed)">{{ 'common.close' | t }}</button>
          <button type="button" class="btn-primary" [disabled]="busy()" (click)="saveTab()">{{ busy() ? ('common.saving' | t) : ('common.save' | t) }}</button>
        </footer>
      }
    </div>
  `,
})
export class EmployeeDialog {
  protected readonly ref = inject<DialogRef<boolean>>(DialogRef);
  protected readonly data = inject<EmployeeDialogData>(DIALOG_DATA);
  protected readonly ctx = inject(TenantContextService);
  protected readonly i18n = inject(I18nService);
  private readonly service = inject(EmployeesService);
  private readonly toast = inject(ToastService);

  protected readonly tabs: Tab[] = ['profile', 'assignments', 'shifts', 'leave'];
  protected readonly leaveTypes = ['annual', 'sick', 'unpaid', 'other'] as const;
  protected readonly tab = signal<Tab>('profile');
  protected readonly employee = signal<Employee | null>(this.data.employee);
  protected readonly busy = signal(false);
  protected changed = false;

  private readonly e = this.data.employee;
  protected readonly form = inject(NonNullableFormBuilder).group({
    name_en: [this.e?.name_en ?? '', [Validators.required, Validators.minLength(2), Validators.maxLength(80)]],
    name_ar: [this.e?.name_ar ?? ''],
    job_title: [this.e?.job_title ?? ''],
    code: [this.e?.code ?? '', Validators.pattern(/^[A-Za-z0-9][A-Za-z0-9-]{0,19}$/)],
    phone: [this.e?.phone ?? '', Validators.pattern(/^\+?[0-9]{6,15}$/)],
    email: [this.e?.email ?? '', Validators.email],
    gender: [this.e?.gender ?? ''],
    hired_on: [this.e?.hired_on ?? ''],
    membership_id: [this.e?.membership_id ?? ''],
    is_active: [this.e?.is_active ?? true],
    is_bookable: [this.e?.is_bookable ?? true],
    color: [this.e?.color ?? '#7a6ab4'],
  });

  protected readonly leaveForm = inject(NonNullableFormBuilder).group({
    leave_type: ['annual'],
    reason: [''],
    starts_at: ['', Validators.required],
    ends_at: ['', Validators.required],
  });

  // ---- assignments ----------------------------------------------------------
  protected readonly branchIds = signal(new Set(this.e ? (this.data.assignments.branches.get(this.e.id) ?? []) : []));
  protected readonly serviceIds = signal(new Set(this.e ? (this.data.assignments.services.get(this.e.id) ?? []) : []));
  protected readonly activeServices = computed(() => this.data.services.filter((s) => s.is_active || this.serviceIds().has(s.id)));
  protected readonly serviceGroups = computed(() => {
    const groups = [...this.data.categories.map((c) => ({ id: c.id, name: this.i18n.pick(c.name_en, c.name_ar) })), { id: '', name: this.i18n.t('services.uncategorised') }];
    return groups
      .map((g) => ({ ...g, services: this.activeServices().filter((s) => (s.category_id ?? '') === g.id) }))
      .filter((g) => g.services.length > 0);
  });

  protected readonly availableMembers = computed(() =>
    this.data.members.filter((m) => m.membership_id === this.e?.membership_id || !this.data.linkedMembershipIds.includes(m.membership_id)),
  );

  // ---- shifts ----------------------------------------------------------------
  protected readonly myBranches = computed(() => this.ctx.branches().filter((b) => this.branchIds().has(b.id)));
  protected readonly shifts = signal<ShiftRow[][]>(DAYS.map(() => []));
  protected readonly leaves = signal<StaffLeave[]>([]);
  protected readonly canManageLeave = computed(() => this.ctx.can('attendance.manage'));

  constructor() {
    if (this.e) void this.loadDetails(this.e.id);
  }

  private async loadDetails(id: string): Promise<void> {
    try {
      const [shifts, leaves] = await Promise.all([this.service.shifts(id), this.service.leaves(id)]);
      this.shifts.set(
        DAYS.map((d) =>
          shifts.filter((s) => s.day_of_week === d).map((s) => ({ branch_id: s.branch_id, starts_at: s.starts_at.slice(0, 5), ends_at: s.ends_at.slice(0, 5) })),
        ),
      );
      this.leaves.set(leaves);
    } catch (err) {
      this.toast.error(err);
    }
  }

  protected toggle(target: typeof this.branchIds, id: string): void {
    target.update((set) => {
      const next = new Set(set);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  protected allChecked(services: Service[]): boolean {
    return services.every((s) => this.serviceIds().has(s.id));
  }

  protected toggleGroup(services: Service[], event: Event): void {
    const on = (event.target as HTMLInputElement).checked;
    this.serviceIds.update((set) => {
      const next = new Set(set);
      for (const s of services) {
        if (on) next.add(s.id);
        else next.delete(s.id);
      }
      return next;
    });
  }

  protected addShift(day: number): void {
    const branch = this.myBranches()[0]?.id;
    if (!branch) return;
    this.shifts.update((all) => all.map((d, i) => (i === day ? [...d, { branch_id: branch, starts_at: '09:00', ends_at: '17:00' }] : d)));
  }

  protected removeShift(day: number, index: number): void {
    this.shifts.update((all) => all.map((d, i) => (i === day ? d.filter((_, j) => j !== index) : d)));
  }

  protected setShift(day: number, index: number, field: keyof ShiftRow, event: Event): void {
    const value = (event.target as HTMLInputElement | HTMLSelectElement).value;
    this.shifts.update((all) => all.map((d, i) => (i === day ? d.map((r, j) => (j === index ? { ...r, [field]: value } : r)) : d)));
  }

  /** Copy the first day that has shifts to every other day except the weekend days. */
  protected copyFirstWorkday(): void {
    const source = this.shifts().find((d) => d.length > 0);
    if (!source) return;
    const weekend = new Set(this.ctx.context()?.settings.weekend_days ?? []);
    this.shifts.update((all) => all.map((d, i) => (weekend.has(i) ? d : source.map((r) => ({ ...r })))));
  }

  // ---- saving ----------------------------------------------------------------
  async saveTab(): Promise<void> {
    if (this.tab() === 'profile') await this.saveProfile();
    else if (this.tab() === 'assignments') await this.saveAssignments();
    else if (this.tab() === 'shifts') await this.saveShifts();
  }

  async saveProfile(): Promise<void> {
    const tenantId = this.ctx.tenantId();
    if (!tenantId || this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const v = this.form.getRawValue();
    const input: EmployeeInput = {
      name_en: v.name_en.trim(),
      name_ar: v.name_ar.trim() || null,
      job_title: v.job_title.trim() || null,
      code: v.code.trim().toUpperCase() || null,
      phone: v.phone.replace(/\s/g, '') || null,
      email: v.email.trim().toLowerCase() || null,
      gender: v.gender || null,
      hired_on: v.hired_on || null,
      membership_id: v.membership_id || null,
      is_active: v.is_active,
      is_bookable: v.is_bookable,
      color: v.color || null,
    };
    await this.run(async () => {
      const current = this.employee();
      const saved = current ? await this.service.update(current.id, input) : await this.service.create(tenantId, input);
      const isNew = !current;
      this.employee.set(saved);
      if (isNew) {
        // New employees usually work at the branch currently selected.
        const branch = this.ctx.branchId() ?? this.ctx.branches()[0]?.id;
        if (branch) {
          this.branchIds.set(new Set([branch]));
          await this.service.setAssignments(saved.id, [branch], []);
        }
        this.tab.set('assignments');
      }
    });
  }

  async saveAssignments(): Promise<void> {
    const emp = this.employee();
    if (!emp) return;
    await this.run(async () => {
      await this.service.setAssignments(emp.id, [...this.branchIds()], [...this.serviceIds()]);
      // Shifts at removed branches were deleted by the database.
      this.shifts.update((all) => all.map((d) => d.filter((r) => this.branchIds().has(r.branch_id))));
    });
  }

  async saveShifts(): Promise<void> {
    const emp = this.employee();
    if (!emp) return;
    const rows: ShiftInput[] = this.shifts().flatMap((d, day) =>
      d.map((r) => ({ branch_id: r.branch_id, day_of_week: day, starts_at: r.starts_at, ends_at: r.ends_at === '00:00' ? '24:00' : r.ends_at })),
    );
    await this.run(() => this.service.setShifts(emp.id, rows));
  }

  async addLeave(): Promise<void> {
    const emp = this.employee();
    const tenantId = this.ctx.tenantId();
    if (!emp || !tenantId || this.leaveForm.invalid) {
      this.leaveForm.markAllAsTouched();
      return;
    }
    const v = this.leaveForm.getRawValue();
    await this.run(async () => {
      await this.service.addLeave(tenantId, {
        employee_id: emp.id,
        leave_type: v.leave_type,
        reason: v.reason.trim() || null,
        starts_at: new Date(v.starts_at).toISOString(),
        ends_at: new Date(v.ends_at).toISOString(),
        status: 'approved',
      });
      this.leaveForm.reset({ leave_type: 'annual', reason: '', starts_at: '', ends_at: '' });
      this.leaves.set(await this.service.leaves(emp.id));
    });
  }

  async cancelLeave(leave: StaffLeave): Promise<void> {
    await this.run(async () => {
      await this.service.setLeaveStatus(leave.id, 'cancelled');
      this.leaves.update((list) => list.map((l) => (l.id === leave.id ? { ...l, status: 'cancelled' } : l)));
    });
  }

  private async run(work: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    try {
      await work();
      this.changed = true;
      this.toast.success(this.i18n.t('common.saved'));
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.busy.set(false);
    }
  }
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
@Component({
  selector: 'sz-employees-page',
  imports: [TranslatePipe, LucideDynamicIcon, PageHeader, StatePanel],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <sz-page-header [heading]="'nav.employees' | t" [subtitle]="'employees.subtitle' | t">
      @if (canManage()) {
        <button type="button" class="btn-primary" (click)="open(null)"><svg lucideIcon="user-plus" [size]="16"></svg>{{ 'employees.add' | t }}</button>
      }
    </sz-page-header>

    <div class="mb-4 flex flex-wrap items-center gap-3">
      <input type="search" class="input max-w-xs" [placeholder]="'employees.search' | t" [value]="query()" (input)="query.set($any($event.target).value)" />
      <label class="flex items-center gap-2 text-sm text-muted"><input type="checkbox" class="checkbox" [checked]="showInactive()" (change)="showInactive.set($any($event.target).checked)" />{{ 'common.showInactive' | t }}</label>
    </div>

    @if (loading()) {
      <div class="card"><sz-state [loading]="true" /></div>
    } @else if (visible().length === 0) {
      <div class="card"><sz-state icon="id-card" [heading]="'employees.emptyTitle' | t" [message]="'employees.empty' | t" /></div>
    } @else {
      <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        @for (e of visible(); track e.id) {
          <article class="card flex flex-col gap-3 p-5" [class.opacity-60]="!e.is_active">
            <div class="flex items-start gap-3">
              <span class="grid h-10 w-10 shrink-0 place-items-center rounded-full font-semibold text-white" [style.background]="e.color || 'var(--sz-primary)'">{{ initials(e) }}</span>
              <div class="min-w-0 flex-1">
                <h3 class="truncate font-semibold">{{ i18n.pick(e.name_en, e.name_ar) }}</h3>
                <p class="truncate text-sm text-muted">{{ e.job_title || '—' }}</p>
              </div>
              @if (canManage()) {
                <button type="button" class="btn-icon" (click)="open(e)" [attr.aria-label]="'common.edit' | t"><svg lucideIcon="pencil" [size]="16"></svg></button>
              }
            </div>
            <div class="flex flex-wrap gap-1.5">
              @if (!e.is_active) { <span class="badge-warning">{{ 'common.inactive' | t }}</span> }
              @if (e.is_active && !e.is_bookable) { <span class="badge-muted">{{ 'employees.notBookable' | t }}</span> }
              @if (e.membership_id) { <span class="badge-success"><svg lucideIcon="key-round" [size]="12"></svg>{{ 'employees.hasLogin' | t }}</span> }
              <span class="badge-muted">{{ 'employees.servicesCount' | t: { n: (assignments().services.get(e.id)?.length ?? 0) } }}</span>
            </div>
            <p class="text-xs text-muted">{{ branchNames(e.id) }}</p>
          </article>
        }
      </div>
    }
  `,
})
export class EmployeesPage implements OnInit {
  private readonly service = inject(EmployeesService);
  private readonly services = inject(ServicesService);
  private readonly team = inject(TeamService);
  private readonly ctx = inject(TenantContextService);
  private readonly dialog = inject(Dialog);
  private readonly toast = inject(ToastService);
  protected readonly i18n = inject(I18nService);

  protected readonly loading = signal(true);
  protected readonly employees = signal<Employee[]>([]);
  protected readonly assignments = signal<EmployeeAssignments>({ branches: new Map(), services: new Map() });
  protected readonly query = signal('');
  protected readonly showInactive = signal(false);
  protected readonly canManage = computed(() => this.ctx.can('employees.manage'));

  protected readonly visible = computed(() => {
    const q = this.query().trim().toLowerCase();
    return this.employees().filter(
      (e) => (this.showInactive() || e.is_active) && (!q || [e.name_en, e.name_ar, e.job_title, e.code].some((v) => v?.toLowerCase().includes(q))),
    );
  });

  ngOnInit(): void {
    void this.load();
  }

  async load(): Promise<void> {
    const tenantId = this.ctx.tenantId();
    if (!tenantId) return;
    try {
      const data = await this.service.list(tenantId);
      this.employees.set(data.employees);
      this.assignments.set(data.assignments);
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.loading.set(false);
    }
  }

  protected initials(e: Employee): string {
    return this.i18n
      .pick(e.name_en, e.name_ar)
      .split(/\s+/)
      .slice(0, 2)
      .map((p) => p[0] ?? '')
      .join('')
      .toUpperCase();
  }

  protected branchNames(employeeId: string): string {
    const ids = this.assignments().branches.get(employeeId) ?? [];
    const names = this.ctx.branches().filter((b) => ids.includes(b.id)).map((b) => this.i18n.pick(b.name_en, b.name_ar));
    return names.length ? names.join(' · ') : this.i18n.t('employees.noBranch');
  }

  async open(employee: Employee | null): Promise<void> {
    const tenantId = this.ctx.tenantId();
    if (!tenantId) return;
    try {
      const [catalogue, members] = await Promise.all([
        this.services.load(tenantId),
        this.ctx.can('team.view') ? this.team.listMembers(tenantId) : Promise.resolve([] as TeamMember[]),
      ]);
      const data: EmployeeDialogData = {
        employee,
        assignments: this.assignments(),
        services: catalogue.services,
        categories: catalogue.categories,
        members: members.filter((m) => m.status === 'active'),
        linkedMembershipIds: this.employees().map((e) => e.membership_id).filter((id): id is string => !!id),
      };
      this.dialog.open<boolean, EmployeeDialogData>(EmployeeDialog, { data, disableClose: true }).closed.subscribe((changed) => {
        if (changed) void this.load();
      });
    } catch (err) {
      this.toast.error(err);
    }
  }
}

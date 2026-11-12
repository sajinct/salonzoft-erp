import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideDynamicIcon } from '@lucide/angular';
import { AuthService } from '../../core/auth/auth.service';
import { I18nService, TranslateDynamicPipe, TranslatePipe } from '../../core/i18n/i18n.service';
import { ToastService } from '../../core/services/toast.service';
import { ConfirmService, StatePanel } from '../../shared/components/ui';
import { LocalDatePipe, MoneyPipe } from '../../shared/pipes/format.pipes';
import { Cycle, SubscriptionInvoice } from '../billing/data/billing.service';
import { AdminPlan, AdminService, TenantDetail, TenantMember, TenantPatch } from './data/admin.service';
import { FormDialogService } from './form-dialog';
import { InvoiceActions } from './invoice-actions';
import { MemberDialogs } from './member-dialogs';
import { BUSINESS_TYPES, tenantBadge } from './tenants.page';

type ModuleState = 'plan' | 'on' | 'off';

@Component({
  selector: 'sz-admin-tenant-page',
  imports: [TranslatePipe, TranslateDynamicPipe, LucideDynamicIcon, StatePanel, LocalDatePipe, MoneyPipe, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <a routerLink="/admin/tenants" class="btn-ghost btn-sm mb-3"><svg lucideIcon="arrow-left" [size]="16" class="rtl:rotate-180"></svg>{{ 'admin.nav.tenants' | t }}</a>
    @if (loading()) {
      <div class="card"><sz-state [loading]="true" /></div>
    } @else if (d(); as d) {
      <header class="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 class="page-title flex flex-wrap items-center gap-2">{{ i18n.pick(d.tenant.name, d.tenant.name_ar) }} <span [class]="badge().cls">{{ badge().key | tx }}</span></h1>
          <p class="text-sm text-muted"><span dir="ltr">/{{ d.tenant.slug }}</span> · {{ 'businessType.' + d.tenant.business_type | tx }} · {{ 'admin.since' | t: { date: (d.tenant.created_at | localDate) } }}@if (d.tenant.legal_name) { · {{ d.tenant.legal_name }} }</p>
        </div>
        <div class="flex flex-wrap gap-2">
          @if (api.canSupport()) {
            <button type="button" class="btn-secondary" (click)="editBusiness()"><svg lucideIcon="pencil" [size]="16"></svg>{{ 'admin.editBusiness' | t }}</button>
            @if (d.tenant.status === 'active') {
              <button type="button" class="btn-secondary" (click)="setStatus('suspended')"><svg lucideIcon="lock" [size]="16"></svg>{{ 'admin.suspend' | t }}</button>
            } @else {
              <button type="button" class="btn-secondary" (click)="setStatus('active')">{{ 'admin.reactivate' | t }}</button>
            }
          }
          @if (api.isAdmin() && d.tenant.status !== 'closed') {
            <button type="button" class="btn-ghost text-danger" (click)="setStatus('closed')">{{ 'admin.close' | t }}</button>
          }
        </div>
      </header>

      <div class="grid gap-5 lg:grid-cols-2">
        <section class="card p-5">
          <h2 class="mb-3 font-semibold">{{ 'admin.subscription' | t }}</h2>
          @if (d.subscription; as s) {
            <dl class="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
              <dt class="text-muted">{{ 'billing.plan' | t }}</dt><dd class="font-medium">{{ i18n.pick(s.plan_name_en, s.plan_name_ar) }} · {{ 'billing.cycle.' + s.billing_cycle | tx }}</dd>
              <dt class="text-muted">{{ 'common.status' | t }}</dt><dd>{{ 'subscription.' + s.status | tx }} @if (!s.operational) { <span class="badge-danger">{{ 'admin.notOperational' | t }}</span> }</dd>
              @if (s.status === 'trialing') {
                <dt class="text-muted">{{ 'admin.trialEnds' | t }}</dt><dd>{{ s.trial_ends_at | localDate: 'datetime' }}</dd>
              } @else {
                <dt class="text-muted">{{ 'admin.period' | t }}</dt><dd>{{ s.current_period_start | localDate }} – {{ s.current_period_end | localDate }}</dd>
              }
              @if (s.cancel_at_period_end) { <dt class="text-muted">{{ 'admin.renewal' | t }}</dt><dd class="text-danger">{{ 'admin.cancelling' | t }}</dd> }
              @if (s.scheduled_plan_code) { <dt class="text-muted">{{ 'admin.scheduled' | t }}</dt><dd>{{ planName(s.scheduled_plan_code) }} · {{ 'billing.cycle.' + s.scheduled_cycle | tx }}</dd> }
            </dl>
          } @else { <p class="text-sm text-muted">{{ 'billing.noSubscription' | t }}</p> }
          <div class="mt-4 flex flex-wrap gap-2">
            @if (api.canSupport() && d.subscription?.status === 'trialing') { <button type="button" class="btn-secondary btn-sm" (click)="extendTrial()">{{ 'admin.extendTrial' | t }}</button> }
            @if (api.canBilling()) {
              <button type="button" class="btn-secondary btn-sm" (click)="assignPlan()">{{ 'admin.assignPlan' | t }}</button>
              <button type="button" class="btn-secondary btn-sm" (click)="createInvoice()">{{ 'admin.createInvoice' | t }}</button>
            }
          </div>
        </section>

        <section class="card p-5">
          <h2 class="mb-3 font-semibold">{{ 'admin.usage' | t }}</h2>
          <dl class="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            @for (u of usage(); track u.key) {
              <div class="rounded-xl bg-surface-2 px-3 py-2"><dt class="text-xs text-muted">{{ u.key | tx }}</dt><dd class="num mt-0.5 font-semibold">{{ u.value }}</dd></div>
            }
          </dl>
          <p class="mt-3 text-xs text-muted">{{ 'admin.lastActivity' | t }}: {{ (d.usage.last_activity | localDate: 'datetime') || '—' }} · {{ d.settings?.timezone }} · {{ d.settings?.default_language === 'ar' ? 'العربية' : 'English' }}
            @if (d.settings?.vat_registered) { · {{ 'billing.vatNo' | t }} <span dir="ltr">{{ d.settings.vat_number }}</span> }</p>
        </section>

        <section class="card overflow-x-auto">
          <h2 class="px-5 pt-5 font-semibold">{{ 'admin.modules' | t }}</h2>
          <table class="table mt-2">
            <tbody>
              @for (m of paidModules(); track m.code) {
                <tr>
                  <td>{{ i18n.pick(m.name_en, m.name_ar) }}</td>
                  <td><span [class]="m.enabled ? 'badge-success' : 'badge-muted'">{{ (m.enabled ? 'admin.moduleOn' : 'admin.moduleOff') | t }}</span></td>
                  <td class="text-end">
                    @if (api.canSupport()) {
                      <select class="input h-8 w-40 text-xs" [value]="moduleState(m)" (change)="setModule(m.code, $any($event.target).value)" [attr.aria-label]="m.name_en">
                        @for (s of moduleStates; track s) { <option [value]="s" [selected]="s === moduleState(m)">{{ 'admin.moduleState.' + s | tx }}</option> }
                      </select>
                    } @else { <span class="text-xs text-muted">{{ 'admin.moduleState.' + moduleState(m) | tx }}</span> }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </section>
      </div>

      <section class="card mt-5 overflow-x-auto">
        <div class="flex flex-wrap items-center justify-between gap-2 px-5 pt-5">
          <h2 class="font-semibold">{{ 'admin.users' | t }}</h2>
          @if (api.canSupport()) { <button type="button" class="btn-secondary btn-sm" (click)="addUser()"><svg lucideIcon="user-plus" [size]="15"></svg>{{ 'admin.addUser' | t }}</button> }
        </div>
        @if (!hasOwner()) { <p class="px-5 pt-2 text-sm text-danger">{{ 'admin.noOwner' | t }}</p> }
        <table class="table mt-2">
          <thead><tr><th>{{ 'team.member' | t }}</th><th>{{ 'team.roles' | t }}</th><th>{{ 'team.branches' | t }}</th><th>{{ 'common.status' | t }}</th><th></th></tr></thead>
          <tbody>
            @for (m of d.members; track m.membership_id) {
              <tr>
                <td>
                  <p class="font-medium">{{ m.full_name || m.email }}</p>
                  <p class="text-xs text-muted" dir="ltr">{{ m.email }}</p>
                  @if (m.job_title) { <p class="text-xs text-muted">{{ m.job_title }}</p> }
                </td>
                <td>
                  @if (m.is_owner) { <span class="badge-primary">{{ 'admin.ownerBadge' | t }}</span> } @else {
                    <div class="flex flex-wrap gap-1">@for (rid of m.role_ids; track rid) { <span class="badge-muted">{{ roleName(rid) }}</span> } @empty { <span class="text-xs text-muted">—</span> }</div>
                  }
                </td>
                <td class="text-sm">{{ m.is_owner || m.all_branches ? ('shell.allBranches' | t) : branchNames(m.branch_ids) }}</td>
                <td><span [class]="m.status === 'active' ? 'badge-success' : 'badge-warning'">{{ (m.status === 'active' ? 'common.active' : 'team.suspended') | t }}</span></td>
                <td class="whitespace-nowrap text-end">
                  @if (api.canSupport()) {
                    @if (!m.is_owner) {
                      <button type="button" class="btn-ghost btn-sm" (click)="editUser(m)">{{ 'team.editAccess' | t }}</button>
                      <button type="button" class="btn-ghost btn-sm" (click)="toggleUser(m)">{{ (m.status === 'active' ? 'team.suspend' : 'team.reactivate') | t }}</button>
                      @if (api.isAdmin() && m.status === 'active') { <button type="button" class="btn-ghost btn-sm" (click)="makeOwner(m)">{{ 'admin.makeOwner' | t }}</button> }
                    }
                    <button type="button" class="btn-icon" (click)="resetPassword(m)" [attr.aria-label]="'admin.resetPassword' | t" [title]="'admin.resetPassword' | t"><svg lucideIcon="key-round" [size]="16"></svg></button>
                  }
                </td>
              </tr>
            } @empty { <tr><td colspan="5" class="py-6 text-center text-muted">{{ 'admin.none' | t }}</td></tr> }
            @for (inv of d.invitations; track inv.id) {
              <tr>
                <td><p class="flex items-center gap-2" dir="ltr"><svg lucideIcon="mail" [size]="15" class="text-muted"></svg>{{ inv.email }}</p></td>
                <td>@if (inv.make_owner) { <span class="badge-primary">{{ 'admin.ownerInvite' | t }}</span> }</td>
                <td class="text-xs text-muted">{{ 'team.expires' | t: { date: (inv.expires_at | localDate) } }}</td>
                <td><span class="badge-muted">{{ 'admin.invited' | t }}</span></td>
                <td class="text-end">@if (api.canSupport()) { <button type="button" class="btn-ghost btn-sm text-danger" (click)="revokeInvite(inv.id)">{{ 'team.revoke' | t }}</button> }</td>
              </tr>
            }
          </tbody>
        </table>
      </section>

      <section class="card mt-5 overflow-x-auto">
        <h2 class="px-5 pt-5 font-semibold">{{ 'billing.invoices' | t }}</h2>
        <table class="table mt-2">
          <thead><tr><th>{{ 'billing.number' | t }}</th><th>{{ 'billing.issued' | t }}</th><th>{{ 'billing.plan' | t }}</th><th class="text-end">{{ 'billing.total' | t }}</th><th>{{ 'common.status' | t }}</th><th></th></tr></thead>
          <tbody>
            @for (inv of d.invoices; track inv.id) {
              <tr>
                <td class="num">{{ inv.number }}</td>
                <td>{{ inv.issued_at | localDate }}</td>
                <td>{{ i18n.pick(inv.plan_name_en, inv.plan_name_ar) }} · {{ 'admin.kind.' + inv.kind | tx }}</td>
                <td class="num text-end">{{ inv.total | money }}</td>
                <td><span [class]="inv.status === 'paid' ? 'badge-success' : inv.status === 'open' ? 'badge-warning' : 'badge-muted'">{{ 'billing.status.' + inv.status | tx }}</span></td>
                <td class="whitespace-nowrap text-end">
                  @if (inv.status === 'open' && api.canBilling()) {
                    <button type="button" class="btn-ghost btn-sm" (click)="pay(inv)">{{ 'admin.markPaid' | t }}</button>
                    <button type="button" class="btn-ghost btn-sm text-danger" (click)="voidInv(inv)">{{ 'admin.void' | t }}</button>
                  }
                  <a class="btn-ghost btn-sm" [routerLink]="['/billing/invoices', inv.id]">{{ 'billing.view' | t }}</a>
                </td>
              </tr>
            } @empty { <tr><td colspan="6" class="py-6 text-center text-muted">{{ 'billing.noInvoices' | t }}</td></tr> }
          </tbody>
        </table>
      </section>

      <section class="card mt-5 p-5">
        <h2 class="mb-3 font-semibold">{{ 'admin.history' | t }}</h2>
        <ul class="space-y-2 text-sm">
          @for (h of d.history; track $index) {
            <li><span class="font-medium">{{ h.action }}</span> <span class="text-muted">· {{ h.actor ?? 'system' }} · {{ h.created_at | localDate: 'datetime' }}</span>
              @if (h.data['reason']) { <p class="text-xs text-muted">{{ h.data['reason'] }}</p> }</li>
          } @empty { <li class="text-muted">{{ 'admin.none' | t }}</li> }
        </ul>
      </section>
    }
  `,
})
export class AdminTenantPage implements OnInit {
  readonly id = input.required<string>();
  protected readonly i18n = inject(I18nService);
  protected readonly api = inject(AdminService);
  private readonly toast = inject(ToastService);
  private readonly form = inject(FormDialogService);
  private readonly invoices = inject(InvoiceActions);
  private readonly members = inject(MemberDialogs);
  private readonly confirm = inject(ConfirmService);
  private readonly auth = inject(AuthService);

  protected readonly moduleStates: ModuleState[] = ['plan', 'on', 'off'];
  protected readonly loading = signal(true);
  protected readonly d = signal<TenantDetail | null>(null);
  private plans: AdminPlan[] = [];

  protected readonly badge = computed(() => {
    const d = this.d();
    return tenantBadge(d?.tenant.status ?? 'active', d?.subscription?.status ?? null, d?.subscription?.trial_ends_at ?? null);
  });
  protected readonly hasOwner = computed(() => (this.d()?.members ?? []).some((m) => m.is_owner));
  protected readonly paidModules = computed(() => (this.d()?.modules ?? []).filter((m) => !m.is_core));
  protected readonly usage = computed(() => {
    const u = this.d()?.usage;
    if (!u) return [];
    return [
      { key: 'billing.usage.branches', value: u.branches },
      { key: 'billing.usage.staff', value: u.staff },
      { key: 'admin.usage.members', value: u.members },
      { key: 'admin.usage.customers', value: u.customers },
      { key: 'admin.usage.appointments', value: u.appointments_30d },
      { key: 'admin.usage.sales', value: u.sales_30d },
      { key: 'billing.usage.messages', value: u.messages_month },
    ];
  });

  async ngOnInit(): Promise<void> {
    await this.load();
  }

  private async load(): Promise<void> {
    try {
      const [d, plans] = await Promise.all([this.api.tenant(this.id()), this.plans.length ? Promise.resolve(this.plans) : this.api.plans()]);
      this.plans = plans;
      this.d.set(d);
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.loading.set(false);
    }
  }

  protected planName(code: string): string {
    const p = this.plans.find((x) => x.code === code);
    return p ? this.i18n.pick(p.name_en, p.name_ar) : code;
  }

  protected moduleState(m: TenantDetail['modules'][number]): ModuleState {
    if (m.source === 'override' || m.source === 'addon') return m.is_enabled ? 'on' : 'off';
    return 'plan';
  }

  private planOptions() {
    return this.plans.map((p) => ({ value: p.code, label: `${this.i18n.pick(p.name_en, p.name_ar)}${p.is_active ? '' : ' (' + this.i18n.t('admin.inactive') + ')'}` }));
  }

  private cycleOptions() {
    return (['monthly', 'yearly'] as const).map((c) => ({ value: c, label: this.i18n.tx('billing.cycle.' + c) }));
  }

  private async run(action: () => Promise<unknown>, success?: string): Promise<void> {
    try {
      await action();
      if (success) this.toast.success(success);
      await this.load();
    } catch (err) {
      this.toast.error(err);
    }
  }

  async setStatus(status: 'active' | 'suspended' | 'closed'): Promise<void> {
    const t = this.i18n.t.bind(this.i18n);
    const titles = { active: 'admin.reactivate', suspended: 'admin.suspend', closed: 'admin.close' } as const;
    const values = await this.form.open({
      title: t(titles[status]),
      message: t(status === 'active' ? 'admin.reactivateLine' : status === 'suspended' ? 'admin.suspendLine' : 'admin.closeLine'),
      submitLabel: t(titles[status]),
      danger: status !== 'active',
      fields: [{ key: 'reason', label: t('admin.reason'), type: 'text', required: status !== 'active' }],
    });
    if (!values) return;
    await this.run(() => this.api.setTenantStatus(this.id(), status, values['reason'].trim() || null), t('common.saved'));
  }

  protected roleName(id: string): string {
    const r = this.d()?.roles.find((x) => x.id === id);
    return r ? this.i18n.pick(r.name_en, r.name_ar) : '…';
  }

  protected branchNames(ids: string[]): string {
    const branches = this.d()?.branches ?? [];
    return branches.filter((b) => ids.includes(b.id)).map((b) => this.i18n.pick(b.name_en, b.name_ar)).join(', ') || '—';
  }

  private businessName(): string {
    const t = this.d()?.tenant;
    return t ? this.i18n.pick(t.name, t.name_ar) : '';
  }

  async editBusiness(): Promise<void> {
    const t = this.i18n.t.bind(this.i18n);
    const cur = this.d()?.tenant;
    if (!cur) return;
    const values = await this.form.open({
      title: t('admin.editBusiness'),
      submitLabel: t('common.save'),
      fields: [
        { key: 'name', label: t('onboarding.businessName'), type: 'text', value: cur.name, required: true },
        { key: 'name_ar', label: t('admin.nameAr'), type: 'text', value: cur.name_ar ?? '' },
        { key: 'legal_name', label: t('admin.legalName'), type: 'text', value: cur.legal_name ?? '' },
        { key: 'business_type', label: t('onboarding.businessType'), type: 'select', value: cur.business_type, options: BUSINESS_TYPES.map((b) => ({ value: b, label: this.i18n.tx('businessType.' + b) })) },
        { key: 'slug', label: t('onboarding.slug'), type: 'text', value: cur.slug, required: true, hint: t('admin.slugChangeHint') },
      ],
    });
    if (!values) return;
    // Send only what changed, so an untouched booking address is never rewritten.
    const before: Record<string, string> = { name: cur.name, name_ar: cur.name_ar ?? '', legal_name: cur.legal_name ?? '', business_type: cur.business_type, slug: cur.slug };
    const patch: TenantPatch = {};
    for (const key of ['name', 'name_ar', 'legal_name', 'business_type', 'slug'] as const) {
      const value = key === 'slug' ? values[key].trim().toLowerCase() : values[key].trim();
      if (value !== before[key]) patch[key] = value;
    }
    if (!Object.keys(patch).length) return;
    await this.run(() => this.api.updateTenant(this.id(), patch), t('common.saved'));
  }

  async addUser(): Promise<void> {
    const d = this.d();
    if (!d) return;
    const r = await this.members.access({ roles: d.roles, branches: d.branches, member: null, canOwner: this.api.isAdmin() && !this.hasOwner() });
    if (!r) return;
    try {
      const res = await this.api.addMember(this.id(), r.email, r.access, r.owner);
      if (res.invitation) await this.members.showInvitation(res.invitation, this.businessName());
      else this.toast.success(this.i18n.t('admin.userAdded', { email: res.email }));
      await this.load();
    } catch (err) {
      this.toast.error(err);
    }
  }

  async editUser(m: TenantMember): Promise<void> {
    const d = this.d();
    if (!d) return;
    const r = await this.members.access({ roles: d.roles, branches: d.branches, member: m, canOwner: false });
    if (!r) return;
    await this.run(() => this.api.updateMember(m.membership_id, r.access), this.i18n.t('common.saved'));
  }

  async toggleUser(m: TenantMember): Promise<void> {
    const suspend = m.status === 'active';
    if (suspend) {
      const ok = await this.confirm.ask({
        title: this.i18n.t('team.suspend'),
        message: this.i18n.t('team.confirmSuspend', { name: m.full_name || m.email }),
        confirmLabel: this.i18n.t('team.suspend'),
        danger: true,
      });
      if (!ok) return;
    }
    await this.run(() => this.api.setMemberStatus(m.membership_id, suspend ? 'suspended' : 'active'));
  }

  async makeOwner(m: TenantMember): Promise<void> {
    const ok = await this.confirm.ask({
      title: this.i18n.t('admin.makeOwner'),
      message: this.i18n.t('admin.makeOwnerLine', { name: m.full_name || m.email }),
      confirmLabel: this.i18n.t('admin.makeOwner'),
      danger: true,
    });
    if (!ok) return;
    await this.run(() => this.api.transferOwnership(this.id(), m.membership_id), this.i18n.t('common.saved'));
  }

  async resetPassword(m: TenantMember): Promise<void> {
    const ok = await this.confirm.ask({
      title: this.i18n.t('admin.resetPassword'),
      message: this.i18n.t('admin.resetPasswordLine', { email: m.email }),
      confirmLabel: this.i18n.t('admin.resetPassword'),
    });
    if (!ok) return;
    try {
      await this.auth.sendPasswordReset(m.email);
      this.toast.success(this.i18n.t('admin.resetSent'));
    } catch (err) {
      this.toast.error(err);
    }
  }

  async revokeInvite(invitationId: string): Promise<void> {
    await this.run(() => this.api.revokeInvitation(invitationId));
  }

  async extendTrial(): Promise<void> {
    const t = this.i18n.t.bind(this.i18n);
    const values = await this.form.open({
      title: t('admin.extendTrial'),
      submitLabel: t('admin.extend'),
      fields: [{ key: 'days', label: t('admin.days'), type: 'number', value: '7', required: true, hint: t('admin.daysHint') }],
    });
    if (!values) return;
    await this.run(() => this.api.extendTrial(this.id(), Number(values['days'])), t('common.saved'));
  }

  async assignPlan(): Promise<void> {
    const t = this.i18n.t.bind(this.i18n);
    const s = this.d()?.subscription;
    const values = await this.form.open({
      title: t('admin.assignPlan'),
      message: t('admin.assignPlanLine'),
      submitLabel: t('admin.assign'),
      fields: [
        { key: 'plan', label: t('billing.plan'), type: 'select', options: this.planOptions(), value: s?.plan_code },
        { key: 'cycle', label: t('admin.cycle'), type: 'select', options: this.cycleOptions(), value: s?.billing_cycle },
        { key: 'end', label: t('admin.periodEnd'), type: 'date', hint: t('admin.periodEndHint'), required: s?.status !== 'trialing' },
      ],
    });
    if (!values) return;
    const end = values['end'] ? new Date(values['end'] + 'T23:59:00').toISOString() : null;
    await this.run(() => this.api.assignPlan(this.id(), values['plan'], values['cycle'] as Cycle, end), t('common.saved'));
  }

  async createInvoice(): Promise<void> {
    const t = this.i18n.t.bind(this.i18n);
    const s = this.d()?.subscription;
    const values = await this.form.open({
      title: t('admin.createInvoice'),
      message: t('admin.createInvoiceLine'),
      submitLabel: t('admin.issue'),
      fields: [
        { key: 'plan', label: t('billing.plan'), type: 'select', options: this.planOptions(), value: s?.plan_code },
        { key: 'cycle', label: t('admin.cycle'), type: 'select', options: this.cycleOptions(), value: s?.billing_cycle },
        {
          key: 'kind', label: t('admin.invoiceKind'), type: 'select', value: s?.status === 'trialing' || !s ? 'new' : 'renewal',
          options: (['new', 'renewal', 'change'] as const).map((k) => ({ value: k, label: this.i18n.tx('admin.kind.' + k) })),
        },
      ],
    });
    if (!values) return;
    await this.run(async () => {
      const r = await this.api.createInvoice(this.id(), values['plan'], values['cycle'] as Cycle, values['kind']);
      this.toast.success(t('admin.issuedToast', { number: r.number }));
    });
  }

  async setModule(code: string, state: ModuleState): Promise<void> {
    await this.run(() => this.api.setModule(this.id(), code, state === 'plan' ? null : state === 'on', null));
  }

  async pay(inv: SubscriptionInvoice): Promise<void> {
    if (await this.invoices.recordPayment(inv)) await this.load();
  }

  async voidInv(inv: SubscriptionInvoice): Promise<void> {
    if (await this.invoices.void(inv)) await this.load();
  }
}

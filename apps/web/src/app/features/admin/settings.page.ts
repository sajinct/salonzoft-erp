import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { LucideDynamicIcon } from '@lucide/angular';
import { AuthService } from '../../core/auth/auth.service';
import { I18nService, TranslateDynamicPipe, TranslatePipe } from '../../core/i18n/i18n.service';
import { ToastService } from '../../core/services/toast.service';
import { ConfirmService, PageHeader, StatePanel } from '../../shared/components/ui';
import { AdminRole, AdminService, BillingSettings, PlatformAdmin } from './data/admin.service';
import { FormDialogService } from './form-dialog';

const ROLES: AdminRole[] = ['admin', 'billing', 'support'];

@Component({
  selector: 'sz-admin-settings-page',
  imports: [TranslatePipe, TranslateDynamicPipe, LucideDynamicIcon, PageHeader, StatePanel],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <sz-page-header [heading]="'admin.nav.settings' | t" />
    @if (loading()) {
      <div class="card"><sz-state [loading]="true" /></div>
    } @else {
      <div class="grid gap-5 lg:grid-cols-2">
        <section class="card p-5">
          <h2 class="font-semibold">{{ 'admin.billingSettings' | t }}</h2>
          <p class="mb-4 text-sm text-muted">{{ 'admin.billingSettingsHint' | t }}</p>
          <div class="space-y-3 text-sm">
            <div class="field"><label class="label" for="sc">{{ 'admin.company' | t }}</label><input id="sc" class="input" [disabled]="!api.isAdmin()" [value]="s()['billing_company']" (input)="set('billing_company', $any($event.target).value)" /></div>
            <div class="grid gap-3 sm:grid-cols-3">
              <div class="field"><label class="label" for="sv">{{ 'billing.vatNo' | t }}</label><input id="sv" class="input" dir="ltr" [disabled]="!api.isAdmin()" [value]="s()['billing_vat_number']" (input)="set('billing_vat_number', $any($event.target).value)" /></div>
              <div class="field"><label class="label" for="sr">{{ 'admin.vatRate' | t }}</label><input id="sr" class="input num" type="number" min="0" max="99" step="0.01" dir="ltr" [disabled]="!api.isAdmin()" [value]="s()['billing_vat_rate']" (input)="set('billing_vat_rate', $any($event.target).value)" /></div>
              <div class="field"><label class="label" for="sd">{{ 'admin.suspendAfter' | t }}</label><input id="sd" class="input num" type="number" min="1" max="90" dir="ltr" [disabled]="!api.isAdmin()" [value]="s()['billing_suspend_after_days']" (input)="set('billing_suspend_after_days', $any($event.target).value)" /></div>
            </div>
            <div class="field"><label class="label" for="sb">{{ 'admin.bankDetails' | t }}</label>
              <textarea id="sb" class="input" rows="4" [disabled]="!api.isAdmin()" [value]="s()['billing_bank_details']" (input)="set('billing_bank_details', $any($event.target).value)"></textarea>
              <p class="hint">{{ 'admin.bankDetailsHint' | t }}</p></div>
            @if (api.isAdmin()) { <button type="button" class="btn-primary" [disabled]="busy()" (click)="saveSettings()">{{ 'common.save' | t }}</button> }
          </div>
        </section>

        <section class="card p-5">
          <div class="mb-3 flex items-center justify-between gap-2">
            <h2 class="font-semibold">{{ 'admin.admins' | t }}</h2>
            @if (api.isAdmin()) { <button type="button" class="btn-secondary btn-sm" (click)="addAdmin()"><svg lucideIcon="user-plus" [size]="15"></svg>{{ 'admin.addAdmin' | t }}</button> }
          </div>
          <ul class="divide-y divide-line text-sm">
            @for (a of admins(); track a.user_id) {
              <li class="flex items-center justify-between gap-3 py-2">
                <div class="min-w-0"><p class="truncate font-medium">{{ a.full_name || a.email }}</p><p class="truncate text-xs text-muted" dir="ltr">{{ a.email }}</p></div>
                @if (api.isAdmin() && a.user_id !== me()) {
                  <div class="flex shrink-0 items-center gap-1">
                    <select class="input h-8 w-32 text-xs" [value]="a.role" (change)="setRole(a, $any($event.target).value)" [attr.aria-label]="'admin.roleLabel' | t">
                      @for (r of roles; track r) { <option [value]="r" [selected]="r === a.role">{{ 'admin.role.' + r | tx }}</option> }
                    </select>
                    <button type="button" class="btn-icon text-danger" (click)="remove(a)" [attr.aria-label]="'common.remove' | t"><svg lucideIcon="trash-2" [size]="16"></svg></button>
                  </div>
                } @else {
                  <span class="badge-muted">{{ 'admin.role.' + a.role | tx }}</span>
                }
              </li>
            }
          </ul>
          <p class="hint mt-3">{{ 'admin.rolesHint' | t }}</p>
        </section>
      </div>
    }
  `,
})
export class AdminSettingsPage {
  protected readonly i18n = inject(I18nService);
  protected readonly api = inject(AdminService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  private readonly form = inject(FormDialogService);
  private readonly confirm = inject(ConfirmService);

  protected readonly roles = ROLES;
  protected readonly loading = signal(true);
  protected readonly busy = signal(false);
  protected readonly s = signal<BillingSettings>({ billing_company: '', billing_vat_number: '', billing_vat_rate: '', billing_bank_details: '', billing_suspend_after_days: '' });
  protected readonly admins = signal<PlatformAdmin[]>([]);
  protected readonly me = () => this.auth.user()?.id;

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const [s, admins] = await Promise.all([this.api.settings(), this.api.admins()]);
      this.s.set({ ...this.s(), ...s });
      this.admins.set(admins);
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.loading.set(false);
    }
  }

  protected set(key: keyof BillingSettings, value: string): void {
    this.s.update((s) => ({ ...s, [key]: value }));
  }

  async saveSettings(): Promise<void> {
    this.busy.set(true);
    try {
      await this.api.saveSettings(this.s());
      this.toast.success(this.i18n.t('common.saved'));
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.busy.set(false);
    }
  }

  async addAdmin(): Promise<void> {
    const t = this.i18n.t.bind(this.i18n);
    const values = await this.form.open({
      title: t('admin.addAdmin'),
      message: t('admin.addAdminLine'),
      submitLabel: t('admin.addAdmin'),
      fields: [
        { key: 'email', label: t('auth.email'), type: 'email', required: true },
        { key: 'role', label: t('admin.roleLabel'), type: 'select', value: 'support', options: ROLES.map((r) => ({ value: r, label: this.i18n.tx('admin.role.' + r) })) },
      ],
    });
    if (!values) return;
    await this.change(values['email'].trim(), values['role'] as AdminRole);
  }

  async setRole(a: PlatformAdmin, role: AdminRole): Promise<void> {
    await this.change(a.email, role);
  }

  async remove(a: PlatformAdmin): Promise<void> {
    const ok = await this.confirm.ask({
      title: this.i18n.t('admin.removeAdmin'),
      message: this.i18n.t('admin.removeAdminLine', { email: a.email }),
      confirmLabel: this.i18n.t('common.remove'),
      danger: true,
    });
    if (ok) await this.change(a.email, null);
  }

  private async change(email: string, role: AdminRole | null): Promise<void> {
    try {
      await this.api.setAdmin(email, role);
      this.admins.set(await this.api.admins());
      this.toast.success(this.i18n.t('common.saved'));
    } catch (err) {
      this.toast.error(err);
    }
  }
}

import { Clipboard } from '@angular/cdk/clipboard';
import { Dialog, DialogRef, DIALOG_DATA } from '@angular/cdk/dialog';
import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { LucideDynamicIcon } from '@lucide/angular';
import { AuthService } from '../../core/auth/auth.service';
import { I18nService, TranslatePipe } from '../../core/i18n/i18n.service';
import { ToastService } from '../../core/services/toast.service';
import { TenantContextService } from '../../core/tenant/tenant-context.service';
import { ConfirmService, PageHeader, StatePanel } from '../../shared/components/ui';
import { LocalDatePipe } from '../../shared/pipes/format.pipes';
import { Role, RolesService } from './data/settings.services';
import { CreatedInvitation, Invitation, TeamMember, TeamService } from './data/team.service';

interface AccessDialogData {
  roles: Role[];
  member: TeamMember | null; // null = new invitation
}

/** Invite a member, or edit an existing member's roles & branch access. */
@Component({
  selector: 'sz-access-dialog',
  imports: [ReactiveFormsModule, TranslatePipe, LucideDynamicIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="card flex max-h-[90vh] w-[min(36rem,calc(100vw-2rem))] flex-col" role="dialog" aria-modal="true">
      <header class="flex items-center justify-between border-b border-line px-6 py-4">
        <h2 class="text-lg font-semibold">{{ (data.member ? 'team.editAccess' : 'team.inviteTitle') | t }}</h2>
        <button type="button" class="btn-icon" (click)="ref.close()" [attr.aria-label]="'common.close' | t"><svg lucideIcon="x" [size]="18"></svg></button>
      </header>

      @if (created(); as inv) {
        <div class="space-y-4 px-6 py-5">
          <p class="flex items-center gap-2 font-semibold text-success"><svg lucideIcon="circle-check" [size]="18"></svg>{{ 'team.inviteCreated' | t }}</p>
          <p class="text-sm text-muted">{{ 'team.inviteShare' | t: { email: inv.email } }}</p>
          <div class="flex gap-2" dir="ltr">
            <input class="input font-mono text-xs" [value]="inv.url" readonly (focus)="$any($event.target).select()" />
            <button type="button" class="btn-secondary shrink-0" (click)="copy(inv.url)"><svg lucideIcon="copy" [size]="16"></svg>{{ 'common.copy' | t }}</button>
          </div>
          <div class="flex flex-wrap gap-2">
            <a class="btn-secondary btn-sm" [href]="whatsAppLink()" target="_blank" rel="noopener"><svg lucideIcon="message-circle" [size]="14"></svg>{{ 'team.shareWhatsApp' | t }}</a>
            <a class="btn-secondary btn-sm" [href]="mailLink()"><svg lucideIcon="mail" [size]="14"></svg>{{ 'team.shareEmail' | t }}</a>
          </div>
          <div class="flex justify-end"><button type="button" class="btn-primary" (click)="ref.close(true)">{{ 'common.close' | t }}</button></div>
        </div>
      } @else {
        <form [formGroup]="form" (ngSubmit)="submit()" class="flex min-h-0 flex-1 flex-col" novalidate>
          <div class="flex-1 space-y-5 overflow-y-auto px-6 py-5">
            @if (!data.member) {
              <div class="field">
                <label class="label" for="email">{{ 'team.inviteEmail' | t }}</label>
                <input id="email" class="input" type="email" formControlName="email" dir="ltr" autocomplete="off" />
              </div>
            } @else {
              <div class="field">
                <label class="label" for="job">{{ 'team.jobTitle' | t }}</label>
                <input id="job" class="input" formControlName="jobTitle" maxlength="80" />
              </div>
            }

            <fieldset>
              <legend class="label mb-2">{{ 'team.selectRoles' | t }}</legend>
              <div class="grid gap-2 sm:grid-cols-2">
                @for (role of data.roles; track role.id) {
                  <label class="flex cursor-pointer items-center gap-2 rounded-xl border border-line px-3 py-2 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary-soft">
                    <input type="checkbox" class="checkbox" [checked]="roleIds().includes(role.id)" (change)="toggle(roleIds, role.id)" />
                    {{ i18n.pick(role.name_en, role.name_ar) }}
                  </label>
                }
              </div>
            </fieldset>

            <fieldset>
              <legend class="label mb-2">{{ 'team.selectBranches' | t }}</legend>
              @if (canGrantAllBranches()) {
                <label class="mb-2 flex items-center gap-2 text-sm"><input type="checkbox" class="checkbox" formControlName="allBranches" />{{ 'team.allBranches' | t }}</label>
              }
              @if (!form.controls.allBranches.value) {
                <div class="grid gap-2 sm:grid-cols-2">
                  @for (b of ctx.branches(); track b.id) {
                    <label class="flex cursor-pointer items-center gap-2 rounded-xl border border-line px-3 py-2 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary-soft">
                      <input type="checkbox" class="checkbox" [checked]="branchIds().includes(b.id)" (change)="toggle(branchIds, b.id)" />
                      {{ i18n.pick(b.name_en, b.name_ar) }}
                    </label>
                  }
                </div>
              }
            </fieldset>
          </div>
          <footer class="flex justify-end gap-2 border-t border-line px-6 py-4">
            <button type="button" class="btn-secondary" (click)="ref.close()">{{ 'common.cancel' | t }}</button>
            <button type="submit" class="btn-primary" [disabled]="busy()">{{ (data.member ? 'common.save' : 'team.sendInvite') | t }}</button>
          </footer>
        </form>
      }
    </div>
  `,
})
export class AccessDialog {
  protected readonly ref = inject<DialogRef<boolean>>(DialogRef);
  protected readonly data = inject<AccessDialogData>(DIALOG_DATA);
  protected readonly ctx = inject(TenantContextService);
  protected readonly i18n = inject(I18nService);
  private readonly team = inject(TeamService);
  private readonly toast = inject(ToastService);
  private readonly clipboard = inject(Clipboard);

  protected readonly busy = signal(false);
  protected readonly created = signal<CreatedInvitation | null>(null);
  protected readonly roleIds = signal<string[]>(this.data.member?.role_ids ?? []);
  protected readonly branchIds = signal<string[]>(
    this.data.member?.branch_ids ?? (this.ctx.branchId() ? [this.ctx.branchId()!] : []),
  );
  protected readonly canGrantAllBranches = computed(() => {
    const m = this.ctx.context()?.membership;
    return !!m && (m.is_owner || m.all_branches);
  });

  protected readonly form = inject(NonNullableFormBuilder).group({
    email: ['', this.data.member ? [] : [Validators.required, Validators.email]],
    jobTitle: [this.data.member?.job_title ?? ''],
    allBranches: [this.data.member?.all_branches ?? false],
  });

  protected readonly whatsAppLink = computed(() => `https://wa.me/?text=${encodeURIComponent(this.shareText())}`);
  protected readonly mailLink = computed(() => {
    const inv = this.created();
    return inv ? `mailto:${inv.email}?subject=${encodeURIComponent('Salonzoft')}&body=${encodeURIComponent(this.shareText())}` : '';
  });

  private shareText(): string {
    const inv = this.created();
    const t = this.ctx.context()?.tenant;
    return inv ? this.i18n.t('team.inviteMessage', { business: t ? this.i18n.pick(t.name, t.name_ar) : '', url: inv.url }) : '';
  }

  protected toggle(list: ReturnType<typeof signal<string[]>>, id: string): void {
    list.update((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  }

  protected copy(text: string): void {
    if (this.clipboard.copy(text)) this.toast.success(this.i18n.t('common.copied'));
  }

  async submit(): Promise<void> {
    const tenantId = this.ctx.tenantId();
    if (!tenantId || this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const v = this.form.getRawValue();
    this.busy.set(true);
    try {
      if (this.data.member) {
        await this.team.updateAccess(this.data.member.membership_id, {
          roleIds: this.roleIds(),
          allBranches: v.allBranches,
          branchIds: this.branchIds(),
          jobTitle: v.jobTitle.trim() || null,
        });
        this.toast.success(this.i18n.t('common.saved'));
        this.ref.close(true);
      } else {
        this.created.set(
          await this.team.invite(tenantId, {
            email: v.email.trim().toLowerCase(),
            roleIds: this.roleIds(),
            allBranches: v.allBranches,
            branchIds: this.branchIds(),
          }),
        );
      }
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.busy.set(false);
    }
  }
}

@Component({
  selector: 'sz-team-page',
  imports: [TranslatePipe, LucideDynamicIcon, PageHeader, StatePanel, LocalDatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <sz-page-header [heading]="'settings.team' | t" [subtitle]="'team.subtitle' | t">
      @if (canManage()) {
        <button type="button" class="btn-primary" (click)="openInvite()"><svg lucideIcon="plus" [size]="16"></svg>{{ 'team.invite' | t }}</button>
      }
    </sz-page-header>
    @if (maxStaff(); as max) {
      <p class="mb-4 text-xs text-muted">{{ 'team.seats' | t: { used: members().length + invitations().length, max } }}</p>
    }

    @if (loading()) {
      <div class="card"><sz-state [loading]="true" /></div>
    } @else {
      <div class="card overflow-x-auto">
        <table class="table">
          <thead>
            <tr><th>{{ 'team.member' | t }}</th><th>{{ 'team.roles' | t }}</th><th>{{ 'team.branches' | t }}</th><th>{{ 'team.status' | t }}</th><th></th></tr>
          </thead>
          <tbody>
            @for (m of members(); track m.membership_id) {
              <tr>
                <td>
                  <p class="font-medium">{{ m.full_name || m.email }}
                    @if (m.user_id === auth.user()?.id) { <span class="badge-muted ms-1">{{ 'team.you' | t }}</span> }
                  </p>
                  <p class="text-xs text-muted" dir="ltr">{{ m.email }}</p>
                  @if (m.job_title) { <p class="text-xs text-muted">{{ m.job_title }}</p> }
                </td>
                <td>
                  @if (m.is_owner) {
                    <span class="badge-primary">{{ 'team.owner' | t }}</span>
                  } @else {
                    <div class="flex flex-wrap gap-1">
                      @for (rid of m.role_ids; track rid) { <span class="badge-muted">{{ roleName(rid) }}</span> }
                    </div>
                  }
                </td>
                <td class="text-sm">{{ m.is_owner || m.all_branches ? ('shell.allBranches' | t) : branchNames(m.branch_ids) }}</td>
                <td>
                  <span [class]="m.status === 'active' ? 'badge-success' : 'badge-warning'">{{ (m.status === 'active' ? 'common.active' : 'team.suspended') | t }}</span>
                </td>
                <td class="text-end whitespace-nowrap">
                  @if (canManage() && !m.is_owner && m.user_id !== auth.user()?.id) {
                    <button type="button" class="btn-ghost btn-sm" (click)="openEdit(m)">{{ 'team.editAccess' | t }}</button>
                    <button type="button" class="btn-ghost btn-sm" (click)="toggleStatus(m)">{{ (m.status === 'active' ? 'team.suspend' : 'team.reactivate') | t }}</button>
                  }
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>

      @if (canManage() && invitations().length) {
        <h2 class="mb-3 mt-8 text-base font-semibold">{{ 'team.pending' | t }}</h2>
        <div class="card divide-y divide-line">
          @for (inv of invitations(); track inv.id) {
            <div class="flex items-center gap-3 px-4 py-3">
              <svg lucideIcon="mail" [size]="16" class="text-muted"></svg>
              <span class="flex-1 text-sm" dir="ltr">{{ inv.email }}</span>
              <span class="text-xs text-muted">{{ 'team.expires' | t: { date: (inv.expires_at | localDate) } }}</span>
              <button type="button" class="btn-ghost btn-sm text-danger" (click)="revoke(inv)">{{ 'team.revoke' | t }}</button>
            </div>
          }
        </div>
      }
    }
  `,
})
export class TeamPage implements OnInit {
  private readonly team = inject(TeamService);
  private readonly rolesService = inject(RolesService);
  private readonly ctx = inject(TenantContextService);
  private readonly dialog = inject(Dialog);
  private readonly toast = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  protected readonly auth = inject(AuthService);
  protected readonly i18n = inject(I18nService);

  protected readonly loading = signal(true);
  protected readonly members = signal<TeamMember[]>([]);
  protected readonly invitations = signal<Invitation[]>([]);
  protected readonly roles = signal<Role[]>([]);
  protected readonly canManage = computed(() => this.ctx.can('team.manage'));
  protected readonly maxStaff = computed(() => this.ctx.context()?.subscription?.max_staff ?? null);

  ngOnInit(): void {
    void this.load();
  }

  async load(): Promise<void> {
    const tenantId = this.ctx.tenantId();
    if (!tenantId) return;
    try {
      const [members, invitations, roles] = await Promise.all([
        this.team.listMembers(tenantId),
        this.canManage() ? this.team.listPendingInvitations(tenantId) : Promise.resolve([]),
        this.rolesService.load(tenantId).then((r) => r.roles),
      ]);
      this.members.set(members);
      this.invitations.set(invitations);
      this.roles.set(roles);
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.loading.set(false);
    }
  }

  protected roleName(id: string): string {
    const role = this.roles().find((r) => r.id === id);
    return role ? this.i18n.pick(role.name_en, role.name_ar) : '…';
  }

  protected branchNames(ids: string[]): string {
    return (
      ids
        .map((id) => this.ctx.branches().find((b) => b.id === id))
        .filter((b) => !!b)
        .map((b) => this.i18n.pick(b!.name_en, b!.name_ar))
        .join(', ') || '—'
    );
  }

  openInvite(): void {
    this.openDialog(null);
  }

  openEdit(member: TeamMember): void {
    this.openDialog(member);
  }

  private openDialog(member: TeamMember | null): void {
    const ref = this.dialog.open<boolean, AccessDialogData>(AccessDialog, { data: { roles: this.roles(), member } });
    ref.closed.subscribe(() => void this.load());
  }

  async toggleStatus(member: TeamMember): Promise<void> {
    const suspend = member.status === 'active';
    if (suspend) {
      const ok = await this.confirm.ask({
        title: this.i18n.t('team.suspend'),
        message: this.i18n.t('team.confirmSuspend', { name: member.full_name || member.email }),
        confirmLabel: this.i18n.t('team.suspend'),
        danger: true,
      });
      if (!ok) return;
    }
    try {
      await this.team.setStatus(member.membership_id, suspend ? 'suspended' : 'active');
      await this.load();
    } catch (err) {
      this.toast.error(err);
    }
  }

  async revoke(inv: Invitation): Promise<void> {
    try {
      await this.team.revokeInvitation(inv.id);
      await this.load();
    } catch (err) {
      this.toast.error(err);
    }
  }
}

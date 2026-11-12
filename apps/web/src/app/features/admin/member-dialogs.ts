import { Clipboard } from '@angular/cdk/clipboard';
import { Dialog, DialogRef, DIALOG_DATA } from '@angular/cdk/dialog';
import { ChangeDetectionStrategy, Component, Injectable, computed, inject, signal } from '@angular/core';
import { LucideDynamicIcon } from '@lucide/angular';
import { firstValueFrom } from 'rxjs';
import { I18nService, TranslatePipe } from '../../core/i18n/i18n.service';
import { ToastService } from '../../core/services/toast.service';
import { AdminInvitation, MemberAccessInput, TenantBranch, TenantMember, TenantRole } from './data/admin.service';

export interface MemberDialogData {
  roles: TenantRole[];
  branches: TenantBranch[];
  /** null = add a new user. */
  member: TenantMember | null;
  /** Offer "make this person the owner" (business without an owner, administrators only). */
  canOwner: boolean;
}

export interface MemberDialogResult {
  email: string;
  owner: boolean;
  access: MemberAccessInput;
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Add a user to a business, or edit a user's roles and branch access. Resolves with the values or null. */
@Component({
  selector: 'sz-admin-member-dialog',
  imports: [TranslatePipe, LucideDynamicIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form class="card flex max-h-[90vh] w-[min(36rem,calc(100vw-2rem))] flex-col" role="dialog" aria-modal="true" (submit)="$event.preventDefault(); submit()">
      <header class="flex items-center justify-between border-b border-line px-6 py-4">
        <h2 class="text-lg font-semibold">{{ (data.member ? 'team.editAccess' : 'admin.addUser') | t }}</h2>
        <button type="button" class="btn-icon" (click)="ref.close(null)" [attr.aria-label]="'common.close' | t"><svg lucideIcon="x" [size]="18"></svg></button>
      </header>
      <div class="flex-1 space-y-5 overflow-y-auto px-6 py-5 text-sm">
        @if (data.member; as m) {
          <p class="text-muted" dir="ltr">{{ m.email }}</p>
        } @else {
          <p class="text-muted">{{ 'admin.addUserLine' | t }}</p>
          <div class="field">
            <label class="label" for="am-email">{{ 'team.inviteEmail' | t }}</label>
            <input id="am-email" class="input" type="email" dir="ltr" autocomplete="off" [value]="email()" (input)="email.set($any($event.target).value)" />
          </div>
          @if (data.canOwner) {
            <label class="flex items-center gap-2"><input type="checkbox" class="checkbox" [checked]="owner()" (change)="owner.set($any($event.target).checked)" />{{ 'admin.makeOwnerCheck' | t }}</label>
          }
        }
        @if (!owner()) {
          <div class="field">
            <label class="label" for="am-job">{{ 'team.jobTitle' | t }}</label>
            <input id="am-job" class="input" maxlength="80" [value]="jobTitle()" (input)="jobTitle.set($any($event.target).value)" />
          </div>
          <fieldset>
            <legend class="label mb-2">{{ 'team.selectRoles' | t }}</legend>
            <div class="grid gap-2 sm:grid-cols-2">
              @for (role of data.roles; track role.id) {
                <label class="flex cursor-pointer items-center gap-2 rounded-xl border border-line px-3 py-2 has-[:checked]:border-primary has-[:checked]:bg-primary-soft">
                  <input type="checkbox" class="checkbox" [checked]="roleIds().includes(role.id)" (change)="toggle(roleIds, role.id)" />
                  {{ i18n.pick(role.name_en, role.name_ar) }}
                </label>
              }
            </div>
          </fieldset>
          <fieldset>
            <legend class="label mb-2">{{ 'team.selectBranches' | t }}</legend>
            <label class="mb-2 flex items-center gap-2"><input type="checkbox" class="checkbox" [checked]="allBranches()" (change)="allBranches.set($any($event.target).checked)" />{{ 'team.allBranches' | t }}</label>
            @if (!allBranches()) {
              <div class="grid gap-2 sm:grid-cols-2">
                @for (b of data.branches; track b.id) {
                  <label class="flex cursor-pointer items-center gap-2 rounded-xl border border-line px-3 py-2 has-[:checked]:border-primary has-[:checked]:bg-primary-soft">
                    <input type="checkbox" class="checkbox" [checked]="branchIds().includes(b.id)" (change)="toggle(branchIds, b.id)" />
                    {{ i18n.pick(b.name_en, b.name_ar) }}
                  </label>
                }
              </div>
            }
          </fieldset>
        }
      </div>
      <footer class="flex justify-end gap-2 border-t border-line px-6 py-4">
        <button type="button" class="btn-secondary" (click)="ref.close(null)">{{ 'common.cancel' | t }}</button>
        <button type="submit" class="btn-primary" [disabled]="!valid()">{{ (data.member ? 'common.save' : 'admin.addUser') | t }}</button>
      </footer>
    </form>
  `,
})
export class AdminMemberDialog {
  protected readonly data = inject<MemberDialogData>(DIALOG_DATA);
  protected readonly ref = inject<DialogRef<MemberDialogResult | null>>(DialogRef);
  protected readonly i18n = inject(I18nService);

  protected readonly email = signal('');
  protected readonly owner = signal(false);
  protected readonly jobTitle = signal(this.data.member?.job_title ?? '');
  protected readonly roleIds = signal<string[]>(this.data.member?.role_ids ?? []);
  protected readonly allBranches = signal(this.data.member?.all_branches ?? this.data.branches.length <= 1);
  protected readonly branchIds = signal<string[]>(
    this.data.member?.branch_ids ?? this.data.branches.filter((b) => b.is_main).map((b) => b.id),
  );

  protected readonly valid = computed(
    () => (!!this.data.member || EMAIL.test(this.email().trim())) && (this.owner() || this.allBranches() || this.branchIds().length > 0),
  );

  protected toggle(list: ReturnType<typeof signal<string[]>>, id: string): void {
    list.update((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  }

  protected submit(): void {
    if (!this.valid()) return;
    this.ref.close({
      email: this.email().trim().toLowerCase(),
      owner: this.owner(),
      access: {
        roleIds: this.owner() ? [] : this.roleIds(),
        allBranches: this.owner() || this.allBranches(),
        branchIds: this.branchIds(),
        jobTitle: this.jobTitle().trim() || null,
      },
    });
  }
}

interface InviteLinkData {
  invitation: AdminInvitation;
  business: string;
}

/** Shows the one-time invitation link (it cannot be retrieved again). */
@Component({
  selector: 'sz-admin-invite-link-dialog',
  imports: [TranslatePipe, LucideDynamicIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="card w-[min(32rem,calc(100vw-2rem))]" role="dialog" aria-modal="true">
      <header class="flex items-center justify-between border-b border-line px-6 py-4">
        <h2 class="text-lg font-semibold">{{ 'admin.inviteLinkTitle' | t }}</h2>
        <button type="button" class="btn-icon" (click)="ref.close()" [attr.aria-label]="'common.close' | t"><svg lucideIcon="x" [size]="18"></svg></button>
      </header>
      <div class="space-y-4 px-6 py-5">
        <p class="flex items-center gap-2 font-semibold text-success"><svg lucideIcon="circle-check" [size]="18"></svg>{{ 'team.inviteCreated' | t }}</p>
        <p class="text-sm text-muted">{{ 'team.inviteShare' | t: { email: data.invitation.email } }}</p>
        <div class="flex gap-2" dir="ltr">
          <input class="input font-mono text-xs" [value]="data.invitation.url" readonly (focus)="$any($event.target).select()" />
          <button type="button" class="btn-secondary shrink-0" (click)="copy()"><svg lucideIcon="copy" [size]="16"></svg>{{ 'common.copy' | t }}</button>
        </div>
        <div class="flex flex-wrap gap-2">
          <a class="btn-secondary btn-sm" [href]="whatsAppLink" target="_blank" rel="noopener"><svg lucideIcon="message-circle" [size]="14"></svg>{{ 'team.shareWhatsApp' | t }}</a>
          <a class="btn-secondary btn-sm" [href]="mailLink"><svg lucideIcon="mail" [size]="14"></svg>{{ 'team.shareEmail' | t }}</a>
        </div>
        <div class="flex justify-end"><button type="button" class="btn-primary" (click)="ref.close()">{{ 'common.close' | t }}</button></div>
      </div>
    </div>
  `,
})
export class AdminInviteLinkDialog {
  protected readonly data = inject<InviteLinkData>(DIALOG_DATA);
  protected readonly ref = inject<DialogRef<void>>(DialogRef);
  private readonly i18n = inject(I18nService);
  private readonly toast = inject(ToastService);
  private readonly clipboard = inject(Clipboard);

  private readonly text = this.i18n.t('team.inviteMessage', { business: this.data.business, url: this.data.invitation.url });
  protected readonly whatsAppLink = `https://wa.me/?text=${encodeURIComponent(this.text)}`;
  protected readonly mailLink = `mailto:${this.data.invitation.email}?subject=${encodeURIComponent('Salonzoft')}&body=${encodeURIComponent(this.text)}`;

  protected copy(): void {
    if (this.clipboard.copy(this.data.invitation.url)) this.toast.success(this.i18n.t('common.copied'));
  }
}

@Injectable({ providedIn: 'root' })
export class MemberDialogs {
  private readonly dialog = inject(Dialog);

  async access(data: MemberDialogData): Promise<MemberDialogResult | null> {
    const ref = this.dialog.open<MemberDialogResult | null, MemberDialogData>(AdminMemberDialog, { data });
    return (await firstValueFrom(ref.closed)) ?? null;
  }

  /** Resolves when the admin closes the link dialog. */
  async showInvitation(invitation: AdminInvitation, business: string): Promise<void> {
    const ref = this.dialog.open<void, InviteLinkData>(AdminInviteLinkDialog, { data: { invitation, business }, disableClose: true });
    await firstValueFrom(ref.closed, { defaultValue: undefined });
  }
}

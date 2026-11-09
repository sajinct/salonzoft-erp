import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { I18nService, TranslatePipe } from '../../core/i18n/i18n.service';
import { ToastService } from '../../core/services/toast.service';
import { TenantContextService } from '../../core/tenant/tenant-context.service';
import { StatePanel } from '../../shared/components/ui';
import { TeamService } from '../settings/data/team.service';

@Component({
  selector: 'sz-accept-invite-page',
  imports: [RouterLink, TranslatePipe, StatePanel],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="page-title">{{ 'invite.title' | t }}</h1>
    @if (!token()) {
      <sz-state icon="circle-alert" [message]="'invite.missingToken' | t" />
    } @else if (!auth.isSignedIn()) {
      <p class="mt-2 text-sm text-muted">{{ 'invite.signInPrompt' | t }}</p>
      <div class="mt-8 flex flex-col gap-3">
        <a class="btn-primary" routerLink="/auth/login" [queryParams]="{ next: returnUrl() }">{{ 'auth.signIn' | t }}</a>
        <a class="btn-secondary" routerLink="/auth/signup" [queryParams]="{ next: returnUrl() }">{{ 'auth.signUp' | t }}</a>
      </div>
    } @else {
      <p class="mt-2 text-sm text-muted">{{ auth.user()?.email }}</p>
      @if (error()) {
        <p class="mt-6 rounded-xl bg-danger-soft px-3 py-2 text-sm text-danger" role="alert">{{ error() }}</p>
      }
      <button type="button" class="btn-primary mt-8 w-full" [disabled]="busy()" (click)="accept()">{{ 'invite.accept' | t }}</button>
    }
  `,
})
export class AcceptInvitePage {
  protected readonly auth = inject(AuthService);
  private readonly team = inject(TeamService);
  private readonly ctx = inject(TenantContextService);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  private readonly i18n = inject(I18nService);

  readonly token = input<string>();
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly returnUrl = computed(() => `/accept-invite?token=${encodeURIComponent(this.token() ?? '')}`);

  async accept(): Promise<void> {
    const token = this.token();
    if (!token) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const { tenant_id } = await this.team.acceptInvitation(token);
      this.ctx.clear();
      await this.ctx.loadTenants();
      await this.ctx.select(tenant_id);
      this.toast.success(this.i18n.t('invite.accepted'));
      await this.router.navigateByUrl('/');
    } catch (err) {
      this.error.set(this.toast.describe(err));
    } finally {
      this.busy.set(false);
    }
  }
}

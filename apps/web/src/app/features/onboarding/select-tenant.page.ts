import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { LucideDynamicIcon } from '@lucide/angular';
import { I18nService, TranslateDynamicPipe, TranslatePipe } from '../../core/i18n/i18n.service';
import { ToastService } from '../../core/services/toast.service';
import { TenantContextService } from '../../core/tenant/tenant-context.service';
import { StatePanel } from '../../shared/components/ui';

@Component({
  selector: 'sz-select-tenant-page',
  imports: [RouterLink, LucideDynamicIcon, TranslatePipe, TranslateDynamicPipe, StatePanel],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="page-title">{{ 'tenantSelect.title' | t }}</h1>
    <p class="mt-1 text-sm text-muted">{{ 'tenantSelect.subtitle' | t }}</p>

    @if (ctx.tenants() === null) {
      <sz-state [loading]="true" />
    } @else {
      <ul class="mt-8 space-y-2">
        @for (t of ctx.tenants(); track t.tenant_id) {
          <li>
            <button type="button" class="card flex w-full items-center gap-3 p-4 text-start hover:border-primary" [disabled]="busy()" (click)="choose(t.tenant_id)">
              <span class="grid h-10 w-10 place-items-center rounded-xl bg-primary-soft text-primary"><svg lucideIcon="store" [size]="18"></svg></span>
              <span class="min-w-0 flex-1">
                <span class="block truncate font-semibold">{{ i18n.pick(t.name, t.name_ar) }}</span>
                <span class="block text-xs text-muted" dir="ltr">salonzoft.com/book/{{ t.slug }}</span>
              </span>
              @if (t.is_owner) {
                <span class="badge-primary">{{ 'tenantSelect.owner' | t }}</span>
              }
              @if (t.subscription_status) {
                <span class="badge-muted">{{ 'subscription.' + t.subscription_status | tx }}</span>
              }
              <svg lucideIcon="chevron-right" [size]="16" class="text-muted rtl:rotate-180"></svg>
            </button>
          </li>
        }
      </ul>
      <a routerLink="/onboarding" class="btn-secondary mt-6 w-full"><svg lucideIcon="plus" [size]="16"></svg>{{ 'tenantSelect.createNew' | t }}</a>
    }
  `,
})
export class SelectTenantPage implements OnInit {
  protected readonly ctx = inject(TenantContextService);
  protected readonly i18n = inject(I18nService);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  protected readonly busy = signal(false);

  async ngOnInit(): Promise<void> {
    try {
      const tenants = await this.ctx.loadTenants();
      if (tenants.length === 0) await this.router.navigateByUrl('/onboarding');
    } catch (err) {
      this.toast.error(err);
    }
  }

  async choose(tenantId: string): Promise<void> {
    this.busy.set(true);
    try {
      this.ctx.setBranch(null);
      await this.ctx.select(tenantId);
      await this.router.navigateByUrl('/');
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.busy.set(false);
    }
  }
}

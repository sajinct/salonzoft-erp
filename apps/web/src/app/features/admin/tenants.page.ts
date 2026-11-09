import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { LucideDynamicIcon } from '@lucide/angular';
import { I18nService, TranslateDynamicPipe, TranslatePipe } from '../../core/i18n/i18n.service';
import { ToastService } from '../../core/services/toast.service';
import { PageHeader, StatePanel } from '../../shared/components/ui';
import { LocalDatePipe, MoneyPipe } from '../../shared/pipes/format.pipes';
import { AdminService, TenantFilter, TenantRow } from './data/admin.service';

const PAGE = 50;

/** Shared status badge for a business: tenant status first, then the subscription. */
export function tenantBadge(status: string, subStatus: string | null, trialEnd: string | null): { key: string; cls: string } {
  if (status !== 'active') return { key: 'admin.tenantStatus.' + status, cls: 'badge-danger' };
  if (subStatus === 'trialing' && trialEnd && new Date(trialEnd).getTime() <= Date.now()) return { key: 'subscription.expired', cls: 'badge-danger' };
  const cls = subStatus === 'active' ? 'badge-success' : subStatus === 'trialing' ? 'badge-primary' : subStatus === 'past_due' ? 'badge-warning' : 'badge-danger';
  return { key: 'subscription.' + (subStatus ?? 'expired'), cls };
}

@Component({
  selector: 'sz-admin-tenants-page',
  imports: [TranslatePipe, TranslateDynamicPipe, LucideDynamicIcon, PageHeader, StatePanel, LocalDatePipe, MoneyPipe, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <sz-page-header [heading]="'admin.nav.tenants' | t" [subtitle]="'admin.tenantsCount' | t: { n: total() }" />
    <div class="mb-4 flex flex-wrap gap-2">
      <label class="relative min-w-60 flex-1">
        <svg lucideIcon="search" [size]="16" class="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-muted"></svg>
        <input class="input ps-9" type="search" [placeholder]="'admin.searchTenants' | t" [value]="search()" (input)="onSearch($any($event.target).value)" />
      </label>
      <select class="input w-52" [value]="status()" (change)="setFilter($any($event.target).value)" [attr.aria-label]="'common.status' | t">
        @for (f of filters; track f) { <option [value]="f" [selected]="f === status()">{{ 'admin.filter.' + f | tx }}</option> }
      </select>
    </div>

    <div class="card overflow-x-auto">
      @if (loading()) {
        <sz-state [loading]="true" />
      } @else {
        <table class="table">
          <thead><tr><th>{{ 'admin.business' | t }}</th><th>{{ 'admin.owner' | t }}</th><th>{{ 'billing.plan' | t }}</th><th>{{ 'admin.until' | t }}</th><th class="text-end">{{ 'admin.size' | t }}</th><th>{{ 'admin.lastActivity' | t }}</th><th class="text-end">{{ 'admin.mrr' | t }}</th></tr></thead>
          <tbody>
            @for (r of rows(); track r.id) {
              <tr class="cursor-pointer" (click)="open(r)">
                <td><a class="font-medium hover:text-primary" [routerLink]="['/admin/tenants', r.id]" (click)="$event.stopPropagation()">{{ i18n.pick(r.name, r.name_ar) }}</a><p class="text-xs text-muted" dir="ltr">/{{ r.slug }} · {{ r.created_at | localDate }}</p></td>
                <td class="text-xs">{{ r.owner_email }}</td>
                <td>
                  @let b = badge(r);
                  <p>{{ i18n.pick(r.plan_name_en, r.plan_name_ar) }}</p><span [class]="b.cls">{{ b.key | tx }}</span>
                </td>
                <td class="text-xs">{{ (r.sub_status === 'trialing' ? r.trial_ends_at : r.current_period_end) | localDate }}@if (r.cancel_at_period_end) { <span class="text-danger"> · {{ 'admin.cancelling' | t }}</span> }</td>
                <td class="num text-end text-xs">{{ 'admin.sizeLine' | t: { branches: r.branches, staff: r.staff } }}</td>
                <td class="text-xs">{{ r.last_activity | localDate }}</td>
                <td class="num text-end">{{ r.mrr | money }}</td>
              </tr>
            } @empty {
              <tr><td colspan="7"><sz-state icon="building-2" [heading]="'admin.noTenants' | t" /></td></tr>
            }
          </tbody>
        </table>
        @if (total() > PAGE) {
          <div class="flex items-center justify-end gap-2 border-t border-line px-4 py-3 text-sm">
            <span class="text-muted">{{ offset() + 1 }}–{{ offset() + rows().length }} / {{ total() }}</span>
            <button type="button" class="btn-secondary btn-sm" [disabled]="offset() === 0" (click)="page(-1)">{{ 'admin.prev' | t }}</button>
            <button type="button" class="btn-secondary btn-sm" [disabled]="offset() + PAGE >= total()" (click)="page(1)">{{ 'admin.next' | t }}</button>
          </div>
        }
      }
    </div>
  `,
})
export class AdminTenantsPage implements OnInit {
  /** ?filter= from the overview cards. */
  readonly filter = input<string>();
  protected readonly i18n = inject(I18nService);
  private readonly api = inject(AdminService);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);

  protected readonly PAGE = PAGE;
  protected readonly filters: TenantFilter[] = ['all', 'trialing', 'expired', 'active', 'past_due', 'suspended', 'cancelled', 'tenant_suspended', 'closed'];
  protected readonly search = signal('');
  protected readonly status = signal<TenantFilter>('all');
  protected readonly offset = signal(0);
  protected readonly total = signal(0);
  protected readonly rows = signal<TenantRow[]>([]);
  protected readonly loading = signal(true);
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    inject(DestroyRef).onDestroy(() => clearTimeout(this.timer));
  }

  ngOnInit(): void {
    const f = this.filter() as TenantFilter | undefined;
    if (f && this.filters.includes(f)) this.status.set(f);
    void this.load();
  }

  protected badge(r: TenantRow) {
    return tenantBadge(r.status, r.sub_status, r.trial_ends_at);
  }

  protected onSearch(value: string): void {
    this.search.set(value);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.offset.set(0);
      void this.load();
    }, 300);
  }

  protected setFilter(value: TenantFilter): void {
    this.status.set(value);
    this.offset.set(0);
    void this.load();
  }

  protected page(dir: 1 | -1): void {
    this.offset.update((o) => Math.max(0, o + dir * PAGE));
    void this.load();
  }

  protected open(r: TenantRow): void {
    void this.router.navigate(['/admin/tenants', r.id]);
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    try {
      const r = await this.api.tenants(this.search().trim(), this.status(), PAGE, this.offset());
      this.total.set(r.total);
      this.rows.set(r.rows);
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.loading.set(false);
    }
  }
}

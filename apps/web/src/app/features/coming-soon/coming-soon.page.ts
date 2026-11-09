import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { I18nService, TranslatePipe } from '../../core/i18n/i18n.service';
import { NAV_ITEMS } from '../../core/navigation/nav-items';
import { TenantContextService } from '../../core/tenant/tenant-context.service';
import { StatePanel } from '../../shared/components/ui';

/** Honest roadmap placeholder for modules that have not shipped yet (no mock data). */
@Component({
  selector: 'sz-coming-soon-page',
  imports: [StatePanel, TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (item(); as nav) {
      @if (allowed()) {
        <div class="card">
          <sz-state
            [icon]="nav.icon"
            [heading]="'comingSoon.title' | t: { module: i18n.t(nav.key) }"
            [message]="'comingSoon.body' | t: { phase: nav.phase }"
          />
        </div>
      } @else {
        <div class="card"><sz-state icon="lock" [heading]="'errors.forbiddenTitle' | t" [message]="'errors.forbiddenBody' | t" /></div>
      }
    } @else {
      <div class="card"><sz-state icon="circle-alert" [heading]="'errors.notFoundTitle' | t" [message]="'errors.notFoundBody' | t" /></div>
    }
  `,
})
export class ComingSoonPage {
  protected readonly i18n = inject(I18nService);
  private readonly ctx = inject(TenantContextService);
  readonly module = input<string>();
  protected readonly item = computed(() => NAV_ITEMS.find((i) => i.path === `/m/${this.module()}` && i.phase));
  protected readonly allowed = computed(() => {
    const nav = this.item();
    return !!nav && this.ctx.hasModule(nav.module) && this.ctx.canAny(nav.permissions);
  });
}

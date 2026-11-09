import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { LucideDynamicIcon } from '@lucide/angular';
import { I18nService, TranslatePipe } from './core/i18n/i18n.service';
import { AppUpdateService } from './core/services/app-update.service';
import { ThemeService } from './core/services/theme.service';
import { ToastOutlet } from './shared/components/ui';

@Component({
  selector: 'sz-root',
  imports: [RouterOutlet, ToastOutlet, LucideDynamicIcon, TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <router-outlet /><sz-toasts />
    @if (updates.ready()) {
      <div class="no-print fixed inset-x-0 bottom-4 z-50 flex justify-center px-4" role="status">
        <div class="card flex items-center gap-3 px-4 py-2.5 text-sm shadow-xl">
          <svg lucideIcon="sparkles" [size]="16" class="text-primary"></svg>
          <span>{{ 'update.ready' | t }}@if (updates.next()) { <span class="text-muted"> · {{ updates.next() }}</span> }</span>
          <button type="button" class="btn-primary btn-sm" (click)="updates.apply()">{{ 'update.now' | t }}</button>
        </div>
      </div>
    }
  `,
})
export class App {
  // Instantiate early so <html lang/dir> and theme classes are applied on boot.
  protected readonly i18n = inject(I18nService);
  protected readonly theme = inject(ThemeService);
  protected readonly updates = inject(AppUpdateService);

  constructor() {
    this.updates.start();
  }
}

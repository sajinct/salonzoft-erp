import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { I18nService } from './core/i18n/i18n.service';
import { ThemeService } from './core/services/theme.service';
import { ToastOutlet } from './shared/components/ui';

@Component({
  selector: 'sz-root',
  imports: [RouterOutlet, ToastOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<router-outlet /><sz-toasts />`,
})
export class App {
  // Instantiate early so <html lang/dir> and theme classes are applied on boot.
  protected readonly i18n = inject(I18nService);
  protected readonly theme = inject(ThemeService);
}

import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { LucideDynamicIcon } from '@lucide/angular';
import { I18nService, TranslatePipe } from '../core/i18n/i18n.service';
import { ThemeService } from '../core/services/theme.service';

@Component({
  selector: 'sz-auth-layout',
  imports: [RouterOutlet, TranslatePipe, LucideDynamicIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="grid min-h-screen lg:grid-cols-[1.05fr_1fr]">
      <!-- Brand panel -->
      <aside class="relative hidden overflow-hidden bg-[#2b1226] p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <div class="absolute -end-24 -top-24 h-96 w-96 rounded-full bg-[#b9805f]/25 blur-3xl"></div>
        <div class="absolute -bottom-32 -start-16 h-[28rem] w-[28rem] rounded-full bg-[#6b2d5c]/60 blur-3xl"></div>
        <div class="relative flex items-center gap-3">
          <span class="grid h-10 w-10 place-items-center rounded-xl bg-white/10"><svg lucideIcon="sparkles" [size]="20"></svg></span>
          <span class="font-[family-name:var(--font-display)] text-2xl font-semibold">{{ 'app.name' | t }}</span>
        </div>
        <div class="relative max-w-md">
          <p class="font-[family-name:var(--font-display)] text-4xl leading-tight">{{ 'app.tagline' | t }}</p>
          <ul class="mt-8 space-y-3 text-sm text-white/80">
            <li class="flex items-center gap-2"><svg lucideIcon="calendar-days" [size]="16"></svg> {{ 'nav.appointments' | t }} · {{ 'nav.customers' | t }}</li>
            <li class="flex items-center gap-2"><svg lucideIcon="receipt" [size]="16"></svg> {{ 'nav.pos' | t }} · VAT · OMR</li>
            <li class="flex items-center gap-2"><svg lucideIcon="languages" [size]="16"></svg> English · العربية</li>
          </ul>
        </div>
        <p class="relative text-xs text-white/50">© Salonzoft · Muscat, Oman</p>
      </aside>

      <main class="flex flex-col">
        <div class="flex justify-end gap-1 p-4">
          <button type="button" class="btn-ghost btn-sm" (click)="i18n.toggle()">
            <svg lucideIcon="languages" [size]="16"></svg>
            {{ i18n.lang() === 'en' ? ('common.arabic' | t) : ('common.english' | t) }}
          </button>
          <button type="button" class="btn-icon" (click)="theme.toggle()" [attr.aria-label]="'shell.theme' | t">
            <svg [lucideIcon]="theme.theme() === 'dark' ? 'sun' : 'moon'" [size]="18"></svg>
          </button>
        </div>
        <div class="flex flex-1 items-center justify-center px-4 pb-16">
          <div class="w-full max-w-md"><router-outlet /></div>
        </div>
      </main>
    </div>
  `,
})
export class AuthLayout {
  protected readonly i18n = inject(I18nService);
  protected readonly theme = inject(ThemeService);
}

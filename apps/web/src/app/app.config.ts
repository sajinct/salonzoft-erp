import { ApplicationConfig, inject, provideAppInitializer, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withComponentInputBinding, withInMemoryScrolling } from '@angular/router';
import {
  LucideBuilding2, LucideCalendarDays, LucideChartColumn, LucideCheck, LucideChevronDown, LucideChevronRight,
  LucideCircleAlert, LucideCircleCheck, LucideClock, LucideCopy, LucideGift, LucideIdCard, LucideLanguages,
  LucideLayoutDashboard, LucideLock, LucideLogOut, LucideMail, LucideMegaphone, LucideMenu, LucideMessageCircle,
  LucideMoon, LucidePackage, LucidePencil, LucidePlus, LucideReceipt, LucideScissors, LucideSettings,
  LucideShieldCheck, LucideSparkles, LucideStore, LucideSun, LucideTrash2, LucideTruck, LucideUpload,
  LucideUserRound, LucideUsers, LucideWallet, LucideX, provideLucideConfig, provideLucideIcons,
  LucidePrinter, LucideChevronLeft, LucideArrowLeft, LucideFolderPlus, LucideKeyRound, LucidePhone, LucidePin, LucideSearch, LucideUserPlus, LucideUserX,
} from '@lucide/angular';
import { routes } from './app.routes';
import { I18nService } from './core/i18n/i18n.service';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // Load the stored language (Arabic is a lazy chunk) before the first render.
    provideAppInitializer(() => inject(I18nService).init()),
    provideRouter(routes, withComponentInputBinding(), withInMemoryScrolling({ scrollPositionRestoration: 'top' })),
    provideLucideConfig({ strokeWidth: 1.75 }),
    provideLucideIcons(
      LucideBuilding2, LucideCalendarDays, LucideChartColumn, LucideCheck, LucideChevronDown, LucideChevronRight,
      LucideCircleAlert, LucideCircleCheck, LucideClock, LucideCopy, LucideGift, LucideIdCard, LucideLanguages,
      LucideLayoutDashboard, LucideLock, LucideLogOut, LucideMail, LucideMegaphone, LucideMenu, LucideMessageCircle,
      LucideMoon, LucidePackage, LucidePencil, LucidePlus, LucideReceipt, LucideScissors, LucideSettings,
      LucideShieldCheck, LucideSparkles, LucideStore, LucideSun, LucideTrash2, LucideTruck, LucideUpload,
      LucideUserRound, LucideUsers, LucideWallet, LucideX,
      LucidePrinter, LucideChevronLeft, LucideArrowLeft, LucideFolderPlus, LucideKeyRound, LucidePhone, LucidePin, LucideSearch, LucideUserPlus, LucideUserX,
    ),
  ],
};

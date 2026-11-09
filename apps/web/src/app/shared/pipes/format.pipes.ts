import { Pipe, PipeTransform, inject } from '@angular/core';
import { I18nService } from '../../core/i18n/i18n.service';
import { TenantContextService } from '../../core/tenant/tenant-context.service';
import { MoneyInput, formatMoney } from '../money/money';

/** `{{ amount | money }}` — tenant currency, 3-decimal OMR by default, locale-aware. */
@Pipe({ name: 'money', pure: false })
export class MoneyPipe implements PipeTransform {
  private readonly i18n = inject(I18nService);
  private readonly ctx = inject(TenantContextService);

  transform(value: MoneyInput, showCurrency = true): string {
    const settings = this.ctx.context()?.settings;
    return formatMoney(value, {
      currency: settings?.currency_code ?? 'OMR',
      decimals: settings?.currency_decimals ?? 3,
      locale: this.i18n.locale(),
      showCurrency,
    });
  }
}

/**
 * `{{ timestamp | localDate:'datetime' }}` — renders in the branch/tenant
 * timezone (default Asia/Muscat), optionally with the Hijri (Umm al-Qura) date.
 */
@Pipe({ name: 'localDate', pure: false })
export class LocalDatePipe implements PipeTransform {
  private readonly i18n = inject(I18nService);
  private readonly ctx = inject(TenantContextService);

  transform(value: string | Date | null | undefined, style: 'date' | 'datetime' | 'time' = 'date'): string {
    if (!value) return '';
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const timeZone = this.ctx.activeBranch()?.timezone ?? this.ctx.context()?.settings.timezone ?? 'Asia/Muscat';
    const options: Intl.DateTimeFormatOptions = { timeZone };
    if (style !== 'time') Object.assign(options, { day: 'numeric', month: 'short', year: 'numeric' });
    if (style !== 'date') Object.assign(options, { hour: '2-digit', minute: '2-digit' });
    const locale = this.i18n.locale();
    const gregorian = new Intl.DateTimeFormat(locale, options).format(date);
    if (style === 'time' || !this.ctx.context()?.settings.show_hijri_dates) return gregorian;
    const hijri = new Intl.DateTimeFormat(`${locale.split('-u-')[0]}-u-ca-islamic-umalqura-nu-latn`, {
      timeZone, day: 'numeric', month: 'long', year: 'numeric',
    }).format(date);
    return `${gregorian} · ${hijri}`;
  }
}

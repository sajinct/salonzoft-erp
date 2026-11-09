import { DOCUMENT } from '@angular/common';
import { Injectable, Pipe, PipeTransform, computed, effect, inject, signal } from '@angular/core';
import { Dictionary, TranslationKey, en, enErrors } from './en';

export type Lang = 'en' | 'ar';
export type TranslationParams = Record<string, string | number | null | undefined>;

const STORAGE_KEY = 'sz.lang';
// English is bundled (it is also the fallback); Arabic is a lazy chunk so the
// initial download stays small. It is loaded before first render when the
// stored preference is Arabic (see `init`), so there is no flash of English.
const dictionaries: Partial<Record<Lang, Dictionary>> = { en };
const errorDictionaries: Partial<Record<Lang, Record<string, string>>> = { en: enErrors };

async function loadDictionary(lang: Lang): Promise<void> {
  if (dictionaries[lang]) return;
  const m = await import('./ar');
  dictionaries.ar = m.ar;
  errorDictionaries.ar = m.arErrors;
}

function readStoredLang(): Lang {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'ar' ? 'ar' : 'en';
  } catch {
    return 'en';
  }
}

export function interpolate(template: string, params?: TranslationParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === null || value === undefined ? match : String(value);
  });
}

/**
 * Runtime bilingual support. Switching language updates <html lang/dir> so the
 * whole layout mirrors for Arabic (Tailwind logical utilities: ms-/me-/ps-/pe-/start-/end-).
 */
@Injectable({ providedIn: 'root' })
export class I18nService {
  private readonly document = inject(DOCUMENT);

  /** Starts in English; `init()` switches to the stored language once its dictionary is loaded. */
  readonly lang = signal<Lang>('en');
  readonly dir = computed(() => (this.lang() === 'ar' ? 'rtl' : 'ltr'));
  readonly isRtl = computed(() => this.lang() === 'ar');
  /** BCP-47 locale for Intl formatting (Latin digits keep money/phone numbers unambiguous). */
  readonly locale = computed(() => (this.lang() === 'ar' ? 'ar-OM-u-nu-latn' : 'en-OM'));

  constructor() {
    effect(() => {
      const lang = this.lang();
      const html = this.document.documentElement;
      html.lang = lang;
      html.dir = this.dir();
      try {
        localStorage.setItem(STORAGE_KEY, lang);
      } catch {
        /* storage unavailable (private mode) — preference just won't persist */
      }
    });
  }

  /** App initializer: restore the stored language before the first render. */
  async init(): Promise<void> {
    await this.setLang(readStoredLang());
  }

  /** Switch language; the switch happens once that language's dictionary is loaded. */
  async setLang(lang: Lang): Promise<void> {
    try {
      await loadDictionary(lang);
      this.lang.set(lang);
    } catch {
      /* offline before the chunk was cached — stay in the current language */
    }
  }

  toggle(): Promise<void> {
    return this.setLang(this.lang() === 'en' ? 'ar' : 'en');
  }

  t(key: TranslationKey, params?: TranslationParams): string {
    return interpolate(dictionaries[this.lang()]?.[key] ?? en[key] ?? key, params);
  }

  /** For keys built at runtime (e.g. `businessType.${type}`). Falls back to the key. */
  tx(key: string, params?: TranslationParams): string {
    const dict = (dictionaries[this.lang()] ?? en) as Record<string, string>;
    const fallback = en as Record<string, string>;
    return interpolate(dict[key] ?? fallback[key] ?? key, params);
  }

  /** Translate a server error code (see app.raise in SQL). */
  error(code: string | null | undefined, fallback?: string | null): string {
    if (code) {
      const message = errorDictionaries[this.lang()]?.[code] ?? enErrors[code];
      if (message) return message;
    }
    return fallback || this.t('errors.generic');
  }

  /** Pick the localized variant of a bilingual DB field pair (name_en / name_ar). */
  pick(en: string | null | undefined, ar: string | null | undefined): string {
    return (this.lang() === 'ar' ? ar || en : en || ar) ?? '';
  }
}

/** `{{ 'nav.dashboard' | t }}` — impure so it re-evaluates when the language signal changes. */
@Pipe({ name: 't', pure: false })
export class TranslatePipe implements PipeTransform {
  private readonly i18n = inject(I18nService);
  transform(key: TranslationKey, params?: TranslationParams): string {
    return this.i18n.t(key, params);
  }
}

/** `{{ 'businessType.' + type | tx }}` for dynamic keys. */
@Pipe({ name: 'tx', pure: false })
export class TranslateDynamicPipe implements PipeTransform {
  private readonly i18n = inject(I18nService);
  transform(key: string, params?: TranslationParams): string {
    return this.i18n.tx(key, params);
  }
}

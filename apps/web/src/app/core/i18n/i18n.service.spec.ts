import { TestBed } from '@angular/core/testing';
import { ar } from './ar';
import { en } from './en';
import { I18nService, interpolate } from './i18n.service';

describe('I18nService', () => {
  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({});
  });

  it('every English key has a non-empty Arabic translation', () => {
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(ar[key], key).toBeTruthy();
    }
  });

  it('Arabic strings keep the same {placeholders} as English', () => {
    const vars = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(',');
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(vars(ar[key]), key).toBe(vars(en[key]));
    }
  });

  it('switching to Arabic sets <html lang="ar" dir="rtl"> and persists', () => {
    const i18n = TestBed.inject(I18nService);
    i18n.setLang('ar');
    TestBed.tick();
    expect(document.documentElement.dir).toBe('rtl');
    expect(document.documentElement.lang).toBe('ar');
    expect(localStorage.getItem('sz.lang')).toBe('ar');
    expect(i18n.t('nav.dashboard')).toBe('لوحة التحكم');

    i18n.toggle();
    TestBed.tick();
    expect(document.documentElement.dir).toBe('ltr');
    expect(i18n.t('nav.dashboard')).toBe('Dashboard');
  });

  it('interpolates parameters and leaves unknown ones intact', () => {
    expect(interpolate('Hi {name}, {n} left', { name: 'Aisha', n: 3 })).toBe('Hi Aisha, 3 left');
    expect(interpolate('Hi {name}', {})).toBe('Hi {name}');
  });

  it('translates server error codes with sensible fallbacks', () => {
    const i18n = TestBed.inject(I18nService);
    expect(i18n.error('TENANT_SLUG_TAKEN')).toContain('already taken');
    expect(i18n.error('SOMETHING_NEW', 'Server detail')).toBe('Server detail');
    expect(i18n.error(null)).toBe(en['errors.generic']);
    i18n.setLang('ar');
    expect(i18n.error('FORBIDDEN')).toBe('ليست لديك صلاحية للقيام بذلك.');
  });

  it('picks the bilingual field for the active language with fallback', () => {
    const i18n = TestBed.inject(I18nService);
    expect(i18n.pick('Seeb', 'السيب')).toBe('Seeb');
    i18n.setLang('ar');
    expect(i18n.pick('Seeb', 'السيب')).toBe('السيب');
    expect(i18n.pick('Seeb', null)).toBe('Seeb');
  });
});

import { safeNext } from '../../features/auth/auth-shared';
import { slugify } from '../../features/onboarding/onboarding.service';
import { AppError, toAppError, unwrap } from './app-error';

describe('toAppError', () => {
  it('extracts business codes raised by app.raise()', () => {
    const e = toAppError({ code: 'P0001', message: 'TENANT_SLUG_TAKEN', details: 'This booking address is already taken' });
    expect(e.code).toBe('TENANT_SLUG_TAKEN');
    expect(e.details).toContain('taken');
  });

  it('maps insufficient_privilege (RLS/grants) to FORBIDDEN', () => {
    expect(toAppError({ code: '42501', message: 'permission denied for table branches' }).code).toBe('FORBIDDEN');
  });

  it('keeps auth error codes', () => {
    expect(toAppError({ name: 'AuthApiError', code: 'invalid_credentials', message: 'Invalid login credentials' }).code).toBe(
      'invalid_credentials',
    );
  });

  it('detects network failures', () => {
    expect(toAppError(new TypeError('Failed to fetch')).code).toBe('NETWORK');
  });

  it('unwrap throws on error and returns data otherwise', () => {
    expect(unwrap({ data: 42, error: null })).toBe(42);
    expect(() => unwrap({ data: null, error: { message: 'FORBIDDEN', code: '42501' } })).toThrow(AppError);
  });
});

describe('safeNext (open-redirect protection)', () => {
  it('allows same-origin paths only', () => {
    expect(safeNext('/settings/team')).toBe('/settings/team');
    expect(safeNext('//evil.example')).toBe('/');
    expect(safeNext('/\\evil.example')).toBe('/');
    expect(safeNext('https://evil.example')).toBe('/');
    expect(safeNext(undefined, '/onboarding')).toBe('/onboarding');
  });
});

describe('slugify', () => {
  it('produces valid booking slugs', () => {
    expect(slugify('Al Noor Spa & Salon')).toBe('al-noor-spa-salon');
    expect(slugify('  Café Beauté  ')).toBe('cafe-beaute');
    expect(slugify('صالون النور')).toBe('');
  });
});

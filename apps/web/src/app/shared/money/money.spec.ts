import { addMoney, formatMoney, fromMinor, multiplyMoney, percentOf, splitInclusiveVat, toMinor } from './money';

describe('money (OMR, 3 decimals)', () => {
  it('parses strings, numbers and grouped input exactly', () => {
    expect(toMinor('12.345')).toBe(12345n);
    expect(toMinor(12.345)).toBe(12345n);
    expect(toMinor('1,250.5')).toBe(1250500n);
    expect(toMinor('-0.001')).toBe(-1n);
    expect(toMinor('.5')).toBe(500n);
    expect(toMinor(null)).toBe(0n);
  });

  it('rounds extra decimals half away from zero', () => {
    expect(toMinor('1.2345')).toBe(1235n);
    expect(toMinor('1.2344')).toBe(1234n);
    expect(toMinor('-1.2345')).toBe(-1235n);
  });

  it('rejects garbage', () => {
    expect(() => toMinor('12a')).toThrow();
    expect(() => toMinor('.')).toThrow();
    expect(() => toMinor(Number.NaN)).toThrow();
  });

  it('formats canonical strings with 3 decimals', () => {
    expect(fromMinor(12345n)).toBe('12.345');
    expect(fromMinor(5n)).toBe('0.005');
    expect(fromMinor(-1500n)).toBe('-1.500');
  });

  it('avoids floating point drift that plain JS would produce', () => {
    // 0.1 + 0.2 = 0.30000000000000004 in JS floats
    expect(addMoney(['0.1', '0.2'])).toBe('0.300');
    expect(addMoney(Array.from({ length: 1000 }, () => '0.001'))).toBe('1.000');
    expect(multiplyMoney('3.335', 3)).toBe('10.005');
  });

  it('calculates Oman VAT (5%) consistently', () => {
    expect(percentOf('10.000', 5)).toBe('0.500');
    expect(percentOf('3.333', '5')).toBe('0.167'); // 0.16665 → 0.167
    expect(splitInclusiveVat('10.500', 5)).toEqual({ net: '10.000', vat: '0.500', gross: '10.500' });
    const s = splitInclusiveVat('7.777', 5);
    expect(addMoney([s.net, s.vat])).toBe('7.777'); // net + vat always equals gross
  });

  it('formats for English and Arabic', () => {
    expect(formatMoney('1234.5')).toBe('OMR 1,234.500');
    expect(formatMoney('1234.5', { locale: 'ar-OM-u-nu-latn' })).toContain('ر.ع.');
    expect(formatMoney('-2', { showCurrency: false })).toBe('-2.000');
  });
});

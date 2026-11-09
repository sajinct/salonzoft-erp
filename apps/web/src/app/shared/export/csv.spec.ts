import { describe, expect, it } from 'vitest';
import { csvCell, toCsv } from './csv';

describe('csv', () => {
  it('quotes separators, quotes and line breaks', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(12.5)).toBe('12.5');
  });

  it('neutralises formulas in text but keeps negative numbers numeric', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"');
    expect(csvCell('+96891234567')).toBe("'+96891234567");
    expect(csvCell(-42)).toBe('-42');
    expect(csvCell('-42.000', false)).toBe('-42.000');
  });

  it('adds a BOM and CRLF rows (Excel opens Arabic correctly)', () => {
    const out = toCsv(['الاسم', 'Total'], [['نور', '42.000'], ['Aisha', null]], [true, false]);
    expect(out.startsWith('﻿')).toBe(true);
    expect(out).toBe('﻿الاسم,Total\r\nنور,42.000\r\nAisha,\r\n');
  });
});

import { csvToImportRows, mapHeaders, parseCsv } from './csv';

describe('CSV parsing for customer import', () => {
  it('handles quotes, escaped quotes, commas inside fields and CRLF', () => {
    const rows = parseCsv('name,note\r\n"Al Balushi, Aisha","She said ""hi"""\r\nNoor,\r\n');
    expect(rows).toEqual([
      ['name', 'note'],
      ['Al Balushi, Aisha', 'She said "hi"'],
      ['Noor', ''],
    ]);
  });

  it('detects semicolon delimiters and strips the BOM', () => {
    expect(parseCsv('﻿name;mobile\nAisha;91234567')).toEqual([
      ['name', 'mobile'],
      ['Aisha', '91234567'],
    ]);
  });

  it('keeps line breaks inside quoted fields and skips blank lines', () => {
    expect(parseCsv('name,note\n\nAisha,"line 1\nline 2"\n')).toEqual([
      ['name', 'note'],
      ['Aisha', 'line 1\nline 2'],
    ]);
  });

  it('maps common English and Arabic header spellings', () => {
    expect(mapHeaders(['First Name', 'Mobile No', 'E-mail', 'الجنس', 'Unknown', 'DOB'])).toEqual([
      'first_name', 'mobile', 'email', 'gender', null, 'date_of_birth',
    ]);
    // "Name" maps to first_name once; a second name-like column is not reused.
    expect(mapHeaders(['Name', 'Customer'])).toEqual(['first_name', null]);
  });

  it('builds import rows and drops empty cells', () => {
    const { rows, columns } = csvToImportRows('Name,Phone,Email\nAisha,9123 4567,\nNoor,95551111,noor@example.com');
    expect(columns).toEqual(['first_name', 'mobile', 'email']);
    expect(rows).toEqual([
      { first_name: 'Aisha', mobile: '9123 4567' },
      { first_name: 'Noor', mobile: '95551111', email: 'noor@example.com' },
    ]);
  });

  it('requires a name column', () => {
    expect(() => csvToImportRows('mobile\n91234567')).toThrowError('CSV_NO_NAME_COLUMN');
  });
});

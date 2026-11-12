import { describe, expect, it } from 'vitest';
import { toCsv } from '../../../shared/export/csv';
import { parseCsv } from '../../customers/data/csv';
import { EMPLOYEE_COLUMNS, employeeTemplateTable, employeesToTable, mapEmployeeHeaders, tableToEmployeeRows } from './employees-io';
import { Employee } from './employees.service';

const employee = {
  id: 'e1', code: 'E-01', name_en: 'Fatma Al Harthy', name_ar: 'فاطمة', job_title: 'Stylist', phone: '+96890000001', email: null,
  gender: 'female', is_bookable: true, is_active: true, hired_on: '2024-01-15', sort_order: 2,
} as Employee;

describe('employee import / export', () => {
  it('maps export headers and common spellings', () => {
    expect(mapEmployeeHeaders(EMPLOYEE_COLUMNS.map((c) => c.header))).toEqual(EMPLOYEE_COLUMNS.map((c) => c.field));
    expect(mapEmployeeHeaders(['Staff name', 'Mobile', 'Designation', 'Branch', 'الجنس', 'Salary'])).toEqual(['name_en', 'phone', 'job_title', 'branches', 'gender', null]);
  });

  it('reads Excel cells: dates become ISO text, numbers and booleans become text', () => {
    const { rows } = tableToEmployeeRows([
      ['Name', 'Phone', 'Hired on', 'Active'],
      ['Maryam', 96890000002, new Date('2023-02-03T00:00:00Z'), false],
    ]);
    expect(rows).toEqual([{ name_en: 'Maryam', phone: '96890000002', hired_on: '2023-02-03T00:00:00.000Z', is_active: 'false' }]);
  });

  it('undoes the CSV formula guard on phone numbers', () => {
    expect(tableToEmployeeRows([['Name', 'Phone'], ['Noor', "'+96890000003"], ["O'Neil", "'hello"]]).rows).toEqual([
      { name_en: 'Noor', phone: '+96890000003' },
      { name_en: "O'Neil", phone: "'hello" },
    ]);
  });

  it('needs a name column', () => {
    expect(() => tableToEmployeeRows([['Phone'], ['123456']])).toThrow('IMPORT_NO_NAME_COLUMN');
  });

  it('exports branches as codes and services as code or name, and imports the file back', () => {
    const table = employeesToTable(
      [employee],
      { branches: new Map([['e1', ['b2', 'b1']]]), services: new Map([['e1', ['s1', 's2', 'gone']]]) },
      [{ id: 'b1', code: 'MAIN' }, { id: 'b2', code: 'B2' }],
      [{ id: 's1', code: 'HC-01', name_en: 'Haircut' }, { id: 's2', code: null, name_en: 'Blow dry' }],
    );
    const { rows } = tableToEmployeeRows(parseCsv(toCsv(table.header, table.rows)));
    expect(rows).toEqual([{
      code: 'E-01', name_en: 'Fatma Al Harthy', name_ar: 'فاطمة', job_title: 'Stylist', phone: '+96890000001', gender: 'female',
      is_bookable: 'yes', is_active: 'yes', hired_on: '2024-01-15', branches: 'B2; MAIN', services: 'Blow dry; HC-01', sort_order: '2',
    }]);
  });

  it('offers a template with every column', () => {
    const t = employeeTemplateTable('HQ');
    expect(t.rows.every((r) => r.length === t.header.length)).toBe(true);
    expect(tableToEmployeeRows([t.header, ...t.rows]).rows[0]).toMatchObject({ code: 'E-01', branches: 'HQ', services: 'all' });
  });
});

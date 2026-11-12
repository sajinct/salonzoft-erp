import { describe, expect, it } from 'vitest';
import { parseCsv } from '../../customers/data/csv';
import { toCsv } from '../../../shared/export/csv';
import { SERVICE_COLUMNS, mapServiceHeaders, serviceTemplateTable, servicesToTable, tableToServiceRows } from './services-io';
import { Service, ServiceCategory } from './services.service';

const category = { id: 'c1', name_en: 'Hair', name_ar: 'الشعر' } as ServiceCategory;
const service = {
  id: 's1', category_id: 'c1', code: 'HC-01', name_en: 'Haircut, long', name_ar: 'قص شعر', description_en: null, description_ar: null,
  duration_minutes: 45, buffer_before_minutes: 0, buffer_after_minutes: 10, price: 5.5, price_type: 'fixed', vat_category: 'standard',
  audience: 'all', online_bookable: true, is_active: false, sort_order: 3,
} as Service;

describe('service import / export', () => {
  it('maps export headers, snake_case and Arabic headers', () => {
    expect(mapServiceHeaders(SERVICE_COLUMNS.map((c) => c.header))).toEqual(SERVICE_COLUMNS.map((c) => c.field));
    expect(mapServiceHeaders(['name_en', 'Duration', 'السعر', 'Notes', 'Category'])).toEqual(['name_en', 'duration_minutes', 'price', null, 'category']);
    expect(mapServiceHeaders(['Name', 'Service'])).toEqual(['name_en', null]);
  });

  it('turns a sheet into import rows, skipping blanks and unknown columns', () => {
    const { rows, columns } = tableToServiceRows([
      ['Name', 'Price', 'Extra', 'Active'],
      ['Haircut', 5.5, 'x', true],
      ['', '', '', ''],
      [' Manicure ', null, 'y', 'no'],
    ]);
    expect(columns).toEqual(['name_en', 'price', 'is_active']);
    expect(rows).toEqual([{ name_en: 'Haircut', price: '5.5', is_active: 'true' }, { name_en: 'Manicure', is_active: 'no' }]);
  });

  it('needs a name column', () => {
    expect(() => tableToServiceRows([['Price'], [5]])).toThrow('IMPORT_NO_NAME_COLUMN');
    expect(tableToServiceRows([])).toEqual({ rows: [], columns: [] });
  });

  it('exports a file that imports back unchanged', () => {
    const table = servicesToTable([service], [category]);
    const { rows } = tableToServiceRows(parseCsv(toCsv(table.header, table.rows)));
    expect(rows).toEqual([{
      code: 'HC-01', name_en: 'Haircut, long', name_ar: 'قص شعر', category: 'Hair', category_ar: 'الشعر', duration_minutes: '45', price: '5.5',
      price_type: 'fixed', vat_category: 'standard', audience: 'all', online_bookable: 'yes', is_active: 'no',
      buffer_before_minutes: '0', buffer_after_minutes: '10', sort_order: '3',
    }]);
  });

  it('offers a template with every column', () => {
    const t = serviceTemplateTable();
    expect(t.rows.every((r) => r.length === t.header.length)).toBe(true);
    expect(tableToServiceRows([t.header, ...t.rows]).rows[0]).toMatchObject({ code: 'HC-01', name_en: 'Haircut', category: 'Hair' });
  });
});

import { CsvCell, downloadText, toCsv } from '../../../shared/export/csv';
import { parseCsv } from '../../customers/data/csv';
import { Service, ServiceCategory } from './services.service';

/**
 * Service catalogue ⇄ spreadsheet. The same columns are written by the export
 * and understood by the import, so a salon can export, edit in Excel and
 * import the file back. Files are CSV (UTF-8) or Excel (.xlsx).
 */
export type ServiceImportField =
  | 'code' | 'name_en' | 'name_ar' | 'category' | 'category_ar' | 'duration_minutes' | 'price' | 'price_type'
  | 'vat_category' | 'audience' | 'online_bookable' | 'is_active' | 'buffer_before_minutes' | 'buffer_after_minutes'
  | 'description_en' | 'description_ar' | 'sort_order';

export type ServiceImportRow = Partial<Record<ServiceImportField, string>>;

export interface ServiceImportResult {
  dry_run: boolean;
  total: number;
  inserted: number;
  updated: number;
  categories_created: number;
  errors: { row: number; code: string; detail: string }[];
}

interface Column {
  field: ServiceImportField;
  header: string;
  /** Other accepted header spellings (normalised: lower-case, no spaces or punctuation). */
  aliases: string[];
  width: number;
}

export const SERVICE_COLUMNS: Column[] = [
  { field: 'code', header: 'Code', aliases: ['servicecode', 'sku', 'id', 'الرمز', 'الكود'], width: 12 },
  { field: 'name_en', header: 'Name', aliases: ['nameen', 'nameenglish', 'service', 'servicename', 'title', 'الاسم', 'الخدمة', 'اسمالخدمة'], width: 32 },
  { field: 'name_ar', header: 'Name (Arabic)', aliases: ['namear', 'arabicname', 'nameinarabic', 'الاسمبالعربي', 'الاسمبالعربية'], width: 32 },
  { field: 'category', header: 'Category', aliases: ['categoryen', 'categoryname', 'group', 'الفئة', 'التصنيف'], width: 20 },
  { field: 'category_ar', header: 'Category (Arabic)', aliases: ['categoryar', 'arabiccategory', 'الفئةبالعربي', 'الفئةبالعربية'], width: 20 },
  { field: 'duration_minutes', header: 'Duration (min)', aliases: ['duration', 'durationminutes', 'minutes', 'mins', 'time', 'المدة'], width: 14 },
  { field: 'price', header: 'Price', aliases: ['amount', 'rate', 'cost', 'السعر'], width: 12 },
  { field: 'price_type', header: 'Price type', aliases: ['pricing', 'نوعالسعر'], width: 12 },
  { field: 'vat_category', header: 'VAT', aliases: ['vatcategory', 'tax', 'taxcategory', 'الضريبة'], width: 12 },
  { field: 'audience', header: 'Audience', aliases: ['gender', 'for', 'الفئةالمستهدفة', 'الجنس'], width: 12 },
  { field: 'online_bookable', header: 'Online booking', aliases: ['onlinebookable', 'online', 'bookableonline', 'الحجزالإلكتروني'], width: 14 },
  { field: 'is_active', header: 'Active', aliases: ['isactive', 'enabled', 'status', 'نشط', 'نشطة'], width: 10 },
  { field: 'buffer_before_minutes', header: 'Buffer before (min)', aliases: ['bufferbefore', 'bufferbeforeminutes'], width: 18 },
  { field: 'buffer_after_minutes', header: 'Buffer after (min)', aliases: ['bufferafter', 'bufferafterminutes'], width: 18 },
  { field: 'description_en', header: 'Description', aliases: ['descriptionen', 'details', 'الوصف'], width: 40 },
  { field: 'description_ar', header: 'Description (Arabic)', aliases: ['descriptionar', 'arabicdescription', 'الوصفبالعربي', 'الوصفبالعربية'], width: 40 },
  { field: 'sort_order', header: 'Order', aliases: ['sortorder', 'sort', 'position', 'الترتيب'], width: 8 },
];

const normaliseHeader = (h: string) => h.trim().toLowerCase().replace(/[\s_\-.()/]/g, '');

/** Map header cells to import fields; unknown columns are ignored and each field is used once. */
export function mapServiceHeaders(headers: string[]): (ServiceImportField | null)[] {
  const used = new Set<ServiceImportField>();
  return headers.map((h) => {
    const n = normaliseHeader(h);
    const col = SERVICE_COLUMNS.find((c) => !used.has(c.field) && (normaliseHeader(c.header) === n || c.aliases.includes(n)));
    if (col) used.add(col.field);
    return col?.field ?? null;
  });
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  return String(value).trim();
}

/** A sheet (first row = headers) → rows for import_services. Throws IMPORT_NO_NAME_COLUMN without a name column. */
export function tableToServiceRows(table: unknown[][]): { rows: ServiceImportRow[]; columns: ServiceImportField[] } {
  const [header, ...body] = table.filter((r) => r.some((v) => cellText(v) !== ''));
  if (!header) return { rows: [], columns: [] };
  const fields = mapServiceHeaders(header.map(cellText));
  if (!fields.includes('name_en')) throw new Error('IMPORT_NO_NAME_COLUMN');
  const rows = body.map((cells) => {
    const row: ServiceImportRow = {};
    fields.forEach((f, i) => {
      const v = cellText(cells[i]);
      if (f && v !== '') row[f] = v;
    });
    return row;
  });
  return { rows, columns: fields.filter((f): f is ServiceImportField => f !== null) };
}

const isXlsx = (file: File) => /\.xlsx$/i.test(file.name) || file.type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Read the first sheet of an .xlsx file, or a CSV file, as rows of cells. */
export async function readTableFile(file: File): Promise<unknown[][]> {
  if (/\.xls$/i.test(file.name)) throw new Error('IMPORT_OLD_EXCEL');
  if (isXlsx(file)) {
    const { readSheet } = await import('read-excel-file/browser');
    return (await readSheet(file)) as unknown[][];
  }
  return parseCsv(await file.text());
}

const yesNo = (v: boolean) => (v ? 'yes' : 'no');

/** Header + one row per service, in SERVICE_COLUMNS order. */
export function servicesToTable(services: Service[], categories: ServiceCategory[]): { header: string[]; rows: CsvCell[][] } {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const rows = services.map((s): CsvCell[] => {
    const c = s.category_id ? byId.get(s.category_id) : undefined;
    return [
      s.code, s.name_en, s.name_ar, c?.name_en ?? null, c?.name_ar ?? null, s.duration_minutes, Number(s.price), s.price_type,
      s.vat_category, s.audience, yesNo(s.online_bookable), yesNo(s.is_active), s.buffer_before_minutes, s.buffer_after_minutes,
      s.description_en, s.description_ar, s.sort_order,
    ];
  });
  return { header: SERVICE_COLUMNS.map((c) => c.header), rows };
}

/** An example file: the headers and two sample rows. */
export function serviceTemplateTable(): { header: string[]; rows: CsvCell[][] } {
  return {
    header: SERVICE_COLUMNS.map((c) => c.header),
    rows: [
      ['HC-01', 'Haircut', 'قص شعر', 'Hair', 'الشعر', 45, 5, 'fixed', 'standard', 'all', 'yes', 'yes', 0, 0, null, null, 1],
      ['MN-01', 'Manicure', 'مانيكير', 'Nails', 'الأظافر', 30, 6.5, 'fixed', 'standard', 'female', 'yes', 'yes', 0, 10, null, null, 2],
    ],
  };
}

export function downloadCsv(table: { header: string[]; rows: CsvCell[][] }, filename: string): void {
  downloadText(toCsv(table.header, table.rows), filename);
}

export async function downloadXlsx(table: { header: string[]; rows: CsvCell[][] }, filename: string, sheet = 'Services'): Promise<void> {
  const { default: writeExcelFile } = await import('write-excel-file/browser');
  const data = [
    table.header.map((h) => ({ value: h, fontWeight: 'bold' as const })),
    ...table.rows.map((r) => r.map((v) => (v === undefined ? null : v))),
  ];
  await writeExcelFile(data, { sheet, columns: SERVICE_COLUMNS.map((c) => ({ width: c.width })), stickyRowsCount: 1 }).toFile(filename);
}

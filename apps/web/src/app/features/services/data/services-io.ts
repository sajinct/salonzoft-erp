import { ImportResult, Table, TableColumn, mapHeaders, tableToRows, yesNo } from '../../../shared/import/table-io';
import { Service, ServiceCategory } from './services.service';

/**
 * Service catalogue ⇄ spreadsheet. The same columns are written by the export
 * and understood by the import, so a salon can export, edit in Excel and
 * import the file back.
 */
export type ServiceImportField =
  | 'code' | 'name_en' | 'name_ar' | 'category' | 'category_ar' | 'duration_minutes' | 'price' | 'price_type'
  | 'vat_category' | 'audience' | 'online_bookable' | 'is_active' | 'buffer_before_minutes' | 'buffer_after_minutes'
  | 'description_en' | 'description_ar' | 'sort_order';

export type ServiceImportRow = Partial<Record<ServiceImportField, string>>;

export interface ServiceImportResult extends ImportResult {
  categories_created: number;
}

export const SERVICE_COLUMNS: TableColumn<ServiceImportField>[] = [
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

export const SERVICE_WIDTHS = SERVICE_COLUMNS.map((c) => c.width);
const HEADER = SERVICE_COLUMNS.map((c) => c.header);

export function mapServiceHeaders(headers: string[]): (ServiceImportField | null)[] {
  return mapHeaders(SERVICE_COLUMNS, headers);
}

/** A sheet (first row = headers) → rows for import_services. Throws IMPORT_NO_NAME_COLUMN without a name column. */
export function tableToServiceRows(table: unknown[][]): { rows: ServiceImportRow[]; columns: ServiceImportField[] } {
  return tableToRows(SERVICE_COLUMNS, table, 'name_en');
}

/** Header + one row per service, in SERVICE_COLUMNS order. */
export function servicesToTable(services: Service[], categories: ServiceCategory[]): Table {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const rows = services.map((s) => {
    const c = s.category_id ? byId.get(s.category_id) : undefined;
    return [
      s.code, s.name_en, s.name_ar, c?.name_en ?? null, c?.name_ar ?? null, s.duration_minutes, Number(s.price), s.price_type,
      s.vat_category, s.audience, yesNo(s.online_bookable), yesNo(s.is_active), s.buffer_before_minutes, s.buffer_after_minutes,
      s.description_en, s.description_ar, s.sort_order,
    ];
  });
  return { header: HEADER, rows };
}

/** An example file: the headers and two sample rows. */
export function serviceTemplateTable(): Table {
  return {
    header: HEADER,
    rows: [
      ['HC-01', 'Haircut', 'قص شعر', 'Hair', 'الشعر', 45, 5, 'fixed', 'standard', 'all', 'yes', 'yes', 0, 0, null, null, 1],
      ['MN-01', 'Manicure', 'مانيكير', 'Nails', 'الأظافر', 30, 6.5, 'fixed', 'standard', 'female', 'yes', 'yes', 0, 10, null, null, 2],
    ],
  };
}

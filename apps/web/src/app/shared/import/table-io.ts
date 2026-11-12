import { CsvCell, downloadText, toCsv } from '../export/csv';
import { parseCsv } from '../../features/customers/data/csv';

/**
 * Spreadsheet import / export shared by the catalogue pages (services,
 * employees). A page describes its columns once; the export writes them and
 * the import reads them back, from CSV (UTF-8) or Excel (.xlsx).
 */
export interface TableColumn<F extends string> {
  field: F;
  header: string;
  /** Other accepted header spellings (normalised: lower-case, no spaces or punctuation). */
  aliases: string[];
  /** Column width in the Excel export, in characters. */
  width: number;
}

export interface Table {
  header: string[];
  rows: CsvCell[][];
}

/** What the import_* RPCs return. */
export interface ImportResult {
  dry_run: boolean;
  total: number;
  inserted: number;
  updated: number;
  errors: { row: number; code: string; detail: string }[];
}

const normaliseHeader = (h: string) => h.trim().toLowerCase().replace(/[\s_\-.()/]/g, '');

/** Map header cells to fields; unknown columns are ignored and each field is used once. */
export function mapHeaders<F extends string>(columns: TableColumn<F>[], headers: string[]): (F | null)[] {
  const used = new Set<F>();
  return headers.map((h) => {
    const n = normaliseHeader(h);
    const col = columns.find((c) => !used.has(c.field) && (normaliseHeader(c.header) === n || c.aliases.includes(n)));
    if (col) used.add(col.field);
    return col?.field ?? null;
  });
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  // The CSV export prefixes text that starts like a formula (= + - @) with an apostrophe; undo that here.
  return String(value).trim().replace(/^'(?=[=+@-])/, '');
}

/** A sheet (first row = headers) → import rows. Throws IMPORT_NO_NAME_COLUMN when the required column is missing. */
export function tableToRows<F extends string>(
  columns: TableColumn<F>[],
  table: unknown[][],
  required: F,
): { rows: Partial<Record<F, string>>[]; columns: F[] } {
  const [header, ...body] = table.filter((r) => r.some((v) => cellText(v) !== ''));
  if (!header) return { rows: [], columns: [] };
  const fields = mapHeaders(columns, header.map(cellText));
  if (!fields.includes(required)) throw new Error('IMPORT_NO_NAME_COLUMN');
  const rows = body.map((cells) => {
    const row: Partial<Record<F, string>> = {};
    fields.forEach((f, i) => {
      const v = cellText(cells[i]);
      if (f && v !== '') row[f] = v;
    });
    return row;
  });
  return { rows, columns: fields.filter((f): f is F => f !== null) };
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

export const yesNo = (v: boolean) => (v ? 'yes' : 'no');

export function downloadCsv(table: Table, filename: string): void {
  downloadText(toCsv(table.header, table.rows), filename);
}

export async function downloadXlsx(table: Table, filename: string, sheet: string, widths: number[]): Promise<void> {
  const { default: writeExcelFile } = await import('write-excel-file/browser');
  const data = [
    table.header.map((h) => ({ value: h, fontWeight: 'bold' as const })),
    ...table.rows.map((r) => r.map((v) => (v === undefined ? null : v))),
  ];
  await writeExcelFile(data, { sheet, columns: widths.map((width) => ({ width })), stickyRowsCount: 1 }).toFile(filename);
}

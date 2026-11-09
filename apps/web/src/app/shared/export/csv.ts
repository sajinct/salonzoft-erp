/**
 * CSV export that opens correctly in Excel (incl. Arabic): UTF-8 with BOM, CRLF,
 * RFC 4180 quoting. Text cells that a spreadsheet would treat as a formula
 * (= + - @, tab, CR) are prefixed with an apostrophe (CSV injection).
 */
export type CsvCell = string | number | boolean | null | undefined;

const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: CsvCell, isText = typeof value === 'string'): string {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (isText && FORMULA_START.test(s)) s = `'${s}`;
  return /[",\r\n;]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}

/** `textColumns[i]` marks columns whose values are free text (formula-guarded). */
export function toCsv(header: string[], rows: CsvCell[][], textColumns: boolean[] = []): string {
  const lines = [header.map((h) => csvCell(h, true)), ...rows.map((r) => r.map((v, i) => csvCell(v, textColumns[i] ?? typeof v === 'string')))];
  return '﻿' + lines.map((l) => l.join(',')).join('\r\n') + '\r\n';
}

export function downloadText(content: string, filename: string, type = 'text/csv;charset=utf-8'): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

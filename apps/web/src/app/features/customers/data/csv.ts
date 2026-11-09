import { ImportRow } from './customers.service';

/**
 * Minimal RFC 4180 CSV parser: quoted fields, escaped quotes (""), CRLF/LF,
 * UTF-8 BOM, and comma / semicolon / tab delimiters (auto-detected from the
 * header line, as Excel in Arabic locales often exports with ";").
 */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = [',', ';', '\t'].reduce((best, d) => (count(firstLine, d) > count(firstLine, best) ? d : best), ',');

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"' && field === '') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

function count(s: string, ch: string): number {
  return s.split(ch).length - 1;
}

type ImportField = keyof ImportRow;

/** Accepted header spellings (normalised: lower-case, no spaces/underscores/dashes). */
const HEADER_ALIASES: Record<ImportField, string[]> = {
  first_name: ['firstname', 'first', 'givenname', 'name', 'customername', 'customer', 'الاسم', 'الاسمالأول'],
  last_name: ['lastname', 'last', 'surname', 'familyname', 'اسمالعائلة', 'العائلة'],
  name_ar: ['namear', 'arabicname', 'nameinarabic', 'الاسمبالعربي', 'الاسمبالعربية'],
  mobile: ['mobile', 'mobileno', 'mobilenumber', 'phone', 'phoneno', 'phonenumber', 'tel', 'whatsapp', 'الجوال', 'الهاتف', 'رقمالهاتف'],
  email: ['email', 'emailaddress', 'mail', 'emailid', 'البريد', 'البريدالإلكتروني'],
  gender: ['gender', 'sex', 'الجنس'],
  date_of_birth: ['dateofbirth', 'dob', 'birthday', 'birthdate', 'تاريخالميلاد'],
  preferred_language: ['language', 'preferredlanguage', 'lang', 'اللغة'],
  tags: ['tags', 'tag', 'labels', 'الوسوم'],
  external_ref: ['externalref', 'id', 'customerid', 'customerno', 'reference', 'ref', 'legacyid'],
  note: ['note', 'notes', 'remarks', 'comment', 'comments', 'ملاحظات'],
  whatsapp_marketing: ['whatsappmarketing', 'marketingconsent', 'consent', 'optin', 'marketing'],
};

const normaliseHeader = (h: string) => h.trim().toLowerCase().replace(/[\s_\-.]/g, '');

/** Map header cells to import fields; unknown columns are ignored. */
export function mapHeaders(headers: string[]): (ImportField | null)[] {
  const used = new Set<ImportField>();
  return headers.map((h) => {
    const n = normaliseHeader(h);
    const field = (Object.keys(HEADER_ALIASES) as ImportField[]).find((f) => !used.has(f) && HEADER_ALIASES[f].includes(n));
    if (field) used.add(field);
    return field ?? null;
  });
}

/** CSV text → rows for import_customers. Throws if no name column is found. */
export function csvToImportRows(text: string): { rows: ImportRow[]; columns: ImportField[] } {
  const [header, ...body] = parseCsv(text);
  if (!header) return { rows: [], columns: [] };
  const fields = mapHeaders(header);
  if (!fields.includes('first_name')) throw new Error('CSV_NO_NAME_COLUMN');
  const rows = body.map((cells) => {
    const row: ImportRow = {};
    fields.forEach((f, i) => {
      const v = (cells[i] ?? '').trim();
      if (f && v !== '') row[f] = v;
    });
    return row;
  });
  return { rows, columns: fields.filter((f): f is ImportField => f !== null) };
}

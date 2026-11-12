import { Table, TableColumn, mapHeaders, tableToRows, yesNo } from '../../../shared/import/table-io';
import { Employee, EmployeeAssignments } from './employees.service';

/**
 * Employees ⇄ spreadsheet. The same columns are written by the export and
 * understood by the import. Branches and services are lists separated by ";"
 * (branch codes, service codes or names).
 */
export type EmployeeImportField =
  | 'code' | 'name_en' | 'name_ar' | 'job_title' | 'phone' | 'email' | 'gender' | 'is_bookable' | 'is_active'
  | 'hired_on' | 'branches' | 'services' | 'sort_order';

export type EmployeeImportRow = Partial<Record<EmployeeImportField, string>>;

export const EMPLOYEE_COLUMNS: TableColumn<EmployeeImportField>[] = [
  { field: 'code', header: 'Code', aliases: ['employeecode', 'staffcode', 'employeeid', 'staffid', 'id', 'الرمز', 'الكود'], width: 12 },
  { field: 'name_en', header: 'Name', aliases: ['nameen', 'nameenglish', 'employee', 'employeename', 'staff', 'staffname', 'fullname', 'الاسم', 'الموظف', 'اسمالموظف'], width: 28 },
  { field: 'name_ar', header: 'Name (Arabic)', aliases: ['namear', 'arabicname', 'nameinarabic', 'الاسمبالعربي', 'الاسمبالعربية'], width: 28 },
  { field: 'job_title', header: 'Job title', aliases: ['title', 'position', 'role', 'designation', 'المسمىالوظيفي', 'الوظيفة'], width: 22 },
  { field: 'phone', header: 'Phone', aliases: ['mobile', 'mobileno', 'phoneno', 'phonenumber', 'tel', 'الهاتف', 'الجوال', 'رقمالهاتف'], width: 18 },
  { field: 'email', header: 'Email', aliases: ['emailaddress', 'mail', 'البريد', 'البريدالإلكتروني'], width: 28 },
  { field: 'gender', header: 'Gender', aliases: ['sex', 'الجنس'], width: 10 },
  { field: 'is_bookable', header: 'Bookable', aliases: ['isbookable', 'takesbookings', 'appointments', 'قابلللحجز'], width: 10 },
  { field: 'is_active', header: 'Active', aliases: ['isactive', 'enabled', 'status', 'نشط'], width: 10 },
  { field: 'hired_on', header: 'Hired on', aliases: ['hiredon', 'hiredate', 'joiningdate', 'joined', 'startdate', 'تاريخالتعيين'], width: 14 },
  { field: 'branches', header: 'Branches', aliases: ['branch', 'branchcode', 'branchcodes', 'الفروع', 'الفرع'], width: 18 },
  { field: 'services', header: 'Services', aliases: ['service', 'skills', 'الخدمات'], width: 50 },
  { field: 'sort_order', header: 'Order', aliases: ['sortorder', 'sort', 'الترتيب'], width: 8 },
];

export const EMPLOYEE_WIDTHS = EMPLOYEE_COLUMNS.map((c) => c.width);
const HEADER = EMPLOYEE_COLUMNS.map((c) => c.header);

export function mapEmployeeHeaders(headers: string[]): (EmployeeImportField | null)[] {
  return mapHeaders(EMPLOYEE_COLUMNS, headers);
}

/** A sheet (first row = headers) → rows for import_employees. Throws IMPORT_NO_NAME_COLUMN without a name column. */
export function tableToEmployeeRows(table: unknown[][]): { rows: EmployeeImportRow[]; columns: EmployeeImportField[] } {
  return tableToRows(EMPLOYEE_COLUMNS, table, 'name_en');
}

export interface BranchRef { id: string; code: string }
export interface ServiceRef { id: string; code: string | null; name_en: string }

/** Header + one row per employee. Branches are written as codes, services as their code or name. */
export function employeesToTable(employees: Employee[], assignments: EmployeeAssignments, branches: BranchRef[], services: ServiceRef[]): Table {
  const branchCode = new Map(branches.map((b) => [b.id, b.code]));
  const serviceKey = new Map(services.map((s) => [s.id, s.code || s.name_en]));
  const list = (ids: string[] | undefined, names: Map<string, string>) =>
    (ids ?? []).map((id) => names.get(id)).filter((v): v is string => !!v).sort().join('; ') || null;
  const rows = employees.map((e) => [
    e.code, e.name_en, e.name_ar, e.job_title, e.phone, e.email, e.gender, yesNo(e.is_bookable), yesNo(e.is_active), e.hired_on,
    list(assignments.branches.get(e.id), branchCode), list(assignments.services.get(e.id), serviceKey), e.sort_order,
  ]);
  return { header: HEADER, rows };
}

/** An example file: the headers and two sample rows. */
export function employeeTemplateTable(branchCode = 'MAIN'): Table {
  return {
    header: HEADER,
    rows: [
      ['E-01', 'Fatma Al Harthy', 'فاطمة الحارثي', 'Senior stylist', '+96890000001', 'fatma@example.com', 'female', 'yes', 'yes', '2024-01-15', branchCode, 'all', 1],
      ['E-02', 'Salim Al Balushi', 'سالم البلوشي', 'Barber', '+96890000002', null, 'male', 'yes', 'yes', '2025-03-01', branchCode, null, 2],
    ],
  };
}

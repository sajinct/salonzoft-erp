import { Injectable, inject } from '@angular/core';
import { Tables, TablesInsert } from '../../../core/supabase/database.types';
import { unwrap } from '../../../core/supabase/app-error';
import { SUPABASE } from '../../../core/supabase/supabase.client';
import type { ImportResult } from '../../../shared/import/table-io';
import type { EmployeeImportRow } from './employees-io';

export type Employee = Tables<'employees'>;
export type StaffShift = Tables<'staff_shifts'>;
export type StaffLeave = Tables<'staff_leaves'>;
export type EmployeeInput = Omit<TablesInsert<'employees'>, 'id' | 'tenant_id' | 'created_at' | 'updated_at'>;
export type LeaveInput = Pick<TablesInsert<'staff_leaves'>, 'employee_id' | 'leave_type' | 'starts_at' | 'ends_at' | 'reason' | 'status'>;

export interface ShiftInput {
  branch_id: string;
  day_of_week: number;
  starts_at: string;
  ends_at: string;
}

export interface EmployeeAssignments {
  branches: Map<string, string[]>;
  services: Map<string, string[]>;
}

function group(rows: { employee_id: string }[], key: 'branch_id' | 'service_id'): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const row of rows as Record<string, string>[]) {
    const list = map.get(row['employee_id']) ?? [];
    list.push(row[key]);
    map.set(row['employee_id'], list);
  }
  return map;
}

@Injectable({ providedIn: 'root' })
export class EmployeesService {
  private readonly sb = inject(SUPABASE);

  async list(tenantId: string): Promise<{ employees: Employee[]; assignments: EmployeeAssignments }> {
    const [employees, branches, services] = await Promise.all([
      this.sb.from('employees').select('*').eq('tenant_id', tenantId).order('is_active', { ascending: false }).order('sort_order').order('name_en'),
      this.sb.from('employee_branches').select('employee_id, branch_id').eq('tenant_id', tenantId),
      this.sb.from('employee_services').select('employee_id, service_id').eq('tenant_id', tenantId),
    ]);
    return {
      employees: unwrap(employees),
      assignments: { branches: group(unwrap(branches), 'branch_id'), services: group(unwrap(services), 'service_id') },
    };
  }

  async create(tenantId: string, input: EmployeeInput): Promise<Employee> {
    return unwrap(await this.sb.from('employees').insert({ ...input, tenant_id: tenantId }).select('*').single());
  }

  async update(id: string, input: Partial<EmployeeInput>): Promise<Employee> {
    return unwrap(await this.sb.from('employees').update(input).eq('id', id).select('*').single());
  }

  /** Add or update employees from an imported file; a dry run only validates. */
  async import(tenantId: string, rows: EmployeeImportRow[], dryRun: boolean): Promise<ImportResult> {
    const result = unwrap(await this.sb.rpc('import_employees', { p_tenant: tenantId, p_rows: rows as unknown as never, p_dry_run: dryRun }));
    return result as unknown as ImportResult;
  }

  async setAssignments(employeeId: string, branchIds: string[], serviceIds: string[]): Promise<void> {
    unwrap(await this.sb.rpc('set_employee_assignments', { p_employee_id: employeeId, p_branch_ids: branchIds, p_service_ids: serviceIds }));
  }

  async shifts(employeeId: string): Promise<StaffShift[]> {
    return unwrap(await this.sb.from('staff_shifts').select('*').eq('employee_id', employeeId).order('day_of_week').order('starts_at'));
  }

  async setShifts(employeeId: string, shifts: ShiftInput[]): Promise<void> {
    unwrap(await this.sb.rpc('set_employee_shifts', { p_employee_id: employeeId, p_shifts: shifts as unknown as never }));
  }

  /** Leave that ends within the last 30 days or later, newest first. */
  async leaves(employeeId: string): Promise<StaffLeave[]> {
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
    return unwrap(
      await this.sb.from('staff_leaves').select('*').eq('employee_id', employeeId).gte('ends_at', since).order('starts_at', { ascending: false }).limit(50),
    );
  }

  async addLeave(tenantId: string, input: LeaveInput): Promise<StaffLeave> {
    return unwrap(await this.sb.from('staff_leaves').insert({ ...input, tenant_id: tenantId }).select('*').single());
  }

  async setLeaveStatus(id: string, status: StaffLeave['status']): Promise<void> {
    unwrap(await this.sb.from('staff_leaves').update({ status }).eq('id', id).select('id').single());
  }
}

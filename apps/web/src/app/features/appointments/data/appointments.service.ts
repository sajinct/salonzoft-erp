import { Injectable, inject } from '@angular/core';
import { RealtimeChannel } from '@supabase/supabase-js';
import { unwrap } from '../../../core/supabase/app-error';
import { SUPABASE } from '../../../core/supabase/supabase.client';

export type AppointmentStatus = 'booked' | 'confirmed' | 'checked_in' | 'in_service' | 'completed' | 'cancelled' | 'no_show';
export type Range = [string, string];

export interface CalendarEmployee {
  id: string;
  name_en: string;
  name_ar: string | null;
  color: string | null;
  job_title: string | null;
  working: Range[];
}

export interface CalendarLine {
  id: string;
  service_id: string;
  employee_id: string;
  starts_at: string;
  ends_at: string;
  service_name_en: string;
  service_name_ar: string | null;
  price: number;
  price_type: string;
}

export interface CalendarAppointment {
  id: string;
  status: AppointmentStatus;
  starts_at: string;
  ends_at: string;
  source: string;
  notes: string | null;
  cancel_reason: string | null;
  customer: { id: string; first_name: string; last_name: string | null; name_ar: string | null; mobile: string | null } | null;
  lines: CalendarLine[];
}

export interface CalendarData {
  branch: { id: string; timezone: string; name_en: string; name_ar: string | null };
  can_manage: boolean;
  my_employee_ids: string[];
  open: Range[];
  employees: CalendarEmployee[];
  appointments: CalendarAppointment[];
}

export interface Slot {
  starts_at: string;
  employee_id: string;
}

export interface BookingItem {
  service_id: string;
  employee_id: string | null;
}

/** Transitions the front desk can offer for a status (mirrors the SQL state machine). */
export const NEXT_STATUSES: Record<AppointmentStatus, AppointmentStatus[]> = {
  booked: ['confirmed', 'checked_in', 'in_service', 'no_show', 'cancelled'],
  confirmed: ['checked_in', 'in_service', 'no_show', 'cancelled'],
  checked_in: ['in_service', 'completed', 'cancelled'],
  in_service: ['completed'],
  completed: [],
  cancelled: [],
  no_show: [],
};

@Injectable({ providedIn: 'root' })
export class AppointmentsService {
  private readonly sb = inject(SUPABASE);

  async calendar(branchId: string, from: Date, to: Date): Promise<CalendarData> {
    const data = unwrap(await this.sb.rpc('get_calendar', { p_branch_id: branchId, p_from: from.toISOString(), p_to: to.toISOString() }));
    return data as unknown as CalendarData;
  }

  async availability(branchId: string, serviceIds: string[], date: string, employeeId: string | null, excludeAppointment?: string): Promise<Slot[]> {
    return (
      unwrap(
        await this.sb.rpc('calculate_availability', {
          p_branch_id: branchId,
          p_service_ids: serviceIds,
          p_date: date,
          p_employee_id: employeeId ?? undefined,
          p_exclude_appointment: excludeAppointment,
        }),
      ) ?? []
    );
  }

  async create(input: {
    tenantId: string;
    branchId: string;
    customerId: string | null;
    startsAt: string;
    items: BookingItem[];
    notes: string | null;
    source: string;
    idempotencyKey: string;
  }): Promise<{ appointment_id: string; replayed: boolean }> {
    const res = unwrap(
      await this.sb.rpc('create_appointment', {
        p_tenant: input.tenantId,
        p_branch_id: input.branchId,
        p_customer_id: input.customerId as string, // null = walk-in without a profile
        p_starts_at: input.startsAt,
        p_items: input.items as unknown as never,
        p_notes: input.notes ?? undefined,
        p_source: input.source,
        p_idempotency_key: input.idempotencyKey,
      }),
    );
    return res as unknown as { appointment_id: string; replayed: boolean };
  }

  async reschedule(appointmentId: string, startsAt: string, employeeId: string | null): Promise<void> {
    unwrap(await this.sb.rpc('reschedule_appointment', { p_appointment_id: appointmentId, p_starts_at: startsAt, p_employee_id: employeeId ?? undefined }));
  }

  async setStatus(appointmentId: string, status: AppointmentStatus, reason?: string): Promise<void> {
    unwrap(await this.sb.rpc('set_appointment_status', { p_appointment_id: appointmentId, p_status: status, p_reason: reason }));
  }

  async update(appointmentId: string, customerId: string | null, notes: string | null): Promise<void> {
    unwrap(await this.sb.rpc('update_appointment', { p_appointment_id: appointmentId, p_customer_id: customerId as string, p_notes: notes as string }));
  }

  /**
   * Live updates for a branch. Supabase checks RLS per subscriber, so users
   * only receive events for appointments they may read.
   */
  watchBranch(branchId: string, onChange: () => void): () => void {
    const channel: RealtimeChannel = this.sb
      .channel(`appointments:${branchId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'appointments', filter: `branch_id=eq.${branchId}` }, onChange)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'appointment_services', filter: `branch_id=eq.${branchId}` }, onChange)
      .subscribe();
    return () => void this.sb.removeChannel(channel);
  }
}

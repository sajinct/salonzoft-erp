import { Injectable, inject } from '@angular/core';
import { unwrap } from '../../../core/supabase/app-error';
import { SUPABASE } from '../../../core/supabase/supabase.client';

/** Everything the public booking page may know about a salon (see public_get_salon). */
export interface PublicSalon {
  salon: { name: string; name_ar: string | null; slug: string };
  settings: {
    currency_code: string;
    currency_decimals: number;
    timezone: string;
    default_language: 'en' | 'ar';
    lead_minutes: number;
    horizon_days: number;
    cancel_hours: number;
    note_en: string | null;
    note_ar: string | null;
  };
  branches: { id: string; name_en: string; name_ar: string | null; address_en: string | null; address_ar: string | null; city: string | null; phone: string | null; timezone: string }[];
  categories: { id: string; name_en: string; name_ar: string | null }[];
  services: {
    id: string;
    category_id: string | null;
    name_en: string;
    name_ar: string | null;
    description_en: string | null;
    description_ar: string | null;
    duration_minutes: number;
    price: number;
    price_type: string;
    unavailable_branch_ids: string[];
  }[];
  staff: { id: string; name_en: string; name_ar: string | null; color: string | null; branch_ids: string[]; service_ids: string[] }[];
}

export interface PublicBooking {
  status: string;
  starts_at: string;
  ends_at: string;
  salon: { name: string; name_ar: string | null; slug: string };
  branch: { name_en: string; name_ar: string | null; phone: string | null; address_en: string | null; address_ar: string | null; timezone: string };
  services: { name_en: string; name_ar: string | null; staff_en: string; staff_ar: string | null }[];
  can_cancel: boolean;
  cancel_hours: number;
}

export interface BookingRequest {
  slug: string;
  branchId: string;
  serviceIds: string[];
  employeeId: string | null;
  startsAt: string;
  firstName: string;
  lastName: string | null;
  mobile: string;
  email: string | null;
  notes: string | null;
  consent: boolean;
  key: string;
}

/** Calls only the anonymous public_* functions — works without signing in. */
@Injectable({ providedIn: 'root' })
export class BookingService {
  private readonly sb = inject(SUPABASE);

  async salon(slug: string): Promise<PublicSalon> {
    return unwrap(await this.sb.rpc('public_get_salon', { p_slug: slug })) as unknown as PublicSalon;
  }

  async slots(slug: string, branchId: string, serviceIds: string[], date: string, employeeId: string | null): Promise<{ starts_at: string; employee_id: string }[]> {
    return (
      unwrap(
        await this.sb.rpc('public_availability', {
          p_slug: slug,
          p_branch_id: branchId,
          p_service_ids: serviceIds,
          p_date: date,
          p_employee_id: employeeId ?? undefined,
        }),
      ) ?? []
    );
  }

  async book(r: BookingRequest): Promise<{ appointment_id: string; token: string }> {
    return unwrap(
      await this.sb.rpc('public_create_booking', {
        p_slug: r.slug,
        p_branch_id: r.branchId,
        p_service_ids: r.serviceIds,
        p_employee_id: r.employeeId as string,
        p_starts_at: r.startsAt,
        p_first_name: r.firstName,
        p_last_name: r.lastName as string,
        p_mobile: r.mobile,
        p_email: r.email as string,
        p_notes: r.notes as string,
        p_consent_reminders: r.consent,
        p_idempotency_key: r.key,
      }),
    ) as unknown as { appointment_id: string; token: string };
  }

  async booking(token: string): Promise<PublicBooking> {
    return unwrap(await this.sb.rpc('public_get_booking', { p_token: token })) as unknown as PublicBooking;
  }

  async cancel(token: string): Promise<void> {
    unwrap(await this.sb.rpc('public_cancel_booking', { p_token: token }));
  }
}

import { Injectable, inject } from '@angular/core';
import { unwrap } from '../../core/supabase/app-error';
import { SUPABASE } from '../../core/supabase/supabase.client';

export const BUSINESS_TYPES = [
  'unisex_salon', 'beauty_salon', 'barbershop', 'nail_studio', 'makeup_studio', 'spa', 'multi_concept',
] as const;
export type BusinessType = (typeof BUSINESS_TYPES)[number];

export interface CreateBusinessInput {
  name: string;
  slug: string;
  businessType: BusinessType;
  branchName: string;
  language: 'en' | 'ar';
  idempotencyKey: string;
}

/** Turn "Al Noor Spa & Salon" into "al-noor-spa-salon" (Latin only; Arabic names → user types a slug). */
export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
}

@Injectable({ providedIn: 'root' })
export class OnboardingService {
  private readonly sb = inject(SUPABASE);

  async isSlugAvailable(slug: string): Promise<boolean> {
    return unwrap(await this.sb.rpc('is_slug_available', { p_slug: slug })) === true;
  }

  /** Atomic server-side provisioning (tenant, settings, trial, roles, owner, main branch). Idempotent. */
  async createBusiness(input: CreateBusinessInput): Promise<{ tenant_id: string; branch_id: string; slug: string }> {
    const result = unwrap(
      await this.sb.rpc('create_tenant', {
        p_name: input.name,
        p_slug: input.slug,
        p_business_type: input.businessType,
        p_branch_name: input.branchName,
        p_default_language: input.language,
        p_idempotency_key: input.idempotencyKey,
      }),
    );
    return result as unknown as { tenant_id: string; branch_id: string; slug: string };
  }
}

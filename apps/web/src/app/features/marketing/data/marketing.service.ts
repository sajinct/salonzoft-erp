import { Injectable, inject } from '@angular/core';
import { Tables } from '../../../core/supabase/database.types';
import { unwrap } from '../../../core/supabase/app-error';
import { SUPABASE } from '../../../core/supabase/supabase.client';

export type Campaign = Tables<'campaigns'>;
export interface Segment {
  inactive_days?: number;
  active_days?: number;
  min_visits?: number;
  min_spend?: number;
  tags?: string[];
  gender?: 'female' | 'male';
  home_branch_id?: string;
  birthday_this_month?: boolean;
  members_only?: boolean;
}
export interface CampaignStats {
  campaign_id: string;
  queued: number;
  sent: number;
  failed: number;
  skipped: number;
  cancelled: number;
}
export interface FeedbackSummary {
  requested: number;
  responses: number;
  average: number | null;
  distribution: Record<string, number>;
  staff: { employee_id: string; name_en: string; name_ar: string | null; average: number; responses: number }[];
  recent: { rating: number; comment: string | null; submitted_at: string; customer: string }[];
}
export interface CampaignInput {
  name: string;
  channel: string;
  segment: Segment;
  subject_en: string | null;
  subject_ar: string | null;
  body_en: string;
  body_ar: string | null;
  scheduled_for: string | null;
}

@Injectable({ providedIn: 'root' })
export class MarketingService {
  private readonly sb = inject(SUPABASE);

  async campaigns(tenantId: string): Promise<Campaign[]> {
    return unwrap(await this.sb.from('campaigns').select('*').eq('tenant_id', tenantId).order('created_at', { ascending: false }).limit(100));
  }

  async stats(tenantId: string): Promise<CampaignStats[]> {
    return (unwrap(await this.sb.rpc('get_campaign_stats', { p_tenant: tenantId })) ?? []) as CampaignStats[];
  }

  async save(tenantId: string, id: string | null, input: CampaignInput): Promise<Campaign> {
    const row = { ...input, segment: input.segment as unknown as never };
    return id
      ? unwrap(await this.sb.from('campaigns').update(row).eq('id', id).select('*').single())
      : unwrap(await this.sb.from('campaigns').insert({ ...row, tenant_id: tenantId }).select('*').single());
  }

  async remove(id: string): Promise<void> {
    unwrap(await this.sb.from('campaigns').delete().eq('id', id));
  }

  async preview(tenantId: string, segment: Segment, channel: string): Promise<{ count: number; sample: string[]; consented: number }> {
    return unwrap(
      await this.sb.rpc('preview_campaign_audience', { p_tenant: tenantId, p_segment: segment as unknown as never, p_channel: channel }),
    ) as unknown as { count: number; sample: string[]; consented: number };
  }

  async launch(id: string): Promise<{ recipients: number; scheduled_for: string }> {
    return unwrap(await this.sb.rpc('launch_campaign', { p_campaign_id: id })) as unknown as { recipients: number; scheduled_for: string };
  }

  async cancel(id: string): Promise<number> {
    return unwrap(await this.sb.rpc('cancel_campaign', { p_campaign_id: id })) as number;
  }

  async feedback(tenantId: string, from: string, to: string): Promise<FeedbackSummary> {
    return unwrap(await this.sb.rpc('get_feedback_summary', { p_tenant: tenantId, p_from: from, p_to: to })) as unknown as FeedbackSummary;
  }

  // ---- public (anon) ----------------------------------------------------------
  async getFeedback(token: string) {
    return unwrap(await this.sb.rpc('public_get_feedback', { p_token: token })) as unknown as {
      submitted: boolean;
      expired: boolean;
      rating: number | null;
      salon: { name: string; name_ar: string | null; slug: string };
      visit: { starts_at: string; timezone: string; branch_en: string; branch_ar: string | null };
      services: { name_en: string; name_ar: string | null; staff_en: string; staff_ar: string | null }[];
    };
  }

  async submitFeedback(token: string, rating: number, comment: string | null): Promise<void> {
    unwrap(await this.sb.rpc('public_submit_feedback', { p_token: token, p_rating: rating, p_comment: comment as string }));
  }

  async unsubscribe(token: string): Promise<{ salon: string; salon_ar: string | null }> {
    return unwrap(await this.sb.rpc('public_unsubscribe', { p_token: token })) as unknown as { salon: string; salon_ar: string | null };
  }
}

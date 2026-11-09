// Salonzoft · notification worker (Supabase Edge Function, Deno).
//
// Called every minute by pg_cron (see docs/06-deployment.md) with
//   Authorization: Bearer <NOTIFY_CRON_SECRET>
// It claims due jobs (claim_notification_jobs: FOR UPDATE SKIP LOCKED, so
// overlapping runs never send twice), sends each one through the channel's
// provider and reports the outcome (complete_notification_job retries with
// exponential backoff, up to 5 attempts).
//
// Providers (secrets via `supabase secrets set …`):
//   WhatsApp  WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID
//             WHATSAPP_TEMPLATE_<EVENT>_<LANG> (optional, e.g. WHATSAPP_TEMPLATE_BOOKING_REMINDER_AR=booking_reminder_ar)
//             Business-initiated WhatsApp messages need an approved template; without one a
//             plain text message is sent, which Meta only delivers inside the 24-hour window.
//   SMS       TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM
//   Email     RESEND_API_KEY, EMAIL_FROM
// A channel without credentials marks its jobs "skipped" (nothing is lost:
// the message text stays in the log).
import { createClient } from 'npm:@supabase/supabase-js@2.49.1';

interface Job {
  id: string;
  event: string;
  channel: 'whatsapp' | 'sms' | 'email';
  language: 'en' | 'ar';
  to_address: string | null;
  subject: string | null;
  body: string | null;
}

type Outcome =
  | { outcome: 'sent'; provider: string; id?: string }
  | { outcome: 'skipped'; provider: string; error: string }
  | { outcome: 'failed' | 'failed_permanent'; provider: string; error: string };

const env = (k: string) => Deno.env.get(k) ?? '';

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 4xx (except 408/429) won't succeed on retry. */
const permanent = (status: number) => status >= 400 && status < 500 && status !== 408 && status !== 429;

async function sendWhatsApp(job: Job): Promise<Outcome> {
  const token = env('WHATSAPP_TOKEN');
  const phoneId = env('WHATSAPP_PHONE_NUMBER_ID');
  if (!token || !phoneId) return { outcome: 'skipped', provider: 'whatsapp', error: 'WhatsApp is not configured' };
  const to = (job.to_address ?? '').replace(/^\+/, '');
  const template = env(`WHATSAPP_TEMPLATE_${job.event}_${job.language}`.toUpperCase());
  const payload = template
    ? {
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: {
          name: template,
          language: { code: job.language },
          components: [{ type: 'body', parameters: [{ type: 'text', text: job.body ?? '' }] }],
        },
      }
    : { messaging_product: 'whatsapp', to, type: 'text', text: { body: job.body ?? '', preview_url: true } };
  const res = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok) return { outcome: 'sent', provider: 'whatsapp', id: data?.messages?.[0]?.id };
  return { outcome: permanent(res.status) ? 'failed_permanent' : 'failed', provider: 'whatsapp', error: `${res.status} ${JSON.stringify(data?.error ?? data).slice(0, 300)}` };
}

async function sendSms(job: Job): Promise<Outcome> {
  const sid = env('TWILIO_ACCOUNT_SID');
  const auth = env('TWILIO_AUTH_TOKEN');
  const from = env('TWILIO_FROM');
  if (!sid || !auth || !from) return { outcome: 'skipped', provider: 'sms', error: 'SMS is not configured' };
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: `Basic ${btoa(`${sid}:${auth}`)}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ To: job.to_address ?? '', From: from, Body: job.body ?? '' }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok) return { outcome: 'sent', provider: 'twilio', id: data?.sid };
  return { outcome: permanent(res.status) ? 'failed_permanent' : 'failed', provider: 'twilio', error: `${res.status} ${data?.message ?? ''}`.slice(0, 300) };
}

async function sendEmail(job: Job): Promise<Outcome> {
  const key = env('RESEND_API_KEY');
  const from = env('EMAIL_FROM');
  if (!key || !from) return { outcome: 'skipped', provider: 'email', error: 'Email is not configured' };
  const html = `<div dir="${job.language === 'ar' ? 'rtl' : 'ltr'}" style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.6">${escapeHtml(job.body ?? '').replace(/\n/g, '<br>')}</div>`;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [job.to_address], subject: job.subject ?? 'Salonzoft', text: job.body, html }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok) return { outcome: 'sent', provider: 'resend', id: data?.id };
  return { outcome: permanent(res.status) ? 'failed_permanent' : 'failed', provider: 'resend', error: `${res.status} ${data?.message ?? ''}`.slice(0, 300) };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

async function send(job: Job): Promise<Outcome> {
  if (!job.to_address || !job.body) return { outcome: 'failed_permanent', provider: job.channel, error: 'Missing address or message' };
  try {
    if (job.channel === 'whatsapp') return await sendWhatsApp(job);
    if (job.channel === 'sms') return await sendSms(job);
    return await sendEmail(job);
  } catch (err) {
    return { outcome: 'failed', provider: job.channel, error: String(err).slice(0, 300) };
  }
}

Deno.serve(async (req) => {
  const secret = env('NOTIFY_CRON_SECRET');
  const given = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!secret || !timingSafeEqual(given, secret)) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }

  const db = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
  const { data: jobs, error } = await db.rpc('claim_notification_jobs', { p_limit: 50 });
  if (error) {
    console.error('claim failed', error);
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }

  const summary: Record<string, number> = {};
  for (const job of (jobs ?? []) as Job[]) {
    const result = await send(job);
    summary[result.outcome] = (summary[result.outcome] ?? 0) + 1;
    const { error: doneError } = await db.rpc('complete_notification_job', {
      p_job_id: job.id,
      p_outcome: result.outcome,
      p_provider: result.provider,
      p_provider_message_id: result.outcome === 'sent' ? (result.id ?? null) : null,
      p_error: result.outcome === 'sent' ? null : result.error,
    });
    if (doneError) console.error('complete failed', job.id, doneError);
  }
  // Never log message bodies or phone numbers (customer data).
  console.log(JSON.stringify({ claimed: jobs?.length ?? 0, ...summary }));
  return new Response(JSON.stringify({ claimed: jobs?.length ?? 0, ...summary }), { headers: { 'Content-Type': 'application/json' } });
});

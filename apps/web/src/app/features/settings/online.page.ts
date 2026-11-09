import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { LucideDynamicIcon } from '@lucide/angular';
import { environment } from '../../../environments/environment';
import { I18nService, TranslateDynamicPipe, TranslatePipe } from '../../core/i18n/i18n.service';
import { ToastService } from '../../core/services/toast.service';
import { Tables } from '../../core/supabase/database.types';
import { unwrap } from '../../core/supabase/app-error';
import { SUPABASE } from '../../core/supabase/supabase.client';
import { TenantContextService } from '../../core/tenant/tenant-context.service';
import { PageHeader, StatePanel } from '../../shared/components/ui';
import { LocalDatePipe } from '../../shared/pipes/format.pipes';
import { Branch, BranchesService } from './data/settings.services';

type Template = Tables<'notification_templates'>;
type Job = Tables<'notification_jobs'>;
type Defaults = { event: string; language: string; subject: string; body: string }[];
const EVENTS = ['booking_confirmed', 'booking_reminder', 'booking_cancelled'] as const;
const CHANNELS = ['whatsapp', 'sms', 'email'] as const;
const PLACEHOLDERS = ['{{name}}', '{{salon}}', '{{branch}}', '{{branch_phone}}', '{{date}}', '{{time}}', '{{services}}', '{{staff}}', '{{link}}', '{{book_link}}'];

/** Settings → Online booking & messages. */
@Component({
  selector: 'sz-online-settings-page',
  imports: [TranslatePipe, TranslateDynamicPipe, LucideDynamicIcon, PageHeader, StatePanel, LocalDatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <sz-page-header [heading]="'settings.online' | t" [subtitle]="'online.subtitle' | t" />
    @if (loading()) {
      <div class="card"><sz-state [loading]="true" /></div>
    } @else {
      <div class="space-y-6">
        <!-- Link -->
        <section class="card p-5">
          <h2 class="font-semibold">{{ 'online.link' | t }}</h2>
          @if (!moduleOn()) {
            <p class="mt-2 text-sm text-warning">{{ 'online.notInPlan' | t }}</p>
          } @else {
            <div class="mt-3 flex flex-wrap items-center gap-2">
              <code class="num flex-1 truncate rounded-xl bg-surface-2 px-3 py-2 text-sm" dir="ltr">{{ link() }}</code>
              <button type="button" class="btn-secondary btn-sm" (click)="copy(link())"><svg lucideIcon="copy" [size]="14"></svg>{{ 'common.copy' | t }}</button>
              <a class="btn-secondary btn-sm" [href]="link()" target="_blank" rel="noopener">{{ 'online.open' | t }}</a>
              <a class="btn-secondary btn-sm" [href]="'https://wa.me/?text=' + encode(link())" target="_blank" rel="noopener"><svg lucideIcon="message-circle" [size]="14"></svg>WhatsApp</a>
            </div>
            @if (!anyBranchOn()) { <p class="hint mt-2 text-warning">{{ 'online.noBranchOn' | t }}</p> }
          }
        </section>

        <!-- Branches -->
        @if (ctx.can('branches.manage')) {
          <section class="card p-5">
            <h2 class="font-semibold">{{ 'online.branches' | t }}</h2>
            <ul class="mt-3 space-y-2">
              @for (b of branches(); track b.id) {
                <li><label class="flex items-center gap-2 text-sm"><input type="checkbox" class="checkbox" [checked]="b.online_booking_enabled" (change)="toggleBranch(b, $any($event.target).checked)" />{{ i18n.pick(b.name_en, b.name_ar) }}</label></li>
              }
            </ul>
            <p class="hint mt-2">{{ 'online.servicesHint' | t }}</p>
          </section>
        }

        <!-- Rules + channels -->
        @if (ctx.can('settings.manage')) {
          <section class="card p-5">
            <h2 class="mb-3 font-semibold">{{ 'online.rules' | t }}</h2>
            <div class="grid gap-4 sm:grid-cols-3">
              <div class="field"><label class="label" for="olead">{{ 'online.leadMinutes' | t }}</label><input id="olead" class="input num" type="number" min="0" dir="ltr" [value]="s().online_booking_lead_minutes" (change)="set('online_booking_lead_minutes', +$any($event.target).value)" /></div>
              <div class="field"><label class="label" for="ohor">{{ 'online.horizonDays' | t }}</label><input id="ohor" class="input num" type="number" min="1" max="365" dir="ltr" [value]="s().online_booking_horizon_days" (change)="set('online_booking_horizon_days', +$any($event.target).value)" /></div>
              <div class="field"><label class="label" for="ocan">{{ 'online.cancelHours' | t }}</label><input id="ocan" class="input num" type="number" min="0" max="168" dir="ltr" [value]="s().online_booking_cancel_hours" (change)="set('online_booking_cancel_hours', +$any($event.target).value)" /></div>
              <div class="field sm:col-span-3"><label class="label" for="onen">{{ 'online.noteEn' | t }}</label><input id="onen" class="input" maxlength="500" [value]="s().online_booking_note_en ?? ''" (change)="set('online_booking_note_en', $any($event.target).value || null)" /></div>
              <div class="field sm:col-span-3"><label class="label" for="onar">{{ 'online.noteAr' | t }}</label><input id="onar" class="input" dir="rtl" lang="ar" maxlength="500" [value]="s().online_booking_note_ar ?? ''" (change)="set('online_booking_note_ar', $any($event.target).value || null)" /></div>
            </div>

            <h2 class="mb-1 mt-6 font-semibold">{{ 'online.messages' | t }}</h2>
            <p class="hint mb-3">{{ 'online.messagesHint' | t }}</p>
            <div class="flex flex-wrap gap-x-6 gap-y-2">
              <label class="flex items-center gap-2 text-sm"><input type="checkbox" class="checkbox" [checked]="s().notify_whatsapp" (change)="set('notify_whatsapp', $any($event.target).checked)" />WhatsApp</label>
              <label class="flex items-center gap-2 text-sm"><input type="checkbox" class="checkbox" [checked]="s().notify_sms" (change)="set('notify_sms', $any($event.target).checked)" />SMS</label>
              <label class="flex items-center gap-2 text-sm"><input type="checkbox" class="checkbox" [checked]="s().notify_email" (change)="set('notify_email', $any($event.target).checked)" />{{ 'common.email' | t }}</label>
            </div>
            <div class="field mt-3 w-48"><label class="label" for="orem">{{ 'online.reminderHours' | t }}</label><input id="orem" class="input num" type="number" min="1" max="168" dir="ltr" [value]="s().reminder_hours_before" (change)="set('reminder_hours_before', +$any($event.target).value)" /></div>
            <div class="mt-4 flex justify-end"><button type="button" class="btn-primary" [disabled]="saving() || !dirty()" (click)="saveSettings()">{{ 'common.save' | t }}</button></div>
          </section>
        }

        <!-- Templates -->
        @if (ctx.can('notifications.manage')) {
          <section class="card p-5">
            <h2 class="mb-3 font-semibold">{{ 'online.templates' | t }}</h2>
            <div class="flex flex-wrap gap-2">
              <select class="input w-52" [value]="event()" (change)="pick('event', $any($event.target).value)" [attr.aria-label]="'online.event' | t">
                @for (e of events; track e) { <option [value]="e">{{ 'online.eventName.' + e | tx }}</option> }
              </select>
              <select class="input w-36" [value]="channel()" (change)="pick('channel', $any($event.target).value)" [attr.aria-label]="'online.channel' | t">
                @for (c of channels; track c) { <option [value]="c">{{ 'customers.channel.' + c | tx }}</option> }
              </select>
              <select class="input w-32" [value]="language()" (change)="pick('language', $any($event.target).value)" [attr.aria-label]="'customers.language' | t">
                <option value="en">English</option><option value="ar">العربية</option>
              </select>
              <span class="self-center text-xs" [class]="current() ? 'text-primary' : 'text-muted'">{{ (current() ? 'online.custom' : 'online.usingDefault') | t }}</span>
            </div>
            @if (channel() === 'email') {
              <input class="input mt-3" [dir]="language() === 'ar' ? 'rtl' : 'ltr'" maxlength="200" [placeholder]="'online.subject' | t" [value]="subject()" (input)="subject.set($any($event.target).value)" />
            }
            <textarea class="input mt-3" rows="4" maxlength="1500" [dir]="language() === 'ar' ? 'rtl' : 'ltr'" [value]="body()" (input)="body.set($any($event.target).value)"></textarea>
            <p class="hint mt-1">{{ 'online.placeholders' | t }} <span class="num" dir="ltr">{{ placeholders }}</span></p>
            @if (preview()) { <p class="mt-3 whitespace-pre-line rounded-xl bg-surface-2 p-3 text-sm" [dir]="language() === 'ar' ? 'rtl' : 'ltr'">{{ preview() }}</p> }
            <div class="mt-3 flex flex-wrap justify-end gap-2">
              <button type="button" class="btn-ghost btn-sm" (click)="showPreview()">{{ 'online.preview' | t }}</button>
              @if (current()) { <button type="button" class="btn-ghost btn-sm text-danger" (click)="resetTemplate()">{{ 'online.resetDefault' | t }}</button> }
              <button type="button" class="btn-primary btn-sm" [disabled]="saving() || body().trim().length < 5" (click)="saveTemplate()">{{ 'common.save' | t }}</button>
            </div>
          </section>

          <section class="card overflow-x-auto">
            <h2 class="px-5 pt-5 font-semibold">{{ 'online.log' | t }}</h2>
            <table class="table">
              <thead><tr><th>{{ 'appointments.date' | t }}</th><th>{{ 'online.event' | t }}</th><th>{{ 'online.channel' | t }}</th><th>{{ 'common.status' | t }}</th></tr></thead>
              <tbody>
                @for (j of jobs(); track j.id) {
                  <tr>
                    <td class="text-muted">{{ (j.sent_at ?? j.scheduled_for) | localDate: 'datetime' }}</td>
                    <td>{{ 'online.eventName.' + j.event | tx }}</td>
                    <td>{{ 'customers.channel.' + j.channel | tx }}</td>
                    <td><span [class]="statusClass(j.status)">{{ 'online.status.' + j.status | tx }}</span>@if (j.last_error) { <span class="block text-xs text-muted">{{ j.last_error }}</span> }</td>
                  </tr>
                } @empty {
                  <tr><td colspan="4" class="py-6 text-center text-muted">{{ 'online.noMessages' | t }}</td></tr>
                }
              </tbody>
            </table>
          </section>
        }
      </div>
    }
  `,
})
export class OnlineSettingsPage implements OnInit {
  protected readonly ctx = inject(TenantContextService);
  protected readonly i18n = inject(I18nService);
  private readonly sb = inject(SUPABASE);
  private readonly branchesApi = inject(BranchesService);
  private readonly toast = inject(ToastService);

  protected readonly events = EVENTS;
  protected readonly channels = CHANNELS;
  protected readonly placeholders = PLACEHOLDERS.join('  ');
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly branches = signal<Branch[]>([]);
  protected readonly s = signal<Tables<'tenant_settings'>>({} as Tables<'tenant_settings'>);
  private readonly changes = signal<Partial<Tables<'tenant_settings'>>>({});
  protected readonly dirty = computed(() => Object.keys(this.changes()).length > 0);
  protected readonly templates = signal<Template[]>([]);
  private readonly defaults = signal<Defaults>([]);
  protected readonly jobs = signal<Job[]>([]);
  protected readonly event = signal<string>('booking_confirmed');
  protected readonly channel = signal<string>('whatsapp');
  protected readonly language = signal<string>('en');
  protected readonly subject = signal('');
  protected readonly body = signal('');
  protected readonly preview = signal('');

  protected readonly moduleOn = computed(() => this.ctx.hasModule('online_booking'));
  protected readonly anyBranchOn = computed(() => this.branches().some((b) => b.online_booking_enabled && b.is_active));
  protected readonly link = computed(() => `${environment.appUrl}/book/${this.ctx.context()?.tenant.slug ?? ''}`);
  protected readonly current = computed(() =>
    this.templates().find((t) => t.event === this.event() && t.channel === this.channel() && t.language === this.language()),
  );

  async ngOnInit(): Promise<void> {
    const tenantId = this.ctx.tenantId();
    if (!tenantId) return;
    try {
      const canMsg = this.ctx.can('notifications.manage');
      const [branches, settings, templates, defaults, jobs] = await Promise.all([
        this.branchesApi.list(tenantId),
        this.sb.from('tenant_settings').select('*').eq('tenant_id', tenantId).single(),
        canMsg ? this.sb.from('notification_templates').select('*').eq('tenant_id', tenantId) : Promise.resolve({ data: [], error: null }),
        canMsg ? this.sb.rpc('get_notification_defaults') : Promise.resolve({ data: [], error: null }),
        canMsg ? this.sb.from('notification_jobs').select('*').eq('tenant_id', tenantId).order('created_at', { ascending: false }).limit(50) : Promise.resolve({ data: [], error: null }),
      ]);
      this.branches.set(branches);
      this.s.set(unwrap(settings));
      this.templates.set(unwrap(templates) as Template[]);
      this.defaults.set((unwrap(defaults) ?? []) as Defaults);
      this.jobs.set(unwrap(jobs) as Job[]);
      this.fillEditor();
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.loading.set(false);
    }
  }

  protected encode(v: string): string {
    return encodeURIComponent(v);
  }

  protected async copy(v: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(v);
      this.toast.success(this.i18n.t('common.copied'));
    } catch {
      /* clipboard unavailable */
    }
  }

  protected async toggleBranch(b: Branch, on: boolean): Promise<void> {
    try {
      const updated = await this.branchesApi.update(b.id, { online_booking_enabled: on });
      this.branches.update((list) => list.map((x) => (x.id === b.id ? updated : x)));
    } catch (err) {
      this.toast.error(err);
    }
  }

  protected set<K extends keyof Tables<'tenant_settings'>>(key: K, value: Tables<'tenant_settings'>[K]): void {
    this.s.update((s) => ({ ...s, [key]: value }));
    this.changes.update((c) => ({ ...c, [key]: value }));
  }

  async saveSettings(): Promise<void> {
    const tenantId = this.ctx.tenantId();
    if (!tenantId) return;
    this.saving.set(true);
    try {
      unwrap(await this.sb.from('tenant_settings').update(this.changes()).eq('tenant_id', tenantId).select('tenant_id').single());
      this.changes.set({});
      this.toast.success(this.i18n.t('common.saved'));
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.saving.set(false);
    }
  }

  protected pick(field: 'event' | 'channel' | 'language', value: string): void {
    ({ event: this.event, channel: this.channel, language: this.language })[field].set(value);
    this.fillEditor();
  }

  private fillEditor(): void {
    const t = this.current();
    const d = this.defaults().find((x) => x.event === this.event() && x.language === this.language());
    this.subject.set(t?.subject ?? d?.subject ?? '');
    this.body.set(t?.body ?? d?.body ?? '');
    this.preview.set('');
  }

  async showPreview(): Promise<void> {
    const tenantId = this.ctx.tenantId();
    if (!tenantId) return;
    try {
      this.preview.set(unwrap(await this.sb.rpc('preview_notification', { p_tenant: tenantId, p_body: this.body() })) as string);
    } catch (err) {
      this.toast.error(err);
    }
  }

  async saveTemplate(): Promise<void> {
    const tenantId = this.ctx.tenantId();
    if (!tenantId) return;
    this.saving.set(true);
    try {
      const existing = this.current();
      const subject = this.channel() === 'email' ? this.subject().trim() || null : null;
      const row: Template = existing
        ? unwrap(await this.sb.from('notification_templates').update({ body: this.body().trim(), subject, is_active: true }).eq('id', existing.id).select('*').single())
        : unwrap(
            await this.sb
              .from('notification_templates')
              .insert({ tenant_id: tenantId, event: this.event(), channel: this.channel(), language: this.language(), body: this.body().trim(), subject })
              .select('*')
              .single(),
          );
      this.templates.update((list) => [...list.filter((t) => t.id !== row.id), row]);
      this.toast.success(this.i18n.t('common.saved'));
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.saving.set(false);
    }
  }

  async resetTemplate(): Promise<void> {
    const existing = this.current();
    if (!existing) return;
    try {
      unwrap(await this.sb.from('notification_templates').delete().eq('id', existing.id));
      this.templates.update((list) => list.filter((t) => t.id !== existing.id));
      this.fillEditor();
    } catch (err) {
      this.toast.error(err);
    }
  }

  protected statusClass(status: string): string {
    return status === 'sent' ? 'badge-success' : status === 'failed' ? 'badge-danger' : status === 'queued' || status === 'sending' ? 'badge-warning' : 'badge-muted';
  }
}

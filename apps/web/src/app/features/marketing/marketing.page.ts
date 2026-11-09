import { Dialog, DialogRef, DIALOG_DATA } from '@angular/cdk/dialog';
import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { LucideDynamicIcon } from '@lucide/angular';
import { I18nService, TranslateDynamicPipe, TranslatePipe } from '../../core/i18n/i18n.service';
import { ToastService } from '../../core/services/toast.service';
import { TenantContextService } from '../../core/tenant/tenant-context.service';
import { ConfirmService, PageHeader, StatePanel } from '../../shared/components/ui';
import { LocalDatePipe } from '../../shared/pipes/format.pipes';
import { addDays, zonedDate } from '../appointments/data/calendar-time';
import { Campaign, CampaignStats, FeedbackSummary, MarketingService, Segment } from './data/marketing.service';

type Tab = 'campaigns' | 'feedback';

// ---------------------------------------------------------------------------
// Campaign editor
// ---------------------------------------------------------------------------
@Component({
  selector: 'sz-campaign-dialog',
  imports: [TranslatePipe, TranslateDynamicPipe, LucideDynamicIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="card flex max-h-[94vh] w-[min(44rem,calc(100vw-2rem))] flex-col" role="dialog" aria-modal="true">
      <header class="flex items-center justify-between border-b border-line px-6 py-4">
        <h2 class="text-lg font-semibold">{{ (data ? 'marketing.editCampaign' : 'marketing.newCampaign') | t }}</h2>
        <button type="button" class="btn-icon" (click)="ref.close()" [attr.aria-label]="'common.close' | t"><svg lucideIcon="x" [size]="18"></svg></button>
      </header>
      <div class="flex-1 space-y-5 overflow-y-auto px-6 py-5 text-sm">
        <div class="grid gap-3 sm:grid-cols-[1fr_12rem]">
          <div class="field"><label class="label" for="cname">{{ 'marketing.campaignName' | t }}</label><input id="cname" class="input" maxlength="120" [value]="name()" (input)="name.set($any($event.target).value)" /></div>
          <div class="field">
            <label class="label" for="cch">{{ 'online.channel' | t }}</label>
            <select id="cch" class="input" [value]="channel()" (change)="channel.set($any($event.target).value); refresh()">
              @for (c of channels; track c) { <option [value]="c">{{ 'customers.channel.' + c | tx }}</option> }
            </select>
          </div>
        </div>

        <section>
          <h3 class="label mb-2">{{ 'marketing.audience' | t }}</h3>
          <div class="grid gap-3 sm:grid-cols-3">
            <div class="field"><label class="label text-xs" for="sin">{{ 'marketing.inactiveDays' | t }}</label><input id="sin" class="input num" type="number" min="1" dir="ltr" [value]="seg().inactive_days ?? ''" (change)="setNum('inactive_days', $any($event.target).value)" /></div>
            <div class="field"><label class="label text-xs" for="sact">{{ 'marketing.activeDays' | t }}</label><input id="sact" class="input num" type="number" min="1" dir="ltr" [value]="seg().active_days ?? ''" (change)="setNum('active_days', $any($event.target).value)" /></div>
            <div class="field"><label class="label text-xs" for="svis">{{ 'marketing.minVisits' | t }}</label><input id="svis" class="input num" type="number" min="1" dir="ltr" [value]="seg().min_visits ?? ''" (change)="setNum('min_visits', $any($event.target).value)" /></div>
            <div class="field"><label class="label text-xs" for="sspend">{{ 'marketing.minSpend' | t }}</label><input id="sspend" class="input num" type="number" min="0" dir="ltr" [value]="seg().min_spend ?? ''" (change)="setNum('min_spend', $any($event.target).value)" /></div>
            <div class="field"><label class="label text-xs" for="stags">{{ 'customers.tags' | t }}</label><input id="stags" class="input" [value]="(seg().tags ?? []).join(', ')" (change)="setTags($any($event.target).value)" /></div>
            <div class="field">
              <label class="label text-xs" for="sgen">{{ 'common.gender' | t }}</label>
              <select id="sgen" class="input" [value]="seg().gender ?? ''" (change)="setSeg('gender', $any($event.target).value || undefined)">
                <option value="">{{ 'common.all' | t }}</option><option value="female">{{ 'common.female' | t }}</option><option value="male">{{ 'common.male' | t }}</option>
              </select>
            </div>
          </div>
          <div class="mt-3 flex flex-wrap gap-x-6 gap-y-2">
            <label class="flex items-center gap-2"><input type="checkbox" class="checkbox" [checked]="!!seg().birthday_this_month" (change)="setSeg('birthday_this_month', $any($event.target).checked || undefined)" />{{ 'marketing.birthdayMonth' | t }}</label>
            <label class="flex items-center gap-2"><input type="checkbox" class="checkbox" [checked]="!!seg().members_only" (change)="setSeg('members_only', $any($event.target).checked || undefined)" />{{ 'marketing.membersOnly' | t }}</label>
          </div>
          <div class="mt-3 rounded-xl bg-surface-2 px-4 py-3">
            @if (audience(); as a) {
              <p><strong class="num">{{ a.count }}</strong> {{ 'marketing.recipients' | t }} @if (a.sample.length) { <span class="text-muted">· {{ a.sample.join(', ') }}</span> }</p>
              <p class="hint">{{ 'marketing.consentNote' | t: { n: a.consented } }}</p>
            } @else { <p class="text-muted">{{ 'common.loading' | t }}</p> }
          </div>
        </section>

        <section class="space-y-3">
          @if (channel() === 'email') {
            <div class="grid gap-3 sm:grid-cols-2">
              <input class="input" maxlength="200" [placeholder]="'online.subject' | t" [value]="subjectEn()" (input)="subjectEn.set($any($event.target).value)" />
              <input class="input" dir="rtl" lang="ar" maxlength="200" [placeholder]="('online.subject' | t) + ' (AR)'" [value]="subjectAr()" (input)="subjectAr.set($any($event.target).value)" />
            </div>
          }
          <div class="field"><label class="label" for="ben">{{ 'marketing.messageEn' | t }}</label><textarea id="ben" class="input" rows="3" maxlength="1000" [value]="bodyEn()" (input)="bodyEn.set($any($event.target).value)"></textarea></div>
          <div class="field"><label class="label" for="bar">{{ 'marketing.messageAr' | t }}</label><textarea id="bar" class="input" rows="3" dir="rtl" lang="ar" maxlength="1000" [value]="bodyAr()" (input)="bodyAr.set($any($event.target).value)"></textarea></div>
          <p class="hint">{{ 'marketing.placeholders' | t }} <span class="num" dir="ltr">{{ placeholders }}</span> · {{ 'marketing.optOutNote' | t }}</p>
        </section>

        <section class="field w-72">
          <label class="label" for="csched">{{ 'marketing.sendAt' | t }}</label>
          <input id="csched" class="input" type="datetime-local" dir="ltr" [value]="schedule()" (change)="schedule.set($any($event.target).value)" />
          <p class="hint">{{ 'marketing.sendAtHint' | t }}</p>
        </section>
      </div>
      <footer class="flex flex-wrap justify-between gap-2 border-t border-line px-6 py-4">
        @if (data) { <button type="button" class="btn-ghost text-danger" (click)="remove()">{{ 'common.delete' | t }}</button> } @else { <span></span> }
        <div class="flex gap-2">
          <button type="button" class="btn-secondary" [disabled]="busy()" (click)="save(false)">{{ 'purchases.saveDraft' | t }}</button>
          <button type="button" class="btn-primary" [disabled]="busy() || !audience()?.count" (click)="save(true)">
            <svg lucideIcon="megaphone" [size]="15"></svg>{{ (schedule() ? 'marketing.schedule' : 'marketing.sendNow') | t }} ({{ audience()?.count ?? 0 }})
          </button>
        </div>
      </footer>
    </div>
  `,
})
export class CampaignDialog {
  protected readonly ref = inject<DialogRef<boolean>>(DialogRef);
  protected readonly data = inject<Campaign | null>(DIALOG_DATA);
  protected readonly i18n = inject(I18nService);
  private readonly api = inject(MarketingService);
  private readonly ctx = inject(TenantContextService);
  private readonly toast = inject(ToastService);
  private readonly confirm = inject(ConfirmService);

  protected readonly channels = ['whatsapp', 'sms', 'email'] as const;
  protected readonly placeholders = ['name', 'salon', 'book_link', 'unsubscribe_link'].map((p) => '{{' + p + '}}').join('  ');
  protected readonly name = signal(this.data?.name ?? '');
  protected readonly channel = signal<string>(this.data?.channel ?? 'whatsapp');
  protected readonly seg = signal<Segment>((this.data?.segment as Segment) ?? {});
  protected readonly subjectEn = signal(this.data?.subject_en ?? '');
  protected readonly subjectAr = signal(this.data?.subject_ar ?? '');
  protected readonly bodyEn = signal(this.data?.body_en ?? '');
  protected readonly bodyAr = signal(this.data?.body_ar ?? '');
  protected readonly schedule = signal(this.data?.scheduled_for ? this.data.scheduled_for.slice(0, 16) : '');
  protected readonly audience = signal<{ count: number; sample: string[]; consented: number } | null>(null);
  protected readonly busy = signal(false);
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    inject(DestroyRef).onDestroy(() => clearTimeout(this.timer));
    this.refresh();
  }

  protected setSeg<K extends keyof Segment>(key: K, value: Segment[K] | undefined): void {
    this.seg.update((s) => {
      const next = { ...s };
      if (value === undefined) delete next[key];
      else next[key] = value;
      return next;
    });
    this.refresh();
  }

  protected setNum(key: 'inactive_days' | 'active_days' | 'min_visits' | 'min_spend', raw: string): void {
    const n = Number(raw);
    this.setSeg(key, raw.trim() && Number.isFinite(n) && n > 0 ? n : undefined);
  }

  protected setTags(raw: string): void {
    const tags = raw.split(/[,;]/).map((t) => t.trim()).filter(Boolean);
    this.setSeg('tags', tags.length ? tags : undefined);
  }

  /** Debounced audience count. */
  refresh(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      const tenantId = this.ctx.tenantId();
      if (!tenantId) return;
      try {
        this.audience.set(await this.api.preview(tenantId, this.seg(), this.channel()));
      } catch (err) {
        this.toast.error(err);
      }
    }, 300);
  }

  async save(launch: boolean): Promise<void> {
    const tenantId = this.ctx.tenantId();
    if (!tenantId || this.name().trim().length < 2 || this.bodyEn().trim().length < 5) {
      this.toast.error({ message: 'INVALID_VALUE' });
      return;
    }
    if (launch) {
      const ok = await this.confirm.ask({
        title: this.i18n.t(this.schedule() ? 'marketing.schedule' : 'marketing.sendNow'),
        message: this.i18n.t('marketing.confirmLaunch', { n: this.audience()?.count ?? 0 }),
        confirmLabel: this.i18n.t(this.schedule() ? 'marketing.schedule' : 'marketing.sendNow'),
      });
      if (!ok) return;
    }
    this.busy.set(true);
    try {
      const saved = await this.api.save(tenantId, this.data?.id ?? null, {
        name: this.name().trim(),
        channel: this.channel(),
        segment: this.seg(),
        subject_en: this.subjectEn().trim() || null,
        subject_ar: this.subjectAr().trim() || null,
        body_en: this.bodyEn().trim(),
        body_ar: this.bodyAr().trim() || null,
        scheduled_for: this.schedule() ? new Date(this.schedule()).toISOString() : null,
      });
      if (launch) {
        const r = await this.api.launch(saved.id);
        this.toast.success(this.i18n.t('marketing.launched', { n: r.recipients }));
      } else {
        this.toast.success(this.i18n.t('common.saved'));
      }
      this.ref.close(true);
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.busy.set(false);
    }
  }

  async remove(): Promise<void> {
    if (!this.data) return;
    try {
      await this.api.remove(this.data.id);
      this.ref.close(true);
    } catch (err) {
      this.toast.error(err);
    }
  }
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
@Component({
  selector: 'sz-marketing-page',
  imports: [TranslatePipe, TranslateDynamicPipe, LucideDynamicIcon, PageHeader, StatePanel, LocalDatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <sz-page-header [heading]="'nav.marketing' | t" [subtitle]="'marketing.subtitle' | t">
      @if (tab() === 'campaigns' && ctx.can('marketing.manage')) {
        <button type="button" class="btn-primary" (click)="open(null)"><svg lucideIcon="plus" [size]="16"></svg>{{ 'marketing.newCampaign' | t }}</button>
      }
    </sz-page-header>
    <div class="mb-4 flex flex-wrap gap-2">
      @for (t of tabs(); track t) {
        <button type="button" [class]="tab() === t ? 'btn-primary btn-sm' : 'btn-secondary btn-sm'" (click)="tab.set(t)">{{ 'marketing.tab.' + t | tx }}</button>
      }
      @if (tab() === 'feedback') {
        <select class="input ms-auto w-44" [value]="period()" (change)="period.set(+$any($event.target).value)" [attr.aria-label]="'pos.period' | t">
          <option value="7">{{ 'finance.period.week' | t }}</option><option value="30">{{ 'finance.period.last30' | t }}</option><option value="90">{{ 'marketing.last90' | t }}</option>
        </select>
      }
    </div>

    @if (loading()) {
      <div class="card"><sz-state [loading]="true" /></div>
    } @else if (tab() === 'campaigns') {
      <div class="card overflow-x-auto">
        <table class="table">
          <thead><tr><th>{{ 'marketing.campaignName' | t }}</th><th>{{ 'online.channel' | t }}</th><th>{{ 'common.status' | t }}</th><th class="text-end">{{ 'marketing.delivery' | t }}</th><th></th></tr></thead>
          <tbody>
            @for (c of campaigns(); track c.id) {
              <tr>
                <td><p class="font-medium">{{ c.name }}</p><p class="text-xs text-muted">{{ (c.scheduled_for ?? c.created_at) | localDate: 'datetime' }}</p></td>
                <td>{{ 'customers.channel.' + c.channel | tx }}</td>
                <td><span [class]="c.status === 'launched' ? 'badge-success' : c.status === 'cancelled' ? 'badge-danger' : 'badge-muted'">{{ 'marketing.status.' + c.status | tx }}</span></td>
                <td class="num text-end text-xs">
                  @if (statsOf(c.id); as s) {
                    {{ 'marketing.deliveryLine' | t: { sent: s.sent, total: c.recipients, queued: s.queued, failed: s.failed + s.skipped } }}
                  } @else { — }
                </td>
                <td class="whitespace-nowrap text-end">
                  @if (c.status === 'draft' && ctx.can('marketing.manage')) { <button type="button" class="btn-ghost btn-sm" (click)="open(c)">{{ 'common.edit' | t }}</button> }
                  @if (c.status === 'launched' && (statsOf(c.id)?.queued ?? 0) > 0 && ctx.can('marketing.manage')) { <button type="button" class="btn-ghost btn-sm text-danger" (click)="stop(c)">{{ 'marketing.stop' | t }}</button> }
                </td>
              </tr>
            } @empty {
              <tr><td colspan="5"><sz-state icon="megaphone" [heading]="'marketing.noCampaigns' | t" [message]="'marketing.noCampaignsHint' | t" /></td></tr>
            }
          </tbody>
        </table>
      </div>
    } @else if (feedback(); as f) {
      <div class="grid gap-3 sm:grid-cols-3">
        <div class="card p-4"><p class="text-xs text-muted">{{ 'marketing.averageRating' | t }}</p><p class="mt-1 text-2xl font-semibold">{{ f.average ?? '—' }} <span class="text-warning">★</span></p></div>
        <div class="card p-4"><p class="text-xs text-muted">{{ 'marketing.responses' | t }}</p><p class="num mt-1 text-2xl font-semibold">{{ f.responses }}</p></div>
        <div class="card p-4"><p class="text-xs text-muted">{{ 'marketing.responseRate' | t }}</p><p class="num mt-1 text-2xl font-semibold">{{ rate(f) }}</p></div>
      </div>
      <div class="mt-5 grid gap-5 lg:grid-cols-2">
        <section class="card p-5">
          <h2 class="mb-3 font-semibold">{{ 'marketing.byStaff' | t }}</h2>
          <ul class="space-y-2 text-sm">
            @for (s of f.staff; track s.employee_id) {
              <li class="flex justify-between"><span>{{ i18n.pick(s.name_en, s.name_ar) }} <span class="text-xs text-muted">({{ s.responses }})</span></span><span class="font-semibold">{{ s.average }} ★</span></li>
            } @empty { <li class="text-muted">{{ 'marketing.noFeedback' | t }}</li> }
          </ul>
        </section>
        <section class="card p-5">
          <h2 class="mb-3 font-semibold">{{ 'marketing.comments' | t }}</h2>
          <ul class="space-y-3 text-sm">
            @for (r of f.recent; track $index) {
              <li><p><span class="text-warning">{{ stars(r.rating) }}</span> <span class="text-xs text-muted">{{ r.customer }} · {{ r.submitted_at | localDate }}</span></p>@if (r.comment) { <p>{{ r.comment }}</p> }</li>
            } @empty { <li class="text-muted">{{ 'marketing.noFeedback' | t }}</li> }
          </ul>
        </section>
      </div>
    }
  `,
})
export class MarketingPage {
  protected readonly ctx = inject(TenantContextService);
  protected readonly i18n = inject(I18nService);
  private readonly api = inject(MarketingService);
  private readonly dialog = inject(Dialog);
  private readonly toast = inject(ToastService);
  private readonly confirm = inject(ConfirmService);

  protected readonly tabs = computed<Tab[]>(() => [
    ...(this.ctx.can('marketing.manage') ? (['campaigns'] as const) : []),
    ...(this.ctx.canAny(['marketing.manage', 'reports.view']) ? (['feedback'] as const) : []),
  ]);
  protected readonly tab = signal<Tab>('campaigns');
  protected readonly period = signal(30);
  protected readonly loading = signal(true);
  protected readonly campaigns = signal<Campaign[]>([]);
  protected readonly stats = signal<CampaignStats[]>([]);
  protected readonly feedback = signal<FeedbackSummary | null>(null);

  constructor() {
    effect(() => {
      const tabs = this.tabs();
      if (tabs.length && !tabs.includes(this.tab())) this.tab.set(tabs[0]);
    });
    effect(() => {
      const tab = this.tab();
      const days = this.period();
      untracked(() => void this.load(tab, days));
    });
  }

  private async load(tab: Tab, days: number): Promise<void> {
    const tenantId = this.ctx.tenantId();
    if (!tenantId) return;
    this.loading.set(true);
    try {
      if (tab === 'campaigns') {
        const [campaigns, stats] = await Promise.all([this.api.campaigns(tenantId), this.api.stats(tenantId)]);
        this.campaigns.set(campaigns);
        this.stats.set(stats);
      } else {
        const today = zonedDate(new Date(), this.ctx.context()?.settings.timezone ?? 'Asia/Muscat');
        this.feedback.set(await this.api.feedback(tenantId, addDays(today, -(days - 1)), today));
      }
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.loading.set(false);
    }
  }

  protected statsOf(id: string): CampaignStats | undefined {
    return this.stats().find((s) => s.campaign_id === id);
  }

  protected rate(f: FeedbackSummary): string {
    return f.requested ? Math.round((f.responses / f.requested) * 100) + '%' : '—';
  }

  protected stars(n: number): string {
    return '★'.repeat(n) + '☆'.repeat(5 - n);
  }

  open(c: Campaign | null): void {
    this.dialog.open<boolean, Campaign | null>(CampaignDialog, { data: c }).closed.subscribe((changed) => changed && void this.load(this.tab(), this.period()));
  }

  async stop(c: Campaign): Promise<void> {
    const ok = await this.confirm.ask({ title: this.i18n.t('marketing.stop'), message: this.i18n.t('marketing.confirmStop'), confirmLabel: this.i18n.t('marketing.stop'), danger: true });
    if (!ok) return;
    try {
      await this.api.cancel(c.id);
      void this.load(this.tab(), this.period());
    } catch (err) {
      this.toast.error(err);
    }
  }
}

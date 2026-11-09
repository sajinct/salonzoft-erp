import { Dialog } from '@angular/cdk/dialog';
import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { LucideDynamicIcon } from '@lucide/angular';
import { I18nService, TranslateDynamicPipe, TranslatePipe } from '../../core/i18n/i18n.service';
import { ToastService } from '../../core/services/toast.service';
import { TenantContextService } from '../../core/tenant/tenant-context.service';
import { ConfirmService, StatePanel } from '../../shared/components/ui';
import { LocalDatePipe, MoneyPipe } from '../../shared/pipes/format.pipes';
import { PosService, Wallet } from '../pos/data/pos.service';
import { CustomerDialog } from './customer-dialog';
import {
  ConsentChannel,
  ConsentPurpose,
  Customer,
  CustomerConsent,
  CustomerNote,
  CustomersService,
  currentConsents,
} from './data/customers.service';

@Component({
  selector: 'sz-customer-detail-page',
  imports: [ReactiveFormsModule, RouterLink, TranslatePipe, TranslateDynamicPipe, LucideDynamicIcon, StatePanel, LocalDatePipe, MoneyPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <a routerLink="/customers" class="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
      <svg lucideIcon="arrow-left" [size]="15" class="rtl:rotate-180"></svg>{{ 'nav.customers' | t }}
    </a>

    @if (loading()) {
      <div class="card"><sz-state [loading]="true" /></div>
    } @else if (customer(); as c) {
      <div class="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 class="page-title">{{ c.first_name }} {{ c.last_name }}</h1>
          @if (c.name_ar) { <p class="mt-1 text-muted" dir="rtl" lang="ar">{{ c.name_ar }}</p> }
          <div class="mt-2 flex flex-wrap items-center gap-2">
            @if (c.status !== 'active') { <span [class]="c.status === 'blocked' ? 'badge-danger' : 'badge-muted'">{{ 'customers.status.' + c.status | tx }}</span> }
            @for (t of c.tags; track t) { <span class="badge-primary">{{ t }}</span> }
          </div>
        </div>
        <div class="flex flex-wrap gap-2">
          @if (c.mobile) {
            <a class="btn-secondary" [href]="'https://wa.me/' + c.mobile.replace('+', '')" target="_blank" rel="noopener noreferrer"><svg lucideIcon="message-circle" [size]="16"></svg>WhatsApp</a>
            <a class="btn-secondary" [href]="'tel:' + c.mobile"><svg lucideIcon="phone" [size]="16"></svg>{{ 'customers.call' | t }}</a>
          }
          @if (canManage()) {
            <button type="button" class="btn-primary" (click)="edit(c)"><svg lucideIcon="pencil" [size]="16"></svg>{{ 'common.edit' | t }}</button>
          }
        </div>
      </div>

      <div class="grid gap-6 lg:grid-cols-[1fr_1.4fr]">
        <div class="space-y-6">
          <section class="card p-5">
            <h2 class="mb-3 font-semibold">{{ 'customers.details' | t }}</h2>
            <dl class="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-2 text-sm">
              <dt class="text-muted">{{ 'common.mobile' | t }}</dt><dd class="num" dir="ltr">{{ c.mobile || '—' }}</dd>
              <dt class="text-muted">{{ 'common.email' | t }}</dt><dd dir="ltr" class="break-all">{{ c.email || '—' }}</dd>
              <dt class="text-muted">{{ 'common.gender' | t }}</dt><dd>{{ c.gender ? ('common.' + c.gender | tx) : '—' }}</dd>
              <dt class="text-muted">{{ 'customers.dateOfBirth' | t }}</dt><dd>{{ c.date_of_birth ? (c.date_of_birth | localDate) : '—' }}</dd>
              <dt class="text-muted">{{ 'customers.language' | t }}</dt><dd>{{ c.preferred_language === 'ar' ? ('common.arabic' | t) : c.preferred_language === 'en' ? ('common.english' | t) : '—' }}</dd>
              <dt class="text-muted">{{ 'customers.homeBranch' | t }}</dt><dd>{{ branchName(c.home_branch_id) }}</dd>
              <dt class="text-muted">{{ 'customers.source' | t }}</dt><dd>{{ 'customers.sourceName.' + c.source | tx }}</dd>
              <dt class="text-muted">{{ 'customers.since' | t }}</dt><dd>{{ c.created_at | localDate }}</dd>
            </dl>
          </section>

          @if (wallet(); as w) {
            @if (w.membership || w.packages.length || w.vouchers.length) {
              <section class="card p-5">
                <h2 class="mb-3 font-semibold">{{ 'customers.wallet' | t }}</h2>
                <div class="space-y-2 text-sm">
                  @if (w.membership; as m) {
                    <p><span class="badge-primary">{{ i18n.pick(m.name_en, m.name_ar) }} · −{{ m.discount_percent }}%</span> <span class="text-muted">{{ 'customers.until' | t }} {{ m.ends_at | localDate }}</span></p>
                  }
                  @for (p of w.packages; track p.id) {
                    <div class="rounded-xl bg-surface-2 p-3">
                      <p class="font-medium">{{ i18n.pick(p.name_en, p.name_ar) }}@if (p.expires_at) { <span class="text-xs text-muted"> · {{ 'customers.until' | t }} {{ p.expires_at | localDate }}</span> }</p>
                      @for (b of p.balances; track b.service_id) { <p class="text-muted">{{ i18n.pick(b.service_name_en, b.service_name_ar) }}: <strong class="text-ink">{{ b.remaining }}</strong> / {{ b.total }}</p> }
                    </div>
                  }
                  @for (v of w.vouchers; track v.id) {
                    <p class="flex justify-between"><span>{{ 'pos.voucherKind.' + v.kind | tx }} @if (v.code) { <span class="num text-xs text-muted" dir="ltr">{{ v.code }}</span> }</span><span class="num font-medium">{{ v.balance | money }}</span></p>
                  }
                </div>
              </section>
            }
          }

          <section class="card p-5">
            <h2 class="font-semibold">{{ 'customers.consent' | t }}</h2>
            <p class="hint mb-3">{{ 'customers.consentHint' | t }}</p>
            <table class="w-full text-sm">
              <thead><tr><th></th>@for (p of purposes; track p) { <th class="pb-2 text-center text-xs font-semibold text-muted">{{ 'customers.purpose.' + p | tx }}</th> }</tr></thead>
              <tbody>
                @for (ch of channels; track ch) {
                  <tr>
                    <td class="py-1.5 font-medium">{{ 'customers.channel.' + ch | tx }}</td>
                    @for (p of purposes; track p) {
                      <td class="text-center">
                        <input type="checkbox" class="checkbox" [checked]="consentState().get(ch + ':' + p)?.granted ?? false" [disabled]="!canManage() || busy()"
                               (change)="setConsent(ch, p, $any($event.target).checked)" [attr.aria-label]="ch + ' ' + p" />
                      </td>
                    }
                  </tr>
                }
              </tbody>
            </table>
            @if (consents().length > 0) {
              <details class="mt-3 text-xs text-muted">
                <summary class="cursor-pointer">{{ 'customers.consentHistory' | t }} ({{ consents().length }})</summary>
                <ul class="mt-2 space-y-1">
                  @for (h of consents(); track h.id) {
                    <li>{{ h.recorded_at | localDate: 'datetime' }} · {{ 'customers.channel.' + h.channel | tx }} / {{ 'customers.purpose.' + h.purpose | tx }} ·
                      <strong>{{ (h.granted ? 'customers.granted' : 'customers.withdrawn') | t }}</strong> ({{ 'customers.consentSource.' + h.source | tx }})</li>
                  }
                </ul>
              </details>
            }
          </section>
        </div>

        <section class="card p-5">
          <h2 class="mb-3 font-semibold">{{ 'customers.notes' | t }}</h2>
          @if (canManage()) {
            <form [formGroup]="noteForm" class="mb-4 space-y-2" (ngSubmit)="addNote()" novalidate>
              <textarea class="input" rows="3" formControlName="body" maxlength="2000" [placeholder]="'customers.notePlaceholder' | t"></textarea>
              <div class="flex flex-wrap items-center gap-3">
                <select class="input h-9 w-44" formControlName="kind" [attr.aria-label]="'customers.noteKind' | t">
                  @for (k of noteKinds(); track k) { <option [value]="k">{{ 'customers.noteKindName.' + k | tx }}</option> }
                </select>
                <label class="flex items-center gap-2 text-sm"><input type="checkbox" class="checkbox" formControlName="is_pinned" />{{ 'customers.pin' | t }}</label>
                <button type="submit" class="btn-secondary ms-auto" [disabled]="busy() || noteForm.invalid">{{ 'customers.addNote' | t }}</button>
              </div>
            </form>
          }
          <ul class="space-y-3">
            @for (n of notes(); track n.id) {
              <li class="rounded-xl border p-3" [class]="n.is_sensitive ? 'border-danger/30 bg-danger-soft/40' : 'border-line'">
                <div class="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted">
                  <span [class]="n.is_sensitive ? 'badge-danger' : 'badge-muted'">{{ 'customers.noteKindName.' + n.kind | tx }}</span>
                  @if (n.is_pinned) { <svg lucideIcon="pin" [size]="12"></svg> }
                  <span>{{ n.created_at | localDate: 'datetime' }}</span>
                  @if (canManage()) {
                    <button type="button" class="btn-ghost btn-sm ms-auto" (click)="togglePin(n)">{{ (n.is_pinned ? 'customers.unpin' : 'customers.pin') | t }}</button>
                    <button type="button" class="btn-icon h-7 w-7" (click)="deleteNote(n)" [attr.aria-label]="'common.delete' | t"><svg lucideIcon="trash-2" [size]="14"></svg></button>
                  }
                </div>
                <p class="whitespace-pre-line text-sm">{{ n.body }}</p>
              </li>
            } @empty {
              <li class="py-6 text-center text-sm text-muted">{{ 'customers.noNotes' | t }}</li>
            }
          </ul>
          @if (!canSeeSensitive()) { <p class="hint mt-3">{{ 'customers.sensitiveHidden' | t }}</p> }
        </section>
      </div>
    } @else {
      <div class="card"><sz-state icon="user-x" [heading]="'errors.notFoundTitle' | t" /></div>
    }
  `,
})
export class CustomerDetailPage implements OnInit {
  /** Route parameter (component input binding). */
  readonly id = input.required<string>();

  private readonly service = inject(CustomersService);
  private readonly pos = inject(PosService);
  protected readonly wallet = signal<Wallet | null>(null);
  private readonly ctx = inject(TenantContextService);
  private readonly dialog = inject(Dialog);
  private readonly toast = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  protected readonly i18n = inject(I18nService);

  protected readonly channels: ConsentChannel[] = ['whatsapp', 'sms', 'email'];
  protected readonly purposes: ConsentPurpose[] = ['reminders', 'marketing'];
  protected readonly loading = signal(true);
  protected readonly busy = signal(false);
  protected readonly customer = signal<Customer | null>(null);
  protected readonly notes = signal<CustomerNote[]>([]);
  protected readonly consents = signal<CustomerConsent[]>([]);
  protected readonly consentState = computed(() => currentConsents(this.consents()));
  protected readonly canManage = computed(() => this.ctx.can('customers.manage'));
  protected readonly canSeeSensitive = computed(() => this.ctx.can('customers.sensitive'));
  protected readonly noteKinds = computed(() =>
    this.canSeeSensitive() ? (['general', 'preference', 'allergy', 'medical'] as const) : (['general', 'preference'] as const),
  );

  protected readonly noteForm = inject(NonNullableFormBuilder).group({
    body: ['', [Validators.required, Validators.maxLength(2000)]],
    kind: ['general' as CustomerNote['kind']],
    is_pinned: [false],
  });

  ngOnInit(): void {
    void this.load();
  }

  async load(): Promise<void> {
    try {
      const [customer, notes, consents] = await Promise.all([
        this.service.get(this.id()),
        this.service.notes(this.id()),
        this.service.consents(this.id()),
      ]);
      this.customer.set(customer);
      this.notes.set(notes);
      this.consents.set(consents);
      // Packages, membership and vouchers (hidden when the role can't see them).
      this.pos.wallet(this.id()).then((w) => this.wallet.set(w), () => this.wallet.set(null));
    } catch {
      this.customer.set(null); // not found or not permitted (RLS) — same answer
    } finally {
      this.loading.set(false);
    }
  }

  protected branchName(id: string | null): string {
    const b = this.ctx.branches().find((x) => x.id === id);
    return b ? this.i18n.pick(b.name_en, b.name_ar) : '—';
  }

  edit(c: Customer): void {
    this.dialog.open<Customer, Customer | null>(CustomerDialog, { data: c }).closed.subscribe((saved) => {
      if (saved) this.customer.set(saved);
    });
  }

  async setConsent(channel: ConsentChannel, purpose: ConsentPurpose, granted: boolean): Promise<void> {
    const tenantId = this.ctx.tenantId();
    if (!tenantId) return;
    await this.run(async () => {
      await this.service.recordConsent(tenantId, this.id(), channel, purpose, granted);
      this.consents.set(await this.service.consents(this.id()));
    });
  }

  async addNote(): Promise<void> {
    const tenantId = this.ctx.tenantId();
    if (!tenantId || this.noteForm.invalid) return;
    const v = this.noteForm.getRawValue();
    await this.run(async () => {
      await this.service.addNote(tenantId, this.id(), { kind: v.kind, body: v.body.trim(), is_pinned: v.is_pinned });
      this.noteForm.reset({ body: '', kind: 'general', is_pinned: false });
      this.notes.set(await this.service.notes(this.id()));
    });
  }

  async togglePin(note: CustomerNote): Promise<void> {
    await this.run(async () => {
      await this.service.setNotePinned(note.id, !note.is_pinned);
      this.notes.set(await this.service.notes(this.id()));
    });
  }

  async deleteNote(note: CustomerNote): Promise<void> {
    const ok = await this.confirm.ask({
      title: this.i18n.t('common.delete'),
      message: this.i18n.t('customers.confirmDeleteNote'),
      confirmLabel: this.i18n.t('common.delete'),
      danger: true,
    });
    if (!ok) return;
    await this.run(async () => {
      await this.service.deleteNote(note.id);
      this.notes.update((list) => list.filter((n) => n.id !== note.id));
    });
  }

  private async run(work: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    try {
      await work();
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.busy.set(false);
    }
  }
}

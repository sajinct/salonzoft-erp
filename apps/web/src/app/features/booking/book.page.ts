import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideDynamicIcon } from '@lucide/angular';
import { I18nService, TranslateDynamicPipe, TranslatePipe } from '../../core/i18n/i18n.service';
import { ToastService } from '../../core/services/toast.service';
import { StatePanel } from '../../shared/components/ui';
import { formatMoney } from '../../shared/money/money';
import { addDays, zonedDate, zonedInstant, zonedTime } from '../appointments/data/calendar-time';
import { BookingService, PublicSalon } from './data/booking.service';

type Step = 'services' | 'time' | 'details' | 'done';

/** Public, no-login booking page: /book/:slug */
@Component({
  selector: 'sz-book-page',
  imports: [TranslatePipe, TranslateDynamicPipe, LucideDynamicIcon, StatePanel, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="min-h-screen bg-bg">
      <header class="sticky top-0 z-10 border-b border-line bg-surface/90 backdrop-blur">
        <div class="mx-auto flex max-w-2xl items-center gap-3 px-4 py-3">
          <span class="grid h-9 w-9 place-items-center rounded-xl bg-primary text-on-primary"><svg lucideIcon="sparkles" [size]="18"></svg></span>
          <div class="min-w-0 flex-1">
            <p class="truncate font-semibold">{{ salon() ? i18n.pick(salon()!.salon.name, salon()!.salon.name_ar) : ('app.name' | t) }}</p>
            <p class="text-xs text-muted">{{ 'book.title' | t }}</p>
          </div>
          <button type="button" class="btn-ghost btn-sm" (click)="i18n.toggle()">{{ i18n.lang() === 'en' ? 'العربية' : 'English' }}</button>
        </div>
      </header>

      <main class="mx-auto max-w-2xl px-4 py-6">
        @if (loading()) {
          <div class="card"><sz-state [loading]="true" /></div>
        } @else if (!salon()) {
          <div class="card"><sz-state icon="calendar-days" [heading]="'book.unavailable' | t" [message]="'book.unavailableHint' | t" /></div>
        } @else {
          @let s = salon()!;
          @if (step() !== 'done') {
            <ol class="mb-5 flex gap-2 text-xs font-medium">
              @for (st of steps; track st; let i = $index) {
                <li class="flex-1 rounded-full py-1 text-center" [class]="stepIndex() >= i ? 'bg-primary text-on-primary' : 'bg-surface-2 text-muted'">{{ i + 1 }}. {{ 'book.step.' + st | tx }}</li>
              }
            </ol>
          }

          @switch (step()) {
            @case ('services') {
              @if (s.branches.length > 1) {
                <section class="mb-5">
                  <h2 class="label mb-2">{{ 'book.chooseBranch' | t }}</h2>
                  <div class="grid gap-2 sm:grid-cols-2">
                    @for (b of s.branches; track b.id) {
                      <button type="button" class="card p-3 text-start" [class.ring-2]="branchId() === b.id" [class.ring-primary]="branchId() === b.id" (click)="chooseBranch(b.id)">
                        <p class="font-semibold">{{ i18n.pick(b.name_en, b.name_ar) }}</p>
                        <p class="text-xs text-muted">{{ i18n.pick(b.address_en, b.address_ar) || b.city }}</p>
                      </button>
                    }
                  </div>
                </section>
              }
              @if (note()) { <p class="mb-4 rounded-xl bg-primary-soft px-4 py-3 text-sm">{{ note() }}</p> }
              <h2 class="label mb-2">{{ 'book.chooseServices' | t }}</h2>
              @for (g of groups(); track g.id) {
                <section class="mb-4">
                  <h3 class="mb-2 text-sm font-semibold text-muted">{{ g.name }}</h3>
                  <ul class="space-y-2">
                    @for (sv of g.services; track sv.id) {
                      <li>
                        <label class="card flex cursor-pointer items-start gap-3 p-3" [class.ring-2]="picked().has(sv.id)" [class.ring-primary]="picked().has(sv.id)">
                          <input type="checkbox" class="checkbox mt-1" [checked]="picked().has(sv.id)" (change)="toggle(sv.id)" />
                          <span class="flex-1">
                            <span class="block font-medium">{{ i18n.pick(sv.name_en, sv.name_ar) }}</span>
                            @if (i18n.pick(sv.description_en, sv.description_ar)) { <span class="block text-xs text-muted">{{ i18n.pick(sv.description_en, sv.description_ar) }}</span> }
                            <span class="text-xs text-muted">{{ 'services.minutes' | t: { n: sv.duration_minutes } }}</span>
                          </span>
                          <span class="num text-sm font-semibold">{{ price(sv) }}</span>
                        </label>
                      </li>
                    }
                  </ul>
                </section>
              }
              <div class="sticky bottom-0 -mx-4 border-t border-line bg-surface px-4 py-3">
                <button type="button" class="btn-primary w-full" [disabled]="picked().size === 0" (click)="toTime()">
                  {{ 'book.continueWith' | t: { n: picked().size, minutes: totalMinutes() } }}
                </button>
              </div>
            }

            @case ('time') {
              <section class="mb-4">
                <h2 class="label mb-2">{{ 'book.chooseStaff' | t }}</h2>
                <div class="flex flex-wrap gap-2">
                  <button type="button" [class]="employeeId() === null ? 'btn-primary btn-sm' : 'btn-secondary btn-sm'" (click)="chooseStaff(null)">{{ 'appointments.anyStaff' | t }}</button>
                  @for (e of qualifiedStaff(); track e.id) {
                    <button type="button" [class]="employeeId() === e.id ? 'btn-primary btn-sm' : 'btn-secondary btn-sm'" (click)="chooseStaff(e.id)">{{ i18n.pick(e.name_en, e.name_ar) }}</button>
                  }
                </div>
              </section>
              <section class="mb-4">
                <h2 class="label mb-2">{{ 'book.chooseDay' | t }}</h2>
                <div class="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
                  @for (d of days(); track d) {
                    <button type="button" class="shrink-0 rounded-xl border px-3 py-2 text-center" [class]="date() === d ? 'border-primary bg-primary text-on-primary' : 'border-line bg-surface'" (click)="chooseDate(d)">
                      <span class="block text-xs">{{ weekday(d) }}</span><span class="num block text-lg font-semibold">{{ d.slice(8) }}</span>
                    </button>
                  }
                </div>
              </section>
              <section>
                <h2 class="label mb-2">{{ 'appointments.availableTimes' | t }}</h2>
                @if (loadingSlots()) {
                  <p class="text-sm text-muted">{{ 'common.loading' | t }}</p>
                } @else if (slots().length === 0) {
                  <p class="card p-4 text-sm text-muted">{{ 'book.noTimes' | t }}</p>
                } @else {
                  <div class="grid grid-cols-4 gap-2 sm:grid-cols-6">
                    @for (sl of slots(); track sl.starts_at) {
                      <button type="button" class="num rounded-xl border py-2 text-sm" dir="ltr" [class]="slot()?.starts_at === sl.starts_at ? 'border-primary bg-primary text-on-primary' : 'border-line bg-surface hover:border-primary'" (click)="slot.set(sl)">{{ time(sl.starts_at) }}</button>
                    }
                  </div>
                }
              </section>
              <div class="mt-6 flex gap-2">
                <button type="button" class="btn-secondary" (click)="step.set('services')">{{ 'common.back' | t }}</button>
                <button type="button" class="btn-primary flex-1" [disabled]="!slot()" (click)="step.set('details')">{{ 'common.continue' | t }}</button>
              </div>
            }

            @case ('details') {
              <div class="card mb-4 p-4 text-sm">
                <p class="font-semibold">{{ summaryLine() }}</p>
                <p class="text-muted">{{ servicesLine() }}</p>
              </div>
              <form class="grid gap-4 sm:grid-cols-2" (submit)="$event.preventDefault(); submit()" novalidate>
                <div class="field"><label class="label" for="bfn">{{ 'customers.firstName' | t }}</label><input id="bfn" class="input" autocomplete="given-name" maxlength="80" [value]="firstName()" (input)="firstName.set($any($event.target).value)" /></div>
                <div class="field"><label class="label" for="bln">{{ 'customers.lastName' | t }}</label><input id="bln" class="input" autocomplete="family-name" maxlength="80" [value]="lastName()" (input)="lastName.set($any($event.target).value)" /></div>
                <div class="field"><label class="label" for="bmob">{{ 'common.mobile' | t }}</label><input id="bmob" class="input num" type="tel" autocomplete="tel" dir="ltr" placeholder="9123 4567" [value]="mobile()" (input)="mobile.set($any($event.target).value)" /></div>
                <div class="field"><label class="label" for="bem">{{ 'common.email' | t }} <span class="hint">({{ 'common.optional' | t }})</span></label><input id="bem" class="input" type="email" autocomplete="email" dir="ltr" [value]="email()" (input)="email.set($any($event.target).value)" /></div>
                <div class="field sm:col-span-2"><label class="label" for="bnotes">{{ 'book.notes' | t }} <span class="hint">({{ 'common.optional' | t }})</span></label><input id="bnotes" class="input" maxlength="500" [value]="notes()" (input)="notes.set($any($event.target).value)" /></div>
                <label class="flex items-start gap-2 text-sm sm:col-span-2"><input type="checkbox" class="checkbox mt-0.5" [checked]="consent()" (change)="consent.set($any($event.target).checked)" />{{ 'book.consent' | t }}</label>
                <div class="flex gap-2 sm:col-span-2">
                  <button type="button" class="btn-secondary" (click)="step.set('time')">{{ 'common.back' | t }}</button>
                  <button type="submit" class="btn-primary flex-1" [disabled]="busy() || !firstName().trim() || mobile().replace(' ', '').length < 7">{{ busy() ? ('common.saving' | t) : ('book.confirm' | t) }}</button>
                </div>
              </form>
            }

            @case ('done') {
              <div class="card flex flex-col items-center gap-3 p-8 text-center">
                <span class="grid h-14 w-14 place-items-center rounded-full bg-success-soft text-success"><svg lucideIcon="circle-check" [size]="30"></svg></span>
                <h1 class="page-title">{{ 'book.booked' | t }}</h1>
                <p class="font-medium">{{ summaryLine() }}</p>
                <p class="text-sm text-muted">{{ servicesLine() }}</p>
                <a class="btn-secondary mt-2" [routerLink]="['/book/manage', token()]">{{ 'book.manage' | t }}</a>
                <p class="hint max-w-sm">{{ 'book.manageHint' | t: { hours: s.settings.cancel_hours } }}</p>
              </div>
            }
          }
        }
      </main>
    </div>
  `,
})
export class BookPage implements OnInit {
  readonly slug = input.required<string>();

  protected readonly i18n = inject(I18nService);
  private readonly api = inject(BookingService);
  private readonly toast = inject(ToastService);

  protected readonly steps = ['services', 'time', 'details'] as const;
  protected readonly loading = signal(true);
  protected readonly salon = signal<PublicSalon | null>(null);
  protected readonly step = signal<Step>('services');
  protected readonly branchId = signal<string | null>(null);
  protected readonly picked = signal(new Set<string>());
  protected readonly employeeId = signal<string | null>(null);
  protected readonly date = signal('');
  protected readonly slots = signal<{ starts_at: string; employee_id: string }[]>([]);
  protected readonly slot = signal<{ starts_at: string; employee_id: string } | null>(null);
  protected readonly loadingSlots = signal(false);
  protected readonly firstName = signal('');
  protected readonly lastName = signal('');
  protected readonly mobile = signal('');
  protected readonly email = signal('');
  protected readonly notes = signal('');
  protected readonly consent = signal(false); // explicit opt-in (PDPL)
  protected readonly busy = signal(false);
  protected readonly token = signal('');
  /** One key per booking attempt: retries never create a second booking. */
  private key = crypto.randomUUID();

  protected readonly stepIndex = computed(() => this.steps.indexOf(this.step() as (typeof this.steps)[number]));
  private readonly tz = computed(() => this.salon()?.branches.find((b) => b.id === this.branchId())?.timezone ?? this.salon()?.settings.timezone ?? 'Asia/Muscat');
  protected readonly note = computed(() => {
    const s = this.salon()?.settings;
    return s ? this.i18n.pick(s.note_en, s.note_ar) : '';
  });
  private readonly branchServices = computed(() => (this.salon()?.services ?? []).filter((sv) => !sv.unavailable_branch_ids.includes(this.branchId() ?? '')));
  protected readonly groups = computed(() => {
    const s = this.salon();
    if (!s) return [];
    const cats = [...s.categories.map((c) => ({ id: c.id, name: this.i18n.pick(c.name_en, c.name_ar) })), { id: '', name: this.i18n.t('book.other') }];
    return cats.map((c) => ({ ...c, services: this.branchServices().filter((sv) => (sv.category_id ?? '') === c.id) })).filter((c) => c.services.length);
  });
  protected readonly chosen = computed(() => this.branchServices().filter((sv) => this.picked().has(sv.id)));
  protected readonly totalMinutes = computed(() => this.chosen().reduce((m, sv) => m + sv.duration_minutes, 0));
  protected readonly qualifiedStaff = computed(() =>
    (this.salon()?.staff ?? []).filter((e) => e.branch_ids.includes(this.branchId() ?? '') && [...this.picked()].every((id) => e.service_ids.includes(id))),
  );
  protected readonly days = computed(() => {
    const s = this.salon();
    if (!s) return [];
    const today = zonedDate(new Date(), this.tz());
    return Array.from({ length: Math.min(s.settings.horizon_days, 21) + 1 }, (_, i) => addDays(today, i));
  });

  async ngOnInit(): Promise<void> {
    try {
      const salon = await this.api.salon(this.slug());
      this.salon.set(salon);
      this.branchId.set(salon.branches[0]?.id ?? null);
      if (!localStorageLang()) void this.i18n.setLang(salon.settings.default_language);
    } catch {
      this.salon.set(null);
    } finally {
      this.loading.set(false);
    }
  }

  protected price(sv: PublicSalon['services'][number]): string {
    if (sv.price_type === 'variable') return this.i18n.t('book.priceOnSite');
    const s = this.salon()!.settings;
    const amount = formatMoney(sv.price, { currency: s.currency_code, decimals: s.currency_decimals, locale: this.i18n.locale() });
    return sv.price_type === 'from' ? `${this.i18n.t('services.from')} ${amount}` : amount;
  }

  protected chooseBranch(id: string): void {
    this.branchId.set(id);
    this.picked.set(new Set([...this.picked()].filter((sid) => this.branchServices().some((sv) => sv.id === sid))));
  }

  protected toggle(id: string): void {
    const next = new Set(this.picked());
    if (next.has(id)) next.delete(id);
    else if (next.size < 5) next.add(id);
    this.picked.set(next);
  }

  protected toTime(): void {
    if (this.employeeId() && !this.qualifiedStaff().some((e) => e.id === this.employeeId())) this.employeeId.set(null);
    this.step.set('time');
    void this.chooseDate(this.date() || this.days()[0]);
  }

  protected chooseStaff(id: string | null): void {
    this.employeeId.set(id);
    void this.loadSlots();
  }

  protected chooseDate(d: string): void {
    this.date.set(d);
    void this.loadSlots();
  }

  private async loadSlots(): Promise<void> {
    const branch = this.branchId();
    if (!branch || !this.date()) return;
    this.slot.set(null);
    this.loadingSlots.set(true);
    try {
      const rows = await this.api.slots(this.slug(), branch, [...this.picked()], this.date(), this.employeeId());
      const seen = new Set<string>();
      this.slots.set(rows.sort((a, b) => a.starts_at.localeCompare(b.starts_at)).filter((r) => !seen.has(r.starts_at) && !!seen.add(r.starts_at)));
    } catch (err) {
      this.slots.set([]);
      this.toast.error(err);
    } finally {
      this.loadingSlots.set(false);
    }
  }

  protected weekday(d: string): string {
    return new Intl.DateTimeFormat(this.i18n.locale(), { weekday: 'short', timeZone: this.tz() }).format(zonedInstant(d, '12:00', this.tz()));
  }

  protected time(iso: string): string {
    return zonedTime(iso, this.tz());
  }

  protected summaryLine(): string {
    const sl = this.slot();
    if (!sl) return '';
    const day = new Intl.DateTimeFormat(this.i18n.locale(), { weekday: 'long', day: 'numeric', month: 'long', timeZone: this.tz() }).format(new Date(sl.starts_at));
    const b = this.salon()?.branches.find((x) => x.id === this.branchId());
    return `${day} · ${this.time(sl.starts_at)}${b ? ' · ' + this.i18n.pick(b.name_en, b.name_ar) : ''}`;
  }

  protected servicesLine(): string {
    return this.chosen().map((sv) => this.i18n.pick(sv.name_en, sv.name_ar)).join(', ');
  }

  async submit(): Promise<void> {
    const sl = this.slot();
    const branch = this.branchId();
    if (!sl || !branch) return;
    this.busy.set(true);
    try {
      const res = await this.api.book({
        slug: this.slug(),
        branchId: branch,
        serviceIds: [...this.picked()],
        employeeId: this.employeeId() ?? sl.employee_id,
        startsAt: sl.starts_at,
        firstName: this.firstName().trim(),
        lastName: this.lastName().trim() || null,
        mobile: this.mobile().trim(),
        email: this.email().trim() || null,
        notes: this.notes().trim() || null,
        consent: this.consent(),
        key: this.key,
      });
      this.token.set(res.token);
      this.step.set('done');
    } catch (err) {
      this.toast.error(err);
      // The time may have been taken meanwhile: offer fresh times and a fresh key.
      this.key = crypto.randomUUID();
      this.step.set('time');
      void this.loadSlots();
    } finally {
      this.busy.set(false);
    }
  }
}

function localStorageLang(): string | null {
  try {
    return localStorage.getItem('sz.lang');
  } catch {
    return null;
  }
}

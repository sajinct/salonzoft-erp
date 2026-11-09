import { ChangeDetectionStrategy, Component, OnInit, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { I18nService, TranslateDynamicPipe, TranslatePipe } from '../../core/i18n/i18n.service';
import { ToastService } from '../../core/services/toast.service';
import { ConfirmService, StatePanel } from '../../shared/components/ui';
import { zonedTime } from '../appointments/data/calendar-time';
import { BookingService, PublicBooking } from './data/booking.service';

/** Customer self-service for one booking: /book/manage/:token (the token is the secret). */
@Component({
  selector: 'sz-manage-booking-page',
  imports: [TranslatePipe, TranslateDynamicPipe, StatePanel, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="min-h-screen bg-bg">
      <main class="mx-auto max-w-lg px-4 py-10">
        <div class="mb-4 flex justify-end"><button type="button" class="btn-ghost btn-sm" (click)="i18n.toggle()">{{ i18n.lang() === 'en' ? 'العربية' : 'English' }}</button></div>
        @if (loading()) {
          <div class="card"><sz-state [loading]="true" /></div>
        } @else if (booking(); as b) {
          <article class="card p-6">
            <p class="text-sm text-muted">{{ i18n.pick(b.salon.name, b.salon.name_ar) }}</p>
            <h1 class="page-title mt-1">{{ day(b) }}</h1>
            <p class="num text-lg" dir="ltr">{{ time(b.starts_at, b) }} – {{ time(b.ends_at, b) }}</p>
            <span class="mt-2 inline-block" [class]="b.status === 'cancelled' ? 'badge-danger' : 'badge-success'">{{ 'appointments.status.' + b.status | tx }}</span>
            <ul class="mt-4 space-y-1 text-sm">
              @for (s of b.services; track $index) { <li>{{ i18n.pick(s.name_en, s.name_ar) }} · <span class="text-muted">{{ i18n.pick(s.staff_en, s.staff_ar) }}</span></li> }
            </ul>
            <p class="mt-4 text-sm">{{ i18n.pick(b.branch.name_en, b.branch.name_ar) }}@if (i18n.pick(b.branch.address_en, b.branch.address_ar)) { · {{ i18n.pick(b.branch.address_en, b.branch.address_ar) }} }</p>
            @if (b.branch.phone) { <a class="num text-sm text-primary" dir="ltr" [href]="'tel:' + b.branch.phone">{{ b.branch.phone }}</a> }

            <div class="mt-6 flex flex-wrap gap-2">
              @if (b.can_cancel) {
                <button type="button" class="btn-danger" [disabled]="busy()" (click)="cancel()">{{ 'book.cancelBooking' | t }}</button>
              } @else if (b.status === 'booked' || b.status === 'confirmed') {
                <p class="text-sm text-muted">{{ 'book.cancelClosed' | t: { hours: b.cancel_hours } }}</p>
              }
              <a class="btn-secondary" [routerLink]="['/book', b.salon.slug]">{{ 'book.bookAgain' | t }}</a>
            </div>
          </article>
        } @else {
          <div class="card"><sz-state icon="calendar-days" [heading]="'book.notFound' | t" /></div>
        }
      </main>
    </div>
  `,
})
export class ManageBookingPage implements OnInit {
  readonly token = input.required<string>();

  protected readonly i18n = inject(I18nService);
  private readonly api = inject(BookingService);
  private readonly toast = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  protected readonly loading = signal(true);
  protected readonly busy = signal(false);
  protected readonly booking = signal<PublicBooking | null>(null);

  async ngOnInit(): Promise<void> {
    await this.load();
  }

  private async load(): Promise<void> {
    try {
      this.booking.set(await this.api.booking(this.token()));
    } catch {
      this.booking.set(null);
    } finally {
      this.loading.set(false);
    }
  }

  protected day(b: PublicBooking): string {
    return new Intl.DateTimeFormat(this.i18n.locale(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: b.branch.timezone }).format(new Date(b.starts_at));
  }

  protected time(iso: string, b: PublicBooking): string {
    return zonedTime(iso, b.branch.timezone);
  }

  async cancel(): Promise<void> {
    const ok = await this.confirm.ask({
      title: this.i18n.t('book.cancelBooking'),
      message: this.i18n.t('book.confirmCancel'),
      confirmLabel: this.i18n.t('book.cancelBooking'),
      danger: true,
    });
    if (!ok) return;
    this.busy.set(true);
    try {
      await this.api.cancel(this.token());
      this.toast.success(this.i18n.t('book.cancelled'));
      await this.load();
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.busy.set(false);
    }
  }
}

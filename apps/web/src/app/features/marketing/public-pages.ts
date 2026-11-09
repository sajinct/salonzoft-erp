import { ChangeDetectionStrategy, Component, OnInit, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideDynamicIcon } from '@lucide/angular';
import { I18nService, TranslatePipe } from '../../core/i18n/i18n.service';
import { ToastService } from '../../core/services/toast.service';
import { StatePanel } from '../../shared/components/ui';
import { MarketingService } from './data/marketing.service';

type FeedbackData = Awaited<ReturnType<MarketingService['getFeedback']>>;

/** Public: rate a visit — /feedback/:token */
@Component({
  selector: 'sz-feedback-page',
  imports: [TranslatePipe, LucideDynamicIcon, StatePanel, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="min-h-screen bg-bg">
      <main class="mx-auto max-w-md px-4 py-10">
        <div class="mb-4 flex justify-end"><button type="button" class="btn-ghost btn-sm" (click)="i18n.toggle()">{{ i18n.lang() === 'en' ? 'العربية' : 'English' }}</button></div>
        @if (loading()) {
          <div class="card"><sz-state [loading]="true" /></div>
        } @else if (data(); as d) {
          <article class="card p-6 text-center">
            <p class="text-sm text-muted">{{ i18n.pick(d.salon.name, d.salon.name_ar) }}</p>
            @if (done() || d.submitted) {
              <span class="mx-auto mt-4 grid h-14 w-14 place-items-center rounded-full bg-success-soft text-success"><svg lucideIcon="circle-check" [size]="30"></svg></span>
              <h1 class="page-title mt-3">{{ 'feedback.thanks' | t }}</h1>
              <a class="btn-secondary mt-5" [routerLink]="['/book', d.salon.slug]">{{ 'book.bookAgain' | t }}</a>
            } @else if (d.expired) {
              <h1 class="page-title mt-2">{{ 'feedback.expired' | t }}</h1>
            } @else {
              <h1 class="page-title mt-2">{{ 'feedback.question' | t }}</h1>
              <p class="mt-1 text-sm text-muted">{{ servicesLine(d) }}</p>
              <div class="mt-5 flex justify-center gap-1" role="radiogroup" [attr.aria-label]="'feedback.question' | t">
                @for (n of [1, 2, 3, 4, 5]; track n) {
                  <button type="button" class="text-4xl leading-none transition" [class]="n <= rating() ? 'text-warning' : 'text-line'" role="radio"
                          [attr.aria-checked]="rating() === n" [attr.aria-label]="n + ' / 5'" (click)="rating.set(n)">★</button>
                }
              </div>
              <textarea class="input mt-5" rows="3" maxlength="1000" [placeholder]="'feedback.comment' | t" [value]="comment()" (input)="comment.set($any($event.target).value)"></textarea>
              <button type="button" class="btn-primary mt-4 w-full" [disabled]="!rating() || busy()" (click)="send()">{{ 'feedback.send' | t }}</button>
            }
          </article>
        } @else {
          <div class="card"><sz-state icon="circle-alert" [heading]="'feedback.invalid' | t" /></div>
        }
      </main>
    </div>
  `,
})
export class FeedbackPage implements OnInit {
  readonly token = input.required<string>();
  protected readonly i18n = inject(I18nService);
  private readonly api = inject(MarketingService);
  private readonly toast = inject(ToastService);
  protected readonly loading = signal(true);
  protected readonly data = signal<FeedbackData | null>(null);
  protected readonly rating = signal(0);
  protected readonly comment = signal('');
  protected readonly busy = signal(false);
  protected readonly done = signal(false);

  async ngOnInit(): Promise<void> {
    try {
      this.data.set(await this.api.getFeedback(this.token()));
    } catch {
      this.data.set(null);
    } finally {
      this.loading.set(false);
    }
  }

  protected servicesLine(d: FeedbackData): string {
    return (d.services ?? []).map((s) => `${this.i18n.pick(s.name_en, s.name_ar)} · ${this.i18n.pick(s.staff_en, s.staff_ar)}`).join(', ');
  }

  async send(): Promise<void> {
    this.busy.set(true);
    try {
      await this.api.submitFeedback(this.token(), this.rating(), this.comment().trim() || null);
      this.done.set(true);
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.busy.set(false);
    }
  }
}

/** Public: stop marketing messages — /unsubscribe/:token */
@Component({
  selector: 'sz-unsubscribe-page',
  imports: [TranslatePipe, LucideDynamicIcon, StatePanel],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="min-h-screen bg-bg">
      <main class="mx-auto max-w-md px-4 py-10">
        <div class="mb-4 flex justify-end"><button type="button" class="btn-ghost btn-sm" (click)="i18n.toggle()">{{ i18n.lang() === 'en' ? 'العربية' : 'English' }}</button></div>
        @if (loading()) {
          <div class="card"><sz-state [loading]="true" /></div>
        } @else if (salon()) {
          <article class="card p-6 text-center">
            <span class="mx-auto grid h-14 w-14 place-items-center rounded-full bg-success-soft text-success"><svg lucideIcon="circle-check" [size]="30"></svg></span>
            <h1 class="page-title mt-3">{{ 'unsubscribe.done' | t }}</h1>
            <p class="mt-2 text-sm text-muted">{{ 'unsubscribe.detail' | t: { salon: salon() } }}</p>
          </article>
        } @else {
          <div class="card"><sz-state icon="circle-alert" [heading]="'feedback.invalid' | t" /></div>
        }
      </main>
    </div>
  `,
})
export class UnsubscribePage implements OnInit {
  readonly token = input.required<string>();
  protected readonly i18n = inject(I18nService);
  private readonly api = inject(MarketingService);
  protected readonly loading = signal(true);
  protected readonly salon = signal('');

  async ngOnInit(): Promise<void> {
    try {
      const r = await this.api.unsubscribe(this.token());
      this.salon.set(this.i18n.pick(r.salon, r.salon_ar));
    } catch {
      this.salon.set('');
    } finally {
      this.loading.set(false);
    }
  }
}

import { DialogRef, DIALOG_DATA } from '@angular/cdk/dialog';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { LucideDynamicIcon } from '@lucide/angular';
import { I18nService, TranslateDynamicPipe, TranslatePipe } from '../../core/i18n/i18n.service';
import { ToastService } from '../../core/services/toast.service';
import { MoneyPipe } from '../../shared/pipes/format.pipes';
import { CashSession, InvoiceDoc, PAYMENT_METHODS, PaymentMethod, PosService } from './data/pos.service';

/** Parse a 3-decimal amount typed by the user; null when invalid. */
export function parseAmount(raw: string): number | null {
  const s = raw.trim().replace(',', '.');
  if (!/^\d{1,9}(\.\d{1,3})?$/.test(s)) return null;
  return Number(s);
}

/** Exact 3-decimal subtraction for display (avoids float drift like 0.30000000000000004). */
export function minus(a: number, b: number): number {
  return Math.round(a * 1000 - b * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// Payment (split / partial)
// ---------------------------------------------------------------------------
@Component({
  selector: 'sz-payment-dialog',
  imports: [TranslatePipe, TranslateDynamicPipe, LucideDynamicIcon, MoneyPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="card w-[min(30rem,calc(100vw-2rem))] p-6" role="dialog" aria-modal="true">
      <div class="mb-4 flex items-start justify-between">
        <div>
          <h2 class="text-lg font-semibold">{{ 'pos.takePayment' | t }}</h2>
          <p class="num text-sm text-muted" dir="ltr">{{ doc().number }}</p>
        </div>
        <button type="button" class="btn-icon" (click)="ref.close(changed)" [attr.aria-label]="'common.close' | t"><svg lucideIcon="x" [size]="18"></svg></button>
      </div>

      <div class="mb-4 grid grid-cols-2 gap-3 text-center">
        <div class="rounded-xl bg-surface-2 p-3"><p class="text-xs text-muted">{{ 'pos.total' | t }}</p><p class="num text-lg font-semibold">{{ doc().total | money }}</p></div>
        <div class="rounded-xl p-3" [class]="due() > 0 ? 'bg-warning-soft' : 'bg-success-soft'">
          <p class="text-xs text-muted">{{ 'pos.balanceDue' | t }}</p><p class="num text-lg font-semibold">{{ due() | money }}</p>
        </div>
      </div>

      @if (due() > 0) {
        <div class="mb-3 grid grid-cols-4 gap-2">
          @for (m of methods; track m) {
            <button type="button" class="rounded-xl border px-2 py-2 text-sm font-medium" [class]="method() === m ? 'border-primary bg-primary-soft text-primary' : 'border-line'" (click)="method.set(m)">
              {{ 'pos.method.' + m | tx }}
            </button>
          }
        </div>
        <div class="grid gap-3 sm:grid-cols-2">
          <div class="field">
            <label class="label" for="pamt">{{ 'pos.amount' | t }}</label>
            <input id="pamt" class="input num text-lg" inputmode="decimal" dir="ltr" [value]="amount()" (input)="amount.set($any($event.target).value)" />
          </div>
          @if (method() === 'cash') {
            <div class="field">
              <label class="label" for="ptend">{{ 'pos.tendered' | t }}</label>
              <input id="ptend" class="input num text-lg" inputmode="decimal" dir="ltr" [value]="tendered()" (input)="tendered.set($any($event.target).value)" />
            </div>
          } @else {
            <div class="field">
              <label class="label" for="pref">{{ 'pos.reference' | t }}</label>
              <input id="pref" class="input" maxlength="100" dir="ltr" [value]="reference()" (input)="reference.set($any($event.target).value)" [placeholder]="'pos.referenceHint' | t" />
            </div>
          }
        </div>
        @if (change() !== null) {
          <p class="mt-3 rounded-xl bg-success-soft px-3 py-2 text-sm">{{ 'pos.changeDue' | t }}: <strong class="num">{{ change() | money }}</strong></p>
        }
        <button type="button" class="btn-primary mt-4 w-full" [disabled]="busy() || parsed() === null" (click)="take()">
          {{ busy() ? ('common.saving' | t) : ('pos.receive' | t: { amount: (parsed() ?? 0 | money) }) }}
        </button>
      } @else {
        <div class="flex flex-col items-center gap-3 py-4 text-center">
          <span class="grid h-12 w-12 place-items-center rounded-full bg-success-soft text-success"><svg lucideIcon="circle-check" [size]="26"></svg></span>
          <p class="font-semibold">{{ 'pos.paidInFull' | t }}</p>
          <button type="button" class="btn-primary w-full" (click)="ref.close(true)">{{ 'common.continue' | t }}</button>
        </div>
      }

      @if (doc().payments.length > 0) {
        <ul class="mt-4 space-y-1 border-t border-line pt-3 text-sm">
          @for (p of doc().payments; track p.id) {
            <li class="flex justify-between"><span>{{ 'pos.method.' + p.method | tx }}@if (p.direction === 'out') { · {{ 'pos.refund' | t }} }</span><span class="num">{{ p.amount | money }}</span></li>
          }
        </ul>
      }
    </div>
  `,
})
export class PaymentDialog {
  protected readonly ref = inject<DialogRef<boolean>>(DialogRef);
  private readonly pos = inject(PosService);
  private readonly toast = inject(ToastService);

  protected readonly methods = PAYMENT_METHODS;
  protected readonly doc = signal(inject<InvoiceDoc>(DIALOG_DATA));
  protected readonly due = computed(() => Math.max(0, this.doc().balance_due));
  protected readonly method = signal<PaymentMethod>('cash');
  protected readonly amount = signal(String(this.doc().balance_due));
  protected readonly tendered = signal('');
  protected readonly reference = signal('');
  protected readonly busy = signal(false);
  protected changed = false;
  /** One idempotency key per attempt; regenerated after each successful payment. */
  private key = crypto.randomUUID();

  protected readonly parsed = computed(() => {
    const v = parseAmount(this.amount());
    return v !== null && v > 0 && v <= this.due() ? v : null;
  });
  protected readonly change = computed(() => {
    const t = parseAmount(this.tendered());
    const a = this.parsed();
    return this.method() === 'cash' && t !== null && a !== null && t >= a ? minus(t, a) : null;
  });

  async take(): Promise<void> {
    const amount = this.parsed();
    if (amount === null) return;
    this.busy.set(true);
    try {
      await this.pos.pay(this.doc().id, this.method(), amount, this.reference().trim() || null, this.key);
      this.key = crypto.randomUUID();
      this.changed = true;
      const doc = await this.pos.get(this.doc().id);
      this.doc.set(doc);
      this.amount.set(String(Math.max(0, doc.balance_due)));
      this.tendered.set('');
      this.reference.set('');
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.busy.set(false);
    }
  }
}

// ---------------------------------------------------------------------------
// Cash drawer: open with a float, close with a count
// ---------------------------------------------------------------------------
export interface DrawerDialogData {
  branchId: string;
  session: CashSession | null;
}

@Component({
  selector: 'sz-cash-drawer-dialog',
  imports: [TranslatePipe, LucideDynamicIcon, MoneyPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="card w-[min(26rem,calc(100vw-2rem))] p-6" role="dialog" aria-modal="true">
      <div class="mb-4 flex items-center justify-between">
        <h2 class="text-lg font-semibold">{{ (data.session ? 'pos.closeDrawer' : 'pos.openDrawer') | t }}</h2>
        <button type="button" class="btn-icon" (click)="ref.close(done())" [attr.aria-label]="'common.close' | t"><svg lucideIcon="x" [size]="18"></svg></button>
      </div>
      @if (result(); as r) {
        <dl class="grid grid-cols-2 gap-y-2 text-sm">
          <dt class="text-muted">{{ 'pos.expectedCash' | t }}</dt><dd class="num text-end">{{ r.expected_cash | money }}</dd>
          <dt class="text-muted">{{ 'pos.countedCash' | t }}</dt><dd class="num text-end">{{ r.counted_cash | money }}</dd>
          <dt class="font-semibold">{{ 'pos.variance' | t }}</dt>
          <dd class="num text-end font-semibold" [class.text-danger]="r.variance !== 0" [class.text-success]="r.variance === 0">{{ r.variance | money }}</dd>
        </dl>
        <button type="button" class="btn-primary mt-5 w-full" (click)="ref.close(true)">{{ 'common.close' | t }}</button>
      } @else {
        @if (data.session) {
          <p class="mb-3 text-sm text-muted">{{ 'pos.closeHint' | t: { float: (data.session.opening_float | money) } }}</p>
        }
        <div class="field">
          <label class="label" for="damt">{{ (data.session ? 'pos.countedCash' : 'pos.openingFloat') | t }}</label>
          <input id="damt" class="input num text-lg" inputmode="decimal" dir="ltr" [value]="amount()" (input)="amount.set($any($event.target).value)" />
        </div>
        @if (data.session) {
          <div class="field mt-3"><label class="label" for="dnotes">{{ 'appointments.notes' | t }}</label><input id="dnotes" class="input" maxlength="500" [value]="notes()" (input)="notes.set($any($event.target).value)" /></div>
        }
        <button type="button" class="btn-primary mt-5 w-full" [disabled]="busy() || parsed() === null" (click)="submit()">
          {{ (data.session ? 'pos.closeDrawer' : 'pos.openDrawer') | t }}
        </button>
      }
    </div>
  `,
})
export class CashDrawerDialog {
  protected readonly ref = inject<DialogRef<boolean>>(DialogRef);
  protected readonly data = inject<DrawerDialogData>(DIALOG_DATA);
  private readonly pos = inject(PosService);
  private readonly toast = inject(ToastService);

  protected readonly amount = signal(this.data.session ? '' : '0');
  protected readonly notes = signal('');
  protected readonly busy = signal(false);
  protected readonly result = signal<{ expected_cash: number; counted_cash: number; variance: number } | null>(null);
  protected readonly done = computed(() => this.result() !== null);
  protected readonly parsed = computed(() => parseAmount(this.amount()));

  async submit(): Promise<void> {
    const value = this.parsed();
    if (value === null) return;
    this.busy.set(true);
    try {
      if (this.data.session) {
        this.result.set(await this.pos.closeCash(this.data.session.id, value, this.notes().trim() || null));
      } else {
        await this.pos.openCash(this.data.branchId, value);
        this.ref.close(true);
      }
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.busy.set(false);
    }
  }
}

// ---------------------------------------------------------------------------
// Credit note / refund
// ---------------------------------------------------------------------------
@Component({
  selector: 'sz-credit-note-dialog',
  imports: [TranslatePipe, TranslateDynamicPipe, LucideDynamicIcon, MoneyPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="card flex max-h-[92vh] w-[min(36rem,calc(100vw-2rem))] flex-col" role="dialog" aria-modal="true">
      <header class="flex items-center justify-between border-b border-line px-6 py-4">
        <h2 class="text-lg font-semibold">{{ 'pos.creditNote' | t }} · <span class="num" dir="ltr">{{ doc.number }}</span></h2>
        <button type="button" class="btn-icon" (click)="ref.close()" [attr.aria-label]="'common.close' | t"><svg lucideIcon="x" [size]="18"></svg></button>
      </header>
      <div class="flex-1 space-y-4 overflow-y-auto px-6 py-5 text-sm">
        <label class="flex items-center gap-2"><input type="checkbox" class="checkbox" [checked]="everything()" (change)="everything.set($any($event.target).checked)" />{{ 'pos.creditEverything' | t }}</label>
        @if (!everything()) {
          <ul class="divide-y divide-line rounded-xl border border-line">
            @for (it of doc.items; track it.id; let i = $index) {
              <li class="flex items-center gap-3 px-3 py-2">
                <span class="flex-1">{{ i18n.pick(it.description_en, it.description_ar) }} <span class="text-muted">× {{ it.quantity }}</span></span>
                <span class="num text-muted">{{ it.total_amount | money }}</span>
                <input class="input num h-9 w-20" inputmode="decimal" dir="ltr" [value]="qty()[i]" (input)="setQty(i, $any($event.target).value)" [attr.aria-label]="'pos.quantity' | t" />
              </li>
            }
          </ul>
        }
        <div class="field">
          <label class="label" for="creason">{{ 'appointments.reason' | t }}</label>
          <input id="creason" class="input" maxlength="300" [value]="reason()" (input)="reason.set($any($event.target).value)" />
        </div>
        <div class="field">
          <label class="label" for="cmethod">{{ 'pos.refundMethod' | t }}</label>
          <select id="cmethod" class="input" [value]="method()" (change)="method.set($any($event.target).value)">
            <option value="">{{ 'pos.noRefund' | t }}</option>
            @for (m of methods; track m) { <option [value]="m">{{ 'pos.method.' + m | tx }}</option> }
          </select>
          <p class="hint">{{ 'pos.refundHint' | t }}</p>
        </div>
      </div>
      <footer class="flex justify-end gap-2 border-t border-line px-6 py-4">
        <button type="button" class="btn-secondary" (click)="ref.close()">{{ 'common.cancel' | t }}</button>
        <button type="button" class="btn-danger" [disabled]="busy() || !reason().trim()" (click)="submit()">{{ 'pos.issueCreditNote' | t }}</button>
      </footer>
    </div>
  `,
})
export class CreditNoteDialog {
  protected readonly ref = inject<DialogRef<string>>(DialogRef);
  protected readonly doc = inject<InvoiceDoc>(DIALOG_DATA);
  protected readonly i18n = inject(I18nService);
  private readonly pos = inject(PosService);
  private readonly toast = inject(ToastService);

  protected readonly methods = PAYMENT_METHODS;
  protected readonly everything = signal(true);
  protected readonly qty = signal<string[]>(this.doc.items.map(() => '0'));
  protected readonly reason = signal('');
  protected readonly method = signal<PaymentMethod | ''>(this.doc.paid_total > 0 ? (this.doc.payments.find((p) => p.direction === 'in')?.method as PaymentMethod) ?? 'cash' : '');
  protected readonly busy = signal(false);
  private readonly key = crypto.randomUUID();

  protected setQty(index: number, value: string): void {
    this.qty.update((list) => list.map((q, i) => (i === index ? value : q)));
  }

  async submit(): Promise<void> {
    let items: { item_id: string; quantity: number }[] | null = null;
    if (!this.everything()) {
      items = this.doc.items.map((it, i) => ({ item_id: it.id, quantity: parseAmount(this.qty()[i]) ?? NaN })).filter((x) => x.quantity !== 0);
      if (items.some((x) => Number.isNaN(x.quantity)) || items.length === 0) {
        this.toast.error({ message: 'INVALID_QUANTITY' });
        return;
      }
    }
    this.busy.set(true);
    try {
      const res = await this.pos.creditNote(this.doc.id, items, this.reason().trim(), this.method() || null, this.key);
      this.toast.success(this.i18n.t('pos.creditIssued', { number: res.number }));
      this.ref.close(res.credit_note_id);
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.busy.set(false);
    }
  }
}

// ---------------------------------------------------------------------------
// Custom line (retail item, misc charge)
// ---------------------------------------------------------------------------
@Component({
  selector: 'sz-custom-item-dialog',
  imports: [TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form class="card w-[min(24rem,calc(100vw-2rem))] p-6" (submit)="$event.preventDefault(); add()" role="dialog" aria-modal="true">
      <h2 class="mb-4 text-lg font-semibold">{{ 'pos.customItem' | t }}</h2>
      <div class="field"><label class="label" for="cidesc">{{ 'pos.description' | t }}</label><input id="cidesc" class="input" maxlength="160" [value]="desc()" (input)="desc.set($any($event.target).value)" /></div>
      <div class="field mt-3"><label class="label" for="ciprice">{{ 'services.price' | t }}</label><input id="ciprice" class="input num" inputmode="decimal" dir="ltr" [value]="price()" (input)="price.set($any($event.target).value)" /></div>
      <div class="mt-5 flex justify-end gap-2">
        <button type="button" class="btn-secondary" (click)="ref.close()">{{ 'common.cancel' | t }}</button>
        <button type="submit" class="btn-primary" [disabled]="!desc().trim() || parsed() === null">{{ 'common.create' | t }}</button>
      </div>
    </form>
  `,
})
export class CustomItemDialog {
  protected readonly ref = inject<DialogRef<{ description: string; unit_price: number }>>(DialogRef);
  protected readonly desc = signal('');
  protected readonly price = signal('');
  protected readonly parsed = computed(() => parseAmount(this.price()));

  add(): void {
    const price = this.parsed();
    if (price === null || !this.desc().trim()) return;
    this.ref.close({ description: this.desc().trim(), unit_price: price });
  }
}

import { Injectable, inject } from '@angular/core';
import { I18nService } from '../../core/i18n/i18n.service';
import { ToastService } from '../../core/services/toast.service';
import { formatMoney } from '../../shared/money/money';
import { SubscriptionInvoice } from '../billing/data/billing.service';
import { AdminService } from './data/admin.service';
import { FormDialogService } from './form-dialog';

/** Record-payment and void flows shared by the tenant and invoice pages. Resolve true when something changed. */
@Injectable({ providedIn: 'root' })
export class InvoiceActions {
  private readonly api = inject(AdminService);
  private readonly form = inject(FormDialogService);
  private readonly i18n = inject(I18nService);
  private readonly toast = inject(ToastService);

  async recordPayment(inv: SubscriptionInvoice): Promise<boolean> {
    const t = this.i18n.t.bind(this.i18n);
    const values = await this.form.open({
      title: t('admin.recordPayment'),
      message: t('admin.recordPaymentLine', {
        number: inv.number,
        total: formatMoney(inv.total, { currency: inv.currency_code, decimals: 3, locale: this.i18n.locale() }),
      }),
      submitLabel: t('admin.markPaid'),
      fields: [
        {
          key: 'method', label: t('admin.method'), type: 'select',
          options: (['bank_transfer', 'cash', 'card', 'other'] as const).map((m) => ({ value: m, label: this.i18n.tx('billing.method.' + m) })),
        },
        { key: 'ref', label: t('admin.reference'), type: 'text' },
        { key: 'paid_at', label: t('admin.paidOn'), type: 'date', value: new Date().toISOString().slice(0, 10) },
      ],
    });
    if (!values) return false;
    try {
      const paidAt = values['paid_at'] && values['paid_at'] !== new Date().toISOString().slice(0, 10) ? new Date(values['paid_at'] + 'T12:00:00').toISOString() : null;
      const r = await this.api.recordPayment(inv.id, values['method'], values['ref'].trim() || null, paidAt);
      this.toast.success(t('admin.paidToast', { number: r.number }));
      return true;
    } catch (err) {
      this.toast.error(err);
      return false;
    }
  }

  async void(inv: SubscriptionInvoice): Promise<boolean> {
    const t = this.i18n.t.bind(this.i18n);
    const values = await this.form.open({
      title: t('admin.voidInvoice'),
      message: inv.number,
      submitLabel: t('admin.void'),
      danger: true,
      fields: [{ key: 'reason', label: t('admin.reason'), type: 'text', required: true }],
    });
    if (!values) return false;
    try {
      await this.api.voidInvoice(inv.id, values['reason'].trim());
      return true;
    } catch (err) {
      this.toast.error(err);
      return false;
    }
  }
}

/**
 * Click-to-chat: opens WhatsApp with a message already typed for the customer.
 * The staff member reviews it and presses send — the app itself sends nothing.
 *
 * On a computer this goes straight to WhatsApp Web; on a phone or tablet it
 * opens the WhatsApp app. Without a number, WhatsApp asks which chat to use.
 */
export interface ShareInfo {
  mobile: string | null;
  name: string | null;
  message: string;
  link: string;
}

const MOBILE_UA = /Android|iPhone|iPad|iPod|Mobile/i;

/** International number without "+", spaces or punctuation — or null when it is not a usable number. */
export function whatsAppNumber(mobile: string | null | undefined): string | null {
  const digits = (mobile ?? '').replace(/\D/g, '').replace(/^00/, '');
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

export function whatsAppUrl(mobile: string | null | undefined, text: string, userAgent = globalThis.navigator?.userAgent ?? ''): string {
  const number = whatsAppNumber(mobile);
  const message = encodeURIComponent(text);
  if (MOBILE_UA.test(userAgent)) return `https://wa.me/${number ?? ''}?text=${message}`;
  return `https://web.whatsapp.com/send?${number ? `phone=${number}&` : ''}text=${message}`;
}

/**
 * Open WhatsApp once the message is ready. The tab is opened right away, inside
 * the click, so pop-up blockers allow it; it is closed again if preparing fails.
 */
export async function openWhatsApp(prepare: () => Promise<ShareInfo>): Promise<ShareInfo> {
  const tab = window.open('about:blank', '_blank');
  try {
    const info = await prepare();
    const url = whatsAppUrl(info.mobile, info.message);
    if (tab) {
      tab.opener = null;
      tab.location.replace(url);
    } else {
      window.location.assign(url); // pop-ups blocked: use this tab
    }
    return info;
  } catch (err) {
    tab?.close();
    throw err;
  }
}

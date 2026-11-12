import { describe, expect, it } from 'vitest';
import { whatsAppNumber, whatsAppUrl } from './whatsapp';

const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36';
const PHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';

describe('WhatsApp links', () => {
  it('normalises numbers', () => {
    expect(whatsAppNumber('+968 9123-4567')).toBe('96891234567');
    expect(whatsAppNumber('0096891234567')).toBe('96891234567');
    expect(whatsAppNumber('123')).toBeNull();
    expect(whatsAppNumber(null)).toBeNull();
  });

  it('opens WhatsApp Web on a computer', () => {
    expect(whatsAppUrl('+96891234567', 'Hello & مرحبا', DESKTOP)).toBe(
      'https://web.whatsapp.com/send?phone=96891234567&text=Hello%20%26%20%D9%85%D8%B1%D8%AD%D8%A8%D8%A7',
    );
  });

  it('opens the app on a phone', () => {
    expect(whatsAppUrl('+96891234567', 'Hi', PHONE)).toBe('https://wa.me/96891234567?text=Hi');
  });

  it('lets the user pick the chat when there is no number', () => {
    expect(whatsAppUrl(null, 'Hi', DESKTOP)).toBe('https://web.whatsapp.com/send?text=Hi');
    expect(whatsAppUrl('', 'Hi', PHONE)).toBe('https://wa.me/?text=Hi');
  });
});

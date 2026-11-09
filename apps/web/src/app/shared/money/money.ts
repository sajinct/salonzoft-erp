/**
 * Currency-safe money helpers.
 *
 * Amounts are handled as integer MINOR units in BigInt (OMR: 1 rial = 1000
 * baisa) — never as floating-point. The database (NUMERIC) is the source of
 * truth for financial totals; these helpers are for display, input parsing and
 * client-side previews that must match server rounding (half away from zero).
 */
export type MoneyInput = string | number | bigint | null | undefined;

const DEFAULT_DECIMALS = 3;

function pow10(decimals: number): bigint {
  return 10n ** BigInt(decimals);
}

/**
 * Parse a decimal value (e.g. "12.345", 12.3, "1,250.5") into minor units.
 * Extra fractional digits are rounded half away from zero.
 * Throws on anything that is not a plain decimal number.
 */
export function toMinor(value: MoneyInput, decimals = DEFAULT_DECIMALS): bigint {
  if (value === null || value === undefined || value === '') return 0n;
  if (typeof value === 'bigint') return value * pow10(decimals);
  // Numbers from PostgREST (NUMERIC → JSON number) are converted via their
  // shortest round-trip string representation, which is exact for 3 decimals.
  const raw = typeof value === 'number' ? numberToPlainString(value) : value.trim().replace(/,/g, '');
  const match = /^([+-])?(\d*)(?:\.(\d*))?$/.exec(raw);
  if (!match || (match[2] === '' && (match[3] ?? '') === '')) {
    throw new Error(`Invalid money value: ${String(value)}`);
  }
  const negative = match[1] === '-';
  const intPart = match[2] || '0';
  const frac = match[3] ?? '';
  const kept = frac.slice(0, decimals).padEnd(decimals, '0');
  let minor = BigInt(intPart) * pow10(decimals) + BigInt(kept || '0');
  const nextDigit = frac.length > decimals ? Number(frac[decimals]) : 0;
  if (nextDigit >= 5) minor += 1n; // half away from zero (applied before sign)
  return negative ? -minor : minor;
}

/** Minor units → canonical decimal string, e.g. 12345n → "12.345". */
export function fromMinor(minor: bigint, decimals = DEFAULT_DECIMALS): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const base = pow10(decimals);
  const int = abs / base;
  const frac = (abs % base).toString().padStart(decimals, '0');
  const body = decimals > 0 ? `${int}.${frac}` : `${int}`;
  return negative && abs !== 0n ? `-${body}` : body;
}

export function addMoney(values: MoneyInput[], decimals = DEFAULT_DECIMALS): string {
  return fromMinor(values.reduce<bigint>((sum, v) => sum + toMinor(v, decimals), 0n), decimals);
}

/** Multiply by an integer quantity. */
export function multiplyMoney(value: MoneyInput, quantity: number, decimals = DEFAULT_DECIMALS): string {
  if (!Number.isInteger(quantity)) throw new Error('Quantity must be an integer');
  return fromMinor(toMinor(value, decimals) * BigInt(quantity), decimals);
}

/** Integer division of minor units with half-away-from-zero rounding. */
function divRound(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const q = (n * 2n + d) / (2n * d);
  return negative ? -q : q;
}

/**
 * Percentage of an amount, e.g. VAT: percentOf("10.000", "5") → "0.500".
 * The rate is a decimal string with up to 4 fractional digits.
 */
export function percentOf(value: MoneyInput, rate: string | number, decimals = DEFAULT_DECIMALS): string {
  const rateScaled = toMinor(rate, 4); // rate × 10^4
  return fromMinor(divRound(toMinor(value, decimals) * rateScaled, 100n * 10_000n), decimals);
}

/**
 * Split a VAT-inclusive gross amount into net + VAT (e.g. Oman 5%):
 * vat = round(gross × rate / (100 + rate)), net = gross − vat.
 */
export function splitInclusiveVat(gross: MoneyInput, rate: string | number, decimals = DEFAULT_DECIMALS) {
  const g = toMinor(gross, decimals);
  const r = toMinor(rate, 4);
  const vat = divRound(g * r, 100n * 10_000n + r);
  return { net: fromMinor(g - vat, decimals), vat: fromMinor(vat, decimals), gross: fromMinor(g, decimals) };
}

export function formatMoney(
  value: MoneyInput,
  options: { currency?: string; decimals?: number; locale?: string; showCurrency?: boolean } = {},
): string {
  const { currency = 'OMR', decimals = DEFAULT_DECIMALS, locale = 'en-OM', showCurrency = true } = options;
  const canonical = fromMinor(toMinor(value, decimals), decimals);
  const negative = canonical.startsWith('-');
  const [int, frac] = canonical.replace('-', '').split('.');
  // Group the integer part using the locale's separator without converting to float.
  const group = new Intl.NumberFormat(locale).formatToParts(1000).find((p) => p.type === 'group')?.value ?? ',';
  const decimal = new Intl.NumberFormat(locale).formatToParts(1.1).find((p) => p.type === 'decimal')?.value ?? '.';
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, group);
  const number = `${negative ? '-' : ''}${grouped}${frac !== undefined ? decimal + frac : ''}`;
  if (!showCurrency) return number;
  const symbol = locale.startsWith('ar') && currency === 'OMR' ? 'ر.ع.' : currency;
  return locale.startsWith('ar') ? `${number} ${symbol}` : `${symbol} ${number}`;
}

function numberToPlainString(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`Invalid money value: ${n}`);
  const s = String(n);
  if (!/e/i.test(s)) return s;
  return n.toFixed(20).replace(/0+$/, '').replace(/\.$/, '');
}

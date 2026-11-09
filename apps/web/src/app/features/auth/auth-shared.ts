import { Validators } from '@angular/forms';

/** Mirrors supabase/config.toml: ≥10 chars with lower, upper and a digit. */
export const PASSWORD_VALIDATORS = [
  Validators.required,
  Validators.minLength(10),
  Validators.pattern(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).+$/),
];

/** Only allow same-origin relative redirects (prevents open-redirects via ?next=). */
export function safeNext(next: string | null | undefined, fallback = '/'): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return fallback;
  return next;
}

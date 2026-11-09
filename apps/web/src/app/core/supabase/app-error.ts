/**
 * Normalised error thrown by data-access services.
 * `code` is the stable server error code (e.g. TENANT_SLUG_TAKEN) raised by
 * app.raise() in PL/pgSQL, or a Postgres SQLSTATE / auth error code.
 */
export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: string | null,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

interface ErrorLike {
  code?: string | null;
  message?: string | null;
  details?: string | null;
  name?: string;
}

const BUSINESS_CODE = /^[A-Z][A-Z0-9_]{2,}$/;

/** Convert a PostgrestError / AuthError / unknown into an AppError. */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  const e = (err ?? {}) as ErrorLike;
  const message = e.message ?? 'Unknown error';
  // Our SQL puts the machine-readable code in `message` (SQLSTATE P0001 / 42501 / 28000).
  if (BUSINESS_CODE.test(message)) return new AppError(message, message, e.details);
  if (e.name?.startsWith('Auth')) return new AppError(e.code ?? 'AUTH_ERROR', message, message);
  if (e.code === '42501') return new AppError('FORBIDDEN', message, e.details);
  if (e.name === 'TypeError' && /fetch/i.test(message)) return new AppError('NETWORK', message);
  return new AppError(e.code ?? 'UNKNOWN', message, e.details ?? null);
}

/** Unwrap a supabase-js `{ data, error }` result, throwing AppError on failure. */
export function unwrap<T>(result: { data: T | null; error: unknown }): T {
  if (result.error) throw toAppError(result.error);
  return result.data as T;
}

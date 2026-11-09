/**
 * Time helpers for the calendar. Everything is computed in the BRANCH
 * timezone (e.g. Asia/Muscat), never the browser's, so a manager travelling
 * abroad still sees the salon's local times.
 */

function parts(instant: Date, timeZone: string): Record<string, number> {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const out: Record<string, number> = {};
  for (const p of fmt.formatToParts(instant)) if (p.type !== 'literal') out[p.type] = Number(p.value);
  return out;
}

/** Offset of `timeZone` from UTC at `instant`, in minutes (Muscat = +240). */
export function tzOffsetMinutes(instant: Date, timeZone: string): number {
  const p = parts(instant, timeZone);
  const asUtc = Date.UTC(p['year'], p['month'] - 1, p['day'], p['hour'] % 24, p['minute'], p['second']);
  return Math.round((asUtc - instant.getTime()) / 60_000);
}

/** The instant at local `date` (YYYY-MM-DD) + `time` (HH:MM) in `timeZone`. */
export function zonedInstant(date: string, time: string, timeZone: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let instant = guess - tzOffsetMinutes(new Date(guess), timeZone) * 60_000;
  // Second pass handles offset changes (DST) between the guess and the result.
  instant = guess - tzOffsetMinutes(new Date(instant), timeZone) * 60_000;
  return new Date(instant);
}

/** Local calendar date (YYYY-MM-DD) of an instant in `timeZone`. */
export function zonedDate(instant: Date | string, timeZone: string): string {
  const p = parts(new Date(instant), timeZone);
  return `${p['year']}-${String(p['month']).padStart(2, '0')}-${String(p['day']).padStart(2, '0')}`;
}

/** Minutes since local midnight of `date` (may exceed 1440 for next-day times). */
export function minutesInDay(instant: Date | string, date: string, timeZone: string): number {
  return Math.round((new Date(instant).getTime() - zonedInstant(date, '00:00', timeZone).getTime()) / 60_000);
}

/** HH:MM label of an instant in `timeZone`. */
export function zonedTime(instant: Date | string, timeZone: string): string {
  const p = parts(new Date(instant), timeZone);
  return `${String(p['hour'] % 24).padStart(2, '0')}:${String(p['minute']).padStart(2, '0')}`;
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function minutesToLabel(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  return `${String(h).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

export interface Block {
  start: number;
  end: number;
}

/**
 * Visible hour range for a day: from the earliest opening / booking to the
 * latest closing, padded to whole hours; defaults to 08:00–22:00.
 */
export function visibleRange(blocks: Block[], fallback: Block = { start: 8 * 60, end: 22 * 60 }): Block {
  if (blocks.length === 0) return fallback;
  const start = Math.max(0, Math.floor(Math.min(...blocks.map((b) => b.start)) / 60) * 60);
  const end = Math.min(24 * 60, Math.ceil(Math.max(...blocks.map((b) => b.end)) / 60) * 60);
  return end > start ? { start, end } : fallback;
}

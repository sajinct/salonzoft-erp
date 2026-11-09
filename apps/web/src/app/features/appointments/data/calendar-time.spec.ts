import { addDays, minutesInDay, tzOffsetMinutes, visibleRange, zonedDate, zonedInstant, zonedTime } from './calendar-time';

describe('calendar time helpers (branch timezone)', () => {
  it('knows Muscat is UTC+4 all year', () => {
    expect(tzOffsetMinutes(new Date('2027-01-15T12:00:00Z'), 'Asia/Muscat')).toBe(240);
    expect(tzOffsetMinutes(new Date('2027-07-15T12:00:00Z'), 'Asia/Muscat')).toBe(240);
  });

  it('converts local salon time to an instant and back', () => {
    const t = zonedInstant('2027-03-01', '09:30', 'Asia/Muscat');
    expect(t.toISOString()).toBe('2027-03-01T05:30:00.000Z');
    expect(zonedTime(t, 'Asia/Muscat')).toBe('09:30');
    expect(zonedDate('2027-03-01T21:00:00Z', 'Asia/Muscat')).toBe('2027-03-02');
  });

  it('handles DST zones (a branch in London)', () => {
    expect(zonedInstant('2027-07-01', '10:00', 'Europe/London').toISOString()).toBe('2027-07-01T09:00:00.000Z');
    expect(zonedInstant('2027-01-01', '10:00', 'Europe/London').toISOString()).toBe('2027-01-01T10:00:00.000Z');
  });

  it('measures minutes from local midnight, including midnight closing', () => {
    expect(minutesInDay('2027-03-01T05:30:00Z', '2027-03-01', 'Asia/Muscat')).toBe(570);
    expect(minutesInDay('2027-03-01T20:00:00Z', '2027-03-01', 'Asia/Muscat')).toBe(1440);
  });

  it('adds days across month ends', () => {
    expect(addDays('2027-02-28', 1)).toBe('2027-03-01');
    expect(addDays('2027-03-01', -1)).toBe('2027-02-28');
  });

  it('pads the visible range to whole hours', () => {
    expect(visibleRange([])).toEqual({ start: 480, end: 1320 });
    expect(visibleRange([{ start: 9 * 60 + 15, end: 21 * 60 + 30 }, { start: 14 * 60, end: 22 * 60 }])).toEqual({ start: 540, end: 1320 });
  });
});

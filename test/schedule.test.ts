import { describe, expect, it } from 'vitest';
import { DEFAULT_SCHEDULE, hourIn, nextRunAfter, normalizeSchedule, shouldRunAt } from '../src/schedule';

// 2026-07-18 is EDT (UTC-4); 2026-01-15 is EST (UTC-5).
const summer = (utcHour: number) => new Date(Date.UTC(2026, 6, 18, utcHour, 0, 0));
const winter = (utcHour: number) => new Date(Date.UTC(2026, 0, 15, utcHour, 0, 0));

describe('shouldRunAt (default 9-19 America/New_York hourly)', () => {
  it('runs 9am-7pm EDT in summer', () => {
    expect(shouldRunAt(summer(13), DEFAULT_SCHEDULE)).toBe(true); // 9am EDT
    expect(shouldRunAt(summer(23), DEFAULT_SCHEDULE)).toBe(true); // 7pm EDT
    expect(shouldRunAt(summer(12), DEFAULT_SCHEDULE)).toBe(false); // 8am EDT
    expect(shouldRunAt(summer(0), DEFAULT_SCHEDULE)).toBe(false); // 8pm EDT
  });

  it('is DST-proof: same ET window in winter (EST)', () => {
    expect(shouldRunAt(winter(14), DEFAULT_SCHEDULE)).toBe(true); // 9am EST
    expect(shouldRunAt(winter(0), DEFAULT_SCHEDULE)).toBe(true); // 7pm EST (midnight UTC)
    expect(shouldRunAt(winter(13), DEFAULT_SCHEDULE)).toBe(false); // 8am EST
  });

  it('honors every_hours cadence anchored at start_hour', () => {
    const cfg = { ...DEFAULT_SCHEDULE, every_hours: 3 }; // 9, 12, 15, 18 ET
    expect(shouldRunAt(summer(13), cfg)).toBe(true); // 9am
    expect(shouldRunAt(summer(14), cfg)).toBe(false); // 10am
    expect(shouldRunAt(summer(16), cfg)).toBe(true); // 12pm
    expect(shouldRunAt(summer(22), cfg)).toBe(true); // 6pm
    expect(shouldRunAt(summer(23), cfg)).toBe(false); // 7pm (not on the 3h grid)
  });

  it('supports other timezones', () => {
    const bogota = { ...DEFAULT_SCHEDULE, timezone: 'America/Bogota' }; // UTC-5 year-round
    expect(shouldRunAt(summer(14), bogota)).toBe(true); // 9am Bogota
    expect(shouldRunAt(summer(13), bogota)).toBe(false); // 8am Bogota
  });
});

describe('normalizeSchedule', () => {
  it('falls back to defaults on garbage', () => {
    expect(normalizeSchedule(null)).toEqual(DEFAULT_SCHEDULE);
    expect(normalizeSchedule({ every_hours: 99, start_hour: -1, end_hour: 99, timezone: 'Mars/Olympus' }))
      .toEqual(DEFAULT_SCHEDULE);
  });

  it('keeps valid values and clamps end below start TO start', () => {
    expect(normalizeSchedule({ every_hours: 2, start_hour: 8, end_hour: 6, timezone: 'UTC' }))
      .toEqual({ every_hours: 2, start_hour: 8, end_hour: 8, timezone: 'UTC' });
  });
});

describe('nextRunAfter', () => {
  it('finds the next active top-of-hour', () => {
    const at = new Date(Date.UTC(2026, 6, 18, 2, 30, 0)); // 10:30pm EDT July 17
    const next = nextRunAfter(at, DEFAULT_SCHEDULE);
    expect(next?.toISOString()).toBe('2026-07-18T13:00:00.000Z'); // 9am EDT
  });

  it('returns the following hour inside the window', () => {
    const at = new Date(Date.UTC(2026, 6, 18, 15, 10, 0)); // 11:10am EDT
    expect(nextRunAfter(at, DEFAULT_SCHEDULE)?.toISOString()).toBe('2026-07-18T16:00:00.000Z'); // 12pm EDT
  });
});

describe('hourIn', () => {
  it('maps midnight correctly (hour 24 -> 0)', () => {
    expect(hourIn('UTC', new Date(Date.UTC(2026, 6, 18, 0, 5, 0)))).toBe(0);
  });
});

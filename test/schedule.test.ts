import { describe, expect, it } from 'vitest';
import { DEFAULT_SCHEDULE, minuteOfDay, nextRunAfter, normalizeSchedule, shouldRunAt } from '../src/schedule';

// Bogota is UTC-5 year-round (no DST). Bogota hour H = UTC H+5.
const bog = (h: number, m = 0) => new Date(Date.UTC(2026, 6, 18, h + 5, m, 0));
const N = 3; // batchesNeeded (e.g. 70 companies / 25 per batch -> 3 batches = one rotation)

describe('shouldRunAt — bursts (default [7,17] Bogota, every 15m)', () => {
  it('runs the first N ticks of each burst, then idles', () => {
    expect(shouldRunAt(bog(7, 0), DEFAULT_SCHEDULE, N)).toBe(true);
    expect(shouldRunAt(bog(7, 15), DEFAULT_SCHEDULE, N)).toBe(true);
    expect(shouldRunAt(bog(7, 30), DEFAULT_SCHEDULE, N)).toBe(true);
    expect(shouldRunAt(bog(7, 45), DEFAULT_SCHEDULE, N)).toBe(false); // 4th tick, > N
    expect(shouldRunAt(bog(17, 0), DEFAULT_SCHEDULE, N)).toBe(true); // afternoon burst
    expect(shouldRunAt(bog(17, 30), DEFAULT_SCHEDULE, N)).toBe(true);
  });

  it('does not run outside a burst or off the batch grid', () => {
    expect(shouldRunAt(bog(6, 45), DEFAULT_SCHEDULE, N)).toBe(false);
    expect(shouldRunAt(bog(8, 0), DEFAULT_SCHEDULE, N)).toBe(false);
    expect(shouldRunAt(bog(12, 15), DEFAULT_SCHEDULE, N)).toBe(false);
    expect(shouldRunAt(bog(7, 7), DEFAULT_SCHEDULE, N)).toBe(false); // not a 15m multiple
  });

  it('batchesNeeded scales the burst length', () => {
    expect(shouldRunAt(bog(7, 45), DEFAULT_SCHEDULE, 4)).toBe(true); // 4th tick now covered
    expect(shouldRunAt(bog(7, 15), DEFAULT_SCHEDULE, 1)).toBe(false); // only the :00 tick
    expect(shouldRunAt(bog(7, 0), DEFAULT_SCHEDULE, 0)).toBe(false); // no companies -> never
  });
});

describe('normalizeSchedule', () => {
  it('falls back to defaults on garbage and on the legacy window shape', () => {
    expect(normalizeSchedule(null)).toEqual(DEFAULT_SCHEDULE);
    // legacy shape (every_hours/start/end) has no burst_hours -> defaults, tz kept if valid
    expect(normalizeSchedule({ every_hours: 3, start_hour: 9, end_hour: 19, timezone: 'America/New_York' }))
      .toEqual({ ...DEFAULT_SCHEDULE, timezone: 'America/New_York' });
  });

  it('dedups + sorts + range-filters burst hours; clamps the interval', () => {
    expect(normalizeSchedule({ burst_hours: [17, 7, 7, 25, -1], batch_every_min: 30, timezone: 'UTC' }))
      .toEqual({ burst_hours: [7, 17], batch_every_min: 30, timezone: 'UTC' });
    expect(normalizeSchedule({ burst_hours: [6], batch_every_min: 999, timezone: 'UTC' }).batch_every_min)
      .toBe(DEFAULT_SCHEDULE.batch_every_min);
  });

  it('accepts a 5-minute cadence (the /health dropdown now offers it)', () => {
    expect(normalizeSchedule({ burst_hours: [7], batch_every_min: 5, timezone: 'UTC' }).batch_every_min).toBe(5);
  });
});

describe('nextRunAfter', () => {
  it('finds the next burst start', () => {
    expect(nextRunAfter(bog(6, 40), DEFAULT_SCHEDULE, N)?.toISOString()).toBe(bog(7, 0).toISOString());
  });
  it('advances within a burst', () => {
    expect(nextRunAfter(bog(7, 2), DEFAULT_SCHEDULE, N)?.toISOString()).toBe(bog(7, 15).toISOString());
  });
  it('jumps to the afternoon burst once the morning one is done', () => {
    expect(nextRunAfter(bog(7, 50), DEFAULT_SCHEDULE, N)?.toISOString()).toBe(bog(17, 0).toISOString());
  });
});

describe('minuteOfDay', () => {
  it('maps a UTC instant to the timezone minute-of-day', () => {
    expect(minuteOfDay('America/Bogota', bog(7, 15))).toBe(7 * 60 + 15);
    expect(minuteOfDay('UTC', new Date(Date.UTC(2026, 6, 18, 0, 5, 0)))).toBe(5);
  });
});

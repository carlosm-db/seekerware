// Pipeline schedule (owner request 2026-07-20: BURST runs). The Cloudflare cron
// is a dumb 15-min 24/7 tick; whether a tick RUNS is decided here from the D1
// config `schedule`. Model: a few "bursts" per day (e.g. 07:00 and 17:00). Each
// burst fires one company batch every `batch_every_min` minutes for `batchesNeeded`
// ticks — one full cursor rotation, so every company is covered once per burst —
// then idles until the next burst. `batchesNeeded` is derived at run time from the
// active company count (not stored), so coverage self-adjusts as companies grow.
// Pure + unit-tested.

export interface ScheduleCfg {
  /** Hours of day (0-23, in `timezone`) at which a burst starts. */
  burst_hours: number[];
  /** Minutes between batches within a burst (should match the cron tick, e.g. 15). */
  batch_every_min: number;
  /** IANA timezone the burst hours are expressed in (DST-aware). */
  timezone: string;
}

export const DEFAULT_SCHEDULE: ScheduleCfg = {
  burst_hours: [7, 17], batch_every_min: 15, timezone: 'America/Bogota',
};

export const SCHEDULE_TIMEZONES = [
  'America/Bogota', 'America/New_York', 'America/Vancouver', 'UTC',
] as const;

/** Minute-of-day (0-1439) in the given timezone, DST-aware. */
export function minuteOfDay(timezone: string, d: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hour: 'numeric', minute: 'numeric', hour12: false,
  }).formatToParts(d);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0') % 24;
  const min = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return hour * 60 + min;
}

/** Coerces arbitrary stored JSON into a safe ScheduleCfg (bad OR legacy shapes -> defaults). */
export function normalizeSchedule(raw: unknown): ScheduleCfg {
  const r = (raw ?? {}) as Partial<ScheduleCfg>;
  const tz = typeof r.timezone === 'string' && (SCHEDULE_TIMEZONES as readonly string[]).includes(r.timezone)
    ? r.timezone : DEFAULT_SCHEDULE.timezone;
  const hours = Array.isArray(r.burst_hours)
    ? [...new Set(
        r.burst_hours.map((h) => Math.floor(Number(h))).filter((h) => Number.isInteger(h) && h >= 0 && h <= 23),
      )].sort((a, b) => a - b)
    : [];
  const every = Math.floor(Number(r.batch_every_min));
  return {
    burst_hours: hours.length ? hours : DEFAULT_SCHEDULE.burst_hours,
    batch_every_min: Number.isFinite(every) && every >= 5 && every <= 60 ? every : DEFAULT_SCHEDULE.batch_every_min,
    timezone: tz,
  };
}

/**
 * Should a tick at instant `d` run a batch? True at `burst_hour + k*batch_every_min`
 * for k in [0, batchesNeeded) — one full company rotation per burst, then idle.
 */
export function shouldRunAt(d: Date, cfg: ScheduleCfg, batchesNeeded: number): boolean {
  if (batchesNeeded < 1) return false;
  const mod = minuteOfDay(cfg.timezone, d);
  const span = cfg.batch_every_min * batchesNeeded;
  for (const h of cfg.burst_hours) {
    const delta = mod - h * 60;
    if (delta >= 0 && delta < span && delta % cfg.batch_every_min === 0) return true;
  }
  return false;
}

/** Next instant (aligned to the batch grid) at/after `d` that would run; null if none in 48h. */
export function nextRunAfter(d: Date, cfg: ScheduleCfg, batchesNeeded: number): Date | null {
  const step = cfg.batch_every_min * 60_000;
  const probe = new Date(d);
  probe.setUTCSeconds(0, 0);
  probe.setUTCMinutes(Math.ceil(probe.getUTCMinutes() / cfg.batch_every_min) * cfg.batch_every_min);
  const ticks = Math.ceil((48 * 60) / cfg.batch_every_min) + 1;
  for (let i = 0; i < ticks; i++) {
    const t = new Date(probe.getTime() + i * step);
    if (t > d && shouldRunAt(t, cfg, batchesNeeded)) return t;
  }
  return null;
}

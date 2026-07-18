// Pipeline schedule (owner request 2026-07-18: cron editable from the console,
// no deploys). The Cloudflare cron is a dumb hourly 24/7 tick; whether a tick
// RUNS is decided here from the D1 config `schedule`. Pure + unit-tested.

export interface ScheduleCfg {
  /** Run every N hours within the window (1 = hourly). */
  every_hours: number;
  /** First active hour (0-23) in the configured timezone, inclusive. */
  start_hour: number;
  /** Last active hour (0-23), inclusive. */
  end_hour: number;
  /** IANA timezone the window is expressed in (DST-aware). */
  timezone: string;
}

export const DEFAULT_SCHEDULE: ScheduleCfg = {
  every_hours: 1, start_hour: 9, end_hour: 19, timezone: 'America/New_York',
};

export const SCHEDULE_TIMEZONES = [
  'America/New_York', 'America/Bogota', 'America/Vancouver', 'UTC',
] as const;

/** Hour of day (0-23) in the given timezone, DST-aware. */
export function hourIn(timezone: string, d: Date): number {
  const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', hour12: false }).format(d));
  return h === 24 ? 0 : h;
}

/** Coerces arbitrary stored JSON into a safe ScheduleCfg (bad values -> defaults). */
export function normalizeSchedule(raw: unknown): ScheduleCfg {
  const r = (raw ?? {}) as Partial<ScheduleCfg>;
  const int = (v: unknown, lo: number, hi: number, dflt: number) => {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n >= lo && n <= hi ? n : dflt;
  };
  const tz = typeof r.timezone === 'string' && (SCHEDULE_TIMEZONES as readonly string[]).includes(r.timezone)
    ? r.timezone : DEFAULT_SCHEDULE.timezone;
  const start = int(r.start_hour, 0, 23, DEFAULT_SCHEDULE.start_hour);
  return {
    every_hours: int(r.every_hours, 1, 12, DEFAULT_SCHEDULE.every_hours),
    start_hour: start,
    end_hour: int(r.end_hour, start, 23, Math.max(start, DEFAULT_SCHEDULE.end_hour)),
    timezone: tz,
  };
}

/** Should a tick at instant `d` actually run the pipeline? */
export function shouldRunAt(d: Date, cfg: ScheduleCfg): boolean {
  const h = hourIn(cfg.timezone, d);
  if (h < cfg.start_hour || h > cfg.end_hour) return false;
  return (h - cfg.start_hour) % Math.max(1, cfg.every_hours) === 0;
}

/** Next instant (top of hour) at/after `d` that would run; null if none in 48h. */
export function nextRunAfter(d: Date, cfg: ScheduleCfg): Date | null {
  const probe = new Date(d);
  probe.setMinutes(0, 0, 0);
  for (let i = 0; i < 49; i++) {
    const t = new Date(probe.getTime() + i * 3600_000);
    if (t > d && shouldRunAt(t, cfg)) return t;
  }
  return null;
}

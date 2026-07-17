// Freshness (docs/TRD.md §5): edad = hoy - posted_at <= FRESHNESS_MAX_DAYS.
// posted_at ausente/invalido -> fallback a first_seen y freshness_ok = 'unknown'.

export interface Freshness {
  fresh: boolean;
  freshness_ok: 'true' | 'unknown';
  age_days: number;
}

export function checkFreshness(
  postedAt: string | null,
  firstSeen: string,
  maxDays: number,
  now: Date = new Date(),
): Freshness {
  const posted = postedAt ? new Date(postedAt) : null;
  const hasReliableDate = posted !== null && !Number.isNaN(posted.getTime());
  const reference = hasReliableDate ? posted : new Date(firstSeen);
  const ageDays = (now.getTime() - reference.getTime()) / 86_400_000;
  return {
    fresh: ageDays <= maxDays,
    freshness_ok: hasReliableDate ? 'true' : 'unknown',
    age_days: Math.max(0, Math.round(ageDays * 10) / 10),
  };
}

// Freshness (docs/TRD.md §5): age = today - posted_at <= FRESHNESS_MAX_DAYS.
// posted_at missing/invalid -> falls back to first_seen and freshness_ok = 'unknown'.

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

/**
 * A NEW posting we can prove is older than the freshness window — it can never be notified
 * (rule 3), so the pipeline drops it before any detail fetch or scoring. Requires a RELIABLE
 * date: an unknown/missing date is treated as fresh (processed), never dropped on a guess.
 */
export function reliablyStale(f: Freshness): boolean {
  return !f.fresh && f.freshness_ok === 'true';
}

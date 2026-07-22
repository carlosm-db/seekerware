// Run instrumentation (TRD §7): in-memory counters, zero intermediate
// writes; everything is flushed in ONE flush inside the final db.batch().

export interface PendingEvent {
  type: string;
  severity: 'info' | 'warn' | 'error';
  company_id?: number;
  url_hash?: string;
  detail?: string;
}

export interface PendingNotification {
  url_hash?: string;
  kind: 'job' | 'maintenance' | 'digest';
  status: 'sent' | 'fail';
  tg_message_id?: number;
  error?: string;
}

export class RunStats {
  companiesTotal = 0;
  companiesOk = 0;
  companiesFail = 0;
  jobsSeen = 0;
  jobsNew = 0;
  jobsScored = 0;
  detailFetches = 0;
  survivors = 0;
  notified = 0;
  closed = 0;
  subrequests = 0;
  d1Reads = 0;
  d1Writes = 0;
  geminiCalls = 0;
  events: PendingEvent[] = [];
  notifications: PendingNotification[] = [];

  get errors(): number {
    return this.events.filter((e) => e.severity === 'error').length;
  }

  get errorSummary(): string | null {
    const first = this.events.find((e) => e.severity === 'error');
    return first ? `${first.type}: ${first.detail ?? ''}`.slice(0, 200) : null;
  }

  event(e: PendingEvent): void {
    this.events.push(e);
  }

  /** Exact, free D1 accounting: accumulates the meta of each result. */
  d1(meta: { rows_read?: number; rows_written?: number } | undefined): void {
    this.d1Reads += meta?.rows_read ?? 0;
    this.d1Writes += meta?.rows_written ?? 0;
  }
}

/**
 * Wraps every outbound fetch of the poller: caps each with a timeout and counts them (informational —
 * the Actions runtime has no subrequest limit). Without the timeout a single stalled ATS endpoint could
 * hang the run; on timeout the fetch rejects → the connector throws → per-company isolation records a
 * fetch_fail and the run continues. Used for the ATS + notify path; the Gemini/CV path uses plain fetch.
 */
export function trackedFetch(stats: RunStats, timeoutMs = 20000) {
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    stats.subrequests++;
    return fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(timeoutMs) });
  };
}

/**
 * Per-ATS fetch timeout: list-only ATS (SuccessFactors urlset, Workday) fetch slow, large feeds and
 * legitimately need longer than the fast API boards — a flat 20 s clipped Scotiabank's SF feed. Baked
 * defaults apply even with no config; a `ats_timeouts` config value ({ats: ms}) overrides per ATS.
 */
export const DEFAULT_ATS_TIMEOUTS: Record<string, number> = { successfactors: 35000, workday: 35000 };

export function atsTimeoutMs(cfg: Record<string, number>, ats: string, fallback: number): number {
  return cfg[ats] ?? DEFAULT_ATS_TIMEOUTS[ats] ?? fallback;
}

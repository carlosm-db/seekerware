// Instrumentacion del run (TRD §7): contadores en memoria, cero escrituras
// intermedias; todo se vuelca en UN flush dentro del db.batch() final.

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

  /** Contabilidad D1 exacta y gratis: acumula meta de cada resultado. */
  d1(meta: { rows_read?: number; rows_written?: number } | undefined): void {
    this.d1Reads += meta?.rows_read ?? 0;
    this.d1Writes += meta?.rows_written ?? 0;
  }
}

/** Envuelve TODO fetch saliente del pipeline: cuenta subrequests contra el limite de 50. */
export function trackedFetch(stats: RunStats) {
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    stats.subrequests++;
    return fetch(input, init);
  };
}

// D1 access (docs/DATABASE.md). Single door to the store: prepared statements,
// never interpolated SQL. The run's writes travel in ONE final db.batch().

import type { Company, Env } from './types';
import type { RunStats } from './runstats';

interface CompanyRow {
  id: number;
  name: string;
  ats: Company['ats'];
  token: string;
  active: number;
  last_ok_fetch: string | null;
  fail_count: number;
}

export interface StoredCompany extends Company {
  last_ok_fetch: string | null;
  fail_count: number;
}

export async function getConfigValue(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT value FROM config WHERE key = ?').bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

/** Round-robin page of active companies (cursor in config['poll_cursor']). */
export async function getCompaniesPage(
  env: Env,
  stats: RunStats,
): Promise<{ companies: StoredCompany[]; nextCursor: number }> {
  const pageSize = Number((await getConfigValue(env, 'poll_page_size')) ?? '25');
  const cursor = Number((await getConfigValue(env, 'poll_cursor')) ?? '0');

  const q = env.DB.prepare(
    'SELECT id, name, ats, token, active, last_ok_fetch, fail_count FROM companies WHERE active = 1 AND id > ? ORDER BY id LIMIT ?',
  );
  let res = await q.bind(cursor, pageSize).all<CompanyRow>();
  stats.d1(res.meta);
  let rows = res.results;
  if (rows.length < pageSize) {
    // wrap-around: fill the page from the beginning
    const res2 = await q.bind(0, pageSize - rows.length).all<CompanyRow>();
    stats.d1(res2.meta);
    const seen = new Set(rows.map((r) => r.id));
    rows = rows.concat(res2.results.filter((r) => !seen.has(r.id)));
  }
  const companies = rows.map((r) => ({ ...r, active: r.active === 1 }));
  const nextCursor = rows.length ? rows[rows.length - 1]!.id : 0;
  return { companies, nextCursor };
}

/** Current state of a company's jobs (for dedup and auto-expire). */
export async function getCompanyJobs(
  env: Env,
  stats: RunStats,
  companyId: number,
): Promise<Map<string, string>> {
  const res = await env.DB.prepare('SELECT url_hash, status FROM jobs WHERE company_id = ?')
    .bind(companyId)
    .all<{ url_hash: string; status: string }>();
  stats.d1(res.meta);
  return new Map(res.results.map((r) => [r.url_hash, r.status]));
}

/** Opens the run row (immediate INSERT: a crash must be data, not silence) and stamps orphans. */
export async function openRun(env: Env, trigger: 'cron' | 'manual', nowIso: string): Promise<number> {
  await env.DB.prepare(
    "UPDATE runs SET status = 'crashed', finished_at = ? WHERE status = 'running' AND started_at < datetime(?, '-10 minutes')",
  )
    .bind(nowIso, nowIso)
    .run();
  const row = await env.DB.prepare('INSERT INTO runs (started_at, trigger) VALUES (?, ?) RETURNING id')
    .bind(nowIso, trigger)
    .first<{ id: number }>();
  if (!row) throw new Error('could not open run row');
  return row.id;
}

export interface JobInsert {
  url_hash: string;
  url: string;
  company_id: number;
  ats: string;
  ext_id: string;
  title: string;
  location: string;
  posted_at: string | null;
  freshness_ok: 'true' | 'unknown';
  track: string | null;
  score: number;
  verdict: string;
  status: 'new' | 'notified' | 'skipped' | 'closed';
  first_seen: string;
  last_seen: string;
  notified_at: string | null;
  cv_pending: 0 | 1;
  why_it_fits: string;
  positioning_lead: string;
  description_text: string;
  score_breakdown: string;
  title_norm: string;
}

/** Statement builder for the run's final batch. */
export class RunBatch {
  private statements: D1PreparedStatement[] = [];

  constructor(private env: Env) {}

  insertJob(j: JobInsert): void {
    this.statements.push(
      this.env.DB.prepare(
        `INSERT INTO jobs (url_hash, url, company_id, ats, ext_id, title, location, posted_at,
           freshness_ok, track, score, verdict, status, first_seen, last_seen, notified_at,
           cv_pending, why_it_fits, positioning_lead, description_text, score_breakdown, title_norm)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(
        j.url_hash, j.url, j.company_id, j.ats, j.ext_id, j.title, j.location, j.posted_at,
        j.freshness_ok, j.track, j.score, j.verdict, j.status, j.first_seen, j.last_seen,
        j.notified_at, j.cv_pending, j.why_it_fits, j.positioning_lead, j.description_text,
        j.score_breakdown, j.title_norm,
      ),
    );
  }

  /**
   * Auto-expire: called ONLY for companies with a successful fetch in this run.
   * Stamps last_seen = now (last moment of confirmed presence, with a maximum
   * error of one cron interval).
   */
  closeJobs(urlHashes: string[], nowIso: string): void {
    for (const h of urlHashes) {
      this.statements.push(
        this.env.DB.prepare(
          "UPDATE jobs SET status = 'closed', last_seen = ? WHERE url_hash = ? AND status IN ('new','notified')",
        ).bind(nowIso, h),
      );
    }
  }

  companySuccess(companyId: number, nowIso: string): void {
    this.statements.push(
      this.env.DB.prepare(
        'UPDATE companies SET last_ok_fetch = ?, fail_count = 0, fetch_ok_total = fetch_ok_total + 1 WHERE id = ?',
      ).bind(nowIso, companyId),
    );
  }

  companyFailure(companyId: number, nowIso: string, error: string): void {
    this.statements.push(
      this.env.DB.prepare(
        'UPDATE companies SET fail_count = fail_count + 1, fetch_fail_total = fetch_fail_total + 1, last_fail = ?, last_error = ? WHERE id = ?',
      ).bind(nowIso, error.slice(0, 200), companyId),
    );
  }

  setConfig(key: string, value: string): void {
    this.statements.push(
      this.env.DB.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').bind(key, value),
    );
  }

  /** Flushes events, deliveries and the run close; runs EVERYTHING atomically. */
  async flush(runId: number, stats: RunStats, status: string, nowIso: string, startedMs: number): Promise<void> {
    for (const e of stats.events) {
      this.statements.push(
        this.env.DB.prepare(
          'INSERT INTO events (run_id, ts, type, severity, company_id, url_hash, detail) VALUES (?,?,?,?,?,?,?)',
        ).bind(runId, nowIso, e.type, e.severity, e.company_id ?? null, e.url_hash ?? null, e.detail ?? null),
      );
    }
    for (const n of stats.notifications) {
      this.statements.push(
        this.env.DB.prepare(
          'INSERT INTO notifications (run_id, url_hash, kind, ts, status, tg_message_id, error) VALUES (?,?,?,?,?,?,?)',
        ).bind(runId, n.url_hash ?? null, n.kind, nowIso, n.status, n.tg_message_id ?? null, n.error ?? null),
      );
    }
    // 1) Run the run's work and accumulate the exact D1 accounting from its metas
    if (this.statements.length) {
      const results = await this.env.DB.batch(this.statements);
      for (const r of results) stats.d1(r.meta);
      this.statements = [];
    }
    // 2) Close the run row with the COMPLETE counters (including the batch above)
    await this.env.DB.prepare(
      `UPDATE runs SET finished_at = ?, status = ?, duration_ms = ?,
         companies_total = ?, companies_ok = ?, companies_fail = ?,
         jobs_seen = ?, jobs_new = ?, jobs_scored = ?, survivors = ?, notified = ?, closed = ?,
         subrequests = ?, d1_reads = ?, d1_writes = ?, gemini_calls = ?, errors = ?, error_summary = ?
       WHERE id = ?`,
    )
      .bind(
        nowIso, status, Date.now() - startedMs,
        stats.companiesTotal, stats.companiesOk, stats.companiesFail,
        stats.jobsSeen, stats.jobsNew, stats.jobsScored, stats.survivors, stats.notified, stats.closed,
        stats.subrequests, stats.d1Reads, stats.d1Writes, stats.geminiCalls, stats.errors, stats.errorSummary,
        runId,
      )
      .run();
  }
}

/** Per-table counts — proof of life of the migration and the binding (route /api/health). */
export async function counts(env: Env): Promise<Record<string, number>> {
  const tables = ['companies', 'jobs', 'anchors', 'blocks', 'config', 'runs', 'events', 'notifications'] as const;
  const out: Record<string, number> = {};
  for (const t of tables) {
    const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<{ n: number }>();
    out[t] = row?.n ?? 0;
  }
  return out;
}

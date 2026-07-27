// Run orchestration (docs/TRD.md §7): per-company isolation, dedup,
// freshness, verify-on-notify, notification, auto-expire, instrumentation.

import type { Env, Job } from './types';
import { connectors } from './connectors/index';
import { urlHash } from './connectors/common';
import { loadScoringConfig } from './config-store';
import { normalizeTitle, scoreJob, type ScoringConfig } from './scoring';
import { checkFreshness, reliablyStale } from './freshness';
import { formatDigest, formatJobMessage, formatMaintenance, notifyViaWorker, ruleBasedTexts } from './notify';
import { generateCv } from './ia/cv_factory';
import { RunStats, atsTimeoutMs, trackedFetch } from './runstats';
import { RunBatch, getActiveCompanies, getCompanyJobs, getConfigValue, openRun, type StoredCompany } from './store';

/**
 * Drains the CV queue: builds ONE queued CV (oldest cv_pending job) per call. Standalone so the
 * Worker's cron can drain it on its own — it only reads jobs already flagged `cv_pending=1`; it
 * NEVER polls a company (polling runs in the Actions poller). generateCv clears the flag on
 * success; on failure a `gdocs_fail` event is logged so the retry cap (cv_pending_max) still applies.
 */
export async function buildPendingCvs(env: Env, doFetch: typeof fetch = fetch): Promise<void> {
  if (!env.GOOGLE_OAUTH_REFRESH_TOKEN) return;
  const pending = await env.DB.prepare(
    `SELECT j.url_hash, j.title, j.location, j.description_text, j.track, j.url, j.ext_id, j.ats, c.name company
     FROM jobs j JOIN companies c ON c.id = j.company_id
     WHERE j.cv_pending = 1 AND j.status IN ('new','notified','aged')
     ORDER BY j.notified_at, j.first_seen LIMIT 1`,
  ).first<Record<string, string | null>>();
  if (!pending) return; // empty queue → no-op

  const hash = String(pending.url_hash);
  const nowIso = new Date().toISOString();
  const cvPendingMax = (JSON.parse((await getConfigValue(env, 'observability')) ?? '{}') as
    { cv_pending_max?: number }).cv_pending_max ?? 5;

  // Retry budget: a broken build must not burn Gemini calls forever (2026-07-18 audit).
  const fails = await env.DB.prepare(
    "SELECT COUNT(*) n FROM events WHERE type = 'gdocs_fail' AND url_hash = ?",
  ).bind(hash).first<{ n: number }>();
  if ((fails?.n ?? 0) >= cvPendingMax) {
    await env.DB.batch([
      env.DB.prepare('UPDATE jobs SET cv_pending = 0 WHERE url_hash = ?').bind(hash),
      env.DB.prepare('INSERT INTO job_events (url_hash, ts, actor, event, detail) VALUES (?,?,?,?,?)')
        .bind(hash, nowIso, 'system', 'cv_retries_exhausted',
          `gave up after ${fails?.n} failed builds (cv_pending_max=${cvPendingMax}); re-queue from /cvs once fixed`),
    ]);
    return;
  }

  const fx = await generateCv(env, {
    id: String(pending.ext_id ?? ''), company: String(pending.company), title: String(pending.title),
    location: String(pending.location ?? ''), url: String(pending.url),
    description: String(pending.description_text ?? ''), posted_at: null,
    ats: (pending.ats ?? 'greenhouse') as Job['ats'], raw: null,
    url_hash: hash, track: pending.track ?? null,
  }, 'en', false, doFetch); // on success generateCv sets cv_pending = 0
  if (!fx.ok) {
    await env.DB.prepare(
      'INSERT INTO events (run_id, ts, type, severity, url_hash, detail) VALUES (NULL, ?, ?, ?, ?, ?)',
    ).bind(nowIso, 'gdocs_fail', 'warn', hash, fx.error ?? 'cv build failed').run();
  }
}

export async function runPipeline(env: Env, trigger: 'cron' | 'manual'): Promise<RunStats> {
  const startedMs = Date.now();
  const nowIso = new Date().toISOString();
  const stats = new RunStats();
  // Per-fetch timeout so one stalled ATS board can't wedge the whole run (live-tunable, no deploy).
  const fetchTimeoutMs = Number((await getConfigValue(env, 'fetch_timeout_ms')) ?? '20000') || 20000;
  const doFetch = trackedFetch(stats, fetchTimeoutMs);
  const runId = await openRun(env, trigger, nowIso);
  const batch = new RunBatch(env);
  let runStatus: 'ok' | 'partial' | 'fail' = 'ok';

  try {
    const config = await loadScoringConfig(env);
    const maxDays = Number((await getConfigValue(env, 'FRESHNESS_MAX_DAYS')) ?? '3');
    // STORE window (>= the notify window): a NEW posting reliably older than this is dropped; between the
    // two windows it is kept and stored silently as `aged` (browsable, never alerted). The Node poller is
    // uncapped, so carrying ~45d of backlog is cheap — this replaces the old Worker-era "drop > 3d" rule.
    const storeMaxDays = Number((await getConfigValue(env, 'STORE_MAX_DAYS')) ?? '45');
    // The poller runs in Node (no 10 ms CPU / 50-subrequest limit), so the Worker-era caps are
    // relaxed to effectively unlimited — every fresh new job is scored and enriched each run.
    // Still config-tunable if a specific board ever needs throttling for politeness.
    const maxNewPerRun = Number((await getConfigValue(env, 'max_new_jobs_per_run')) ?? '100000');
    const maxDetailPerRun = Number((await getConfigValue(env, 'max_detail_fetches_per_run')) ?? '100000');
    const detailPerCompany = Number((await getConfigValue(env, 'detail_per_company')) ?? '1000');
    // Companies are processed concurrently (Node has no 6-connection cap) to keep each run ~1 min.
    const concurrency = Number((await getConfigValue(env, 'poll_concurrency')) ?? '10') || 10;
    // Optional per-ATS fetch-timeout overrides ({ats: ms}); SF/Workday get baked longer defaults.
    const atsTimeouts = JSON.parse((await getConfigValue(env, 'ats_timeouts')) ?? '{}') as Record<string, number>;
    const observability = JSON.parse((await getConfigValue(env, 'observability')) ?? '{}') as {
      maintenance_fail_streak?: number;
      cv_pending_max?: number;
    };
    const failStreak = observability.maintenance_fail_streak ?? 3;

    // The Actions poller never builds CVs — those are produced on demand (Telegram/console Prepare)
    // and the Worker's cron drains the queue via buildPendingCvs(). This run only reviews companies.

    const companies = await getActiveCompanies(env, stats);
    stats.companiesTotal = companies.length;

    // Process companies with bounded concurrency. Per-company isolation is unchanged; the shared
    // stats/batch tolerate async interleaving now that the per-run caps no longer bind.
    await mapPool(companies, concurrency, async (company) => {
      // Per-company fetcher with the ATS's timeout: slow list-only feeds (SF/Workday) get longer
      // than the fast API boards, so Scotiabank isn't clipped while a real hang is still aborted.
      const cFetch = trackedFetch(stats, atsTimeoutMs(atsTimeouts, company.ats, fetchTimeoutMs));
      try {
        await processCompany(env, company, config, maxDays, storeMaxDays, maxNewPerRun, maxDetailPerRun, detailPerCompany, nowIso, stats, batch, cFetch);
        stats.companiesOk++;
        batch.companySuccess(company.id, runId, nowIso);
      } catch (err) {
        stats.companiesFail++;
        const detail = err instanceof Error ? err.message : 'unknown error';
        stats.event({ type: 'fetch_fail', severity: 'error', company_id: company.id, detail });
        batch.companyFailure(company.id, runId, nowIso, detail);
        // MAINTENANCE alert exactly when crossing the threshold (anti-spam: only on equality)
        if (company.fail_count + 1 === failStreak) {
          const msg = formatMaintenance(`${company.name} feed failed ${failStreak} runs in a row: ${detail}`);
          const sent = await notifyViaWorker(env, { text: msg, kind: 'maintenance' }, doFetch);
          stats.notifications.push({
            kind: 'maintenance',
            status: sent.ok ? 'sent' : 'fail',
            tg_message_id: sent.message_id,
            error: sent.error,
          });
          stats.event({ type: 'maintenance_alert', severity: 'warn', company_id: company.id, detail });
        }
      }
    });

    if (stats.companiesFail > 0) runStatus = 'partial';

    const obsCfg = JSON.parse((await getConfigValue(env, 'observability')) ?? '{}') as {
      retention_days?: { runs?: number; events?: number; notifications?: number };
      digest?: { dow?: number; hour_utc?: number };
    };

    // Retention: the first run of each day prunes the observability tables.
    // Cutoffs in JS ISO (stored timestamps are toISOString(); comparing them
    // against SQLite's datetime() would over-include the boundary day: 'T' > ' ').
    // FK-safe order: CHILDREN first (events/notifications, including those that
    // reference runs to be pruned), then runs — otherwise DELETE FROM runs violates the FK.
    const today = nowIso.slice(0, 10);
    if ((await getConfigValue(env, 'prune_last')) !== today) {
      const ret = obsCfg.retention_days ?? {};
      const isoDaysAgo = (d: number) => new Date(Date.now() - d * 86400000).toISOString();
      const runsCutoff = isoDaysAgo(ret.runs ?? 400);
      const results = await env.DB.batch([
        env.DB.prepare('DELETE FROM events WHERE ts < ? OR run_id IN (SELECT id FROM runs WHERE started_at < ?)')
          .bind(isoDaysAgo(ret.events ?? 90), runsCutoff),
        env.DB.prepare('DELETE FROM notifications WHERE ts < ? OR run_id IN (SELECT id FROM runs WHERE started_at < ?)')
          .bind(isoDaysAgo(ret.notifications ?? 180), runsCutoff),
        env.DB.prepare('DELETE FROM runs WHERE started_at < ?').bind(runsCutoff),
      ]);
      for (const r of results) stats.d1(r.meta);
      batch.setConfig('prune_last', today);
      const changes = results.map((r) => r.meta.changes ?? 0);
      stats.event({ type: 'prune', severity: 'info', detail: `events:${changes[0]} notifications:${changes[1]} runs:${changes[2]}` });
    }

    // Weekly digest: first run after the configured day/hour (Monday ~06:00 Bogota)
    const digestCfg = obsCfg.digest ?? { dow: 1, hour_utc: 11 };
    const nowDate = new Date(nowIso);
    const weekKey = `${nowDate.getUTCFullYear()}-W${isoWeek(nowDate)}`;
    if (
      nowDate.getUTCDay() === (digestCfg.dow ?? 1) &&
      nowDate.getUTCHours() >= (digestCfg.hour_utc ?? 11) &&
      (await getConfigValue(env, 'digest_last_sent')) !== weekKey
    ) {
      // Claim-first (IMMEDIATE write, not in the final batch): guarantees
      // at-most-once even if a manual run and the cron overlap or the run dies
      // after sending. If the send fails, that week's digest is lost
      // (tolerable, the event remains) — it is never duplicated.
      await env.DB.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('digest_last_sent', ?)")
        .bind(weekKey).run();
      const digest = await buildDigest(env);
      const sent = await notifyViaWorker(env, { text: formatDigest(digest), kind: 'digest' }, doFetch);
      stats.notifications.push({ kind: 'digest', status: sent.ok ? 'sent' : 'fail', tg_message_id: sent.message_id, error: sent.error });
      stats.event({ type: 'digest_sent', severity: sent.ok ? 'info' : 'warn', detail: `${weekKey}${sent.ok ? '' : ` FAILED: ${sent.error}`}` });
    }
  } catch (err) {
    runStatus = 'fail';
    stats.event({
      type: 'run_crash',
      severity: 'error',
      detail: err instanceof Error ? err.message : 'run error',
    });
  } finally {
    await batch.flush(runId, stats, runStatus, new Date().toISOString(), startedMs);
  }
  return stats;
}

function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

/** Runs `fn` over `items` with at most `limit` tasks in flight at once. */
async function mapPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

async function buildDigest(env: Env) {
  // Cutoff in JS ISO: same exact numbers as the Overview funnel (stored timestamps are
  // toISOString(); SQLite's datetime() does not compare well against them).
  const cutoff = new Date(Date.now() - 7 * 86400000).toISOString();
  const wk = await env.DB.prepare(
    `SELECT
      (SELECT COUNT(*) FROM runs WHERE started_at >= ?1) runs_total,
      (SELECT COUNT(*) FROM runs WHERE started_at >= ?1 AND status='ok') runs_ok,
      (SELECT COALESCE(SUM(jobs_seen),0) FROM runs WHERE started_at >= ?1) seen,
      (SELECT COUNT(*) FROM jobs WHERE first_seen >= ?1) new_jobs,
      (SELECT COUNT(*) FROM jobs WHERE first_seen >= ?1 AND verdict != 'Skip') survivors,
      (SELECT COUNT(*) FROM jobs WHERE notified_at >= ?1) notified,
      (SELECT COUNT(*) FROM applications WHERE applied_at >= ?1) applied,
      (SELECT COUNT(*) FROM companies WHERE active=1 AND fail_count > 0) failing`,
  ).bind(cutoff).first<Record<string, number | string>>();
  const top = await env.DB.prepare(
    `SELECT c.name FROM jobs j JOIN companies c ON c.id=j.company_id
     WHERE j.first_seen >= ? AND j.verdict != 'Skip'
     GROUP BY c.id ORDER BY COUNT(*) DESC LIMIT 1`,
  ).bind(cutoff).first<{ name: string }>();
  return {
    runsTotal: Number(wk?.runs_total ?? 0),
    runsOk: Number(wk?.runs_ok ?? 0),
    seen: Number(wk?.seen ?? 0),
    newJobs: Number(wk?.new_jobs ?? 0),
    survivors: Number(wk?.survivors ?? 0),
    notified: Number(wk?.notified ?? 0),
    applied: Number(wk?.applied ?? 0),
    topCompany: top?.name ?? null,
    failing: Number(wk?.failing ?? 0),
  };
}

async function processCompany(
  env: Env,
  company: StoredCompany,
  config: ScoringConfig,
  maxDays: number,
  storeMaxDays: number,
  maxNewPerRun: number,
  maxDetailPerRun: number,
  maxDetailPerCompany: number,
  nowIso: string,
  stats: RunStats,
  batch: RunBatch,
  doFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): Promise<void> {
  const connector = connectors[company.ats];
  // A company's first run = seeding: the history is seeded WITHOUT notifying (rule 4).
  const seeding = company.last_ok_fetch === null;

  const jobs = await connector.fetchJobs(company, doFetch);
  stats.jobsSeen += jobs.length;

  const existing = await getCompanyJobs(env, stats, company.id);
  const seenHashes = new Set<string>();
  let companyDetail = 0; // per-company detail-fetch count this run (fairness cap)

  for (const job of jobs) {
    const hash = await urlHash(job.url);
    seenHashes.add(hash);
    if (existing.has(hash)) {
      // Dedup: existing -> continue. last_seen is NOT written on presence:
      // it would cost ~129k rows/day (>100k free tier). An open job's presence
      // is guaranteed by auto-expire; last_seen is stamped on close.
      continue;
    }
    // Two windows (docs/TRD.md §5): NOTIFY (maxDays, ~3d) gates whether a survivor is alerted; STORE
    // (storeMaxDays, ~45d) gates whether it is kept at all. A NEW posting reliably older than the STORE
    // window is dropped here — before any detail fetch or scoring. Between the two windows it is KEPT and
    // stored silently as `aged` (browsable, never notified — rule 3). A missing/unreliable date is treated
    // as fresh. This still stops a board from dumping ancient (> storeMaxDays) postings every run.
    const freshness = checkFreshness(job.posted_at, nowIso, maxDays);            // notify window
    const storeFreshness = checkFreshness(job.posted_at, nowIso, storeMaxDays);  // store window
    if (reliablyStale(storeFreshness)) continue;
    if (stats.jobsNew >= maxNewPerRun) {
      // CPU cap reached: the rest waits for the next run (they are still
      // "new"; not being in the store, auto-expire does not touch them).
      continue;
    }
    stats.jobsNew++;
    // Fetch the description BEFORE scoring: the light list may omit it (Greenhouse, SF <urlset>,
    // Workday), and the per-track location gates are text-scoped (they read the description), so
    // scoring without it could wrongly reject a "remote in the description" job. Fetch for every
    // fresh new job, capped per run by the subrequest budget; overflow spills to the next run.
    if (connector.fetchDetail && !job.description) {
      // Stop if the run budget OR this company's fair share is spent → the rest spills to next run.
      if (stats.detailFetches >= maxDetailPerRun || companyDetail >= maxDetailPerCompany) { stats.jobsNew--; continue; }
      stats.detailFetches++;
      companyDetail++;
      try {
        Object.assign(job, await connector.fetchDetail(company, job, doFetch));
      } catch (err) {
        stats.event({
          type: 'fetch_fail', severity: 'warn', company_id: company.id, url_hash: hash,
          detail: err instanceof Error ? err.message : 'detail fetch failed',
        });
      }
    }
    const result = scoreJob(job, config);
    stats.jobsScored++;
    const isSurvivor = result.best.verdict !== 'Skip';

    let status: 'new' | 'notified' | 'aged' | 'skipped' | 'closed' =
      isSurvivor ? (freshness.fresh ? 'new' : 'aged') : 'skipped';
    let notifiedAt: string | null = null;
    let cvPending: 0 | 1 = 0;
    let enrichedBy = 'rule';
    let roleAnalysis: string | null = null;
    const texts = ruleBasedTexts(result);

    if (seeding) {
      status = 'skipped';
    } else if (isSurvivor) {
      stats.survivors++;
      // Notify on Apply only: Stretch-worth-it survivors are still stored and shown in the console
      // (New survivors), but never pushed to Telegram (owner's choice — keep alerts high-signal).
      if (freshness.fresh && result.best.verdict === 'Apply') {
        // verify-on-notify immediately before the push
        let alive: boolean | null = null;
        try {
          alive = await connector.isLive(company, job, doFetch);
        } catch (err) {
          stats.event({
            type: 'verify_fail', severity: 'warn', company_id: company.id, url_hash: hash,
            detail: err instanceof Error ? err.message : 'verify indeterminate',
          });
        }
        if (alive === false) {
          status = 'closed';
          stats.event({ type: 'verify_dead', severity: 'info', company_id: company.id, url_hash: hash });
        } else if (alive === true) {
          // Enrichment (job_analyst + enricher) is intentionally OUT of the burst: 2 sequential
          // Gemini calls per survivor inflated wall-clock and hard-killed runs before flush.
          // The notification uses the deterministic rule-based texts; role_analysis stays null
          // here (the CV factory handles a null analysis at Prepare — cv_factory.ts:145-149).
          const ruleBased = true;
          const msg = formatJobMessage({
            job, verdict: result.best.verdict, track: result.best.track ?? '—',
            score: result.best.adjusted_score, ageDays: freshness.age_days,
            whyItFits: texts.whyItFits, gapToAddress: texts.gapToAddress,
            positioningLead: texts.positioningLead, ruleBased,
          });
          // Step-8 buttons (Prepare / I applied / Dismiss) are attached by the Worker's /api/notify.
          const sent = await notifyViaWorker(env, { text: msg, hash, kind: 'job' }, doFetch);
          stats.notifications.push({
            url_hash: hash, kind: 'job', status: sent.ok ? 'sent' : 'fail',
            tg_message_id: sent.message_id, error: sent.error,
          });
          if (sent.ok) {
            status = 'notified';
            notifiedAt = nowIso;
            stats.notified++;
            // CV and kit are NOT built at notify — they're produced on Prepare
            // (console or Telegram), on the spot, in a dedicated request with its
            // own subrequest budget. Notify just alerts; the burst stays light.
          } else {
            stats.event({ type: 'telegram_fail', severity: 'error', url_hash: hash, detail: sent.error });
            // stays 'new': the next run retries
          }
        }
        // alive === null (indeterminate): stays 'new', NEVER notified without verifying
      }
    }

    const row = {
      url_hash: hash, url: job.url, company_id: company.id, ats: job.ats, ext_id: job.id,
      title: job.title, location: job.location, posted_at: job.posted_at,
      freshness_ok: freshness.freshness_ok, track: result.best.track,
      score: result.best.adjusted_score, verdict: result.best.verdict, status,
      first_seen: nowIso, last_seen: nowIso, notified_at: notifiedAt,
      cv_pending: cvPending,
      why_it_fits: texts.whyItFits, positioning_lead: texts.positioningLead,
      description_text: job.description, score_breakdown: JSON.stringify(result),
      title_norm: normalizeTitle(job.title), enriched_by: enrichedBy, role_analysis: roleAnalysis,
    };
    // A NOTIFIED job is persisted IMMEDIATELY: if this run is cut before the final batch flush,
    // it must not be lost or re-notified next run (dedup skips already-saved hashes). Everything
    // else stays in the end-of-run batch (losing those on a crash is harmless: no notification).
    if (status === 'notified') await batch.insertJobNow(row);
    else batch.insertJob(row);
  }

  // Auto-expire ONLY on a successful fetch (being here = success): absent from the feed -> closed
  const disappeared = [...existing.entries()]
    .filter(([hash, status]) => !seenHashes.has(hash) && (status === 'new' || status === 'notified' || status === 'aged'))
    .map(([hash]) => hash);
  if (disappeared.length) {
    batch.closeJobs(disappeared, nowIso);
    stats.closed += disappeared.length;
  }
}

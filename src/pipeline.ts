// Run orchestration (docs/TRD.md §7): per-company isolation, dedup,
// freshness, verify-on-notify, notification, auto-expire, instrumentation.

import type { Env, Job } from './types';
import { connectors } from './connectors/index';
import { urlHash } from './connectors/common';
import { loadScoringConfig } from './config-store';
import { normalizeTitle, scoreJob, type ScoringConfig } from './scoring';
import { checkFreshness } from './freshness';
import { formatDigest, formatJobMessage, formatMaintenance, ruleBasedTexts, sendTelegram } from './notify';
import { enricher } from './ia/agents';
import { generateCv } from './ia/cv_factory';
import { RunStats, trackedFetch } from './runstats';
import { RunBatch, getCompaniesPage, getCompanyJobs, getConfigValue, openRun, type StoredCompany } from './store';

export async function runPipeline(env: Env, trigger: 'cron' | 'manual'): Promise<RunStats> {
  const startedMs = Date.now();
  const nowIso = new Date().toISOString();
  const stats = new RunStats();
  const doFetch = trackedFetch(stats);
  const runId = await openRun(env, trigger, nowIso);
  const batch = new RunBatch(env);
  let runStatus: 'ok' | 'partial' | 'fail' = 'ok';

  try {
    const config = await loadScoringConfig(env);
    const maxDays = Number((await getConfigValue(env, 'FRESHNESS_MAX_DAYS')) ?? '3');
    // Cap on NEW jobs scored per run: protects the free tier's CPU limit
    // (error 1102 confirmed by seeding 1,336 at once). Seeding completes in
    // batches over successive runs; steady state never comes close.
    const maxNewPerRun = Number((await getConfigValue(env, 'max_new_jobs_per_run')) ?? '100');
    // Cap on per-job description fetches per run (list-only connectors: SF <urlset>,
    // Workday). Protects the 50-subrequest budget; overflow spills to the next run.
    const maxDetailPerRun = Number((await getConfigValue(env, 'max_detail_fetches_per_run')) ?? '12');
    const observability = JSON.parse((await getConfigValue(env, 'observability')) ?? '{}') as {
      maintenance_fail_streak?: number;
      cv_pending_max?: number;
    };
    const failStreak = observability.maintenance_fail_streak ?? 3;
    const cvPendingMax = observability.cv_pending_max ?? 5;

    // CV factory: builds ONE pending item per run (oldest first). status also
    // accepts 'new' so the console "Generate REAL CV" action can queue any job.
    if (env.GOOGLE_SA_KEY) {
      const pending = await env.DB.prepare(
        `SELECT j.url_hash, j.title, j.location, j.description_text, j.track, j.url, j.ext_id, j.ats, c.name company
         FROM jobs j JOIN companies c ON c.id = j.company_id
         WHERE j.cv_pending = 1 AND j.status IN ('new','notified')
         ORDER BY j.notified_at, j.first_seen LIMIT 1`,
      ).first<Record<string, string | null>>();
      if (pending) {
        // Retry budget: a broken build (e.g. template not shared with the SA)
        // must not burn 2 Gemini calls every run forever (2026-07-18 audit).
        const fails = await env.DB.prepare(
          "SELECT COUNT(*) n FROM events WHERE type = 'gdocs_fail' AND url_hash = ?",
        ).bind(pending.url_hash).first<{ n: number }>();
        if ((fails?.n ?? 0) >= cvPendingMax) {
          await env.DB.prepare('UPDATE jobs SET cv_pending = 0 WHERE url_hash = ?').bind(pending.url_hash).run();
          stats.event({
            type: 'cv_retries_exhausted', severity: 'warn', url_hash: String(pending.url_hash),
            detail: `gave up after ${fails?.n} failed builds (cv_pending_max=${cvPendingMax}); re-queue from /cvs once fixed`,
          });
        } else {
          const fx = await generateCv(env, {
            id: String(pending.ext_id ?? ''), company: String(pending.company), title: String(pending.title),
            location: String(pending.location ?? ''), url: String(pending.url),
            description: String(pending.description_text ?? ''), posted_at: null,
            ats: (pending.ats ?? 'greenhouse') as Job['ats'], raw: null,
            url_hash: String(pending.url_hash), track: pending.track ?? null,
          }, 'en', false, doFetch);
          stats.geminiCalls += fx.gemini_calls;
          if (!fx.ok) {
            stats.event({ type: 'gdocs_fail', severity: 'warn', url_hash: String(pending.url_hash), detail: fx.error });
          }
        }
      }
    }

    const { companies, nextCursor } = await getCompaniesPage(env, stats);
    stats.companiesTotal = companies.length;

    for (const company of companies) {
      try {
        await processCompany(env, company, config, maxDays, maxNewPerRun, maxDetailPerRun, nowIso, stats, batch, doFetch);
        stats.companiesOk++;
        batch.companySuccess(company.id, nowIso);
      } catch (err) {
        stats.companiesFail++;
        const detail = err instanceof Error ? err.message : 'unknown error';
        stats.event({ type: 'fetch_fail', severity: 'error', company_id: company.id, detail });
        batch.companyFailure(company.id, nowIso, detail);
        // MAINTENANCE alert exactly when crossing the threshold (anti-spam: only on equality)
        if (company.fail_count + 1 === failStreak) {
          const msg = formatMaintenance(`${company.name} feed failed ${failStreak} runs in a row: ${detail}`);
          const sent = await sendTelegram(env, msg, doFetch);
          stats.notifications.push({
            kind: 'maintenance',
            status: sent.ok ? 'sent' : 'fail',
            tg_message_id: sent.message_id,
            error: sent.error,
          });
          stats.event({ type: 'maintenance_alert', severity: 'warn', company_id: company.id, detail });
        }
      }
    }

    batch.setConfig('poll_cursor', String(nextCursor));
    if (stats.companiesFail > 0) runStatus = 'partial';

    // Quota: warn if the subrequests peak approaches the per-invocation limit
    const obsCfg = JSON.parse((await getConfigValue(env, 'observability')) ?? '{}') as {
      subrequests_warn?: number;
      retention_days?: { runs?: number; events?: number; notifications?: number };
      digest?: { dow?: number; hour_utc?: number };
    };
    if (stats.subrequests > (obsCfg.subrequests_warn ?? 40)) {
      stats.event({ type: 'quota_warn', severity: 'warn', detail: `subrequests ${stats.subrequests} > ${obsCfg.subrequests_warn ?? 40}` });
    }

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
      const sent = await sendTelegram(env, formatDigest(digest), doFetch);
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
  maxNewPerRun: number,
  maxDetailPerRun: number,
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

  for (const job of jobs) {
    const hash = await urlHash(job.url);
    seenHashes.add(hash);
    if (existing.has(hash)) {
      // Dedup: existing -> continue. last_seen is NOT written on presence:
      // it would cost ~129k rows/day (>100k free tier). An open job's presence
      // is guaranteed by auto-expire; last_seen is stamped on close.
      continue;
    }
    if (stats.jobsNew >= maxNewPerRun) {
      // CPU cap reached: the rest waits for the next run (they are still
      // "new"; not being in the store, auto-expire does not touch them).
      continue;
    }
    stats.jobsNew++;
    // Bounded description enrichment for list-only connectors (SF <urlset>, Workday):
    // fetch the per-job detail ONLY for jobs that clear a track's hard (location) gate,
    // capped per run. Jobs that hard-fail every track are a real Skip — no fetch.
    if (connector.fetchDetail && !job.description) {
      const pre = scoreJob(job, config);
      // Enrich if a track's hard (location) gate passes, OR the location is unknown
      // (list gave none — e.g. Workday "N Locations") so we must fetch to learn it.
      const locViable = !job.location || Object.values(pre.tracks).some((t) => !t.hard_failed);
      if (locViable) {
        if (stats.detailFetches >= maxDetailPerRun) { stats.jobsNew--; continue; } // budget spent → next run
        stats.detailFetches++;
        try {
          Object.assign(job, await connector.fetchDetail(company, job, doFetch));
        } catch (err) {
          stats.event({
            type: 'fetch_fail', severity: 'warn', company_id: company.id, url_hash: hash,
            detail: err instanceof Error ? err.message : 'detail fetch failed',
          });
        }
      }
    }
    const result = scoreJob(job, config);
    stats.jobsScored++;
    const isSurvivor = result.best.verdict !== 'Skip';
    const freshness = checkFreshness(job.posted_at, nowIso, maxDays);

    let status: 'new' | 'notified' | 'skipped' | 'closed' = isSurvivor ? 'new' : 'skipped';
    let notifiedAt: string | null = null;
    let cvPending: 0 | 1 = 0;
    let enrichedBy = 'rule';
    const texts = ruleBasedTexts(result);

    if (seeding) {
      status = 'skipped';
    } else if (isSurvivor) {
      stats.survivors++;
      if (freshness.fresh) {
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
          // Enricher (survivors only, TRD §4): improves the texts; never the verdict
          let ruleBased = true;
          if (env.GEMINI_API_KEY) {
            const enriched = await enricher(env, job, {
              why_it_fits: texts.whyItFits, gap_to_address: texts.gapToAddress, positioning_lead: texts.positioningLead,
            }, doFetch);
            stats.geminiCalls += enriched.calls;
            if (enriched.ok && enriched.data) {
              texts.whyItFits = enriched.data.why_it_fits;
              texts.gapToAddress = enriched.data.gap_to_address;
              texts.positioningLead = enriched.data.positioning_lead;
              ruleBased = false;
              enrichedBy = enriched.modelUsed ?? 'gemini';
              if (enriched.modelUsed !== 'gemini-3.1-flash-lite') {
                stats.event({ type: 'gemini_fallback', severity: 'info', url_hash: hash, detail: enriched.modelUsed });
              }
            } else {
              stats.event({ type: 'gemini_fail', severity: 'warn', url_hash: hash, detail: enriched.error });
            }
          }
          const msg = formatJobMessage({
            job, verdict: result.best.verdict, track: result.best.track ?? '—',
            score: result.best.adjusted_score, ageDays: freshness.age_days,
            whyItFits: texts.whyItFits, gapToAddress: texts.gapToAddress,
            positioningLead: texts.positioningLead, ruleBased,
          });
          // Step-8 buttons: View kit / I applied (two-way bot).
          const { kitButtons } = await import('./tg');
          const sent = await sendTelegram(env, msg, doFetch, kitButtons(hash));
          stats.notifications.push({
            url_hash: hash, kind: 'job', status: sent.ok ? 'sent' : 'fail',
            tg_message_id: sent.message_id, error: sent.error,
          });
          if (sent.ok) {
            status = 'notified';
            notifiedAt = nowIso;
            stats.notified++;
            // CV factory only for verdict Apply: leaves cv_pending=1 and the
            // run's startup builds it (1 build/run, fixed budget). The kit is
            // NOT pre-built here — the job row flushes at run end, so the
            // Telegram "View kit" button builds it on demand instead.
            if (result.best.verdict === 'Apply') cvPending = 1;
          } else {
            stats.event({ type: 'telegram_fail', severity: 'error', url_hash: hash, detail: sent.error });
            // stays 'new': the next run retries
          }
        }
        // alive === null (indeterminate): stays 'new', NEVER notified without verifying
      }
    }

    batch.insertJob({
      url_hash: hash, url: job.url, company_id: company.id, ats: job.ats, ext_id: job.id,
      title: job.title, location: job.location, posted_at: job.posted_at,
      freshness_ok: freshness.freshness_ok, track: result.best.track,
      score: result.best.adjusted_score, verdict: result.best.verdict, status,
      first_seen: nowIso, last_seen: nowIso, notified_at: notifiedAt,
      cv_pending: cvPending,
      why_it_fits: texts.whyItFits, positioning_lead: texts.positioningLead,
      description_text: job.description, score_breakdown: JSON.stringify(result),
      title_norm: normalizeTitle(job.title), enriched_by: enrichedBy,
    });
  }

  // Auto-expire ONLY on a successful fetch (being here = success): absent from the feed -> closed
  const disappeared = [...existing.entries()]
    .filter(([hash, status]) => !seenHashes.has(hash) && (status === 'new' || status === 'notified'))
    .map(([hash]) => hash);
  if (disappeared.length) {
    batch.closeJobs(disappeared, nowIso);
    stats.closed += disappeared.length;
  }
}

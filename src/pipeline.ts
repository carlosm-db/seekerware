// Orquestacion del run (docs/TRD.md §7): aislamiento por empresa, dedup,
// freshness, verify-on-notify, notificacion, auto-expire, instrumentacion.

import type { Env, Job } from './types';
import * as greenhouse from './connectors/greenhouse';
import { urlHash } from './connectors/common';
import { loadScoringConfig } from './config-store';
import { normalizeTitle, scoreJob, type ScoringConfig } from './scoring';
import { checkFreshness } from './freshness';
import { formatJobMessage, formatMaintenance, ruleBasedTexts, sendTelegram } from './notify';
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
    const observability = JSON.parse((await getConfigValue(env, 'observability')) ?? '{}') as {
      maintenance_fail_streak?: number;
    };
    const failStreak = observability.maintenance_fail_streak ?? 3;

    const { companies, nextCursor } = await getCompaniesPage(env, stats);
    stats.companiesTotal = companies.length;

    for (const company of companies) {
      try {
        await processCompany(env, company, config, maxDays, nowIso, stats, batch, doFetch);
        stats.companiesOk++;
        batch.companySuccess(company.id, nowIso);
      } catch (err) {
        stats.companiesFail++;
        const detail = err instanceof Error ? err.message : 'error desconocido';
        stats.event({ type: 'fetch_fail', severity: 'error', company_id: company.id, detail });
        batch.companyFailure(company.id, nowIso, detail);
        // Alerta MANTENIMIENTO exactamente al cruzar el umbral (anti-spam: solo en la igualdad)
        if (company.fail_count + 1 === failStreak) {
          const msg = formatMaintenance(`Feed de ${company.name} fallo ${failStreak} runs seguidos: ${detail}`);
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
  } catch (err) {
    runStatus = 'fail';
    stats.event({
      type: 'run_crash',
      severity: 'error',
      detail: err instanceof Error ? err.message : 'error de run',
    });
  } finally {
    await batch.flush(runId, stats, runStatus, new Date().toISOString(), startedMs);
  }
  return stats;
}

async function processCompany(
  env: Env,
  company: StoredCompany,
  config: ScoringConfig,
  maxDays: number,
  nowIso: string,
  stats: RunStats,
  batch: RunBatch,
  doFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): Promise<void> {
  if (company.ats !== 'greenhouse') {
    throw new Error(`connector ${company.ats} pendiente (paso 5)`);
  }
  // Primer run de la empresa = seeding: se siembra el historico SIN notificar (regla 4).
  const seeding = company.last_ok_fetch === null;

  const jobs = await greenhouse.fetchJobs(company, doFetch);
  stats.jobsSeen += jobs.length;

  const existing = await getCompanyJobs(env, stats, company.id);
  const seenHashes = new Set<string>();

  for (const job of jobs) {
    const hash = await urlHash(job.url);
    seenHashes.add(hash);
    if (existing.has(hash)) {
      // Dedup: existente -> continuar. NO se escribe last_seen por presencia:
      // costaria ~129k filas/dia (>100k free tier). La presencia de un job
      // abierto la garantiza el auto-expire; last_seen se estampa al cerrar.
      continue;
    }
    stats.jobsNew++;
    const result = scoreJob(job, config);
    stats.jobsScored++;
    const isSurvivor = result.best.verdict !== 'Skip';
    const freshness = checkFreshness(job.posted_at, nowIso, maxDays);

    let status: 'new' | 'notified' | 'skipped' | 'closed' = isSurvivor ? 'new' : 'skipped';
    let notifiedAt: string | null = null;
    const texts = ruleBasedTexts(result);

    if (seeding) {
      status = 'skipped';
    } else if (isSurvivor) {
      stats.survivors++;
      if (freshness.fresh) {
        // verify-on-notify inmediatamente antes del push
        let alive: boolean | null = null;
        try {
          alive = await greenhouse.isLive(company, job, doFetch);
        } catch (err) {
          stats.event({
            type: 'verify_fail', severity: 'warn', company_id: company.id, url_hash: hash,
            detail: err instanceof Error ? err.message : 'verify indeterminado',
          });
        }
        if (alive === false) {
          status = 'closed';
          stats.event({ type: 'verify_dead', severity: 'info', company_id: company.id, url_hash: hash });
        } else if (alive === true) {
          const msg = formatJobMessage({
            job, verdict: result.best.verdict, track: result.best.track ?? '—',
            score: result.best.adjusted_score, ageDays: freshness.age_days,
            whyItFits: texts.whyItFits, gapToAddress: texts.gapToAddress,
            positioningLead: texts.positioningLead, ruleBased: true,
          });
          const sent = await sendTelegram(env, msg, doFetch);
          stats.notifications.push({
            url_hash: hash, kind: 'job', status: sent.ok ? 'sent' : 'fail',
            tg_message_id: sent.message_id, error: sent.error,
          });
          if (sent.ok) {
            status = 'notified';
            notifiedAt = nowIso;
            stats.notified++;
          } else {
            stats.event({ type: 'telegram_fail', severity: 'error', url_hash: hash, detail: sent.error });
            // queda 'new': el run siguiente reintenta
          }
        }
        // alive === null (indeterminado): queda 'new', NUNCA se notifica sin verificar
      }
    }

    batch.insertJob({
      url_hash: hash, url: job.url, company_id: company.id, ats: job.ats, ext_id: job.id,
      title: job.title, location: job.location, posted_at: job.posted_at,
      freshness_ok: freshness.freshness_ok, track: result.best.track,
      score: result.best.adjusted_score, verdict: result.best.verdict, status,
      first_seen: nowIso, last_seen: nowIso, notified_at: notifiedAt,
      why_it_fits: texts.whyItFits, positioning_lead: texts.positioningLead,
      description_text: job.description, score_breakdown: JSON.stringify(result),
      title_norm: normalizeTitle(job.title),
    });
  }

  // Auto-expire SOLO con fetch exitoso (estamos aqui = exito): ausentes del feed -> closed
  const disappeared = [...existing.entries()]
    .filter(([hash, status]) => !seenHashes.has(hash) && (status === 'new' || status === 'notified'))
    .map(([hash]) => hash);
  if (disappeared.length) {
    batch.closeJobs(disappeared, nowIso);
    stats.closed += disappeared.length;
  }
}

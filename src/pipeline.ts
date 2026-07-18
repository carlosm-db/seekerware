// Orquestacion del run (docs/TRD.md §7): aislamiento por empresa, dedup,
// freshness, verify-on-notify, notificacion, auto-expire, instrumentacion.

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
    // Tope de jobs NUEVOS puntuados por run: protege el limite de CPU del free
    // tier (error 1102 comprobado sembrando 1,336 de una vez). La siembra se
    // completa en tandas por runs sucesivos; el regimen permanente ni lo roza.
    const maxNewPerRun = Number((await getConfigValue(env, 'max_new_jobs_per_run')) ?? '100');
    const observability = JSON.parse((await getConfigValue(env, 'observability')) ?? '{}') as {
      maintenance_fail_streak?: number;
    };
    const failStreak = observability.maintenance_fail_streak ?? 3;

    // CV factory: fabrica UN pendiente por run (el mas antiguo notificado)
    if (env.GOOGLE_SA_KEY) {
      const pending = await env.DB.prepare(
        `SELECT j.url_hash, j.title, j.location, j.description_text, j.track, j.url, j.ext_id, j.ats, c.name company
         FROM jobs j JOIN companies c ON c.id = j.company_id
         WHERE j.cv_pending = 1 AND j.status = 'notified' ORDER BY j.notified_at LIMIT 1`,
      ).first<Record<string, string | null>>();
      if (pending) {
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

    const { companies, nextCursor } = await getCompaniesPage(env, stats);
    stats.companiesTotal = companies.length;

    for (const company of companies) {
      try {
        await processCompany(env, company, config, maxDays, maxNewPerRun, nowIso, stats, batch, doFetch);
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

    // Cuota: aviso si el pico de subrequests roza el limite por invocacion
    const obsCfg = JSON.parse((await getConfigValue(env, 'observability')) ?? '{}') as {
      subrequests_warn?: number;
      retention_days?: { runs?: number; events?: number; notifications?: number };
      digest?: { dow?: number; hour_utc?: number };
    };
    if (stats.subrequests > (obsCfg.subrequests_warn ?? 40)) {
      stats.event({ type: 'quota_warn', severity: 'warn', detail: `subrequests ${stats.subrequests} > ${obsCfg.subrequests_warn ?? 40}` });
    }

    // Retencion: el primer run de cada dia poda las tablas de observabilidad.
    // Cutoffs en ISO de JS (los timestamps almacenados son toISOString(); compararlos
    // contra datetime() de SQLite incluye de mas el dia frontera: 'T' > ' ').
    // Orden FK-seguro: primero los HIJOS (events/notifications, incluidos los que
    // referencian runs por podar), despues runs — si no, DELETE FROM runs viola la FK.
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

    // Digest semanal: primer run tras el dia/hora configurados (lunes ~06:00 Bogota)
    const digestCfg = obsCfg.digest ?? { dow: 1, hour_utc: 11 };
    const nowDate = new Date(nowIso);
    const weekKey = `${nowDate.getUTCFullYear()}-W${isoWeek(nowDate)}`;
    if (
      nowDate.getUTCDay() === (digestCfg.dow ?? 1) &&
      nowDate.getUTCHours() >= (digestCfg.hour_utc ?? 11) &&
      (await getConfigValue(env, 'digest_last_sent')) !== weekKey
    ) {
      // Claim-first (escritura INMEDIATA, no en el batch final): garantiza
      // at-most-once aunque un run manual y el cron se solapen o el run muera
      // despues del envio. Si el envio falla, se pierde el digest de esa
      // semana (tolerable, queda el evento) — jamas se duplica.
      await env.DB.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('digest_last_sent', ?)")
        .bind(weekKey).run();
      const digest = await buildDigest(env);
      const sent = await sendTelegram(env, formatDigest(digest), doFetch);
      stats.notifications.push({ kind: 'digest', status: sent.ok ? 'sent' : 'fail', tg_message_id: sent.message_id, error: sent.error });
      stats.event({ type: 'digest_sent', severity: sent.ok ? 'info' : 'warn', detail: `${weekKey}${sent.ok ? '' : ` FALLO: ${sent.error}`}` });
    }
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

function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

async function buildDigest(env: Env) {
  // Cutoff en ISO de JS: mismos numeros exactos que /semana (los timestamps
  // guardados son toISOString(); datetime() de SQLite no compara bien contra ellos).
  const cutoff = new Date(Date.now() - 7 * 86400000).toISOString();
  const wk = await env.DB.prepare(
    `SELECT
      (SELECT COUNT(*) FROM runs WHERE started_at >= ?1) runs_total,
      (SELECT COUNT(*) FROM runs WHERE started_at >= ?1 AND status='ok') runs_ok,
      (SELECT COALESCE(SUM(jobs_seen),0) FROM runs WHERE started_at >= ?1) vistos,
      (SELECT COUNT(*) FROM jobs WHERE first_seen >= ?1) nuevos,
      (SELECT COUNT(*) FROM jobs WHERE first_seen >= ?1 AND verdict != 'Skip') survivors,
      (SELECT COUNT(*) FROM jobs WHERE notified_at >= ?1) notificados,
      (SELECT COUNT(*) FROM applications WHERE applied_at >= ?1) aplicadas,
      (SELECT COALESCE(value,'5') FROM config WHERE key='weekly_goal') goal,
      (SELECT COUNT(*) FROM companies WHERE active=1 AND fail_count > 0) rotas`,
  ).bind(cutoff).first<Record<string, number | string>>();
  const top = await env.DB.prepare(
    `SELECT c.name FROM jobs j JOIN companies c ON c.id=j.company_id
     WHERE j.first_seen >= ? AND j.verdict != 'Skip'
     GROUP BY c.id ORDER BY COUNT(*) DESC LIMIT 1`,
  ).bind(cutoff).first<{ name: string }>();
  return {
    runsTotal: Number(wk?.runs_total ?? 0),
    runsOk: Number(wk?.runs_ok ?? 0),
    vistos: Number(wk?.vistos ?? 0),
    nuevos: Number(wk?.nuevos ?? 0),
    survivors: Number(wk?.survivors ?? 0),
    notificados: Number(wk?.notificados ?? 0),
    aplicadas: Number(wk?.aplicadas ?? 0),
    goal: Number(wk?.goal ?? 5),
    topCompany: top?.name ?? null,
    rotas: Number(wk?.rotas ?? 0),
  };
}

async function processCompany(
  env: Env,
  company: StoredCompany,
  config: ScoringConfig,
  maxDays: number,
  maxNewPerRun: number,
  nowIso: string,
  stats: RunStats,
  batch: RunBatch,
  doFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): Promise<void> {
  const connector = connectors[company.ats];
  // Primer run de la empresa = seeding: se siembra el historico SIN notificar (regla 4).
  const seeding = company.last_ok_fetch === null;

  const jobs = await connector.fetchJobs(company, doFetch);
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
    if (stats.jobsNew >= maxNewPerRun) {
      // Tope de CPU alcanzado: el resto queda para el proximo run (siguen
      // siendo "nuevos"; al no estar en el store, el auto-expire no los toca).
      continue;
    }
    stats.jobsNew++;
    const result = scoreJob(job, config);
    stats.jobsScored++;
    const isSurvivor = result.best.verdict !== 'Skip';
    const freshness = checkFreshness(job.posted_at, nowIso, maxDays);

    let status: 'new' | 'notified' | 'skipped' | 'closed' = isSurvivor ? 'new' : 'skipped';
    let notifiedAt: string | null = null;
    let cvPending: 0 | 1 = 0;
    const texts = ruleBasedTexts(result);

    if (seeding) {
      status = 'skipped';
    } else if (isSurvivor) {
      stats.survivors++;
      if (freshness.fresh) {
        // verify-on-notify inmediatamente antes del push
        let alive: boolean | null = null;
        try {
          alive = await connector.isLive(company, job, doFetch);
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
          // Enricher (solo survivors, TRD §4): mejora los textos; jamas el verdict
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
          const sent = await sendTelegram(env, msg, doFetch);
          stats.notifications.push({
            url_hash: hash, kind: 'job', status: sent.ok ? 'sent' : 'fail',
            tg_message_id: sent.message_id, error: sent.error,
          });
          if (sent.ok) {
            status = 'notified';
            notifiedAt = nowIso;
            stats.notified++;
            // CV factory solo para verdict Apply: queda cv_pending=1 y lo
            // fabrica el arranque del run (1 fabrica/run, presupuesto fijo).
            if (result.best.verdict === 'Apply') cvPending = 1;
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
      cv_pending: cvPending,
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

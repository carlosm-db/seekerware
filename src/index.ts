// Entrypoint del worker: scheduled() = pipeline (paso 3) · fetch() = dashboard + /api/* (siempre tras auth).

import type { Company, Env, Job } from './types';
import * as greenhouse from './connectors/greenhouse';
import { urlHash } from './connectors/common';
import { counts } from './store';
import { loadScoringConfig } from './config-store';
import { scoreJob, type ScoreResult, type ScoringConfig } from './scoring';
import { runPipeline } from './pipeline';
import { sendTelegram } from './notify';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Regla 7: nada publico. Todo exige el Worker secret API_TOKEN hasta que llegue Access (paso 4).
    if (!authorized(request, env)) {
      return json({ error: 'unauthorized' }, 401);
    }

    const url = new URL(request.url);
    try {
      if (url.pathname === '/api/health') return await health(env);
      if (url.pathname === '/api/dry-run') return await dryRun(url, env);
      if (url.pathname === '/api/run' && request.method === 'POST') {
        const stats = await runPipeline(env, 'manual');
        return json({
          ok: true,
          companies: { total: stats.companiesTotal, ok: stats.companiesOk, fail: stats.companiesFail },
          jobs: { seen: stats.jobsSeen, new: stats.jobsNew, survivors: stats.survivors, notified: stats.notified, closed: stats.closed },
          subrequests: stats.subrequests,
          errors: stats.errors,
        });
      }
      if (url.pathname === '/api/notify-test' && request.method === 'POST') {
        const sent = await sendTelegram(env, '✅ Seekerware operativo — prueba de canal');
        return json(sent, sent.ok ? 200 : 502);
      }
      return json({ error: 'not found' }, 404);
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : 'internal error' }, 502);
    }
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runPipeline(env, 'cron').then((stats) => {
        console.log(
          `run: ${stats.companiesOk}/${stats.companiesTotal} empresas OK · ${stats.jobsNew} nuevos · ` +
            `${stats.survivors} survivors · ${stats.notified} notificados · ${stats.closed} cerrados · ` +
            `${stats.subrequests} subrequests · ${stats.errors} errores`,
        );
      }),
    );
  },
} satisfies ExportedHandler<Env>;

function authorized(request: Request, env: Env): boolean {
  if (!env.API_TOKEN) return false; // sin secret configurado -> cerrado por defecto
  return request.headers.get('authorization') === `Bearer ${env.API_TOKEN}`;
}

async function health(env: Env): Promise<Response> {
  return json({ ok: true, tables: await counts(env) });
}

/**
 * Dry-run (glosario): corre el flujo sin escrituras al store ni notificaciones;
 * responde jobs normalizados y, si hay config de scoring sembrada, puntuados.
 */
async function dryRun(url: URL, env: Env): Promise<Response> {
  const token = url.searchParams.get('company');
  const ats = url.searchParams.get('ats') ?? 'greenhouse';
  if (!token) return json({ error: 'falta ?company=<token>' }, 400);
  if (ats !== 'greenhouse') return json({ error: `connector ${ats} pendiente (paso 5)` }, 400);

  // Empresa efimera: el dry-run no toca el store.
  const company: Company = { id: 0, name: token, ats: 'greenhouse', token, active: true };
  const jobs = await greenhouse.fetchJobs(company);

  let config: ScoringConfig | null = null;
  let scoringNote: string | undefined;
  try {
    config = await loadScoringConfig(env);
  } catch (err) {
    scoringNote = err instanceof Error ? err.message : 'config de scoring no disponible';
  }

  const rows = await Promise.all(jobs.map((j) => preview(j, config)));
  if (config) {
    rows.sort((a, b) => (b.scoring?.adjusted_score ?? 0) - (a.scoring?.adjusted_score ?? 0));
  }
  return json({ company: token, ats, count: jobs.length, scoring_note: scoringNote, jobs: rows });
}

interface PreviewRow {
  id: string;
  title: string;
  location: string;
  url: string;
  url_hash: string;
  posted_at: string | null;
  description_preview: string;
  scoring?: {
    score: number;
    track: string | null;
    verdict: string;
    adjusted_score: number;
    top_matches: string[];
    gate_fails: string[];
    near_miss?: string;
  };
}

async function preview(job: Job, config: ScoringConfig | null): Promise<PreviewRow> {
  const row: PreviewRow = {
    id: job.id,
    title: job.title,
    location: job.location,
    url: job.url,
    url_hash: await urlHash(job.url),
    posted_at: job.posted_at,
    description_preview:
      job.description.length > 280 ? `${job.description.slice(0, 280)}…` : job.description,
  };
  if (config) {
    const r: ScoreResult = scoreJob(job, config);
    const topMatches = Object.values(r.breakdown)
      .flatMap((b) => b.matches.filter((m) => m.weight > 0))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 6)
      .map((m) => m.term);
    const gateFails = r.best.track
      ? r.tracks[r.best.track]!.gates.filter((g) => !g.passed).map((g) => `${g.id}: ${g.evidence}`)
      : [];
    row.scoring = {
      score: r.score,
      track: r.best.track,
      verdict: r.best.verdict,
      adjusted_score: r.best.adjusted_score,
      top_matches: topMatches,
      gate_fails: gateFails,
      near_miss: r.near_miss_reason,
    };
  }
  return row;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

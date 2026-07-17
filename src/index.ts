// Entrypoint del worker: scheduled() = pipeline (paso 3) · fetch() = dashboard + /api/* (siempre tras auth).

import type { Company, Env, Job } from './types';
import * as greenhouse from './connectors/greenhouse';
import { urlHash } from './connectors/common';
import { counts } from './store';

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
      return json({ error: 'not found' }, 404);
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : 'internal error' }, 502);
    }
  },

  async scheduled(_controller: ScheduledController, _env: Env): Promise<void> {
    // Pipeline llega en el paso 3; el cron trigger aun no esta configurado.
    console.log('scheduled(): pipeline pendiente (paso 3)');
  },
} satisfies ExportedHandler<Env>;

function authorized(request: Request, env: Env): boolean {
  if (!env.API_TOKEN) return false; // sin secret configurado -> cerrado por defecto
  return request.headers.get('authorization') === `Bearer ${env.API_TOKEN}`;
}

async function health(env: Env): Promise<Response> {
  return json({ ok: true, tables: await counts(env) });
}

/** Dry-run (glosario): corre el flujo sin escrituras al store ni notificaciones; responde jobs normalizados. */
async function dryRun(url: URL, env: Env): Promise<Response> {
  const token = url.searchParams.get('company');
  const ats = url.searchParams.get('ats') ?? 'greenhouse';
  if (!token) return json({ error: 'falta ?company=<token>' }, 400);
  if (ats !== 'greenhouse') return json({ error: `connector ${ats} pendiente (paso 5)` }, 400);

  // Empresa efimera: el dry-run no toca el store.
  const company: Company = { id: 0, name: token, ats: 'greenhouse', token, active: true };
  const jobs = await greenhouse.fetchJobs(company);
  return json({
    company: token,
    ats,
    count: jobs.length,
    jobs: await Promise.all(jobs.map(preview)),
  });
}

async function preview(job: Job) {
  return {
    id: job.id,
    title: job.title,
    location: job.location,
    url: job.url,
    url_hash: await urlHash(job.url),
    posted_at: job.posted_at,
    description_preview:
      job.description.length > 280 ? `${job.description.slice(0, 280)}…` : job.description,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

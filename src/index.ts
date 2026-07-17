// Entrypoint del worker: scheduled() = pipeline · fetch() = consola + /api/* (todo tras auth).

import type { Company, Job } from './types';
import * as greenhouse from './connectors/greenhouse';
import { urlHash } from './connectors/common';
import { counts } from './store';
import { loadScoringConfig } from './config-store';
import { scoreJob, type ScoreResult, type ScoringConfig } from './scoring';
import { runPipeline } from './pipeline';
import { sendTelegram } from './notify';
import { consoleApp } from './console/app';
import type { ConsoleEnv } from './console/auth';

const app = consoleApp();

// ---------- API JSON (auth: cookie o Bearer, via middleware de la consola) ----------

app.get('/api/health', async (c) => c.json({ ok: true, tables: await counts(c.env) }));

app.post('/api/run', async (c) => {
  const stats = await runPipeline(c.env, 'manual');
  return c.json({
    ok: true,
    companies: { total: stats.companiesTotal, ok: stats.companiesOk, fail: stats.companiesFail },
    jobs: { seen: stats.jobsSeen, new: stats.jobsNew, survivors: stats.survivors, notified: stats.notified, closed: stats.closed },
    subrequests: stats.subrequests,
    errors: stats.errors,
  });
});

app.post('/api/notify-test', async (c) => {
  const sent = await sendTelegram(c.env, '✅ Seekerware operativo — prueba de canal');
  return c.json(sent, sent.ok ? 200 : 502);
});

app.get('/api/dry-run', async (c) => {
  const token = c.req.query('company');
  const ats = c.req.query('ats') ?? 'greenhouse';
  if (!token) return c.json({ error: 'falta ?company=<token>' }, 400);
  if (ats !== 'greenhouse') return c.json({ error: `connector ${ats} pendiente (paso 5)` }, 400);

  const company: Company = { id: 0, name: token, ats: 'greenhouse', token, active: true };
  const jobs = await greenhouse.fetchJobs(company);

  let config: ScoringConfig | null = null;
  let scoringNote: string | undefined;
  try {
    config = await loadScoringConfig(c.env);
  } catch (err) {
    scoringNote = err instanceof Error ? err.message : 'config de scoring no disponible';
  }
  const rows = await Promise.all(jobs.map((j) => preview(j, config)));
  if (config) rows.sort((a, b) => (b.scoring?.adjusted_score ?? 0) - (a.scoring?.adjusted_score ?? 0));
  return c.json({ company: token, ats, count: jobs.length, scoring_note: scoringNote, jobs: rows });
});

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
    row.scoring = {
      score: r.score,
      track: r.best.track,
      verdict: r.best.verdict,
      adjusted_score: r.best.adjusted_score,
      top_matches: Object.values(r.breakdown)
        .flatMap((b) => b.matches.filter((m) => m.weight > 0))
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 6)
        .map((m) => m.term),
      gate_fails: r.best.track
        ? r.tracks[r.best.track]!.gates.filter((g) => !g.passed).map((g) => `${g.id}: ${g.evidence}`)
        : [],
      near_miss: r.near_miss_reason,
    };
  }
  return row;
}

export default {
  fetch: app.fetch,

  async scheduled(_controller: ScheduledController, env: ConsoleEnv, ctx: ExecutionContext): Promise<void> {
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
} satisfies ExportedHandler<ConsoleEnv>;

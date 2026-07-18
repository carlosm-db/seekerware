// Worker entrypoint: scheduled() = pipeline · fetch() = console + /api/* (all behind auth).

import type { Ats, Company, Job } from './types';
import { connectors } from './connectors/index';
import { urlHash } from './connectors/common';
import { counts } from './store';
import { loadScoringConfig } from './config-store';
import { scoreJob, type ScoreResult, type ScoringConfig } from './scoring';
import { runPipeline } from './pipeline';
import { sendTelegram } from './notify';
import { consoleApp } from './console/app';
import type { ConsoleEnv } from './console/auth';

const app = consoleApp();

// ---------- JSON API (auth: cookie or Bearer, via the console middleware) ----------

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
  const sent = await sendTelegram(c.env, '✅ Seekerware operational — channel test');
  return c.json(sent, sent.ok ? 200 : 502);
});

/** Replay (glossary): simulated re-score in batches of 50; NEVER writes to jobs. */
app.get('/api/replay-batch', async (c) => {
  const cursor = Math.max(0, Math.floor(Number(c.req.query('cursor')) || 0));
  const target = Math.min(1000, Math.max(50, Math.floor(Number(c.req.query('n')) || 200)));
  const BATCH = 50;
  // LIMIT never negative (in SQLite, negative LIMIT = NO limit -> would blow up CPU/reads)
  const limit = Math.max(0, Math.min(BATCH, target - cursor));
  if (limit === 0) {
    return c.json({ diffs: [], next_cursor: cursor, processed_total: cursor, total_target: target, done: true });
  }
  const draftRow = await c.env.DB.prepare("SELECT value FROM config WHERE key='scoring_draft'")
    .first<{ value: string }>();
  if (!draftRow) return c.json({ error: 'no scoring draft' }, 400);
  const draft = JSON.parse(draftRow.value) as ScoringConfig;

  const rows = (
    await c.env.DB.prepare(
      `SELECT j.url_hash, j.title, j.location, j.description_text, j.score, j.verdict, co.name company
       FROM jobs j JOIN companies co ON co.id = j.company_id
       WHERE j.description_text IS NOT NULL
       ORDER BY j.first_seen DESC, j.url_hash LIMIT ? OFFSET ?`,
    ).bind(limit, cursor).all<Record<string, string | number | null>>()
  ).results;

  const diffs = [];
  for (const r of rows) {
    const job: Job = {
      id: '', company: String(r.company), title: String(r.title), location: String(r.location ?? ''),
      url: '', description: String(r.description_text ?? ''), posted_at: null,
      ats: 'greenhouse', raw: null,
    };
    const res = scoreJob(job, draft);
    const oldVerdict = String(r.verdict);
    const oldScore = Number(r.score);
    if (res.best.verdict !== oldVerdict || Math.abs(res.best.adjusted_score - oldScore) >= 8) {
      diffs.push({
        url_hash: r.url_hash,
        title: String(r.title).slice(0, 60),
        company: r.company,
        old_score: oldScore,
        new_score: res.best.adjusted_score,
        old_verdict: oldVerdict,
        new_verdict: res.best.verdict,
      });
    }
  }
  const processed = cursor + rows.length;
  return c.json({
    diffs,
    next_cursor: processed,
    processed_total: processed,
    total_target: target,
    done: rows.length === 0 || processed >= target,
  });
});

app.get('/api/dry-run', async (c) => {
  const token = c.req.query('company');
  const ats = (c.req.query('ats') ?? 'greenhouse') as Ats;
  if (!token) return c.json({ error: 'missing ?company=<token>' }, 400);
  if (!connectors[ats]) return c.json({ error: `unknown ats: ${ats}` }, 400);

  const company: Company = { id: 0, name: token, ats, token, active: true };
  const jobs = await connectors[ats].fetchJobs(company);

  let config: ScoringConfig | null = null;
  let scoringNote: string | undefined;
  try {
    config = await loadScoringConfig(c.env);
  } catch (err) {
    scoringNote = err instanceof Error ? err.message : 'scoring config unavailable';
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
          `run: ${stats.companiesOk}/${stats.companiesTotal} companies OK · ${stats.jobsNew} new · ` +
            `${stats.survivors} survivors · ${stats.notified} notified · ${stats.closed} closed · ` +
            `${stats.subrequests} subrequests · ${stats.errors} errors`,
        );
      }),
    );
  },
} satisfies ExportedHandler<ConsoleEnv>;

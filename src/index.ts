// Worker entrypoint: scheduled() = pipeline · fetch() = console + /api/* (all behind auth).

import type { Ats, Company, Job } from './types';
import { connectors } from './connectors/index';
import { urlHash } from './connectors/common';
import { counts } from './store';
import { loadScoringConfig } from './config-store';
import { scoreJob, type ScoreResult, type ScoringConfig } from './scoring';
import { buildPendingCvs, runPipeline } from './pipeline';
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

// Replay/Preview and Re-score removed 2026-07-19: calibration edits apply live
// immediately; new jobs use the active config, stored jobs keep their score.

// Telegram webhook (step 8): authenticated by the secret path token — the
// auth middleware lets /tg/* through and THIS check is the gate.
app.post('/tg/:token', async (c) => {
  if (!c.env.TELEGRAM_WEBHOOK_TOKEN || c.req.param('token') !== c.env.TELEGRAM_WEBHOOK_TOKEN) {
    return c.notFound();
  }
  const { handleTelegramUpdate } = await import('./tg');
  try {
    const update = await c.req.json();
    // Prepare (kit+CV) runs in the background so the webhook responds fast.
    await handleTelegramUpdate(c.env, update, fetch, (p) =>
      c.executionCtx.waitUntil(p.catch((e) => console.log(`tg bg: ${e instanceof Error ? e.message : 'err'}`))));
  } catch (err) {
    console.log(`tg webhook error: ${err instanceof Error ? err.message : 'unknown'}`);
  }
  return c.json({ ok: true }); // always 200 — Telegram retries otherwise
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
    // The cron is a dumb 15-min 24/7 tick; the owner-editable D1 config `schedule`
    // (console /health panel) decides which ticks run a batch. batchesNeeded = one
    // full company rotation, so each burst covers every active company once.
    const { normalizeSchedule, shouldRunAt } = await import('./schedule');
    let raw: unknown = null;
    try {
      const row = await env.DB.prepare("SELECT value FROM config WHERE key='schedule'").first<{ value: string }>();
      if (row) raw = JSON.parse(row.value);
    } catch { /* fall back to defaults */ }
    const sched = normalizeSchedule(raw);

    const [countRow, pageRow, forceRow] = await Promise.all([
      env.DB.prepare('SELECT COUNT(*) n FROM companies WHERE active = 1').first<{ n: number }>(),
      env.DB.prepare("SELECT value FROM config WHERE key='poll_page_size'").first<{ value: string }>(),
      env.DB.prepare("SELECT value FROM config WHERE key='force_burst'").first<{ value: string }>(),
    ]);
    const pageSize = Math.max(1, Number(pageRow?.value ?? '25') || 25);
    const batchesNeeded = Math.max(1, Math.ceil((countRow?.n ?? 0) / pageSize));
    // On-demand burst requested from /health: a counter of batches still to run. Adds review
    // ticks OUTSIDE the scheduled windows until it hits 0 (bounded); auto-bursts are unaffected.
    const forceBurst = Math.max(0, Number(forceRow?.value ?? '0') || 0);

    // Every tick: drain the CV queue (reads jobs WHERE cv_pending=1; no-op if none). Decoupled
    // from the company review — never polls a company — so queued CVs (e.g. from Telegram
    // Prepare) build within ~15 min without waking a burst.
    ctx.waitUntil(buildPendingCvs(env).catch((e) => console.log(`cv queue: ${e instanceof Error ? e.message : 'err'}`)));

    // Company review: scheduled burst windows, OR an on-demand burst requested from /health.
    if (!shouldRunAt(new Date(), sched, batchesNeeded) && forceBurst === 0) {
      console.log(`cron tick: company review skipped (outside bursts [${sched.burst_hours.join(',')}] ${sched.timezone}); CV queue checked`);
      return;
    }
    // Consume one forced batch (bounded: decrements to 0 → stops on its own).
    if (forceBurst > 0) {
      await env.DB.prepare("INSERT INTO config (key, value) VALUES ('force_burst', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(String(forceBurst - 1)).run();
    }
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

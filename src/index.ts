// Worker entrypoint: scheduled() = pipeline · fetch() = console + /api/* (all behind auth).

import type { Ats, Company, Job } from './types';
import { connectors } from './connectors/index';
import { urlHash } from './connectors/common';
import { counts } from './store';
import { loadScoringConfig } from './config-store';
import { scoreJob, type ScoreResult, type ScoringConfig } from './scoring';
import { buildPendingCvs } from './pipeline';
import { sendTelegram } from './notify';
import { consoleApp } from './console/app';
import type { ConsoleEnv } from './console/auth';

const app = consoleApp();

// ---------- JSON API (auth: cookie or Bearer, via the console middleware) ----------

app.get('/api/health', async (c) => c.json({ ok: true, tables: await counts(c.env) }));

// Notifications are delivered here so the Telegram token stays in Cloudflare: the Actions poller
// (scripts/poll.ts) POSTs each survivor/alert and this endpoint attaches the kit buttons + sends.
app.post('/api/notify', async (c) => {
  const { text, hash, kind } = await c.req.json<{ text?: string; hash?: string; kind?: string }>();
  if (!text) return c.json({ ok: false, error: 'missing text' }, 400);
  let replyMarkup: unknown;
  if (hash && kind === 'job') {
    const { kitButtons } = await import('./tg');
    replyMarkup = kitButtons(hash);
  }
  const sent = await sendTelegram(c.env, text, fetch, replyMarkup);
  return c.json(sent, sent.ok ? 200 : 502);
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
    // ATS polling runs in GitHub Actions (scripts/poll.ts) — no 10 ms CPU limit, whole roster each
    // run. The Worker cron only drains the CV queue (reads jobs WHERE cv_pending=1; no-op if none),
    // so a Telegram/console Prepare builds its CV within ~5 min without a separate trigger.
    ctx.waitUntil(buildPendingCvs(env).catch((e) => console.log(`cv queue: ${e instanceof Error ? e.message : 'err'}`)));
  },
} satisfies ExportedHandler<ConsoleEnv>;

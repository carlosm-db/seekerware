// Console v1 (UI.md §2): Overview (triage), Jobs, Companies, Calibration, Health.
// Pure server-rendered: every mutation is a real <form>. htmx arrives in v2.

import { Hono, type Context } from 'hono';
import type { Child } from 'hono/jsx';
import { Layout, type FooterStatus } from './layout';
import { authMiddleware, createSession, setSessionCookie, verifyPassword, type ConsoleEnv } from './auth';
import { normalizeScoringConfig, validateScoringConfig } from '../config-store';
import { SKCATS, newBlockId, parseBulletEdits } from './blocks-form';
import { fmtDates, normalizeMonth, tokensOfRole, validateRoleCode } from './roles';
import {
  applyPairRemove, applyWordAdd, applyWordEdit, buildMatrix, MATRIX_CATEGORIES,
  type ConceptRow, type EditTarget, type MatrixCategory, type MatrixGroup, type RemoveTarget,
} from './matrix';
import { connectors } from '../connectors';
import { parseAtsUrl } from '../connectors/common';
import type { Ats, Company, Verdict } from '../types';
import { CATEGORIES, type Category, type ScoreResult } from '../scoring';

// Client island for the Prepare modal (INFORMATIONAL only): intercepts the Prepare form,
// POSTs with x-progress:1 (server runs prepareJob BLOCKING in-request and writes each step
// to the config KV), polls prepare-progress, renders the full step list live, redirects on
// done. No-JS falls back to the plain blocking form POST. It changes nothing about Prepare.
const prepJs = `
(function () {
  var form = document.querySelector('form[data-prepare]');
  if (!form) return;
  var modal = document.getElementById('prep-modal');
  var stepsEl = document.getElementById('prep-steps');
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var hash = form.querySelector('input[name=hash]').value;
    modal.hidden = false;
    var tries = 0;
    function render(plan, current, qdetail, done) {
      stepsEl.innerHTML = (plan || []).map(function (label, i) {
        var st = (done || i < current) ? 'done' : (i === current ? 'active' : 'pending');
        var mark = st === 'done' ? '\\u2713' : (st === 'active' ? '<span class="spin"></span>' : '\\u25CB');
        var det = (i === 0 && qdetail) ? '<div class="qd">' + qdetail + '</div>' : '';
        return '<li class="' + st + '"><span class="mk">' + mark + '</span><div class="tx">' + label + det + '</div></li>';
      }).join('');
    }
    fetch('/jobs/' + hash + '/prepare', { method: 'POST', headers: { 'x-progress': '1' } }).catch(function () {});
    function poll() {
      if (++tries > 120) { stepsEl.innerHTML += '<li class="muted">Still working — refresh in a moment.</li>'; return; }
      fetch('/jobs/' + hash + '/prepare-progress', { headers: { accept: 'application/json' } })
        .then(function (r) { return r.json(); })
        .then(function (p) {
          render(p.plan, p.current, p.qdetail, !!p.done);
          if (p.done) {
            if (p.error) {
              stepsEl.innerHTML += '<li class="warn">\\u2717 ' + p.error + '</li>';
              setTimeout(function () { location.href = '/jobs/' + hash + '?m=' + encodeURIComponent('prepare failed: ' + p.error); }, 2500);
            } else {
              location.href = '/jobs/' + hash + '?m=' + encodeURIComponent(p.msg || 'prepared');
            }
            return;
          }
          setTimeout(poll, 1000);
        })
        .catch(function () { setTimeout(poll, 1500); });
    }
    setTimeout(poll, 500);
  });
})();
`;

type App = Hono<{ Bindings: ConsoleEnv }>;

export function consoleApp(): App {
  const app: App = new Hono();
  app.use('*', authMiddleware());

  // ---------- helpers ----------
  const now = () => new Date().toISOString();
  // Show UTC (as stored) with Bogotá/COT in parentheses — the owner operates in COT (UTC−5).
  const fmt = (iso: string | null | undefined) => {
    if (!iso) return '—';
    const utc = iso.slice(5, 16).replace('T', ' '); // MM-DD HH:MM (UTC, as stored)
    let cot = '';
    try {
      cot = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      }).format(new Date(iso));
    } catch { /* invalid date → UTC only */ }
    return cot ? `${utc} UTC (${cot} COT)` : `${utc} UTC`;
  };

  // Pagination: 30/page. Query with `LIMIT PAGE+1 OFFSET pg*PAGE`, then if
  // more than PAGE rows came back there's a next page (drop the extra row).
  const PAGE = 30;
  const pageNum = (c: Context<{ Bindings: ConsoleEnv }>) => Math.max(0, Math.floor(Number(c.req.query('page')) || 0));
  function pager(base: string, pg: number, hasNext: boolean, total: number, params: Record<string, string | undefined>) {
    const qs = (p: number) => {
      const u = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) if (v) u.set(k, v);
      if (p > 0) u.set('page', String(p));
      const s = u.toString();
      return s ? `${base}?${s}` : base;
    };
    if (total === 0) return null;
    const pages = Math.max(1, Math.ceil(total / PAGE));
    return (
      <div class="pager">
        {pg > 0 ? <a href={qs(pg - 1)}>← Prev</a> : <span class="muted">← Prev</span>}
        <span class="muted">{total} items · page {pg + 1} of {pages}</span>
        {hasNext ? <a href={qs(pg + 1)}>Next →</a> : <span class="muted">Next →</span>}
      </div>
    );
  }

  // ---------- Blocks Bank shared bits (docs/UI.md §2; v4 2026-07-18: LinkedIn-style
  // collapsible cards, edit-in-place, saving IS the approval) ----------
  type AnchorOpt = {
    id: string; company: string | null; kind: string;
    title: string | null; date_from: string | null; date_to: string | null;
  };
  // Newest role first: current (date_to NULL), then by end date, then start date.
  const ANCHOR_ORDER = 'kind, (date_to IS NULL) DESC, date_to DESC, date_from DESC, id';
  const fetchAnchors = async (env: ConsoleEnv): Promise<AnchorOpt[]> =>
    (await env.DB.prepare(
      `SELECT id, company, kind, title, date_from, date_to FROM anchors WHERE status = 'active' ORDER BY ${ANCHOR_ORDER}`,
    ).all<AnchorOpt>()).results;

  async function footer(env: ConsoleEnv): Promise<FooterStatus> {
    const r = await env.DB.prepare(
      'SELECT started_at, status FROM runs ORDER BY id DESC LIMIT 1',
    ).first<{ started_at: string | null; status: string | null }>();
    return { lastRun: r?.started_at ? fmt(r.started_at) : null, status: r?.status ?? null };
  }

  async function pendingTriage(env: ConsoleEnv): Promise<number> {
    const r = await env.DB.prepare(
      `SELECT COUNT(*) n FROM jobs j
       LEFT JOIN applications a ON a.url_hash = j.url_hash
       WHERE j.status IN ('new','notified') AND j.verdict != 'Skip'
         AND a.url_hash IS NULL`,
    ).first<{ n: number }>();
    return r?.n ?? 0;
  }

  async function page(c: Context<{ Bindings: ConsoleEnv }>, title: string, body: Child) {
    const [f, p] = await Promise.all([footer(c.env), pendingTriage(c.env)]);
    const flash = c.req.query('m');
    return c.html(
      <Layout title={title} path={new URL(c.req.url).pathname} pendingTriage={p} footer={f} flash={flash}>
        {body}
      </Layout>,
    );
  }

  async function jobEvent(env: ConsoleEnv, urlHash: string, event: string, detail = ''): Promise<void> {
    await env.DB.prepare(
      "INSERT INTO job_events (url_hash, ts, actor, event, detail) VALUES (?, ?, 'user', ?, ?)",
    ).bind(urlHash, now(), event, detail).run();
  }

  // ---------- login ----------
  app.get('/login', (c) =>
    c.html(
      <html>
        <head><title>Seekerware · login</title>
          <style dangerouslySetInnerHTML={{ __html: 'body{font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0;background:#101014;color:#ececf1} form{display:grid;gap:10px;min-width:280px} input,button{padding:10px;border-radius:8px;border:1px solid #333;background:#1a1a21;color:#ececf1}' }} />
        </head>
        <body>
          <form method="post" action="/login">
            <strong>Seekerware</strong>
            <input type="password" name="password" placeholder="password" autofocus />
            <button type="submit">Sign in</button>
          </form>
        </body>
      </html>,
    ),
  );

  app.post('/login', async (c) => {
    const body = await c.req.parseBody();
    const ok = await verifyPassword(c.env, String(body.password ?? ''));
    if (!ok) {
      await new Promise((r) => setTimeout(r, 500)); // brute-force throttle
      return c.redirect('/login');
    }
    setSessionCookie(c, await createSession(c.env));
    return c.redirect('/');
  });

  // ---------- Overview (indicators) ----------
  app.get('/', (c) => c.redirect('/overview'));
  app.get('/overview', async (c) => {
    const strip = await c.env.DB.prepare(
      `SELECT
        (SELECT COUNT(*) FROM applications WHERE stage='applied' AND applied_at >= datetime('now','-7 days')) applied_week,
        (SELECT status FROM runs ORDER BY id DESC LIMIT 1) run_status`,
    ).first<{ applied_week: number; run_status: string | null }>();

    const pendingTotal = await pendingTriage(c.env);
    // This week's funnel (folded in from the old Week page).
    const fromIso = new Date(Date.now() - 7 * 86400000).toISOString();
    const funnel = await c.env.DB.prepare(
      `SELECT
        (SELECT COUNT(*) FROM jobs WHERE first_seen >= ?1) seen,
        (SELECT COUNT(*) FROM jobs WHERE first_seen >= ?1 AND verdict != 'Skip') survivors,
        (SELECT COUNT(*) FROM jobs WHERE notified_at >= ?1) notified,
        (SELECT COUNT(*) FROM applications WHERE applied_at >= ?1) applied`,
    ).bind(fromIso).first<Record<string, number>>();

    const health = strip?.run_status === 'ok' ? <span class="ok">green</span>
      : strip?.run_status ? <span class="warn">{strip.run_status}</span> : <span class="muted">no runs</span>;

    // Control-panel counts (one cheap aggregate query)
    const panel = await c.env.DB.prepare(
      `SELECT
        (SELECT COUNT(*) FROM applications WHERE stage NOT IN ('dismissed','rejected')) tracker_active,
        (SELECT COUNT(*) FROM companies WHERE active=1) companies_active,
        (SELECT COUNT(*) FROM companies) companies_total,
        (SELECT COUNT(*) FROM jobs) jobs_total,
        (SELECT COUNT(*) FROM blocks WHERE status='approved') blocks_approved,
        (SELECT COUNT(*) FROM blocks) blocks_total,
        (SELECT COUNT(*) FROM config WHERE key='contact_profile') contact_set`,
    ).first<Record<string, number>>();
    const cards: Array<[string, string, string, string]> = [
      ['Operate', '/jobs?view=survivors', `${pendingTotal}`, 'new survivors to triage'],
      ['Operate', '/tracker', `${panel?.tracker_active ?? 0}`, 'active applications'],
      ['Operate', '/jobs', `${panel?.jobs_total ?? 0}`, 'jobs seen (all)'],
      ['Profile & setup', '/companies', `${panel?.companies_active ?? 0}/${panel?.companies_total ?? 0}`, 'companies active'],
      ['Profile & setup', '/blocks_bank', `${panel?.blocks_approved ?? 0}/${panel?.blocks_total ?? 0}`, 'blocks approved'],
      ['Profile & setup', '/contact', panel?.contact_set ? 'set ✓' : 'not set', 'contact profile'],
      ['System', '/health', strip?.run_status ?? '—', 'last run'],
    ];

    return page(c, 'Overview', (
      <>
        <div class="statgrid">
          <div class="stat"><div class="n">{pendingTotal}</div><div class="l">pending triage</div></div>
          <div class="stat"><div class="n">{strip?.applied_week ?? 0}</div><div class="l">applied this week</div></div>
          <div class="stat"><div class="n">{health}</div><div class="l">system health</div></div>
          <div class="stat"><div class="n">{funnel?.survivors ?? 0}</div><div class="l">survivors this week</div></div>
        </div>
        <div class="card">
          <h2>This week's funnel</h2>
          <p>seen <strong>{funnel?.seen ?? 0}</strong> → new-survivors <strong>{funnel?.survivors ?? 0}</strong> → notified <strong>{funnel?.notified ?? 0}</strong> → applied <strong>{funnel?.applied ?? 0}</strong></p>
          <p class="muted">The Monday digest to Telegram summarizes these same numbers.</p>
        </div>
        <div class="cardgrid">
          {cards.map(([group, href, n, label]) => (
            <a class="panelcard" href={href}>
              <div class="pg">{group}</div>
              <div class="pn">{n}</div>
              <div class="pl">{label} →</div>
            </a>
          ))}
        </div>
      </>
    ));
  });

  app.post('/triage', async (c) => {
    const b = await c.req.parseBody();
    const hash = String(b.hash ?? '');
    const action = String(b.stage ?? '');
    const ts = now();
    if (!hash || !action) return c.redirect('/?m=invalid action');
    // 'prepared' has its own route (/jobs/:hash/prepare) — it builds kit + CV (blocking)
    // and reports progress. /triage only moves the stage for applied/dismissed/etc.
    const appliedAt = action === 'applied' ? ts : null;
    await c.env.DB.prepare(
      `INSERT INTO applications (url_hash, stage, applied_at, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(url_hash) DO UPDATE SET stage = ?, applied_at = COALESCE(?, applied_at), updated_at = ?`,
    ).bind(hash, action, appliedAt, ts, action, appliedAt, ts).run();
    await jobEvent(c.env, hash, `stage:${action}`);
    return c.redirect(`/jobs/${hash}?m=${encodeURIComponent(action)}`);
  });

  // Prepare = build the kit (Q&A) AND the CV, ON THE SPOT and BLOCKING (owner's settled
  // decision — never waitUntil; the request stays alive until the PDF finishes). The work
  // runs IN the request; when called with x-progress it also streams step-by-step state to
  // the config KV (read by /prepare-progress) so the console modal can inform live.
  app.post('/jobs/:hash/prepare', async (c) => {
    const hash = c.req.param('hash');
    const { prepareJob } = await import('../kit/kit');
    const doneMsg = (r: Awaited<ReturnType<typeof prepareJob>>) => (r.ok
      ? `prepared: kit ready${r.cv?.ok ? ' + CV built' : r.cv?.error ? ` · CV retry queued (${r.cv.error})` : ''}`
      : `prepare failed: ${r.error ?? 'unknown'}`);

    if (c.req.header('x-progress') === '1') {
      const key = `prepare_progress:${hash}`;
      // FIXED step list, shown up-front. onProgress advances `current` by label match; the
      // question-review counts attach as `qdetail` on step 0. No step appears/disappears —
      // each just goes pending → in-progress → done.
      const PLAN = [
        'Review form questions',
        'Read template + Blocks Bank',
        'Select blocks (AI)',
        'Verify the CV (AI)',
        'Create Doc + fill',
        'Export PDF + archive',
      ];
      let current = 0;
      let qdetail: string | null = null;
      const write = (extra: Record<string, unknown>) => c.env.DB.prepare(
        'INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ).bind(key, JSON.stringify({ plan: PLAN, current, qdetail, ...extra })).run();
      await write({ done: false });
      try {
        const r = await prepareJob(c.env, hash, fetch, async (step, detail) => {
          const i = PLAN.indexOf(step);
          if (i >= 0) current = i;
          if (detail != null) qdetail = detail;
          await write({ done: false });
        });
        current = PLAN.length; // all done
        await write({ done: true, msg: doneMsg(r), doc_url: r.cv?.doc_url ?? null });
        return c.json({ ok: true });
      } catch (e) {
        await write({ done: true, error: e instanceof Error ? e.message : 'prepare failed' });
        return c.json({ ok: false });
      }
    }

    // No-JS fallback: run synchronously and redirect (exactly the prior behavior).
    const r = await prepareJob(c.env, hash);
    return c.redirect(`/jobs/${hash}?m=${encodeURIComponent(doneMsg(r))}`);
  });

  // Progress poll for the Prepare modal (JS path).
  app.get('/jobs/:hash/prepare-progress', async (c) => {
    const row = await c.env.DB.prepare('SELECT value FROM config WHERE key = ?')
      .bind(`prepare_progress:${c.req.param('hash')}`).first<{ value: string }>();
    return c.json(row ? JSON.parse(row.value) : { plan: [], current: 0, qdetail: null, done: false });
  });

  // Send (or resend) the job to Telegram on demand — the SAME notify action, rebuilt from
  // stored fields (no AI re-run): the pipeline's formatJobMessage + kitButtons + sendTelegram.
  app.post('/jobs/:hash/telegram', async (c) => {
    const hash = c.req.param('hash');
    const j = await c.env.DB.prepare(
      'SELECT j.*, c.name company FROM jobs j JOIN companies c ON c.id = j.company_id WHERE j.url_hash = ?',
    ).bind(hash).first<Record<string, string | number | null>>();
    if (!j) return c.notFound();
    const { formatJobMessage, ruleBasedTexts, sendTelegram } = await import('../notify');
    const { kitButtons } = await import('../tg');
    let gap = '—';
    try { gap = ruleBasedTexts(JSON.parse(String(j.score_breakdown ?? '{}')) as ScoreResult).gapToAddress; } catch { /* keep '—' */ }
    const posted = j.posted_at ?? j.first_seen;
    const ageDays = posted ? Math.max(0, (Date.now() - Date.parse(String(posted))) / 86400000) : 0;
    const msg = formatJobMessage({
      job: {
        id: String(j.ext_id ?? ''), company: String(j.company), title: String(j.title),
        location: String(j.location ?? ''), url: String(j.url), description: '',
        posted_at: null, ats: (j.ats ?? 'greenhouse') as Ats, raw: null,
      },
      verdict: (j.verdict ?? 'Skip') as Verdict, track: String(j.track ?? '—'),
      score: Number(j.score ?? 0), ageDays,
      whyItFits: String(j.why_it_fits ?? 'general profile match'),
      gapToAddress: gap, positioningLead: String(j.positioning_lead ?? ''), ruleBased: false,
    });
    const sent = await sendTelegram(c.env, msg, fetch, kitButtons(hash));
    return c.redirect(`/jobs/${hash}?m=${encodeURIComponent(sent.ok ? 'sent to Telegram' : `Telegram failed: ${sent.error ?? 'error'}`)}`);
  });

  // ---------- Jobs ----------
  app.get('/jobs', async (c) => {
    const q = c.req.query();
    const view = q.view ?? 'survivors';
    const where: string[] = ['1=1'];
    const binds: unknown[] = [];
    if (view === 'survivors') {
      where.push("j.status IN ('new','notified') AND j.verdict != 'Skip'");
      where.push('a.url_hash IS NULL');
    } else if (view === 'skipped') {
      where.push("(j.verdict = 'Skip' OR j.status = 'skipped')");
    } else if (view === 'closed') {
      where.push("j.status = 'closed'");
    }
    if (q.track) { where.push('j.track = ?'); binds.push(q.track); }
    if (q.verdict) { where.push('j.verdict = ?'); binds.push(q.verdict); }
    if (q.status) { where.push('j.status = ?'); binds.push(q.status); }
    if (q.q) { where.push('j.title LIKE ?'); binds.push(`%${q.q}%`); }
    const pg = pageNum(c);
    const rows = (
      await c.env.DB.prepare(
        `SELECT j.url_hash, j.title, j.location, j.track, j.verdict, j.score, j.status, j.posted_at,
                j.first_seen, c.name company, a.stage
         FROM jobs j JOIN companies c ON c.id = j.company_id
         LEFT JOIN applications a ON a.url_hash = j.url_hash
         WHERE ${where.join(' AND ')}
         ORDER BY j.first_seen DESC, j.score DESC LIMIT ${PAGE + 1} OFFSET ${pg * PAGE}`,
      ).bind(...binds).all<Record<string, string | number | null>>()
    ).results;
    const hasNext = rows.length > PAGE;
    if (hasNext) rows.pop();
    const total = (await c.env.DB.prepare(
      `SELECT COUNT(*) n FROM jobs j JOIN companies c ON c.id = j.company_id
       LEFT JOIN applications a ON a.url_hash = j.url_hash WHERE ${where.join(' AND ')}`,
    ).bind(...binds).first<{ n: number }>())?.n ?? 0;

    const sel = (name: string, opts: string[], current?: string) => (
      <select name={name}>
        <option value="">({name})</option>
        {opts.map((o) => <option value={o} selected={o === current}>{o}</option>)}
      </select>
    );

    return page(c, 'Jobs', (
      <>
        <div class="actions mb-1">
          {([['survivors', 'New survivors'], ['all', 'All'], ['skipped', 'Skipped'], ['closed', 'Closed']] as const).map(
            ([v, label]) => <a href={`/jobs?view=${v}`} class={view === v ? 'btnlike sec' : 'btnlike'}>{label}</a>,
          )}
        </div>
        <form method="get" action="/jobs" class="card actions filterbar">
          <input type="hidden" name="view" value={view} />
          <input type="text" name="q" placeholder="search in title" value={q.q ?? ''} />
          {sel('track', ['canada_coop', 'colombia_perm', 'contractor_usd'], q.track)}
          {sel('verdict', ['Apply', 'Stretch-worth-it', 'Skip'], q.verdict)}
          {sel('status', ['new', 'notified', 'closed', 'skipped'], q.status)}
          <button type="submit" class="primary">Filter</button>
        </form>
        <div class="table-wrap"><table>
          <tr><th>title</th><th class="hide-sm">track</th><th>verdict</th><th class="hide-sm">status</th><th>score</th><th class="hide-sm">stage</th><th class="hide-sm">seen</th></tr>
          {rows.map((j) => (
            <tr>
              <td><a href={`/jobs/${j.url_hash}`}>{j.title}</a><div class="muted">{j.company} · {j.location}</div></td>
              <td class="hide-sm">{j.track ?? '—'}</td>
              <td class={`v-${j.verdict}`}>{j.verdict}</td>
              <td class={`hide-sm s-${j.status}`}>{j.status}</td>
              <td>{j.score}</td>
              <td class="hide-sm">{j.stage ?? '—'}</td>
              <td class="hide-sm muted">{fmt(String(j.first_seen))}</td>
            </tr>
          ))}
        </table></div>
        {pager('/jobs', pg, hasNext, total, { view, track: q.track, verdict: q.verdict, status: q.status, q: q.q })}
      </>
    ));
  });

  app.get('/jobs/:hash', async (c) => {
    const hash = c.req.param('hash');
    const j = await c.env.DB.prepare(
      `SELECT j.*, c.name company FROM jobs j JOIN companies c ON c.id = j.company_id WHERE j.url_hash = ?`,
    ).bind(hash).first<Record<string, string | number | null>>();
    if (!j) return c.notFound();
    const events = (
      await c.env.DB.prepare('SELECT ts, actor, event, detail FROM job_events WHERE url_hash = ? ORDER BY id DESC LIMIT 20')
        .bind(hash).all<Record<string, string>>()
    ).results;
    let breakdown: ScoreResult | null = null;
    try { breakdown = JSON.parse(String(j.score_breakdown ?? '')) as ScoreResult; } catch { /* no breakdown */ }
    const similares = j.title_norm
      ? (
          await c.env.DB.prepare(
            `SELECT j2.url_hash, j2.title, j2.verdict, j2.score, c2.name company
             FROM jobs j2 JOIN companies c2 ON c2.id = j2.company_id
             WHERE j2.title_norm = ? AND j2.url_hash != ? LIMIT 6`,
          ).bind(j.title_norm, hash).all<Record<string, string | number>>()
        ).results
      : [];
    const kit = await c.env.DB.prepare(
      `SELECT k.answers, k.red_questions, k.eeoc_questions, k.answer_suggestions, k.deep_link, k.updated_at, a.stage
       FROM jobs j LEFT JOIN application_kits k ON k.url_hash = j.url_hash
       LEFT JOIN applications a ON a.url_hash = j.url_hash WHERE j.url_hash = ?`,
    ).bind(hash).first<Record<string, string | null>>();
    const kitAnswers = (() => { try { return JSON.parse(String(kit?.answers ?? '[]')) as Array<{ question: string; answer: string | null; red: boolean }>; } catch { return []; } })();
    const kitRed = (() => { try { return JSON.parse(String(kit?.red_questions ?? '[]')) as string[]; } catch { return []; } })();
    const kitEeoc = (() => { try { return JSON.parse(String(kit?.eeoc_questions ?? '[]')) as string[]; } catch { return []; } })();
    const kitSuggestions = (() => { try { return JSON.parse(String(kit?.answer_suggestions ?? '[]')) as Array<{ question: string; suggestion: string }>; } catch { return []; } })();
    const suggBy = new Map(kitSuggestions.map((s) => [s.question, s.suggestion]));
    const hasKit = kit?.updated_at != null;
    // Only these ATSs expose the application form publicly; SuccessFactors/Workday
    // hide it behind a candidate login, so a kit there has 0 detected questions by
    // design (not a failure) — the card says so instead of a bare "0 matched".
    const formDetectable = ['greenhouse', 'lever', 'ashby'].includes(String(j.ats));
    const currentStage = kit?.stage ?? null;

    return page(c, String(j.title), (
      <>
        <div class="card">
          <div class="jobmeta">
            <div><span class="k">Company:</span>{j.company}</div>
            <div class="span2"><span class="k">Location:</span>{j.location || '—'}</div>
            <div><span class="k">Verdict:</span><span class={`v-${j.verdict}`}>{j.verdict}</span></div>
            <div><span class="k">Score:</span>{j.score}/100</div>
            <div><span class="k">Track:</span>{j.track ?? '—'}</div>
            <div><span class="k">Posted:</span>{fmt(j.posted_at as string)}</div>
            <div><span class="k">Seen:</span>{fmt(j.first_seen as string)}</div>
            <div><span class="k">Status:</span><span class={`s-${j.status}`}>● {j.status}</span></div>
          </div>
          <div class="actions mt-1">
            <a class="btnlike" href={String(j.url)} target="_blank" rel="noreferrer">Open Job ↗</a>
            <form class="inline" method="post" action="/triage">
              <input type="hidden" name="hash" value={hash} />
              <input type="hidden" name="stage" value="dismissed" />
              <button type="submit" class={currentStage === 'dismissed' ? 'primary' : ''}>Dismiss</button>
            </form>
            <form class="inline" method="post" action={`/jobs/${hash}/telegram`}>
              <input type="hidden" name="hash" value={hash} />
              <button type="submit">Telegram</button>
            </form>
          </div>
        </div>
        {j.why_it_fits ? (
          <div class="card">
            <div><strong>Why it fits:</strong> {j.why_it_fits}</div>
            {j.positioning_lead ? <div class="muted mt-2"><strong>Positioning:</strong> {j.positioning_lead}</div> : null}
          </div>
        ) : null}
        <div class="card">
          <h2>Application kit</h2>
          <div class="actions">
            <form class="inline" method="post" action={`/jobs/${hash}/prepare`} data-prepare>
              <input type="hidden" name="hash" value={hash} />
              <button type="submit" class={currentStage === 'prepared' ? 'primary' : ''}>Prepare</button>
            </form>
            {hasKit ? (
              <form class="inline" method="post" action={`/jobs/${hash}/polish`}>
                <button type="submit">✨ Polish answers</button>
              </form>
            ) : null}
            {j.cv_pdf_key ? <a class="btnlike" href={`https://drive.google.com/file/d/${String(j.cv_pdf_key)}/view`} target="_blank" rel="noreferrer">CV ↗ (PDF)</a>
              : j.cv_pending ? <span class="muted">CV queued — builds in ~15 min</span> : null}
            <form class="inline" method="post" action="/triage">
              <input type="hidden" name="hash" value={hash} />
              <input type="hidden" name="stage" value="applied" />
              <button type="submit" class={currentStage === 'applied' ? 'primary' : ''}>I applied ✓</button>
            </form>
          </div>
          <div id="prep-modal" class="modal-backdrop" hidden>
            <div class="modal" role="dialog" aria-label="Preparing">
              <h3>Preparing kit + CV…</h3>
              <ol id="prep-steps" class="steps"></ol>
              <p class="muted sm">This can take a moment; don't close this tab.</p>
            </div>
          </div>
          <script dangerouslySetInnerHTML={{ __html: prepJs }} />
          {hasKit ? (
            <div class="mt-1">
              {formDetectable ? (
                <div class="muted">{kitAnswers.filter((a) => !a.red).length} matched · {kitRed.length} red · {kitEeoc.length} EEOC</div>
              ) : (
                <div class="muted">{String(j.ats)} hides its form behind the apply flow — questions can't be auto-detected. Open the form and use your <a href="/qa">Q&amp;A</a> answers + the CV below.</div>
              )}
              {kitAnswers.filter((a) => !a.red).map((a) => (
                <div class="bullet">
                  <div class="muted">{a.question}</div>
                  <div>{a.answer}</div>
                  {suggBy.get(a.question) ? <div class="muted">✨ tailored for this job (review before use): {suggBy.get(a.question)}</div> : null}
                </div>
              ))}
              {kitRed.length ? (
                <div class="mt-2"><strong class="warn">Unanswered:</strong>
                  {kitRed.map((q) => <div class="muted">🔴 {q}</div>)}
                  <div class="muted">answer them from the Telegram kit message, or add them in <a href="/qa">Q&A</a></div>
                </div>
              ) : null}
              {kitEeoc.length ? (
                <div class="muted mt-2">⚖️ EEOC ({kitEeoc.length}) — never auto-answered: {kitEeoc.map((q) => <div>· {q}</div>)}</div>
              ) : null}
              <div class="muted mt-2">Checklist: open the form → autofill from this kit → attach the PDF → review EVERYTHING → you click submit.</div>
            </div>
          ) : <p class="muted">No kit yet — hit <strong>Prepare</strong> (above) to build the kit + CV on the spot.</p>}
        </div>
        {breakdown ? (
          <div class="card">
            <h2>Score breakdown</h2>
            <div class="table-wrap"><table>
              <tr><th>category</th><th>matches</th><th>norm</th><th>points</th></tr>
              {Object.entries(breakdown.breakdown).map(([cat, b]) => (
                <tr>
                  <td>{cat}</td>
                  <td>{b.matches.map((m) => <span class="chip">{m.term}{m.in_title ? ' ×2' : ''}{m.weight < 0 ? ' (−)' : ''}</span>)}</td>
                  <td>{b.normalized.toFixed(2)}</td>
                  <td>{b.points.toFixed(1)}</td>
                </tr>
              ))}
            </table></div>
            <h2>Gates by track</h2>
            <div class="table-wrap"><table>
              <tr><th>track</th><th>verdict</th><th>adj. score</th><th>gates</th></tr>
              {Object.entries(breakdown.tracks).map(([t, r]) => (
                <tr>
                  <td>{t}</td>
                  <td class={`v-${r.verdict}`}>{r.verdict}</td>
                  <td>{r.adjusted_score}</td>
                  <td>{r.gates.map((g) => <div class={g.passed ? 'ok' : 'bad'}>{g.passed ? '✓' : '✗'} {g.id} <span class="muted">({g.evidence})</span></div>)}</td>
                </tr>
              ))}
            </table></div>
            {breakdown.near_miss_reason ? <p class="warn">why not: {breakdown.near_miss_reason}</p> : null}
          </div>
        ) : null}
        {similares.length > 0 ? (
          <div class="card">
            <h2>Similar jobs radar ({similares.length})</h2>
            {similares.map((s) => (
              <div>
                <a href={`/jobs/${s.url_hash}`}>{s.title}</a> @ {s.company} ·{' '}
                <span class={`v-${s.verdict}`}>{s.verdict}</span> · {s.score}
              </div>
            ))}
          </div>
        ) : null}
        <div class="card">
          <h2>History</h2>
          {events.length === 0 ? <p class="muted">no events</p> : (
            <div class="table-wrap"><table>{events.map((e) => <tr><td class="muted">{fmt(e.ts)}</td><td>{e.actor}</td><td>{e.event}</td><td class="muted">{e.detail}</td></tr>)}</table></div>
          )}
        </div>
      </>
    ));
  });

  // ---------- Companies ----------
  app.get('/companies', async (c) => {
    const pg = pageNum(c);
    const rows = (
      await c.env.DB.prepare(
        `SELECT c.id, c.name, c.ats, c.token, c.active, c.fail_count, c.last_ok_fetch, c.last_error, c.notes,
                COUNT(j.url_hash) jobs_seen,
                SUM(CASE WHEN j.verdict IN ('Apply','Stretch-worth-it') THEN 1 ELSE 0 END) survivors
         FROM companies c
         LEFT JOIN jobs j ON j.company_id = c.id AND j.first_seen >= datetime('now','-90 days')
         GROUP BY c.id ORDER BY survivors DESC, c.name LIMIT ${PAGE + 1} OFFSET ${pg * PAGE}`,
      ).all<Record<string, string | number | null>>()
    ).results;
    const hasNext = rows.length > PAGE;
    if (hasNext) rows.pop();
    const total = (await c.env.DB.prepare('SELECT COUNT(*) n FROM companies').first<{ n: number }>())?.n ?? 0;

    return page(c, 'Companies', (
      <>
        <form method="post" action="/companies" class="card actions">
          <input type="text" name="name" placeholder="name" required />
          <select name="ats">{Object.keys(connectors).map((a) => <option value={a}>{a}</option>)}</select>
          <input type="text" name="token" placeholder="board token / SF host" required />
          <input type="text" name="notes" placeholder="notes" />
          <button type="submit" class="primary">Add company</button>
        </form>
        <form method="post" action="/companies/add-urls" class="card">
          <strong>Add by URL (bulk)</strong>
          <p class="muted my-2">Paste career/board URLs — one per line. Greenhouse / Lever / Ashby are detected automatically; each is validated on the next poll (see the health column).</p>
          <textarea name="urls" rows={4} class="w-full" placeholder={'https://jobs.lever.co/acme\nhttps://boards.greenhouse.io/acme\nhttps://jobs.ashbyhq.com/acme'} />
          <div class="actions mt-1"><button type="submit" class="primary">Add all</button></div>
        </form>
        <div class="table-wrap"><table>
          <tr><th>company</th><th>ats</th><th>token</th><th>active</th><th>health</th><th>jobs 90d</th><th>survivors</th><th>yield</th></tr>
          {rows.map((r) => (
            <tr>
              <td><a href={`/companies/${r.id}`}>{r.name}</a><div class="muted">{r.notes}</div></td>
              <td>{r.ats}</td>
              <td class="muted">{r.token}</td>
              <td>
                <form class="inline" method="post" action="/companies/toggle">
                  <input type="hidden" name="id" value={String(r.id)} />
                  <button type="submit">{r.active ? '✅ yes' : '⛔ no'}</button>
                </form>
              </td>
              <td>{Number(r.fail_count) > 0 ? <span class="bad">{r.fail_count} failures · {r.last_error}</span> : <span class="ok">ok {fmt(r.last_ok_fetch as string)}</span>}</td>
              <td>{r.jobs_seen}</td>
              <td>{r.survivors ?? 0}</td>
              <td>{Number(r.jobs_seen) > 0 ? `${((Number(r.survivors ?? 0) / Number(r.jobs_seen)) * 100).toFixed(1)}%` : '—'}</td>
            </tr>
          ))}
        </table></div>
        {pager('/companies', pg, hasNext, total, {})}
      </>
    ));
  });

  app.post('/companies', async (c) => {
    const b = await c.req.parseBody();
    const name = String(b.name ?? '').trim();
    const ats = String(b.ats ?? 'greenhouse') as Ats;
    const token = String(b.token ?? '').trim();
    const notes = String(b.notes ?? '');
    if (!name || !token) return c.redirect('/companies?m=missing fields');
    if (!connectors[ats]) return c.redirect('/companies?m=unknown ATS');
    // Probe the token via the matching connector for ALL supported ATS (not just
    // Greenhouse); activate only when the board answers.
    let probe: string;
    let active = 0;
    try {
      const jobs = await connectors[ats].fetchJobs({ id: 0, name, ats, token, active: true });
      probe = `token OK: ${jobs.length} jobs on the board`;
      active = 1;
    } catch (err) {
      probe = `token FAILED: ${err instanceof Error ? err.message : 'error'} — saved inactive`;
    }
    await c.env.DB.prepare(
      'INSERT OR IGNORE INTO companies (name, ats, token, active, notes) VALUES (?,?,?,?,?)',
    ).bind(name, ats, token, active, notes).run();
    return c.redirect(`/companies?m=${encodeURIComponent(probe)}`);
  });

  // Bulk "add by URL": paste career/board URLs; detect ATS+token from the host.
  // Zero probes here (subrequest budget) — companies are validated on the next
  // poll (health column), so pasting many is cheap.
  app.post('/companies/add-urls', async (c) => {
    const b = await c.req.parseBody();
    const lines = String(b.urls ?? '').split(/[\r\n,]+/).map((s) => s.trim()).filter(Boolean);
    const stmts = [];
    const skipped: string[] = [];
    for (const line of lines.slice(0, 200)) {
      const parsed = parseAtsUrl(line);
      if (!parsed) { skipped.push(line); continue; }
      stmts.push(
        c.env.DB.prepare('INSERT OR IGNORE INTO companies (name, ats, token, active, notes) VALUES (?,?,?,1,?)')
          .bind(parsed.token, parsed.ats, parsed.token, 'added by URL'),
      );
    }
    if (stmts.length) await c.env.DB.batch(stmts);
    const msg = `added ${stmts.length} (validated on next poll)`
      + (skipped.length ? ` · skipped ${skipped.length} non-ATS URL(s)` : '');
    return c.redirect(`/companies?m=${encodeURIComponent(msg)}`);
  });

  app.post('/companies/toggle', async (c) => {
    const b = await c.req.parseBody();
    await c.env.DB.prepare('UPDATE companies SET active = 1 - active WHERE id = ?').bind(Number(b.id)).run();
    return c.redirect('/companies?m=updated');
  });

  // View + edit a single company (the token/ATS/notes/active are all editable here).
  app.get('/companies/:id', async (c) => {
    const id = Number(c.req.param('id'));
    const co = await c.env.DB.prepare('SELECT * FROM companies WHERE id = ?').bind(id).first<Record<string, string | number | null>>();
    if (!co) return c.notFound();
    const stats = await c.env.DB.prepare(
      `SELECT COUNT(*) jobs_seen,
              SUM(CASE WHEN verdict IN ('Apply','Stretch-worth-it') THEN 1 ELSE 0 END) survivors
       FROM jobs WHERE company_id = ?`,
    ).bind(id).first<{ jobs_seen: number; survivors: number }>();
    return page(c, String(co.name), (
      <>
        <div class="card">
          <form method="post" action={`/companies/${id}/edit`}>
            <div class="field"><label>Name</label><input type="text" name="name" value={String(co.name)} required /></div>
            <div class="field"><label>ATS</label>
              <select name="ats">{Object.keys(connectors).map((a) => <option value={a} selected={a === co.ats}>{a}</option>)}</select></div>
            <div class="field"><label>Board token / host</label><input type="text" name="token" value={String(co.token)} required /></div>
            <div class="field"><label>Notes</label><input type="text" name="notes" value={String(co.notes ?? '')} /></div>
            <label class="chk"><input type="checkbox" name="active" checked={!!co.active} /> Active (polled each run)</label>
            <div class="actions mt-1"><button type="submit" class="primary">Save</button><a class="btnlike" href="/companies">Back to Companies</a></div>
          </form>
        </div>
        <div class="card">
          <h2>Status</h2>
          <div class="kv">
            <div><span class="k">Health:</span>{Number(co.fail_count) > 0 ? <span class="bad">{co.fail_count} failures · {co.last_error}</span> : <span class="ok">ok {fmt(co.last_ok_fetch as string)}</span>}</div>
            <div><span class="k">Jobs (all-time):</span>{stats?.jobs_seen ?? 0}</div>
            <div><span class="k">Survivors:</span>{stats?.survivors ?? 0}</div>
            <div><span class="k">Fetch ok/fail total:</span>{co.fetch_ok_total ?? 0} / {co.fetch_fail_total ?? 0}</div>
          </div>
        </div>
        <div class="card bd-warn">
          <h2 class="warn">Danger zone</h2>
          <p class="muted my-1">Deletes the company and everything derived from it (jobs, kits, CVs, events). Prefer deactivating if you might re-add it.</p>
          <form method="post" action={`/companies/${id}/delete`}
            onsubmit="return confirm('Delete this company AND all its jobs, kits, CVs and events permanently? This cannot be undone.')">
            <button type="submit" class="danger">Delete company</button>
          </form>
        </div>
      </>
    ));
  });

  app.post('/companies/:id/edit', async (c) => {
    const id = Number(c.req.param('id'));
    const b = await c.req.parseBody();
    const name = String(b.name ?? '').trim();
    const ats = String(b.ats ?? '') as Ats;
    const token = String(b.token ?? '').trim();
    const notes = String(b.notes ?? '');
    const active = b.active ? 1 : 0;
    if (!name || !token || !connectors[ats]) {
      return c.redirect(`/companies/${id}?m=${encodeURIComponent('name, a valid ATS and a token are required')}`);
    }
    try {
      await c.env.DB.prepare('UPDATE companies SET name = ?, ats = ?, token = ?, notes = ?, active = ? WHERE id = ?')
        .bind(name, ats, token, notes, active, id).run();
    } catch (err) {
      return c.redirect(`/companies/${id}?m=${encodeURIComponent(`not saved: ${err instanceof Error ? err.message : 'error'} (ats+token must be unique)`)}`);
    }
    return c.redirect(`/companies/${id}?m=saved`);
  });

  // Delete children first — D1 enforces the jobs/events foreign keys.
  app.post('/companies/:id/delete', async (c) => {
    const id = Number(c.req.param('id'));
    const sub = 'SELECT url_hash FROM jobs WHERE company_id = ?';
    await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE cvs SET superseded_by = NULL WHERE url_hash IN (${sub})`).bind(id),
      c.env.DB.prepare(`DELETE FROM application_kits WHERE url_hash IN (${sub})`).bind(id),
      c.env.DB.prepare(`DELETE FROM applications WHERE url_hash IN (${sub})`).bind(id),
      c.env.DB.prepare(`DELETE FROM cvs WHERE url_hash IN (${sub})`).bind(id),
      c.env.DB.prepare(`DELETE FROM job_events WHERE url_hash IN (${sub})`).bind(id),
      c.env.DB.prepare('DELETE FROM jobs WHERE company_id = ?').bind(id),
      c.env.DB.prepare('DELETE FROM events WHERE company_id = ?').bind(id),
      c.env.DB.prepare('DELETE FROM companies WHERE id = ?').bind(id),
    ]);
    return c.redirect('/companies?m=company deleted');
  });

  // ---------- Calibration (matrix redesign 2026-07-18, mockups v3.3: ONE grid
  // — 5 categories × in favor/against × EN/ES — with the track as a path badge
  // on the word; ONE add form after the table; draft → Preview impact →
  // Activate flow unchanged) ----------
  const MATRIX_LABELS: Record<MatrixCategory, [string, string]> = {
    location: ['Location', 'where I can work'],
    role_type: ['Role titles', 'jobs that fit me — or don’t'],
    level_fit: ['Seniority', 'level words'],
    domain: ['Industry & domain', 'what the job is about'],
    tool_overlap: ['Tools', 'what I work with'],
  };
  const TRACK_LABELS: Record<string, string> = {
    canada_coop: 'Canada co-op',
    colombia_perm: 'Colombia permanent',
    contractor_usd: 'Contractor international',
  };
  /** Live scoring config, normalized to the {en,es} shape. */
  async function loadLive(env: ConsoleEnv): Promise<import('../scoring').ScoringConfig> {
    const l = await env.DB.prepare("SELECT value FROM config WHERE key='scoring'").first<{ value: string }>();
    if (!l) throw new Error('scoring config missing');
    return normalizeScoringConfig(JSON.parse(l.value));
  }
  /** Every edit applies immediately: bump the version and write the config live. */
  async function saveLive(env: ConsoleEnv, cfg: import('../scoring').ScoringConfig): Promise<void> {
    cfg.version = (cfg.version ?? 0) + 1;
    await env.DB.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('scoring', ?)")
      .bind(JSON.stringify(cfg)).run();
  }

  app.get('/calibration', async (c) => {
    const rows = (
      await c.env.DB.prepare("SELECT key, value FROM config WHERE key IN ('FRESHNESS_MAX_DAYS')").all<{ key: string; value: string }>()
    ).results;
    const freshness = rows.find((r) => r.key === 'FRESHNESS_MAX_DAYS')?.value ?? '3';
    const cfg = await loadLive(c.env);
    const matrix = buildMatrix(cfg);
    // Keyword impact & recommendations: scan the newest 400 stored breakdowns (bounded CPU).
    // Moved here from /intelligence — this is calibration input, not AI telemetry.
    const sample = (
      await c.env.DB.prepare(
        `SELECT j.url_hash, j.title, j.verdict, j.score, j.score_breakdown, c.name company
         FROM jobs j JOIN companies c ON c.id = j.company_id
         ORDER BY j.first_seen DESC LIMIT 400`,
      ).all<Record<string, string | number | null>>()
    ).results;
    const impact = new Map<string, { hits: number; surv: number; cat: string }>();
    const nearMiss: Array<{ hash: string; title: string; company: string; score: number; reason: string }> = [];
    for (const r of sample) {
      let b: ScoreResult | null = null;
      try { b = JSON.parse(String(r.score_breakdown ?? '')) as ScoreResult; } catch { continue; }
      if (!b?.breakdown) continue;
      const surv = r.verdict !== 'Skip';
      for (const [cat, cb] of Object.entries(b.breakdown)) {
        for (const m of cb.matches) {
          if (m.weight <= 0) continue;
          const e = impact.get(m.term) ?? { hits: 0, surv: 0, cat };
          e.hits++; if (surv) e.surv++;
          impact.set(m.term, e);
        }
      }
      if (r.verdict === 'Skip' && b.near_miss_reason) {
        nearMiss.push({ hash: String(r.url_hash), title: String(r.title), company: String(r.company), score: Number(r.score), reason: b.near_miss_reason });
      }
    }
    const topImpact = [...impact.entries()].sort((a, b) => b[1].hits - a[1].hits).slice(0, 20);
    nearMiss.sort((a, b) => b.score - a.score);
    const topNear = nearMiss.slice(0, 15);
    // dead = configured FAVOR keywords with zero matches in the sample (favor-only;
    // gates/location carry no hit data here). "dead" = unmatched in the window, not forever.
    const dead: Array<{ en: string; cat: Category }> = [];
    for (const cat of CATEGORIES) {
      for (const k of cfg.keywords[cat]) {
        if (k.weight > 0 && !impact.has(k.en)) dead.push({ en: k.en, cat });
      }
    }
    // strong = frequently matched AND mostly landing in survivors.
    const strong = [...impact.entries()]
      .filter(([, e]) => e.hits >= 3 && e.surv / e.hits >= 0.5)
      .sort((a, b) => (b[1].surv / b[1].hits) - (a[1].surv / a[1].hits))
      .slice(0, 12);
    const trackLabel = (t: string) => TRACK_LABELS[t] ?? t;
    const pathClass = (t: string) => `path p-${Math.max(0, cfg.tracks.findIndex((x) => x.id === t))}`;
    const isLocation = (cat: MatrixCategory) => cat === 'location';
    const pathBadge = (t?: string) => (t ? <span class={pathClass(t)}>{trackLabel(t)}</span> : <span class="muted">—</span>);
    const strengthText = (r: ConceptRow) => (r.weight !== undefined ? (r.weight > 0 ? `+${r.weight}` : String(r.weight)) : '');
    const hiddenTarget = (r: ConceptRow) => (
      r.source.kind === 'keyword' ? (
        <input type="hidden" name="category" value={r.category} />
      ) : (
        <>
          <input type="hidden" name="track" value={r.source.track} />
          <input type="hidden" name="gate" value={r.source.gate} />
        </>
      )
    );

    /** One concept: a read row (English | Español | Strength | Path | ✏️ ✕) plus an
        inline edit form. ✏️ toggles to edit; Save writes live; Cancel reverts. */
    const conceptRow = (r: ConceptRow, loc: boolean) => (
      <div class="mconcept-wrap">
        <div class={`mgrid mc-read${loc ? ' loc' : ''}`}>
          <div class="mc-en">{r.en}</div>
          <div class="mc-es">{r.es ? r.es : <span class="mc-empty" title="Spanish not filled yet">—</span>}</div>
          {loc ? null : <div class="mc-str">{strengthText(r)}</div>}
          <div class="mc-path">{pathBadge(r.path)}</div>
          <div class="mc-actions">
            <button type="button" class="chipx mc-editbtn" title="Edit">✏️</button>
            <form class="inline" method="post" action="/calibration/word-remove">
              <input type="hidden" name="kind" value={r.source.kind} />
              {hiddenTarget(r)}
              <input type="hidden" name="en" value={r.en} />
              <button type="submit" class="chipx" title="Remove (both languages)">✕</button>
            </form>
          </div>
        </div>
        <form class={`mgrid mc-edit${loc ? ' loc' : ''}`} method="post" action="/calibration/word-edit">
          <input type="hidden" name="kind" value={r.source.kind} />
          {hiddenTarget(r)}
          <input type="hidden" name="old_en" value={r.en} />
          <input type="text" name="en" value={r.en} required class="mc-in" aria-label="English" />
          <input type="text" name="es" value={r.es} placeholder="español…" required class="mc-in" aria-label="Español" />
          {loc ? null : (
            <select name="weight" class="mc-in" aria-label="Strength">
              {[3, 2, 1, -2, -3].map((w) => <option value={String(w)} selected={r.weight === w}>{w > 0 ? `+${w}` : String(w)}</option>)}
            </select>
          )}
          <div class="mc-path">{pathBadge(r.path)}</div>
          <div class="mc-actions">
            <button type="submit" class="chipx mc-btn" title="Save">✓</button>
            <button type="button" class="chipx mc-btn mc-cancel" title="Cancel">✗</button>
          </div>
        </form>
      </div>
    );

    const sideBlock = (label: string, rows: ConceptRow[], loc: boolean) => (rows.length ? (
      <div class="mside">
        <div class="msidehead">{label}</div>
        <div class={`mgrid mchead${loc ? ' loc' : ''}`}>
          <div>Word — English (required)</div>
          <div>Word — Español (required)</div>
          {loc ? null : <div>Strength</div>}
          <div>Path</div>
          <div />
        </div>
        {rows.map((r) => conceptRow(r, loc))}
      </div>
    ) : null);

    const groupCard = (g: MatrixGroup) => {
      const loc = isLocation(g.category);
      return (
        <details class="rc">
          <summary class="rc-head">
            <span class="caret" />
            <span class="rc-title">{MATRIX_LABELS[g.category][0]}</span>
            <span class="rc-sub">{MATRIX_LABELS[g.category][1]}</span>
            <span class="rc-meta">{g.count} concepts{loc ? ' · gates (pass/fail)' : ''}</span>
          </summary>
          <div class="rc-body">
            {sideBlock('In favor', g.favor, loc)}
            {sideBlock('Against', g.against, loc)}
            {g.count === 0 ? <p class="muted">none yet — ＋ Add word below</p> : null}
          </div>
        </details>
      );
    };

    return page(c, 'Calibration', (
      <>
        <form method="post" action="/calibration/quick" class="card actions">
          <label>Notify me at score ≥ <input type="number" name="apply" value={String(cfg.thresholds.apply)} class="w-sm" /></label>
          <label>Show borderline from ≥ <input type="number" name="stretch" value={String(cfg.thresholds.stretch)} class="w-sm" /></label>
          <label>Ignore postings older than <input type="number" name="freshness" value={freshness} class="w-xs" /> days</label>
          <button type="submit" class="primary">Save</button>
          <span class="muted">Config v{cfg.version ?? 0}</span>
        </form>

        <h2>Keyword matrix (ATS)</h2>
        <p class="muted mb-2">Changes save immediately. New jobs use them on the next run; jobs already stored keep their score.</p>
        <div class="calsearch">
          <span class="cs-ic" aria-hidden="true">🔍</span>
          <input type="search" id="calsearch-input" placeholder="Filter words across every list…" aria-label="Filter words" />
          <button type="button" id="calsearch-clear" class="cs-x" aria-label="Clear filter">×</button>
        </div>

        <div class="matrix-groups">
          {matrix.map(groupCard)}
        </div>

        <ul class="legend">
          <li>Each concept has an <strong>English</strong> and a <strong>Español</strong> value — both required.</li>
          <li><strong>Strength:</strong> +3 / +2 / +1 in favor · −2 / −3 against.</li>
          <li><strong>✏️</strong> edit a concept · <strong>✕</strong> remove it (both languages).</li>
          <li><strong>Path badge</strong> = which track the word applies to · no badge = every track.</li>
        </ul>

        <div class="card">
          <strong>＋ Add word</strong>
          <form method="post" action="/calibration/word-add" class="mt-1">
            <div class="formgrid">
              <div class="field f-en"><label>Word — English (required)</label>
                <input type="text" name="term_en" required placeholder="e.g. remote latam" /></div>
              <div class="field f-es"><label>Word — Español (required; same word twice if it doesn’t translate)</label>
                <input type="text" name="term_es" required placeholder="e.g. latam remoto" /></div>
            </div>
            <div class="actions">
              <label class="muted">Category{' '}
                <select name="category">
                  {MATRIX_CATEGORIES.map((cat) => <option value={cat}>{MATRIX_LABELS[cat][0]}</option>)}
                </select></label>
              <label class="muted">Direction{' '}
                <select name="dir" id="dir-sel">
                  <option value="favor" selected>In favor</option>
                  <option value="against">Against</option>
                </select></label>
              <label class="muted">Strength{' '}
                <select name="weight" id="str-sel">
                  <option value="3">+3 strong</option>
                  <option value="2" selected>+2 medium</option>
                  <option value="1">+1 light</option>
                </select></label>
              <label class="muted">Path{' '}
                <select name="path">
                  <option value="">— every track —</option>
                  {cfg.tracks.map((t) => <option value={t.id}>{trackLabel(t.id)}</option>)}
                </select></label>
              <button type="submit" class="primary">Add</button>
            </div>
            <p class="muted mt-2">Location words REQUIRE a path (they are the track gates; weight does not apply there).</p>
          </form>
        </div>

        <div class="card">
          <h2>Keyword impact &amp; recommendations <span class="muted">(last {sample.length} jobs)</span></h2>
          <p class="muted my-1">How often each favor-keyword matched, and how many of those jobs survived — the signal behind the scores. Prune dead words, trust strong ones.</p>
          <div class="table-wrap"><table>
            <tr><th>keyword</th><th>category</th><th>matches</th><th>in survivors</th><th>survivor rate</th></tr>
            {topImpact.map(([term, e]) => (
              <tr><td>{term}</td><td class="muted">{e.cat}</td><td>{e.hits}</td><td>{e.surv}</td><td class="muted">{Math.round((e.surv / e.hits) * 100)}%</td></tr>
            ))}
          </table></div>
          <p class="mt-2"><strong>Strong signals</strong> <span class="muted">(≥3 matches, ≥50% in survivors)</span></p>
          {strong.length === 0 ? <p class="muted">none yet in the sample</p> : (
            <div class="actions">{strong.map(([term, e]) => <span class="chip">{term} · {e.surv}/{e.hits}</span>)}</div>
          )}
          <p class="mt-2"><strong>Dead keywords</strong> <span class="muted">(favor words with 0 matches in the sample — consider removing)</span></p>
          {dead.length === 0 ? <p class="muted">none — every favor keyword matched at least once</p> : (
            <div class="actions">{dead.map((d) => <span class="chip">{d.en} <span class="muted">({d.cat})</span></span>)}</div>
          )}
          <p class="muted mt-1">Dead / strong use favor keywords only, over the newest 400 jobs. Against-words and location gates are not measured here.</p>
          <h2 class="mt-2">Near-miss mining <span class="muted">({topNear.length})</span></h2>
          <p class="muted my-1">Skipped jobs closest to the threshold — candidates for a calibration tweak.</p>
          {topNear.length === 0 ? <p class="muted">no near-misses in the sample</p> : topNear.map((n) => (
            <div class="bullet">
              <a href={`/jobs/${n.hash}`}>{n.title}</a> @ {n.company} · <strong>{n.score}</strong>
              <div class="muted">{n.reason}</div>
            </div>
          ))}
        </div>

        <script dangerouslySetInnerHTML={{ __html: `
(() => {
  const q = document.getElementById('calsearch-input');
  if (q) q.addEventListener('input', () => {
    const s = q.value.trim().toLowerCase();
    document.querySelectorAll('.matrix-groups .mconcept-wrap').forEach((row) => {
      row.style.display = (!s || row.textContent.toLowerCase().includes(s)) ? '' : 'none';
    });
    if (s) document.querySelectorAll('.matrix-groups details.rc').forEach((d) => { d.open = true; });
  });
  const clr = document.getElementById('calsearch-clear');
  if (clr && q) clr.addEventListener('click', () => { q.value = ''; q.dispatchEvent(new Event('input')); q.focus(); });
  document.querySelectorAll('.mc-editbtn').forEach((b) => b.addEventListener('click', () => {
    b.closest('.mconcept-wrap').classList.add('editing');
  }));
  document.querySelectorAll('.mc-cancel').forEach((b) => b.addEventListener('click', () => {
    b.closest('.mconcept-wrap').classList.remove('editing');
  }));
  const dirSel = document.getElementById('dir-sel');
  const strSel = document.getElementById('str-sel');
  if (dirSel && strSel) dirSel.addEventListener('change', () => {
    strSel.innerHTML = dirSel.value === 'against'
      ? '<option value="2" selected>−2 against</option><option value="3">−3 strongly against</option>'
      : '<option value="3">+3 strong</option><option value="2" selected>+2 medium</option><option value="1">+1 light</option>';
  });
})();` }} />
      </>
    ));
  });

  // Every calibration edit applies IMMEDIATELY: apply → validate → save live.
  // The matrix maps each concept to keywords and/or gate lists (src/console/matrix.ts).
  app.post('/calibration/word-add', async (c) => {
    const b = await c.req.parseBody();
    const category = String(b.category ?? '') as MatrixCategory;
    if (!MATRIX_CATEGORIES.includes(category)) return c.redirect('/calibration?m=invalid category');
    const cfg = await loadLive(c.env);
    const err = applyWordAdd(cfg, {
      en: String(b.term_en ?? ''),
      es: String(b.term_es ?? ''),
      category,
      favor: String(b.dir ?? 'favor') !== 'against',
      weight: Number(b.weight ?? 2),
      path: String(b.path ?? '') || undefined,
    });
    if (err) return c.redirect(`/calibration?m=${encodeURIComponent(`rejected: ${err.error}`)}`);
    try { validateScoringConfig(cfg); } catch (e) {
      return c.redirect(`/calibration?m=${encodeURIComponent(`rejected: ${e instanceof Error ? e.message : 'invalid'}`)}`);
    }
    await saveLive(c.env, cfg);
    return c.redirect(`/calibration?m=${encodeURIComponent(`✓ Added "${String(b.term_en).trim().toLowerCase()}"`)}`);
  });

  app.post('/calibration/word-remove', async (c) => {
    const b = await c.req.parseBody();
    const en = String(b.en ?? '');
    const target: RemoveTarget = String(b.kind ?? '') === 'gate'
      ? { kind: 'gate', track: String(b.track ?? ''), gate: String(b.gate ?? ''), en }
      : { kind: 'keyword', category: String(b.category ?? '') as Category, en };
    if (target.kind === 'keyword' && !CATEGORIES.includes(target.category)) {
      return c.redirect('/calibration?m=invalid category');
    }
    const cfg = await loadLive(c.env);
    const r = applyPairRemove(cfg, target);
    if ('error' in r) return c.redirect(`/calibration?m=${encodeURIComponent(`remove failed: ${r.error}`)}`);
    await saveLive(c.env, cfg);
    return c.redirect(`/calibration?m=${encodeURIComponent(`✓ Removed "${r.removed.join(', ')}"`)}`);
  });

  app.post('/calibration/word-edit', async (c) => {
    const b = await c.req.parseBody();
    const oldEn = String(b.old_en ?? '');
    const en = String(b.en ?? '');
    const es = String(b.es ?? '');
    const target: EditTarget = String(b.kind ?? '') === 'gate'
      ? { kind: 'gate', track: String(b.track ?? ''), gate: String(b.gate ?? ''), oldEn, en, es }
      : { kind: 'keyword', category: String(b.category ?? '') as Category, oldEn, en, es, weight: Number(b.weight ?? 0) };
    if (target.kind === 'keyword' && !CATEGORIES.includes(target.category)) {
      return c.redirect('/calibration?m=invalid category');
    }
    const cfg = await loadLive(c.env);
    const err = applyWordEdit(cfg, target);
    if (err) return c.redirect(`/calibration?m=${encodeURIComponent(`rejected: ${err.error}`)}`);
    try { validateScoringConfig(cfg); } catch (e) {
      return c.redirect(`/calibration?m=${encodeURIComponent(`rejected: ${e instanceof Error ? e.message : 'invalid'}`)}`);
    }
    await saveLive(c.env, cfg);
    return c.redirect(`/calibration?m=${encodeURIComponent(`✓ Saved "${en.trim().toLowerCase()}"`)}`);
  });

  async function saveConfig(env: ConsoleEnv, key: string, value: string): Promise<void> {
    await env.DB.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').bind(key, value).run();
  }

  // ---------- Contact profile (private; fills CV template placeholders) ----------
  // Phone + CV location grouped by country (phone/location feed the CV header per track).
  const SIMPLE_CO: Array<[string, string]> = [
    ['phone_co', 'Colombian phone (colombia_perm & contractor_usd)'],
    ['location_co', 'Colombia location for CV header (e.g. Medellín, Colombia)'],
  ];
  const SIMPLE_CA: Array<[string, string]> = [
    ['phone_ca', 'Canadian phone (canada_coop)'],
    ['location_ca', 'Canada location for CV header (e.g. Vancouver, BC, Canada)'],
  ];
  // Structured addresses (application forms only — never in the CV).
  const ADDR_CA: Array<[string, string]> = [
    ['country', 'Country'], ['province', 'Province'], ['city', 'City'],
    ['address', 'Address'], ['zip', 'Postal code'],
  ];
  const ADDR_CO: Array<[string, string]> = [
    ['country', 'Country'], ['department', 'Department'], ['municipality', 'Municipality'],
    ['neighbourhood', 'Neighbourhood'], ['address', 'Address'],
    ['detail', 'Detail (apt / tower / interior)'], ['zip', 'Postal code'],
  ];

  app.get('/contact', async (c) => {
    const row = await c.env.DB.prepare("SELECT value FROM config WHERE key='contact_profile'").first<{ value: string }>();
    let profile: Record<string, unknown> = {};
    try { profile = row ? JSON.parse(row.value) : {}; } catch { /* invalid */ }
    const str = (v: unknown) => (typeof v === 'string' ? v : '');
    const addr = (k: 'address_ca' | 'address_co') => (profile[k] && typeof profile[k] === 'object' ? profile[k] as Record<string, string> : {});
    const field = (name: string, label: string, value: string) => (
      <div class="field">
        <label>{label}</label>
        <input type="text" name={name} value={value} />
      </div>
    );
    return page(c, 'Contact profile', (
      <>
        <div class="card">
          <p class="muted">Private data — stored only in D1, never in the repo. The CV header uses <code>{'{{phone}}'}</code> and <code>{'{{location}}'}</code> filled per track (name/email/LinkedIn are hardcoded in the template). The structured addresses below are stored only for step-8 application forms and never shown in the CV.</p>
        </div>
        <form method="post" action="/contact" class="card">
          <div class="cols-2">
            <div>
              <h2 class="mt-0">🇨🇴 Colombia</h2>
              {SIMPLE_CO.map(([key, label]) => field(key, label, str(profile[key])))}
              {ADDR_CO.map(([key, label]) => field(`address_co__${key}`, label, addr('address_co')[key] ?? ''))}
            </div>
            <div>
              <h2 class="mt-0">🇨🇦 Canada</h2>
              {SIMPLE_CA.map(([key, label]) => field(key, label, str(profile[key])))}
              {ADDR_CA.map(([key, label]) => field(`address_ca__${key}`, label, addr('address_ca')[key] ?? ''))}
            </div>
          </div>
          <button type="submit" class="primary">Save contact profile</button>
        </form>
      </>
    ));
  });

  app.post('/contact', async (c) => {
    const b = await c.req.parseBody();
    const profile: Record<string, unknown> = {};
    for (const [key] of [...SIMPLE_CO, ...SIMPLE_CA]) profile[key] = String(b[key] ?? '').trim();
    const buildAddr = (prefix: string, fields: Array<[string, string]>) => {
      const obj: Record<string, string> = {};
      for (const [key] of fields) obj[key] = String(b[`${prefix}__${key}`] ?? '').trim();
      return obj;
    };
    profile.address_ca = buildAddr('address_ca', ADDR_CA);
    profile.address_co = buildAddr('address_co', ADDR_CO);
    await saveConfig(c.env, 'contact_profile', JSON.stringify(profile));
    return c.redirect('/contact?m=contact profile saved');
  });

  app.post('/calibration/quick', async (c) => {
    const b = await c.req.parseBody();
    const cfg = await loadLive(c.env);
    cfg.thresholds = { apply: Number(b.apply), stretch: Number(b.stretch) };
    try { validateScoringConfig(cfg); } catch (e) {
      return c.redirect(`/calibration?m=${encodeURIComponent(`rejected: ${e instanceof Error ? e.message : 'invalid'}`)}`);
    }
    await saveLive(c.env, cfg);
    await saveConfig(c.env, 'FRESHNESS_MAX_DAYS', String(Number(b.freshness ?? 3)));
    return c.redirect(`/calibration?m=${encodeURIComponent('✓ Saved')}`);
  });

  // ---------- Tracker ----------
  const STAGES = ['prepared', 'applied', 'interview', 'offer', 'rejected'] as const;
  const STAGE_LABEL: Record<string, string> = {
    prepared: 'Prepared', applied: 'Applied', interview: 'Interview',
    offer: 'Offer', rejected: 'Rejected', dismissed: 'Dismissed',
  };

  app.get('/tracker', async (c) => {
    const rows = (
      await c.env.DB.prepare(
        `SELECT a.url_hash, a.stage, a.applied_at, a.follow_up_at, a.notes, a.updated_at,
                j.title, j.track, j.score, c2.name company
         FROM applications a JOIN jobs j ON j.url_hash = a.url_hash
         JOIN companies c2 ON c2.id = j.company_id
         WHERE a.stage != 'dismissed' ORDER BY a.updated_at DESC LIMIT 301`,
      ).all<Record<string, string | number | null>>()
    ).results;
    const capped = rows.length > 300;
    if (capped) rows.pop();

    return page(c, 'Tracker', (
      <>
        {capped ? <div class="card muted">Showing the 300 most recent applications — dismiss or close old items to tidy the board.</div> : null}
        {STAGES.map((stage) => {
          const col = rows.filter((r) => r.stage === stage);
          return (
            <details class="rc" open={col.length > 0}>
              <summary>
                <span class="caret"></span>
                <span class="rc-title">{STAGE_LABEL[stage]}</span>
                <span class="rc-meta">({col.length})</span>
              </summary>
              <div class="rc-body">
                {col.length === 0 ? <div class="muted">—</div> : col.map((r) => (
                  <div class="b-row">
                    <div class="b-text">
                      <a href={`/jobs/${r.url_hash}`}><strong>{r.title}</strong></a>
                      <div class="muted">{r.company} · <span class="chip">{r.track}</span> · since {r.updated_at ? String(r.updated_at).slice(0, 10) : '—'}</div>
                      {r.notes ? <div class="muted">📝 {String(r.notes).slice(0, 80)}</div> : null}
                    </div>
                    <form method="post" action="/tracker/update" class="inline">
                      <input type="hidden" name="hash" value={String(r.url_hash)} />
                      <select name="stage">
                        {[...STAGES, 'dismissed'].map((s) => <option value={s} selected={s === stage}>{STAGE_LABEL[s]}</option>)}
                      </select>
                      <input type="text" name="note" placeholder="note" />
                      <button type="submit">Update</button>
                    </form>
                  </div>
                ))}
              </div>
            </details>
          );
        })}
      </>
    ));
  });

  app.post('/tracker/update', async (c) => {
    const b = await c.req.parseBody();
    const hash = String(b.hash ?? '');
    const stage = String(b.stage ?? '');
    if (!hash || !STAGE_LABEL[stage]) return c.redirect('/tracker?m=invalid');
    const ts = now();
    const note = String(b.note ?? '').trim();
    const stamp =
      stage === 'applied' ? 'applied_at' : stage === 'interview' ? 'interview_at'
      : stage === 'offer' || stage === 'rejected' ? 'outcome_at' : null;
    await c.env.DB.prepare(
      `UPDATE applications SET stage = ?, updated_at = ?,
         notes = CASE WHEN ? != '' THEN COALESCE(notes || char(10), '') || ? ELSE notes END
         ${stamp ? `, ${stamp} = COALESCE(${stamp}, ?)` : ''}
       WHERE url_hash = ?`,
    ).bind(...(stamp ? [stage, ts, note, note, ts, hash] : [stage, ts, note, note, hash])).run();
    await jobEvent(c.env, hash, `stage:${stage}`, note);
    return c.redirect('/tracker?m=updated');
  });

  // Replay/Preview and Re-score removed 2026-07-19: calibration edits now apply
  // live immediately; stored jobs keep their score, new jobs use the active config.

  // ---------- Blocks Bank (v6 2026-07-18, the owner's sketch): a role/group is ONE
  // form — its fields plus ALL its bullets — edited together via the single ✏️
  // and saved in ONE transaction. Tap = read mode (clean full-width text).
  // Saving IS the approval. Editors open in native <dialog> popups
  // (showModal(): top layer, backdrop, focus trap, Esc — no page reload, no
  // scroll jump); after a server-side validation error the redirect carries
  // ?reopen=<dialog id> so the popup reopens with the message visible.
  // Section order per owner: Summary → Skills → Roles → Projects, each a
  // collapsible group.

  app.get('/blocks_bank', async (c) => {
    const anchors = await fetchAnchors(c.env);
    const rows = (
      await c.env.DB.prepare(
        `SELECT id, section, anchor_id, skcat, text_en, text_es FROM blocks
         WHERE status != 'retired' ORDER BY section, anchor_id, id`,
      ).all<Record<string, string | null>>()
    ).results;
    const roleCount = anchors.filter((a) => a.kind === 'role').length;

    /** Read mode: full-width EN + ES text, nothing else. */
    const readRow = (b: Record<string, string | null>) => (
      <div class="b-row"><div class="b-text">{b.text_en}<div class="es">{b.text_es}</div></div></div>
    );

    /** One editable bullet box: token label, Delete, EN + ES (both required). */
    const bulletBox = (b: Record<string, string | null>, label: string) => (
      <div class="bbox">
        <div class="btokenrow"><span class="btoken">{label}</span>
          <button type="button" class="bdel">Delete</button></div>
        <input type="hidden" class="delflag" name={`del_${b.id}`} value="" />
        <div class="bbox-langs">
          <div class="field"><label>English</label><textarea class="bank-ta" name={`en_${b.id}`} required>{b.text_en}</textarea></div>
          <div class="field"><label>Español</label><textarea class="bank-ta" name={`es_${b.id}`} required>{b.text_es}</textarea></div>
        </div>
      </div>
    );

    /** The ＋add-a-bullet section (shared by role, project and group forms). */
    const bulletsSection = (label: string, boxes: unknown) => (
      <>
        <div class="bsecthead"><span class="t">{label}</span>
          <button type="button" class="btnlike sec addbullet">＋ add a bullet</button></div>
        <div class="blist">{boxes}</div>
        <template class="btpl">
          <div class="bbox">
            <div class="btokenrow"><span class="btoken">new</span>
              <button type="button" class="bdel">Delete</button></div>
            <div class="bbox-langs">
              <div class="field"><label>English</label><textarea class="bank-ta" name="new_en___K__" required /></div>
              <div class="field"><label>Español</label><textarea class="bank-ta" name="new_es___K__" required /></div>
            </div>
          </div>
        </template>
      </>
    );

    /** One action bar shared by every editor: primary + Cancel left, the
        destructive Delete pushed right — all on ONE row. The submit lives
        outside its <form> via form=<id> so it can sit beside the Delete form. */
    const formActions = (fid: string, primaryLabel: string, del?: { id: string; noun: string }) => (
      <div class="rowactions">
        <button type="submit" form={fid} class="primary">{primaryLabel}</button>
        <button type="button" onclick="this.closest('dialog').close()">Cancel</button>
        {del ? (
          <>
            <span class="spacer" />
            <form class="inline" method="post" action="/roles/delete"
              onsubmit={`return confirm('Delete ${del.id} AND all its bullets permanently? This cannot be undone.')`}>
              <input type="hidden" name="id" value={del.id} />
              <button type="submit">Delete {del.noun}</button>
            </form>
          </>
        ) : null}
      </div>
    );

    /** ROLE: job semantics — Title, Company + Code, current + From/To, bullets. */
    const roleForm = (a: AnchorOpt | null, bl: Array<Record<string, string | null>>) => {
      const fid = a ? `rf-${a.id}` : 'rf-new-role';
      return (
        <div class="editpane">
          <form method="post" action={a ? '/roles/save' : '/roles/create'} id={fid}>
            {a ? <input type="hidden" name="id" value={a.id} /> : <input type="hidden" name="kind" value="role" />}
            <div class="fld mb-3"><label>Title</label>
              <input type="text" name="title" value={a?.title ?? ''} /></div>
            <div class="fields2">
              <div class="fld grow"><label>Company{a ? '' : ' (required)'}</label>
                <input type="text" name="company" value={a?.company ?? ''} required={!a} /></div>
              {a ? (
                <div class="fld w-sm"><label>Code (template-coupled)</label>
                  <input type="text" name="new_code" placeholder={a.id} /></div>
              ) : (
                <div class="fld w-sm"><label>Code (required — e.g. TD1)</label>
                  <input type="text" name="code" required /></div>
              )}
            </div>
            <div class="fields2 mt-2">
              <label class="chk"><input type="checkbox" name="current" checked={!!a && !a.date_to && !!a.date_from}
                onchange="this.form.elements.date_to.disabled=this.checked; if(this.checked) this.form.elements.date_to.value=''" />
                I currently work here</label>
              <div class="fld w-sm"><label>From</label>
                <input type="month" name="date_from" value={a?.date_from ?? ''} /></div>
              <div class="fld w-sm"><label>To</label>
                <input type="month" name="date_to" value={a?.date_to ?? ''} disabled={!!a && !a.date_to && !!a.date_from} /></div>
            </div>
            {bulletsSection('responsibility bullets', a ? bl.map((b, i) => bulletBox(b, `${a.id}R${i + 1}`)) : null)}
          </form>
          {formActions(fid, a ? 'Save everything' : 'Add role', a ? { id: a.id, noun: 'role' } : undefined)}
        </div>
      );
    };

    /** PROJECT: no employment semantics — Name, Code, bullets only. */
    const projectForm = (a: AnchorOpt | null, bl: Array<Record<string, string | null>>) => {
      const fid = a ? `pf-${a.id}` : 'pf-new';
      return (
        <div class="editpane">
          <form method="post" action={a ? '/roles/save' : '/roles/create'} id={fid}>
            {a ? <input type="hidden" name="id" value={a.id} /> : <input type="hidden" name="kind" value="project" />}
            <div class="fields2">
              <div class="fld grow"><label>Project name (required)</label>
                <input type="text" name="title" value={a?.title ?? ''} required /></div>
              {a ? (
                <div class="fld w-sm"><label>Code (template-coupled)</label>
                  <input type="text" name="new_code" placeholder={a.id} /></div>
              ) : (
                <div class="fld w-sm"><label>Code (required — e.g. PRJ1)</label>
                  <input type="text" name="code" required /></div>
              )}
            </div>
            {bulletsSection('bullets', a ? bl.map((b, i) => bulletBox(b, `${a.id}R${i + 1}`)) : null)}
          </form>
          {formActions(fid, a ? 'Save everything' : 'Add project', a ? { id: a.id, noun: 'project' } : undefined)}
        </div>
      );
    };

    /** Skills category / summary: same ONE-form pattern over the group's items. */
    const groupForm = (key: string, items: Array<Record<string, string | null>>, hidden: Record<string, string>) => {
      const fid = `gf-${key}`;
      return (
        <div class="editpane">
          <form method="post" action="/blocks_bank/group-save" id={fid}>
            {Object.entries(hidden).map(([k, v]) => <input type="hidden" name={k} value={v} />)}
            {bulletsSection('items', items.map((b, i) => bulletBox(b, `item ${i + 1}`)))}
          </form>
          {formActions(fid, 'Save everything')}
        </div>
      );
    };

    /** Opens the card's <dialog> popup; preventDefault stops the details toggle. */
    const pencilBtn = (dlgId: string, titleTxt: string) => (
      <button type="button" class="pencil" title={titleTxt}
        onclick={`event.preventDefault(); event.stopPropagation(); document.getElementById('${dlgId}').showModal()`}>✏️</button>
    );

    const anchorCard = (a: AnchorOpt) => {
      const isProject = a.kind === 'project';
      const section = isProject ? 'projects' : 'experience';
      const bl = rows.filter((r) => r.anchor_id === a.id && r.section === section);
      const dates = isProject ? '' : fmtDates(a.date_from, a.date_to);
      const dlgId = `dlg-role-${a.id}`;
      return (
        <>
          <details class="rc">
            <summary class="rc-head">
              <span class="caret" />
              <span class="rc-title">{a.title ?? a.company ?? a.id}</span>
              {!isProject && a.title && a.company ? <span class="rc-sub">{a.company}</span> : null}
              {dates ? <span class="rc-dates">{dates}</span> : null}
              <span class="rc-meta">{bl.length} bullets · <span class="chip">{a.id}</span>
                {pencilBtn(dlgId, isProject ? 'Edit everything in this project' : 'Edit everything in this role')}
              </span>
            </summary>
            <div class="rc-body">
              {bl.length ? bl.map(readRow) : <p class="muted">no bullets yet — ✏️ to add</p>}
            </div>
          </details>
          <dialog id={dlgId}>{isProject ? projectForm(a, bl) : roleForm(a, bl)}</dialog>
        </>
      );
    };

    const groupCard = (key: string, title: string, items: Array<Record<string, string | null>>, hidden: Record<string, string>, sub?: string) => {
      const dlgId = `dlg-group-${key}`;
      return (
        <>
          <details class="rc">
            <summary class="rc-head">
              <span class="caret" />
              <span class="rc-title cap">{title}</span>
              {sub ? <span class="rc-sub">{sub}</span> : null}
              <span class="rc-meta">{items.length} items
                {pencilBtn(dlgId, 'Edit all items')}
              </span>
            </summary>
            <div class="rc-body">
              {items.length ? items.map(readRow) : <p class="muted">none yet — ✏️ to add</p>}
            </div>
          </details>
          <dialog id={dlgId}>{groupForm(key, items, hidden)}</dialog>
        </>
      );
    };

    const bankJs = `
(() => {
  let k = 0;
  document.querySelectorAll('.addbullet').forEach((btn) => btn.addEventListener('click', () => {
    const pane = btn.closest('form');
    const tpl = pane.querySelector('template.btpl');
    const list = pane.querySelector('.blist');
    const frag = tpl.content.cloneNode(true);
    k += 1;
    frag.querySelectorAll('[name]').forEach((el) => { el.name = el.name.replace('__K__', 'k' + k); });
    list.appendChild(frag);
  }));
  document.addEventListener('click', (e) => {
    const b = e.target.closest('.bdel'); if (!b) return;
    const box = b.closest('.bbox');
    const del = box.querySelector('input.delflag');
    if (del) {
      del.value = '1';
      box.querySelectorAll('textarea').forEach((t) => { t.disabled = true; });
      box.hidden = true;
    } else box.remove();
  });
  // Textareas follow their text (fallback for browsers without field-sizing).
  const grow = (t) => { t.style.height = 'auto'; t.style.height = t.scrollHeight + 'px'; };
  document.addEventListener('input', (e) => { if (e.target.classList.contains('bank-ta')) grow(e.target); });
  // On dialog open, size every prefilled textarea to its content.
  document.querySelectorAll('dialog').forEach((d) => d.addEventListener('close', () => {}));
  const sizeAll = (root) => root.querySelectorAll('textarea.bank-ta').forEach(grow);
  document.querySelectorAll('.pencil, [onclick*="showModal"]').forEach((btn) => btn.addEventListener('click', () => {
    setTimeout(() => document.querySelectorAll('dialog[open]').forEach(sizeAll), 0);
  }));
  // A failed save redirects with ?reopen=<dialog id>: reopen it, message visible.
  const rp = new URLSearchParams(location.search).get('reopen');
  if (rp) { const d = document.getElementById(rp); if (d && d.showModal) { d.showModal(); sizeAll(d); } }
})();`;

    const openDlg = (id: string, label: string) => (
      <button type="button" class="btnlike sec" onclick={`document.getElementById('${id}').showModal()`}>＋ {label}</button>
    );

    return page(c, 'Blocks Bank', (
      <>
        <div class="actions mb-4">
          <span><strong>{rows.length}</strong> <span class="muted">bullets</span> · <strong>{roleCount}</strong> <span class="muted">roles</span></span>
          <a href="/blocks_bank/template-check">Check template ↗</a>
        </div>

        <details class="sect" open>
          <summary>My summary</summary>
          {groupCard('sum', 'Summary',
            rows.filter((r) => r.section === 'summary'),
            { section: 'summary' },
            'the opening bullets of every CV — the AI picks the best ones per job')}
        </details>

        <details class="sect" open>
          <summary>My skills</summary>
          {SKCATS.map((cat) =>
            groupCard(`skl-${cat}`, cat,
              rows.filter((r) => r.section === 'skills' && r.skcat === cat),
              { section: 'skills', skcat: cat }))}
        </details>

        <details class="sect" open>
          <summary>My roles</summary>
          <p class="muted mt-3 mb-1">newest first · tap a card to read · ✏️ edits everything</p>
          <div class="actions mb-1">{openDlg('dlg-addrole', 'Add role')}</div>
          {anchors.filter((a) => a.kind === 'role').map(anchorCard)}
        </details>

        <details class="sect" open>
          <summary>My projects</summary>
          <p class="muted mt-3 mb-1">static text in the CV template for now — bullets kept for the future project-tailoring option</p>
          <div class="actions mb-1">{openDlg('dlg-addproject', 'Add project')}</div>
          {anchors.filter((a) => a.kind === 'project').map(anchorCard)}
        </details>

        <dialog id="dlg-addrole">{roleForm(null, [])}</dialog>
        <dialog id="dlg-addproject">{projectForm(null, [])}</dialog>

        <script dangerouslySetInnerHTML={{ __html: bankJs }} />
      </>
    ));
  });

  /** Bullet statements shared by the role/group saves (one transaction). */
  const bulletStmts = (
    env: ConsoleEnv,
    edits: { updates: Array<{ id: string; en: string; es: string }>; deletes: string[]; added: Array<{ en: string; es: string }> },
    insert: { section: string; anchor_id: string | null; skcat: string | null },
  ) => {
    const ts = now();
    return [
      ...edits.updates.map((u) =>
        env.DB.prepare(
          "UPDATE blocks SET text_en=?, text_es=?, status='approved', es_status='approved', updated_at=? WHERE id=?",
        ).bind(u.en, u.es, ts, u.id)),
      ...edits.deletes.map((id) => env.DB.prepare('DELETE FROM blocks WHERE id=?').bind(id)),
      ...edits.added.map((n) =>
        env.DB.prepare(
          `INSERT INTO blocks (id, section, anchor_id, skcat, text_en, text_es, es_status, tags, status, updated_at)
           VALUES (?,?,?,?,?,?,'approved','','approved',?)`,
        ).bind(newBlockId(insert.section), insert.section, insert.anchor_id, insert.skcat, n.en, n.es, ts)),
    ];
  };

  // Skills category / summary: ONE save for all the group's items.
  app.post('/blocks_bank/group-save', async (c) => {
    const b = await c.req.parseBody();
    const section = String(b.section ?? '');
    const skcat = String(b.skcat ?? '') || null;
    if (section === 'skills' ? !skcat || !(SKCATS as readonly string[]).includes(skcat) : section !== 'summary') {
      return c.redirect('/blocks_bank?m=invalid group');
    }
    const key = section === 'summary' ? 'sum' : `skl-${skcat}`;
    const edits = parseBulletEdits(b);
    if ('error' in edits) return c.redirect(`/blocks_bank?reopen=dlg-group-${key}&m=${encodeURIComponent(`save failed: ${edits.error}`)}`);
    try {
      const stmts = bulletStmts(c.env, edits, { section, anchor_id: null, skcat });
      if (stmts.length) await c.env.DB.batch(stmts);
    } catch (err) {
      return c.redirect(`/blocks_bank?reopen=dlg-group-${key}&m=${encodeURIComponent(`save failed: ${err instanceof Error ? err.message : 'db error'}`)}`);
    }
    return c.redirect('/blocks_bank?m=saved');
  });

  // ---------- Roles (anchors) — the missing write path (2026-07-18) ----------
  // Create a role/project WITH its bullets in one submit (owner's sketch).
  app.post('/roles/create', async (c) => {
    const b = await c.req.parseBody();
    const code = String(b.code ?? '').trim().toUpperCase();
    const kind = String(b.kind ?? 'role') === 'project' ? 'project' : 'role';
    const isProject = kind === 'project';
    const title = String(b.title ?? '').trim() || null;
    // Projects carry no employment semantics: no company, no dates.
    const company = isProject ? null : (String(b.company ?? '').trim() || null);
    const dateFrom = isProject ? null : normalizeMonth(String(b.date_from ?? ''));
    // "I currently work here" wins over any stale To value.
    const dateTo = isProject || b.current != null ? null : normalizeMonth(String(b.date_to ?? ''));
    const reopen = isProject ? 'dlg-addproject' : 'dlg-addrole';
    if (isProject ? !title : !company) {
      return c.redirect(`/blocks_bank?reopen=${reopen}&m=add ${kind} failed: ${isProject ? 'project name' : 'company/name'} is required`);
    }
    const edits = parseBulletEdits(b);
    if ('error' in edits) return c.redirect(`/blocks_bank?reopen=${reopen}&m=${encodeURIComponent(`add ${kind} failed: ${edits.error}`)}`);
    const existing = ((await c.env.DB.prepare('SELECT id FROM anchors').all<{ id: string }>()).results).map((a) => a.id);
    const err = validateRoleCode(code, existing);
    if (err) return c.redirect(`/blocks_bank?reopen=${reopen}&m=${encodeURIComponent(`add ${kind} failed: ${err}`)}`);
    const section = isProject ? 'projects' : 'experience';
    await c.env.DB.batch([
      c.env.DB.prepare(
        "INSERT INTO anchors (id, kind, company, title, date_from, date_to, status) VALUES (?,?,?,?,?,?,'active')",
      ).bind(code, kind, company, title, dateFrom, dateTo),
      ...bulletStmts(c.env, edits, { section, anchor_id: code, skcat: null }),
    ]);
    return c.redirect(`/blocks_bank?m=${encodeURIComponent(
      `${kind} ${code} added — now paste {{${code}R1}}, {{${code}R2}}, … lines into your CV template Doc (with its static header) and run Check template`,
    )}`);
  });

  // ONE save for the whole role: its fields AND all its bullets (edits,
  // deletions, additions) in a single transaction.
  app.post('/roles/save', async (c) => {
    const b = await c.req.parseBody();
    const id = String(b.id ?? '');
    const title = String(b.title ?? '').trim() || null;
    const newCode = String(b.new_code ?? '').trim().toUpperCase();
    const row = await c.env.DB.prepare('SELECT id, kind, company FROM anchors WHERE id = ?')
      .bind(id).first<{ id: string; kind: string; company: string | null }>();
    if (!row) return c.redirect('/blocks_bank?m=role not found');
    const isProject = row.kind === 'project';
    // Projects carry no employment semantics: company/dates stay null.
    const company = isProject ? null : (String(b.company ?? '').trim() || row.company);
    const dateFrom = isProject ? null : normalizeMonth(String(b.date_from ?? ''));
    // "I currently work here" wins over any stale To value.
    const dateTo = isProject || b.current != null ? null : normalizeMonth(String(b.date_to ?? ''));
    const edits = parseBulletEdits(b);
    if ('error' in edits) return c.redirect(`/blocks_bank?reopen=dlg-role-${encodeURIComponent(id)}&m=${encodeURIComponent(`save failed: ${edits.error}`)}`);
    const renaming = !!newCode && newCode !== id;
    if (renaming) {
      // CODE rename: template-coupled. Refuse while {{OLD…}} tokens remain in
      // the Doc; abort on any Google failure (never rename blind).
      const existing = ((await c.env.DB.prepare('SELECT id FROM anchors WHERE id != ?').bind(id).all<{ id: string }>()).results).map((a) => a.id);
      const err = validateRoleCode(newCode, existing);
      if (err) return c.redirect(`/blocks_bank?reopen=dlg-role-${encodeURIComponent(id)}&m=${encodeURIComponent(`rename failed: ${err}`)}`);
      try {
        if (!c.env.CV_TEMPLATE_DOC_ID) throw new Error('CV_TEMPLATE_DOC_ID not configured');
        const { googleAccessToken, readPlaceholders } = await import('../gdocs');
        const token = await googleAccessToken(c.env);
        const docTokens = await readPlaceholders(token, c.env.CV_TEMPLATE_DOC_ID);
        const leftovers = tokensOfRole(id, docTokens.map((t) => t.name));
        if (leftovers.length) {
          return c.redirect(`/blocks_bank?reopen=dlg-role-${encodeURIComponent(id)}&m=${encodeURIComponent(
            `rename refused: the template still contains ${leftovers.slice(0, 3).join(', ')}${leftovers.length > 3 ? '…' : ''} — update the Doc to {{${newCode}R…}} first`,
          )}`);
        }
      } catch (err2) {
        return c.redirect(`/blocks_bank?reopen=dlg-role-${encodeURIComponent(id)}&m=${encodeURIComponent(
          `rename aborted (cannot verify the template): ${err2 instanceof Error ? err2.message : 'Google unreachable'}`,
        )}`);
      }
    }
    const finalCode = renaming ? newCode : id;
    const section = isProject ? 'projects' : 'experience';
    await c.env.DB.batch([
      ...(renaming
        ? [
            c.env.DB.prepare(
              "INSERT INTO anchors (id, kind, company, title, date_from, date_to, status) VALUES (?,?,?,?,?,?,'active')",
            ).bind(newCode, row.kind, company, title, dateFrom, dateTo),
            c.env.DB.prepare('UPDATE blocks SET anchor_id = ? WHERE anchor_id = ?').bind(newCode, id),
          ]
        : [
            c.env.DB.prepare('UPDATE anchors SET company = ?, title = ?, date_from = ?, date_to = ? WHERE id = ?')
              .bind(company, title, dateFrom, dateTo, id),
          ]),
      ...bulletStmts(c.env, edits, { section, anchor_id: finalCode, skcat: null }),
      ...(renaming ? [c.env.DB.prepare('DELETE FROM anchors WHERE id = ?').bind(id)] : []),
    ]);
    return c.redirect(`/blocks_bank?m=${encodeURIComponent(renaming ? `saved — role renamed ${id} → ${newCode}` : 'saved')}`);
  });

  // Hard delete, LinkedIn-style (owner decision 2026-07-18): the role AND its
  // bullets go, permanently. The confirm dialog names both consequences.
  app.post('/roles/delete', async (c) => {
    const b = await c.req.parseBody();
    const id = String(b.id ?? '');
    if (!id) return c.redirect('/blocks_bank?m=role not found');
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM blocks WHERE anchor_id = ?').bind(id),
      c.env.DB.prepare('DELETE FROM anchors WHERE id = ?').bind(id),
    ]);
    return c.redirect(`/blocks_bank?m=${encodeURIComponent(
      `role ${id} and its bullets deleted — remove its {{${id}R…}} lines from the CV template Doc and run Check template`,
    )}`);
  });

  // ---------- Check template: Blocks Bank ↔ Google Doc contract, both directions ----------
  app.get('/blocks_bank/template-check', async (c) => {
    const { checkTemplate } = await import('./template-check');
    const roles = (
      await c.env.DB.prepare(
        `SELECT a.id, COUNT(b.id) bullets, SUM(CASE WHEN b.status='approved' THEN 1 ELSE 0 END) approved
         FROM anchors a LEFT JOIN blocks b ON b.anchor_id = a.id AND b.section = 'experience'
         WHERE a.kind = 'role' AND a.status = 'active' GROUP BY a.id ORDER BY a.id`,
      ).all<{ id: string; bullets: number; approved: number }>()
    ).results.map((r) => ({ id: r.id, bullets: Number(r.bullets), approved: Number(r.approved ?? 0) }));
    const catRows = (
      await c.env.DB.prepare(
        "SELECT skcat, COUNT(*) n FROM blocks WHERE section='skills' AND skcat IS NOT NULL GROUP BY skcat",
      ).all<{ skcat: string; n: number }>()
    ).results;
    const skillCats: Record<string, number> = { technical: 0, methodologies: 0, academic: 0, emerging: 0 };
    for (const r of catRows) skillCats[r.skcat] = Number(r.n);
    const summary = await c.env.DB.prepare("SELECT COUNT(*) n FROM blocks WHERE section='summary'").first<{ n: number }>();

    let findings;
    let tokenCount = 0;
    try {
      if (!c.env.CV_TEMPLATE_DOC_ID) throw new Error('CV_TEMPLATE_DOC_ID not configured');
      const { googleAccessToken, readPlaceholders } = await import('../gdocs');
      const token = await googleAccessToken(c.env);
      const docTokens = await readPlaceholders(token, c.env.CV_TEMPLATE_DOC_ID);
      tokenCount = docTokens.length;
      findings = checkTemplate(docTokens, { roles, skillCats, summaryCount: summary?.n ?? 0 });
    } catch (err) {
      findings = [{
        level: 'error' as const,
        text: `cannot read the template Doc: ${err instanceof Error ? err.message : 'Google unreachable'} — is it shared with the service account?`,
      }];
    }
    const cls = { error: 'bad', warn: 'warn', ok: 'ok' } as const;
    return page(c, 'Check template', (
      <>
        <div class="card">
          <p>Compared your CV template Doc ({tokenCount} tokens) against Blocks Bank ({roles.length} active roles). <a href="/blocks_bank">← back to Blocks Bank</a></p>
        </div>
        <div class="card">
          {findings.map((f) => <div class={`${cls[f.level]} py-1`}>{f.level === 'ok' ? '✓' : f.level === 'warn' ? '⚠' : '✗'} {f.text}</div>)}
        </div>
      </>
    ));
  });

  // ---------- CVs ----------
  app.get('/cvs', async (c) => {
    const pg = pageNum(c);
    const cvs = (
      await c.env.DB.prepare(
        `SELECT v.id, v.doc_url, v.lang, v.sample, v.pending, v.created_at, v.rationale, v.verifier_notes,
                j.title, co.name company
         FROM cvs v JOIN jobs j ON j.url_hash = v.url_hash JOIN companies co ON co.id = j.company_id
         ORDER BY v.id DESC LIMIT ${PAGE + 1} OFFSET ${pg * PAGE}`,
      ).all<Record<string, string | number | null>>()
    ).results;
    const hasNext = cvs.length > PAGE;
    if (hasNext) cvs.pop();
    const total = (await c.env.DB.prepare(
      'SELECT COUNT(*) n FROM cvs v JOIN jobs j ON j.url_hash = v.url_hash JOIN companies co ON co.id = j.company_id',
    ).first<{ n: number }>())?.n ?? 0;
    const contactSet = await c.env.DB.prepare("SELECT 1 FROM config WHERE key='contact_profile'").first();
    return page(c, 'CV library', (
      <>
        {!contactSet ? (
          <div class="card bd-warn">
            ⚠️ No contact profile set — generated CVs will have empty phone/location.{' '}
            <a href="/contact">Set it now →</a>
          </div>
        ) : null}
        <div class="card actions">
          <span class="muted">To generate a CV, open the job (Overview or Jobs) and tap <strong>Prepare</strong> there.</span>
          <a href="/blocks_bank/template-check">Check template ↗</a>
        </div>
        {cvs.length === 0 ? <div class="card"><p>No CVs generated yet.</p></div> : (
          <div class="table-wrap"><table>
            <tr><th>#</th><th>job</th><th>language</th><th>type</th><th>doc</th><th>selection</th><th>verifier tweaks</th><th>date</th></tr>
            {cvs.map((v) => (
              <tr>
                <td>{v.id}</td>
                <td>{v.title} <div class="muted">{v.company}</div></td>
                <td>{v.lang}</td>
                <td>{v.sample ? <span class="warn">SAMPLE</span> : <span class="ok">real</span>}</td>
                <td><a href={String(v.doc_url)} target="_blank" rel="noreferrer">open Doc ↗</a></td>
                <td class="muted">{String(v.rationale ?? '').slice(0, 80)}</td>
                <td class="muted">{String(v.verifier_notes ?? '').slice(0, 80)}</td>
                <td class="muted">{fmt(String(v.created_at))}</td>
              </tr>
            ))}
          </table></div>
        )}
        {pager('/cvs', pg, hasNext, total, {})}
      </>
    ));
  });

  // (CV is built by Prepare — POST /jobs/:hash/prepare, blocking, on the spot; the
  // cron CV-factory only retries failed builds via cv_pending. No manual queue route.)

  // ---------- Applications (step 8: kit queue + Q&A) ----------
  // ---------- Q&A (Setup): approved answers reused across kits ----------
  app.get('/qa', async (c) => {
    const answersBank = (
      await c.env.DB.prepare(
        'SELECT id, question_label, answer_en, status FROM profile_answers ORDER BY status, question_label LIMIT 200',
      ).all<Record<string, string | number | null>>()
    ).results;
    // Question census: which unanswered questions recur across all built kits.
    const kits = (
      await c.env.DB.prepare('SELECT red_questions FROM application_kits').all<{ red_questions: string | null }>()
    ).results;
    const census = new Map<string, number>();
    for (const k of kits) {
      try { for (const q of JSON.parse(String(k.red_questions ?? '[]')) as string[]) census.set(q, (census.get(q) ?? 0) + 1); }
      catch { /* bad json */ }
    }
    const censusTop = [...census.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);

    return page(c, 'Q&A', (
      <>
        <p class="muted">Approved answers are matched into every application kit automatically. EEOC/demographic questions are never auto-answered. Each job's kit lives on its <a href="/jobs">job page</a>.</p>
        {censusTop.length ? (
          <>
            <h2>Recurring unanswered questions</h2>
            <div class="card">
              {censusTop.map(([q, n]) => <div class="bullet"><span class="chip">{n}×</span> {q}</div>)}
              <p class="muted">Add an answer once below — every future kit matches it automatically.</p>
            </div>
          </>
        ) : null}
        <h2>Q&A ({answersBank.length})</h2>
        <div class="card">
          <form method="post" action="/qa/add">
            <div class="field"><label>Question (as forms ask it)</label><input type="text" name="label" required /></div>
            <div class="field"><label>Your answer</label><textarea name="answer" required /></div>
            <div class="actions"><button type="submit" class="primary">Add as draft</button></div>
          </form>
        </div>
        {answersBank.map((a) => (
          <div class="card">
            <div class="muted">{a.question_label}</div>
            <div>{a.answer_en}</div>
            <div class="actions mt-3">
              <span class={`pill ${a.status === 'approved' ? 'approved' : 'draft'}`}>{a.status}</span>
              {a.status !== 'approved' ? (
                <form class="inline" method="post" action="/qa/approve">
                  <input type="hidden" name="id" value={String(a.id)} />
                  <button type="submit" class="primary">Approve</button>
                </form>
              ) : null}
              <form class="inline" method="post" action="/qa/delete"
                onsubmit="return confirm('Delete this answer permanently?')">
                <input type="hidden" name="id" value={String(a.id)} />
                <button type="submit">Delete</button>
              </form>
            </div>
          </div>
        ))}
      </>
    ));
  });

  app.post('/jobs/:hash/kit', async (c) => {
    const hash = c.req.param('hash');
    const { buildKit } = await import('../kit/kit');
    const r = await buildKit(c.env, hash);
    const msg = r.ok
      ? (r.detectable
        ? `kit built: ${r.matched} matched · ${r.red} red · ${r.eeoc} EEOC-flagged`
        : `kit built (this ATS does not expose its form publicly — open the form to see the questions)${r.error ? ` · ${r.error}` : ''}`)
      : `kit failed: ${r.error}`;
    return c.redirect(`/jobs/${hash}?m=${encodeURIComponent(msg)}`);
  });

  // answer_polisher: suggest job-tailored versions of the matched answers (on-demand,
  // stored on the kit; SUGGESTIONS the owner uses when filling THIS form — never the bank).
  app.post('/jobs/:hash/polish', async (c) => {
    const hash = c.req.param('hash');
    const { polishAnswers } = await import('../kit/kit');
    const r = await polishAnswers(c.env, hash);
    const msg = r.ok
      ? (r.count ? `${r.count} tailored suggestion(s) ready — review them below` : 'no matched answers to polish yet')
      : `polish failed: ${r.error}`;
    return c.redirect(`/jobs/${hash}?m=${encodeURIComponent(msg)}`);
  });

  app.post('/qa/add', async (c) => {
    const b = await c.req.parseBody();
    const label = String(b.label ?? '').trim();
    const answer = String(b.answer ?? '').trim();
    if (!label || !answer) return c.redirect('/qa?m=question and answer are required');
    const { normalizeQuestion } = await import('../kit/questions');
    await c.env.DB.prepare(
      `INSERT INTO profile_answers (question_norm, question_label, answer_en, status, updated_at)
       VALUES (?,?,?,'draft',?)
       ON CONFLICT(question_norm) DO UPDATE SET question_label=excluded.question_label,
         answer_en=excluded.answer_en, status='draft', updated_at=excluded.updated_at`,
    ).bind(normalizeQuestion(label), label, answer, now()).run();
    return c.redirect('/qa?m=answer saved as draft — approve it to use in kits');
  });

  app.post('/qa/approve', async (c) => {
    const b = await c.req.parseBody();
    await c.env.DB.prepare("UPDATE profile_answers SET status='approved', updated_at=? WHERE id=?")
      .bind(now(), Number(b.id)).run();
    return c.redirect('/qa?m=answer approved');
  });

  app.post('/qa/delete', async (c) => {
    const b = await c.req.parseBody();
    await c.env.DB.prepare('DELETE FROM profile_answers WHERE id=?').bind(Number(b.id)).run();
    return c.redirect('/qa?m=answer deleted');
  });

  // ---------- Intelligence (IA: live enrichment pipeline · ML: roadmap card, not built) ----------
  app.get('/intelligence', async (c) => {
    const enabled = !!c.env.GEMINI_API_KEY;
    const calls = await c.env.DB.prepare(
      "SELECT COALESCE(SUM(gemini_calls),0) n FROM runs WHERE started_at >= datetime('now','-7 days')",
    ).first<{ n: number }>();
    const prov = (
      await c.env.DB.prepare(
        "SELECT COALESCE(enriched_by,'(legacy)') src, COUNT(*) n FROM jobs GROUP BY COALESCE(enriched_by,'(legacy)') ORDER BY n DESC",
      ).all<{ src: string; n: number }>()
    ).results;
    const aiEvents = (
      await c.env.DB.prepare(
        "SELECT ts, type, severity, url_hash, detail FROM events WHERE type IN ('gemini_fail','gemini_fallback','gdocs_fail') ORDER BY id DESC LIMIT 20",
      ).all<Record<string, string | null>>()
    ).results;

    const IA_PIPELINE: Array<{ agent: string; when: string; model: string; out: string }> = [
      { agent: 'job_analyst', when: 'at notify', model: 'gemini-3.5-flash → 3.1-flash-lite', out: 'structured role analysis (must-haves, seniority, positioning) — understood once, reused downstream' },
      { agent: 'enricher', when: 'at notify', model: 'gemini-3.1-flash-lite → 2.5-flash-lite', out: 'why-it-fits / gap / positioning wording — never verdicts or gates' },
      { agent: 'cv_selector', when: 'CV build (Prepare)', model: 'gemini-3.5-flash → 3.1-flash-lite', out: 'selects approved block IDs only (enum-forced — no free text)' },
      { agent: 'cv_verifier', when: 'CV build (Prepare)', model: 'gemini-3.5-flash → 2.5-flash', out: '0-5 tweak suggestions — never edits the CV' },
      { agent: 'answer_polisher', when: 'on demand (kit)', model: 'gemini-3.5-flash → 3.1-flash-lite', out: 'tailors approved Q&A answers — suggestions only, EEOC never touched' },
    ];

    return page(c, 'Intelligence', (
      <>
        <div class="card">
          <h2>ML — role-signal model <span class="muted">(roadmap · not built)</span></h2>
          <p class="muted my-1">The job market is an attention market — the edge is knowing which words employers reward. A future statistical model would learn that from outcomes (survivor / applied signals) and feed calibration automatically, instead of hand-tuning weights.</p>
          <p class="muted my-1">This does not exist yet. Scoring today is 100% hand-tuned keyword weights + gates (see <a href="/calibration">Calibration</a>); the IA below is what actually runs. This card is a placeholder for the roadmap.</p>
        </div>
        <div class="card">
          <h2>IA — live enrichment pipeline</h2>
          <div class="kv">
            <div><span class="k">Enricher:</span>{enabled ? <span class="ok">enabled</span> : <span class="warn">disabled (no GEMINI_API_KEY)</span>}</div>
            <div><span class="k">Gemini calls (7d):</span>{calls?.n ?? 0}</div>
          </div>
          <p class="muted mt-2">Five Gemini agents, all forced-JSON with retry + model fallback. They enrich and assist — they never set verdicts, gates, or write CV / answer content.</p>
          <div class="table-wrap"><table>
            <tr><th>agent</th><th>runs</th><th>model (primary → fallback)</th><th>output</th></tr>
            {IA_PIPELINE.map((a) => (
              <tr><td>{a.agent}</td><td class="muted">{a.when}</td><td class="muted">{a.model}</td><td>{a.out}</td></tr>
            ))}
          </table></div>
          <p class="muted mt-2">Provenance of stored jobs — who wrote the why-it-fits / positioning text:</p>
          <div class="actions">{prov.map((p) => <span class="chip">{p.src}: {p.n}</span>)}</div>
        </div>
        <div class="card">
          <h2>Recent AI events</h2>
          {aiEvents.length === 0 ? <p class="muted">no Gemini or CV-build failures recorded</p> : (
            <div class="table-wrap"><table>
              <tr><th>when</th><th>type</th><th>job</th><th>detail</th></tr>
              {aiEvents.map((e) => (
                <tr>
                  <td class="muted">{fmt(String(e.ts))}</td>
                  <td class={e.severity === 'warn' ? 'warn' : ''}>{e.type}</td>
                  <td>{e.url_hash ? <a href={`/jobs/${e.url_hash}`}>open</a> : '—'}</td>
                  <td class="muted">{e.detail}</td>
                </tr>
              ))}
            </table></div>
          )}
        </div>
      </>
    ));
  });

  // ---------- Health ----------
  app.get('/health', async (c) => {
    const pg = pageNum(c);
    const runs = (
      await c.env.DB.prepare(
        `SELECT id, started_at, status, trigger, duration_ms, companies_ok, companies_fail, jobs_seen, jobs_new, survivors, notified, closed, subrequests, d1_reads, d1_writes, errors FROM runs ORDER BY id DESC LIMIT ${PAGE + 1} OFFSET ${pg * PAGE}`,
      ).all<Record<string, string | number | null>>()
    ).results;
    const runsHasNext = runs.length > PAGE;
    if (runsHasNext) runs.pop();
    const runsTotal = (await c.env.DB.prepare('SELECT COUNT(*) n FROM runs').first<{ n: number }>())?.n ?? 0;
    const events = (
      await c.env.DB.prepare(
        'SELECT ts, type, severity, detail FROM events ORDER BY id DESC LIMIT 30',
      ).all<Record<string, string>>()
    ).results;
    const today = await c.env.DB.prepare(
      "SELECT MAX(subrequests) peak_subreq, SUM(d1_reads) reads, SUM(d1_writes) writes, COUNT(*) runs FROM runs WHERE date(started_at) = date('now')",
    ).first<{ peak_subreq: number; reads: number; writes: number; runs: number }>();

    const { DEFAULT_SCHEDULE, SCHEDULE_TIMEZONES, nextRunAfter, normalizeSchedule } = await import('../schedule');
    const schedRow = await c.env.DB.prepare("SELECT value FROM config WHERE key='schedule'").first<{ value: string }>();
    let schedRaw: unknown = null;
    try { if (schedRow) schedRaw = JSON.parse(schedRow.value); } catch { /* defaults */ }
    const sched = normalizeSchedule(schedRaw ?? DEFAULT_SCHEDULE);
    const activeCompanies = (await c.env.DB.prepare('SELECT COUNT(*) n FROM companies WHERE active = 1').first<{ n: number }>())?.n ?? 0;
    const batchesNeeded = Math.max(1, Math.ceil(activeCompanies / 25));
    const lastRun = runs[0]?.started_at ? fmt(String(runs[0].started_at)) : '—';
    const next = nextRunAfter(new Date(), sched, batchesNeeded);
    // On-demand burst counter (batches still to run), set by "Start burst".
    const forceBurst = Math.max(0, Number(
      (await c.env.DB.prepare("SELECT value FROM config WHERE key='force_burst'").first<{ value: string }>())?.value ?? '0',
    ) || 0);

    return page(c, 'Health', (
      <>
        <div class="statgrid">
          <div class="stat"><div class="n">{today?.runs ?? 0}</div><div class="l">runs today</div></div>
          <div class="stat"><div class="n">{today?.peak_subreq ?? 0}/50</div><div class="l">peak subrequests</div></div>
          <div class="stat"><div class="n">{today?.writes ?? 0}</div><div class="l">D1 writes today (limit 100k)</div></div>
          <div class="stat"><div class="n">{today?.reads ?? 0}</div><div class="l">D1 reads today (limit 5M)</div></div>
        </div>
        <form method="post" action="/health/schedule" class="card actions">
          <strong>Schedule (bursts)</strong>
          <label>burst hours{' '}
            <input type="text" name="burst_hours" value={sched.burst_hours.join(', ')} placeholder="7, 17" class="w-md" />
          </label>
          <label>batch every{' '}
            <select name="batch_every_min">
              {[15, 20, 30].map((m) => <option value={String(m)} selected={m === sched.batch_every_min}>{m}m</option>)}
            </select>
          </label>
          <select name="timezone">
            {SCHEDULE_TIMEZONES.map((tz) => <option value={tz} selected={tz === sched.timezone}>{tz}</option>)}
          </select>
          <button type="submit" class="primary">Save schedule</button>
          <span class="muted">
            last run {lastRun} · next {next ? fmt(next.toISOString()) : '—'} ·
            {' '}covers {activeCompanies} companies in {batchesNeeded} batch(es)/burst
          </span>
        </form>
        <form method="post" action="/health/run" class="card actions" data-burst>
          <strong>Manual burst</strong>
          {forceBurst > 0 ? (
            <>
              <span>⏳ Burst in progress — {forceBurst} batch(es) left · next in ≤{sched.batch_every_min} min</span>
              <button type="submit" formAction="/health/run-cancel">Cancel</button>
            </>
          ) : (
            <>
              <button type="submit" class="primary">▶ Start burst</button>
              <span class="muted">runs all active companies now, in batches; completes on its own.</span>
            </>
          )}
        </form>
        <script dangerouslySetInnerHTML={{ __html:
          "(function(){var f=document.querySelector('form[data-burst]');if(!f)return;" +
          "f.addEventListener('submit',function(e){var b=e.submitter||f.querySelector('button[type=submit]');" +
          "if(b){b.disabled=true;if(b.classList.contains('primary'))b.textContent='\\u23f3 Working\\u2026';}});})();"
        }} />
        <div class="table-wrap"><table>
          <tr><th>run</th><th>start</th><th>status</th><th class="hide-sm">ms</th><th>companies</th><th class="hide-sm">seen</th><th class="hide-sm">new</th><th>surv.</th><th>notif.</th><th class="hide-sm">closed</th><th class="hide-sm">subreq</th><th>errors</th></tr>
          {runs.map((r) => (
            <tr>
              <td>{r.id} <span class="muted">{r.trigger}</span></td>
              <td class="muted">{fmt(String(r.started_at))}</td>
              <td class={r.status === 'ok' ? 'ok' : r.status === 'running' ? 'muted' : 'bad'}>{r.status}</td>
              <td class="hide-sm">{r.duration_ms ?? '—'}</td>
              <td>{r.companies_ok}/{Number(r.companies_ok) + Number(r.companies_fail)}</td>
              <td class="hide-sm">{r.jobs_seen}</td><td class="hide-sm">{r.jobs_new}</td><td>{r.survivors}</td>
              <td>{r.notified}</td><td class="hide-sm">{r.closed}</td><td class="hide-sm">{r.subrequests}</td>
              <td class={Number(r.errors) > 0 ? 'bad' : ''}>{r.errors}</td>
            </tr>
          ))}
        </table></div>
        {pager('/health', pg, runsHasNext, runsTotal, {})}
        <h2>Recent events</h2>
        {events.length === 0 ? <p class="muted">no events</p> : (
          <div class="table-wrap"><table>{events.map((e) => (
            <tr><td class="muted">{fmt(e.ts)}</td><td class={e.severity === 'error' ? 'bad' : e.severity === 'warn' ? 'warn' : ''}>{e.type}</td><td class="muted">{e.detail}</td></tr>
          ))}</table></div>
        )}
      </>
    ));
  });

  app.post('/health/schedule', async (c) => {
    const b = await c.req.parseBody();
    const { normalizeSchedule } = await import('../schedule');
    const burst_hours = String(b.burst_hours ?? '')
      .split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
    const sched = normalizeSchedule({
      burst_hours, batch_every_min: Number(b.batch_every_min), timezone: String(b.timezone ?? ''),
    });
    await c.env.DB.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('schedule', ?)")
      .bind(JSON.stringify(sched)).run();
    return c.redirect(`/health?m=${encodeURIComponent(
      `schedule saved: bursts at ${sched.burst_hours.map((h) => h + ':00').join(', ')} every ${sched.batch_every_min}m (${sched.timezone})`,
    )}`);
  });

  // "Start burst": run batch 1 NOW (one page, foreground) + queue the rest via force_burst;
  // the cron finishes the rotation over its ticks (one page each, respecting the subrequest cap).
  app.post('/health/run', async (c) => {
    const [countRow, pageRow] = await Promise.all([
      c.env.DB.prepare('SELECT COUNT(*) n FROM companies WHERE active = 1').first<{ n: number }>(),
      c.env.DB.prepare("SELECT value FROM config WHERE key='poll_page_size'").first<{ value: string }>(),
    ]);
    const pageSize = Math.max(1, Number(pageRow?.value ?? '25') || 25);
    const batchesNeeded = Math.max(1, Math.ceil((countRow?.n ?? 0) / pageSize));
    // Non-blocking: just QUEUE the burst (force_burst = N batches). The cron runs one page per
    // tick until it hits 0. We do NOT run the pipeline in this request — a blocking run can be
    // cut before it returns, leaving the click with no redirect/feedback. Redirect instantly;
    // the "⏳ Burst in progress" state renders on the reload.
    await c.env.DB.prepare("INSERT INTO config (key, value) VALUES ('force_burst', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind(String(batchesNeeded)).run();
    return c.redirect(`/health?m=${encodeURIComponent(`burst started: ${batchesNeeded} batch(es) queued`)}`);
  });

  app.post('/health/run-cancel', async (c) => {
    await c.env.DB.prepare("DELETE FROM config WHERE key='force_burst'").run();
    return c.redirect(`/health?m=${encodeURIComponent('burst canceled')}`);
  });

  return app;
}

// Console v1 (UI.md §2): Today (triage), Jobs, Companies, Calibration, Health.
// Pure server-rendered: every mutation is a real <form>. htmx arrives in v2.

import { Hono, type Context } from 'hono';
import type { Child } from 'hono/jsx';
import { Layout, type FooterStatus } from './layout';
import { authMiddleware, createSession, setSessionCookie, verifyPassword, type ConsoleEnv } from './auth';
import { validateScoringConfig } from '../config-store';
import { SKCATS, newBlockId, normalizeBlockInput } from './blocks-form';
import { fmtDates, normalizeMonth, tokensOfRole, validateRoleCode } from './roles';
import {
  applyPairRemove, applyWordAdd, buildMatrix, MATRIX_CATEGORIES, parseMeta,
  type Chip, type MatrixCategory, type MatrixMeta, type RemoveTarget,
} from './matrix';
import * as greenhouse from '../connectors/greenhouse';
import type { Company } from '../types';
import { CATEGORIES, type Category, type ScoreResult } from '../scoring';

type App = Hono<{ Bindings: ConsoleEnv }>;

export function consoleApp(): App {
  const app: App = new Hono();
  app.use('*', authMiddleware());

  // ---------- helpers ----------
  const now = () => new Date().toISOString();
  const fmt = (iso: string | null | undefined) => (iso ? iso.slice(5, 16).replace('T', ' ') : '—');

  // Pagination: 30/page. Query with `LIMIT PAGE+1 OFFSET pg*PAGE`, then if
  // more than PAGE rows came back there's a next page (drop the extra row).
  const PAGE = 30;
  const pageNum = (c: Context<{ Bindings: ConsoleEnv }>) => Math.max(0, Math.floor(Number(c.req.query('page')) || 0));
  function pager(base: string, pg: number, hasNext: boolean, params: Record<string, string | undefined>) {
    const qs = (p: number) => {
      const u = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) if (v) u.set(k, v);
      if (p > 0) u.set('page', String(p));
      const s = u.toString();
      return s ? `${base}?${s}` : base;
    };
    if (pg === 0 && !hasNext) return null;
    return (
      <div class="pager">
        {pg > 0 ? <a href={qs(pg - 1)}>← Prev</a> : <span class="muted">← Prev</span>}
        <span class="muted">page {pg + 1}</span>
        {hasNext ? <a href={qs(pg + 1)}>Next →</a> : <span class="muted">Next →</span>}
      </div>
    );
  }

  // ---------- Bank shared bits (docs/UI.md §2; v4 2026-07-18: LinkedIn-style
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
      'SELECT finished_at, companies_ok, errors FROM runs ORDER BY id DESC LIMIT 1',
    ).first<{ finished_at: string | null; companies_ok: number; errors: number }>();
    return { lastRun: r?.finished_at ? fmt(r.finished_at) : null, companiesOk: r?.companies_ok ?? 0, errors: r?.errors ?? 0 };
  }

  async function pendingTriage(env: ConsoleEnv): Promise<number> {
    const r = await env.DB.prepare(
      `SELECT COUNT(*) n FROM jobs j
       LEFT JOIN applications a ON a.url_hash = j.url_hash
       WHERE j.status IN ('new','notified') AND j.verdict != 'Skip'
         AND (a.url_hash IS NULL OR (a.stage = 'prepared' AND a.snoozed_until IS NOT NULL AND a.snoozed_until <= ?))`,
    ).bind(now()).first<{ n: number }>();
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

  // ---------- Today (triage) ----------
  app.get('/', async (c) => {
    const nowIso = now();
    const strip = await c.env.DB.prepare(
      `SELECT
        (SELECT COUNT(*) FROM applications WHERE stage='applied' AND applied_at >= datetime('now','-7 days')) applied_week,
        (SELECT status FROM runs ORDER BY id DESC LIMIT 1) run_status`,
    ).first<{ applied_week: number; run_status: string | null }>();

    const pg = pageNum(c);
    const rows = (
      await c.env.DB.prepare(
        `SELECT j.url_hash, j.title, j.location, j.track, j.verdict, j.score, j.url, j.posted_at,
                j.why_it_fits, j.positioning_lead, c.name company
         FROM jobs j
         JOIN companies c ON c.id = j.company_id
         LEFT JOIN applications a ON a.url_hash = j.url_hash
         WHERE j.status IN ('new','notified') AND j.verdict != 'Skip'
           AND (a.url_hash IS NULL OR (a.stage='prepared' AND a.snoozed_until IS NOT NULL AND a.snoozed_until <= ?))
         ORDER BY j.score DESC, j.first_seen DESC LIMIT ${PAGE + 1} OFFSET ${pg * PAGE}`,
      ).bind(nowIso).all<Record<string, string | number>>()
    ).results;
    const hasNext = rows.length > PAGE;
    if (hasNext) rows.pop();
    const pendingTotal = await pendingTriage(c.env);

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
        (SELECT COUNT(*) FROM cvs) cvs_total,
        (SELECT COUNT(*) FROM config WHERE key='contact_profile') contact_set`,
    ).first<Record<string, number>>();
    const cards: Array<[string, string, string, string]> = [
      ['Operate', '/tracker', `${panel?.tracker_active ?? 0}`, 'active applications'],
      ['Operate', '/jobs', `${panel?.jobs_total ?? 0}`, 'jobs seen'],
      ['Profile & setup', '/companies', `${panel?.companies_active ?? 0}/${panel?.companies_total ?? 0}`, 'companies active'],
      ['Profile & setup', '/blocks', `${panel?.blocks_approved ?? 0}/${panel?.blocks_total ?? 0}`, 'blocks approved'],
      ['Profile & setup', '/contact', panel?.contact_set ? 'set ✓' : 'not set', 'contact profile'],
      ['Output', '/cvs', `${panel?.cvs_total ?? 0}`, 'CVs generated'],
      ['System', '/week', `${strip?.applied_week ?? 0}`, 'applied this week'],
      ['System', '/health', strip?.run_status ?? '—', 'last run'],
    ];

    return page(c, 'Today', (
      <>
        <div class="statgrid">
          <div class="stat"><div class="n">{pendingTotal}</div><div class="l">pending triage</div></div>
          <div class="stat"><div class="n">{strip?.applied_week ?? 0}</div><div class="l">applied this week</div></div>
          <div class="stat"><div class="n">{health}</div><div class="l">system health</div></div>
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
        <h2>Triage</h2>
        {pendingTotal === 0 ? <div class="card">Triage up to date ✓</div> : null}
        <div class="twoup">
        {rows.map((j) => (
          <div class="card">
            <div>
              <a href={`/jobs/${j.url_hash}`}><strong>{j.title}</strong></a> — {j.company}
              {' '}<span class="muted">📍 {j.location || 'no location'}</span>
            </div>
            <div style="margin:4px 0">
              <span class={`v-${j.verdict}`}>{j.verdict}</span> · {j.score}/100 ·{' '}
              <span class="chip">{j.track}</span>
              {' '}<a href={String(j.url)} target="_blank" rel="noreferrer">view job ↗</a>
            </div>
            <div class="muted">{j.why_it_fits} · {j.positioning_lead}</div>
            <div class="actions" style="margin-top:8px">
              {(['prepared|Prepare', 'applied|I applied ✓', 'dismissed|Dismiss'] as const).map((x) => {
                const [stage, label] = x.split('|');
                return (
                  <form class="inline" method="post" action="/triage">
                    <input type="hidden" name="hash" value={String(j.url_hash)} />
                    <input type="hidden" name="stage" value={stage} />
                    <button type="submit" class={stage === 'applied' ? 'primary' : ''}>{label}</button>
                  </form>
                );
              })}
              <form class="inline" method="post" action="/triage">
                <input type="hidden" name="hash" value={String(j.url_hash)} />
                <input type="hidden" name="stage" value="snooze3" />
                <button type="submit">Snooze 3d</button>
              </form>
              <form class="inline" method="post" action={`/jobs/${j.url_hash}/cv`}>
                <input type="hidden" name="back" value="today" />
                <button type="submit">CV</button>
              </form>
            </div>
          </div>
        ))}
        </div>
        {pager('/', pg, hasNext, {})}
      </>
    ));
  });

  app.post('/triage', async (c) => {
    const b = await c.req.parseBody();
    const hash = String(b.hash ?? '');
    const action = String(b.stage ?? '');
    const ts = now();
    if (!hash || !action) return c.redirect('/?m=invalid action');
    if (action === 'snooze3') {
      const until = new Date(Date.now() + 3 * 86400000).toISOString();
      await c.env.DB.prepare(
        `INSERT INTO applications (url_hash, stage, snoozed_until, updated_at) VALUES (?, 'prepared', ?, ?)
         ON CONFLICT(url_hash) DO UPDATE SET snoozed_until = ?, updated_at = ?`,
      ).bind(hash, until, ts, until, ts).run();
      await jobEvent(c.env, hash, 'snoozed', 'until ' + until.slice(0, 10));
      return c.redirect('/?m=snoozed 3 days');
    }
    const appliedAt = action === 'applied' ? ts : null;
    await c.env.DB.prepare(
      `INSERT INTO applications (url_hash, stage, applied_at, snoozed_until, updated_at) VALUES (?, ?, ?, NULL, ?)
       ON CONFLICT(url_hash) DO UPDATE SET stage = ?, applied_at = COALESCE(?, applied_at), snoozed_until = NULL, updated_at = ?`,
    ).bind(hash, action, appliedAt, ts, action, appliedAt, ts).run();
    await jobEvent(c.env, hash, `stage:${action}`);
    return c.redirect(`/?m=${action}`);
  });

  // ---------- Jobs ----------
  app.get('/jobs', async (c) => {
    const q = c.req.query();
    const where: string[] = ['1=1'];
    const binds: unknown[] = [];
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

    const sel = (name: string, opts: string[], current?: string) => (
      <select name={name}>
        <option value="">({name})</option>
        {opts.map((o) => <option value={o} selected={o === current}>{o}</option>)}
      </select>
    );

    return page(c, 'Jobs', (
      <>
        <form method="get" action="/jobs" class="card actions filterbar">
          {sel('track', ['canada_coop', 'colombia_perm', 'contractor_usd'], q.track)}
          {sel('verdict', ['Apply', 'Stretch-worth-it', 'Skip'], q.verdict)}
          {sel('status', ['new', 'notified', 'closed', 'skipped'], q.status)}
          <input type="text" name="q" placeholder="search in title" value={q.q ?? ''} />
          <button type="submit" class="primary">Filter</button>
          <a href="/jobs?verdict=Apply&status=new">Apply pending</a>
          <a href="/jobs?status=notified">Notified</a>
        </form>
        <div class="table-wrap"><table>
          <tr><th>title</th><th class="hide-sm">track</th><th>score</th><th>verdict</th><th class="hide-sm">status</th><th class="hide-sm">stage</th><th class="hide-sm">seen</th></tr>
          {rows.map((j) => (
            <tr>
              <td><a href={`/jobs/${j.url_hash}`}>{j.title}</a><div class="muted">{j.company} · {j.location}</div></td>
              <td class="hide-sm">{j.track ?? '—'}</td>
              <td>{j.score}</td>
              <td class={`v-${j.verdict}`}>{j.verdict}</td>
              <td class={`hide-sm s-${j.status}`}>{j.status}</td>
              <td class="hide-sm">{j.stage ?? '—'}</td>
              <td class="hide-sm muted">{fmt(String(j.first_seen))}</td>
            </tr>
          ))}
        </table></div>
        {pager('/jobs', pg, hasNext, { track: q.track, verdict: q.verdict, status: q.status, q: q.q })}
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

    return page(c, String(j.title), (
      <>
        <div class="card">
          <div><strong>{j.company}</strong> · 📍 {j.location || '—'} · <span class={`v-${j.verdict}`}>{j.verdict}</span> · {j.score}/100 · <span class="chip">{j.track ?? '—'}</span> · <span class={`s-${j.status}`}>{j.status}</span></div>
          <div class="muted">posted: {fmt(j.posted_at as string)} · seen: {fmt(j.first_seen as string)} · notified: {fmt(j.notified_at as string)}</div>
          <div class="actions" style="margin-top:6px">
            <a href={String(j.url)} target="_blank" rel="noreferrer">open job ↗</a>
            <form class="inline" method="post" action={`/jobs/${hash}/cv`}>
              <button type="submit">Generate CV</button>
            </form>
          </div>
        </div>
        {breakdown ? (
          <div class="card">
            <h2 style="margin-top:0">Score breakdown</h2>
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
        <div class="card">
          <details><summary>full description</summary><p>{j.description_text}</p></details>
        </div>
        {similares.length > 0 ? (
          <div class="card">
            <h2 style="margin-top:0">Similar jobs radar ({similares.length})</h2>
            {similares.map((s) => (
              <div>
                <a href={`/jobs/${s.url_hash}`}>{s.title}</a> @ {s.company} ·{' '}
                <span class={`v-${s.verdict}`}>{s.verdict}</span> · {s.score}
              </div>
            ))}
          </div>
        ) : null}
        <div class="card">
          <h2 style="margin-top:0">History</h2>
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

    return page(c, 'Companies', (
      <>
        <form method="post" action="/companies" class="card actions">
          <input type="text" name="name" placeholder="name" required />
          <select name="ats"><option>greenhouse</option><option>lever</option><option>ashby</option></select>
          <input type="text" name="token" placeholder="board token" required />
          <input type="text" name="notes" placeholder="notes" />
          <button type="submit" class="primary">Add company</button>
        </form>
        <div class="table-wrap"><table>
          <tr><th>company</th><th>ats</th><th>token</th><th>active</th><th>health</th><th>jobs 90d</th><th>survivors</th><th>yield</th></tr>
          {rows.map((r) => (
            <tr>
              <td>{r.name}<div class="muted">{r.notes}</div></td>
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
        {pager('/companies', pg, hasNext, {})}
      </>
    ));
  });

  app.post('/companies', async (c) => {
    const b = await c.req.parseBody();
    const name = String(b.name ?? '').trim();
    const ats = String(b.ats ?? 'greenhouse');
    const token = String(b.token ?? '').trim();
    const notes = String(b.notes ?? '');
    if (!name || !token) return c.redirect('/companies?m=missing fields');
    let probe = 'connector pending (step 5): saved inactive';
    let active = 0;
    if (ats === 'greenhouse') {
      try {
        const jobs = await greenhouse.fetchJobs({ id: 0, name, ats: 'greenhouse', token, active: true } as Company);
        probe = `token OK: ${jobs.length} jobs on the board`;
        active = 1;
      } catch (err) {
        probe = `token FAILED: ${err instanceof Error ? err.message : 'error'} — saved inactive`;
      }
    }
    await c.env.DB.prepare(
      'INSERT OR IGNORE INTO companies (name, ats, token, active, notes) VALUES (?,?,?,?,?)',
    ).bind(name, ats, token, active, notes).run();
    return c.redirect(`/companies?m=${encodeURIComponent(probe)}`);
  });

  app.post('/companies/toggle', async (c) => {
    const b = await c.req.parseBody();
    await c.env.DB.prepare('UPDATE companies SET active = 1 - active WHERE id = ?').bind(Number(b.id)).run();
    return c.redirect('/companies?m=updated');
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
  /** Draft-or-live scoring config: chip edits accumulate in a draft until activated. */
  async function loadDraftOrLive(env: ConsoleEnv): Promise<{ cfg: import('../scoring').ScoringConfig; isDraft: boolean }> {
    const d = await env.DB.prepare("SELECT value FROM config WHERE key='scoring_draft'").first<{ value: string }>();
    if (d) return { cfg: JSON.parse(d.value), isDraft: true };
    const l = await env.DB.prepare("SELECT value FROM config WHERE key='scoring'").first<{ value: string }>();
    if (!l) throw new Error('scoring config missing');
    return { cfg: JSON.parse(l.value), isDraft: false };
  }
  async function saveDraft(env: ConsoleEnv, cfg: unknown): Promise<void> {
    await env.DB.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('scoring_draft', ?)")
      .bind(JSON.stringify(cfg)).run();
  }
  /** Console-only display metadata for gate terms (language/pairing). Cosmetic — outside the draft flow. */
  async function loadMeta(env: ConsoleEnv): Promise<MatrixMeta> {
    const r = await env.DB.prepare("SELECT value FROM config WHERE key='matrix_meta'").first<{ value: string }>();
    return parseMeta(r?.value);
  }
  async function saveMeta(env: ConsoleEnv, meta: MatrixMeta): Promise<void> {
    await env.DB.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('matrix_meta', ?)")
      .bind(JSON.stringify(meta)).run();
  }

  app.get('/config', async (c) => {
    const rows = (
      await c.env.DB.prepare("SELECT key, value FROM config WHERE key IN ('FRESHNESS_MAX_DAYS')").all<{ key: string; value: string }>()
    ).results;
    const freshness = rows.find((r) => r.key === 'FRESHNESS_MAX_DAYS')?.value ?? '3';
    const { cfg, isDraft } = await loadDraftOrLive(c.env);
    const history = (
      await c.env.DB.prepare('SELECT id, ts, key, replay_summary, diff_summary FROM config_history ORDER BY id DESC LIMIT 30')
        .all<{ id: number; ts: string; key: string; replay_summary: string | null; diff_summary: string | null }>()
    ).results;

    const meta = await loadMeta(c.env);
    const matrix = buildMatrix(cfg, meta);
    const trackLabel = (t: string) => TRACK_LABELS[t] ?? t;
    const pathClass = (t: string) => `path p-${Math.max(0, cfg.tracks.findIndex((x) => x.id === t))}`;

    /** One word chip: term, weight (or penalty), path badge, ✕ removes the pair. */
    const chipEl = (ch: Chip, extra: boolean) => (
      <span class={`chip${extra ? ' extra' : ''}${!ch.favor ? ' neg' : ''}${Math.abs(ch.weight ?? 0) >= 3 ? ' w3' : ''}${Math.abs(ch.weight ?? 0) === 1 ? ' w1' : ''}`}>
        {ch.term}
        {ch.weight !== undefined ? <span class="muted"> {ch.weight > 0 ? `+${ch.weight}` : ch.weight}</span>
          : ch.penalty !== undefined ? <span class="muted"> −{ch.penalty}</span> : null}
        {ch.path ? <span class={pathClass(ch.path)}>{trackLabel(ch.path)}</span> : null}
        <form class="inline" method="post" action="/config/word-remove">
          <input type="hidden" name="kind" value={ch.source.kind} />
          {ch.source.kind === 'keyword' ? (
            <input type="hidden" name="category" value={ch.category} />
          ) : (
            <>
              <input type="hidden" name="track" value={ch.source.track} />
              <input type="hidden" name="gate" value={ch.source.gate} />
            </>
          )}
          <input type="hidden" name="term" value={ch.term} />
          <button type="submit" class="chipx" title="remove word (both languages)">✕</button>
        </form>
      </span>
    );
    const SHOW = 8;
    const cellEl = (chips: Chip[]) => (
      <div class="mcell">
        {chips.length === 0 ? <span class="muted" style="font-size:12.5px">none</span>
          : chips.map((ch, i) => chipEl(ch, i >= SHOW))}
        {chips.length > SHOW ? (
          <div><button type="button" class="morebtn">show {chips.length - SHOW} more</button></div>
        ) : null}
      </div>
    );

    return page(c, 'Calibration', (
      <>
        {isDraft ? (
          <div class="card" style="border-color:var(--warn)">
            <div class="actions">
              <strong>⚠ You have unsaved calibration changes.</strong>
              <form class="inline" method="post" action="/config/replay">
                <input type="hidden" name="n" value="200" />
                <button type="submit" class="primary">Preview impact</button>
              </form>
              <form class="inline" method="post" action="/config/replay/discard">
                <button type="submit">Discard changes</button>
              </form>
            </div>
            <p class="muted">Nothing applies to real scoring until you preview the impact and then activate — Activate is its own button on the preview screen.</p>
          </div>
        ) : null}

        <form method="post" action="/config/quick" class="card actions">
          <label>Notify me at score ≥ <input type="number" name="apply" value={String(cfg.thresholds.apply)} style="width:70px" /></label>
          <label>Show borderline from ≥ <input type="number" name="stretch" value={String(cfg.thresholds.stretch)} style="width:70px" /></label>
          <label>Ignore postings older than <input type="number" name="freshness" value={freshness} style="width:60px" /> days</label>
          <button type="submit" class="primary">Save</button>
        </form>

        <form method="post" action="/config/rescore" class="card actions"
          onsubmit="return confirm('Re-score ALL open jobs with the ACTIVE config? This rewrites score/track/verdict on changed rows (history kept in job events).')">
          <button type="submit">♻️ Re-score open jobs with the active config</button>
          <span class="muted">run this after activating changes so stored jobs pick them up</span>
        </form>

        <h2>What I want to see (the matrix)</h2>
        <p class="muted" style="margin:0 0 6px">
          Weight: <strong>+3</strong> strong · <strong>+2</strong> medium · <strong>+1</strong> light ·
          <strong> −2</strong> against · <strong>−3</strong> strongly against — ✕ removes a word in BOTH
          languages; adding happens in ONE place, after the table.
        </p>
        <p class="muted" style="margin:0 0 8px">
          <strong>Path</strong> — the track a word unlocks (or, on an against word, blocks):
          {cfg.tracks.map((t) => <span class={pathClass(t.id)}>{trackLabel(t.id)}</span>)}
          <span> · no badge = scores every track · path words are gates: absolute, not points (−N = penalty)</span>
        </p>
        <div class="actions" style="margin-bottom:10px">
          <div class="calsearch">
            <input type="search" id="calsearch-input" placeholder="Find a word across every list…" aria-label="Find a word" />
          </div>
        </div>

        <div class="matrix-wrap">
          <div class="matrix">
            <div class="mrow mhead">
              <div>Category</div>
              <div class="fav">In favor · English</div>
              <div class="fav">In favor · Español</div>
              <div class="agn">Against · English</div>
              <div class="agn">Against · Español</div>
            </div>
            {matrix.map((r) => (
              <div class="mrow">
                <div class="mcat">{MATRIX_LABELS[r.category][0]}<span class="sub">{MATRIX_LABELS[r.category][1]}</span></div>
                {cellEl(r.favor_en)}
                {cellEl(r.favor_es)}
                {cellEl(r.against_en)}
                {cellEl(r.against_es)}
              </div>
            ))}
          </div>
        </div>

        <div class="card">
          <strong>＋ Add word — the only add form on the page</strong>
          <form method="post" action="/config/word-add" style="margin-top:8px">
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
              <label><input type="radio" name="dir" value="favor" checked
                onchange="document.getElementById('wf').disabled=false;document.getElementById('wa').disabled=true" /> In favor</label>
              <label><input type="radio" name="dir" value="against"
                onchange="document.getElementById('wf').disabled=true;document.getElementById('wa').disabled=false" /> Against</label>
              <select name="weight" id="wf">
                <option value="3">+3 strong</option>
                <option value="2" selected>+2 medium</option>
                <option value="1">+1 light</option>
              </select>
              <select name="weight" id="wa" disabled>
                <option value="2" selected>−2 against</option>
                <option value="3">−3 strongly against</option>
              </select>
              <label class="muted">Path{' '}
                <select name="path">
                  <option value="">— every track —</option>
                  {cfg.tracks.map((t) => <option value={t.id}>{trackLabel(t.id)}</option>)}
                </select></label>
              <button type="submit" class="primary">Add to draft</button>
            </div>
            <p class="muted" style="margin:6px 0 0">Location words REQUIRE a path (they are the track gates; weight does not apply there).</p>
          </form>
        </div>

        <details class="card">
          <summary>Advanced: raw JSON</summary>
          <form method="post" action="/config/scoring" style="margin-top:8px">
            <textarea name="scoring" rows={18}>{JSON.stringify(cfg, null, 2)}</textarea>
            <div class="actions" style="margin-top:8px">
              <button type="submit" class="primary">Save as active config</button>
              <button type="submit" formaction="/config/replay">Preview impact (Replay)</button>
              <label>against last <input type="number" name="n" value="200" min="50" max="1000" style="width:80px" /> jobs</label>
            </div>
          </form>
        </details>

        <div class="card">
          <h2 style="margin-top:0">History (what changed, in words)</h2>
          <div class="table-wrap"><table>
            {history.map((h) => (
              <tr>
                <td class="muted">{fmt(h.ts)}</td>
                <td>{h.key}</td>
                <td>{h.diff_summary ?? <span class="muted">{h.replay_summary ? 'with replay' : '—'}</span>}</td>
                <td>
                  <form class="inline" method="post" action="/config/revert"
                    onsubmit={`return confirm('Revert this change? It will undo: ${String(h.diff_summary ?? 'the recorded change').replaceAll("'", '’')}')`}>
                    <input type="hidden" name="id" value={String(h.id)} />
                    <button type="submit">Revert</button>
                  </form>
                </td>
              </tr>
            ))}
          </table></div>
        </div>
        <script dangerouslySetInnerHTML={{ __html: `
(() => {
  const q = document.getElementById('calsearch-input');
  if (q) q.addEventListener('input', () => {
    const s = q.value.trim().toLowerCase();
    document.querySelectorAll('.matrix .chip').forEach((ch) => {
      ch.classList.remove('hit', 'dim');
      if (!s) return;
      if (ch.textContent.toLowerCase().includes(s)) { ch.classList.add('hit'); ch.classList.remove('extra'); }
      else ch.classList.add('dim');
    });
  });
  document.querySelectorAll('.morebtn').forEach((b) => b.addEventListener('click', () => {
    const cell = b.closest('.mcell');
    cell.classList.toggle('open');
    b.textContent = cell.classList.contains('open') ? 'show fewer' : b.textContent.replace('fewer', 'more');
  }));
})();` }} />
      </>
    ));
  });

  // Word edits accumulate in the draft; nothing goes live without the
  // Preview impact → Activate steps. ONE add/remove pair of routes: the matrix
  // maps each concept to keywords and/or gate lists (src/console/matrix.ts).
  app.post('/config/word-add', async (c) => {
    const b = await c.req.parseBody();
    const category = String(b.category ?? '') as MatrixCategory;
    if (!MATRIX_CATEGORIES.includes(category)) return c.redirect('/config?m=invalid category');
    const { cfg } = await loadDraftOrLive(c.env);
    const meta = await loadMeta(c.env);
    const err = applyWordAdd(cfg, meta, {
      en: String(b.term_en ?? ''),
      es: String(b.term_es ?? ''),
      category,
      favor: String(b.dir ?? 'favor') !== 'against',
      weight: Number(b.weight ?? 2),
      path: String(b.path ?? '') || undefined,
    });
    if (err) return c.redirect(`/config?m=${encodeURIComponent(`rejected: ${err.error}`)}`);
    try { validateScoringConfig(cfg); } catch (e) {
      return c.redirect(`/config?m=${encodeURIComponent(`rejected: ${e instanceof Error ? e.message : 'invalid'}`)}`);
    }
    await saveDraft(c.env, cfg);
    await saveMeta(c.env, meta);
    return c.redirect(`/config?m=${encodeURIComponent(`added "${String(b.term_en).trim().toLowerCase()}" (EN+ES) — Preview impact to apply`)}`);
  });

  app.post('/config/word-remove', async (c) => {
    const b = await c.req.parseBody();
    const term = String(b.term ?? '');
    const target: RemoveTarget = String(b.kind ?? '') === 'gate'
      ? { kind: 'gate', track: String(b.track ?? ''), gate: String(b.gate ?? ''), term }
      : { kind: 'keyword', category: String(b.category ?? '') as Category, term };
    if (target.kind === 'keyword' && !CATEGORIES.includes(target.category)) {
      return c.redirect('/config?m=invalid category');
    }
    const { cfg } = await loadDraftOrLive(c.env);
    const meta = await loadMeta(c.env);
    const r = applyPairRemove(cfg, meta, target);
    if ('error' in r) return c.redirect(`/config?m=${encodeURIComponent(`remove failed: ${r.error}`)}`);
    await saveDraft(c.env, cfg);
    await saveMeta(c.env, meta);
    return c.redirect(`/config?m=${encodeURIComponent(`removed ${r.removed.map((t) => `"${t}"`).join(' + ')} — Preview impact to apply`)}`);
  });

  async function saveConfig(env: ConsoleEnv, key: string, value: string, diffSummary?: string): Promise<void> {
    const old = await env.DB.prepare('SELECT value FROM config WHERE key = ?').bind(key).first<{ value: string }>();
    await env.DB.batch([
      env.DB.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').bind(key, value),
      env.DB.prepare('INSERT INTO config_history (ts, key, old_value, new_value, diff_summary) VALUES (?, ?, ?, ?, ?)')
        .bind(now(), key, old?.value ?? null, value, diffSummary ?? null),
    ]);
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
              <h2 style="margin-top:0">🇨🇴 Colombia</h2>
              {SIMPLE_CO.map(([key, label]) => field(key, label, str(profile[key])))}
              {ADDR_CO.map(([key, label]) => field(`address_co__${key}`, label, addr('address_co')[key] ?? ''))}
            </div>
            <div>
              <h2 style="margin-top:0">🇨🇦 Canada</h2>
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

  app.post('/config/quick', async (c) => {
    const b = await c.req.parseBody();
    const raw = await c.env.DB.prepare("SELECT value FROM config WHERE key='scoring'").first<{ value: string }>();
    if (raw) {
      const old = JSON.parse(raw.value) as import('../scoring').ScoringConfig;
      const cfg = JSON.parse(raw.value) as import('../scoring').ScoringConfig;
      cfg.thresholds = { apply: Number(b.apply), stretch: Number(b.stretch) };
      validateScoringConfig(cfg);
      const { diffScoring } = await import('./config-diff');
      await saveConfig(c.env, 'scoring', JSON.stringify(cfg), diffScoring(old, cfg));
      // Keep an open draft coherent with the new thresholds.
      const draft = await c.env.DB.prepare("SELECT value FROM config WHERE key='scoring_draft'").first<{ value: string }>();
      if (draft) {
        const d = JSON.parse(draft.value) as import('../scoring').ScoringConfig;
        d.thresholds = cfg.thresholds;
        await saveDraft(c.env, d);
      }
    }
    await saveConfig(c.env, 'FRESHNESS_MAX_DAYS', String(Number(b.freshness ?? 3)));
    return c.redirect('/config?m=saved');
  });

  app.post('/config/scoring', async (c) => {
    const b = await c.req.parseBody();
    try {
      const parsed = JSON.parse(String(b.scoring ?? ''));
      validateScoringConfig(parsed);
      await saveConfig(c.env, 'scoring', JSON.stringify(parsed));
      return c.redirect('/config?m=scoring valid and saved');
    } catch (err) {
      return c.redirect(`/config?m=${encodeURIComponent(`ERROR: ${err instanceof Error ? err.message : 'invalid'}`)}`);
    }
  });

  // ---------- Tracker ----------
  const STAGES = ['prepared', 'applied', 'interview', 'offer', 'rejected'] as const;
  const STAGE_LABEL: Record<string, string> = {
    prepared: 'Prepared', applied: 'Applied', interview: 'Interview',
    offer: 'Offer', rejected: 'Rejected', dismissed: 'Dismissed',
  };

  app.get('/tracker', async (c) => {
    const nowIso = now();
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
    const due = rows.filter((r) => r.follow_up_at && String(r.follow_up_at) <= nowIso);
    const daysIn = (iso: string | number | null | undefined) =>
      iso ? Math.floor((Date.now() - new Date(String(iso)).getTime()) / 86400000) : 0;

    return page(c, 'Tracker', (
      <>
        {due.length > 0 ? (
          <div class="card">
            <h2 style="margin-top:0">Overdue follow-ups</h2>
            {due.map((r) => <div><a href={`/jobs/${r.url_hash}`}>{r.title}</a> @ {r.company} — follow-up {String(r.follow_up_at).slice(0, 10)}</div>)}
          </div>
        ) : null}
        {capped ? <div class="card muted">Showing the 300 most recent applications — dismiss or close old items to tidy the board.</div> : null}
        <div class="kanban">
          {STAGES.map((stage) => {
            const col = rows.filter((r) => r.stage === stage);
            return (
              <div class="kancol">
                <h2 style="margin-top:0">{STAGE_LABEL[stage]} <span class="muted">({col.length})</span></h2>
                {col.map((r) => (
                  <div class="card">
                    <a href={`/jobs/${r.url_hash}`}><strong>{r.title}</strong></a>
                    <div class="muted">{r.company} · <span class="chip">{r.track}</span> · {daysIn(r.updated_at)}d in stage</div>
                    {r.notes ? <div class="muted">📝 {String(r.notes).slice(0, 80)}</div> : null}
                    <form method="post" action="/tracker/update" style="margin-top:6px; display:grid; gap:4px">
                      <input type="hidden" name="hash" value={String(r.url_hash)} />
                      <div class="actions">
                        <select name="stage">
                          {[...STAGES, 'dismissed'].map((s) => <option value={s} selected={s === stage}>{STAGE_LABEL[s]}</option>)}
                        </select>
                        <input type="date" name="follow_up" value={r.follow_up_at ? String(r.follow_up_at).slice(0, 10) : ''} />
                      </div>
                      <input type="text" name="note" placeholder="note (optional)" />
                      <button type="submit">Update</button>
                    </form>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </>
    ));
  });

  app.post('/tracker/update', async (c) => {
    const b = await c.req.parseBody();
    const hash = String(b.hash ?? '');
    const stage = String(b.stage ?? '');
    if (!hash || !STAGE_LABEL[stage]) return c.redirect('/tracker?m=invalid');
    const ts = now();
    const followUp = b.follow_up ? `${String(b.follow_up)}T12:00:00Z` : null;
    const note = String(b.note ?? '').trim();
    const stamp =
      stage === 'applied' ? 'applied_at' : stage === 'interview' ? 'interview_at'
      : stage === 'offer' || stage === 'rejected' ? 'outcome_at' : null;
    await c.env.DB.prepare(
      `UPDATE applications SET stage = ?, follow_up_at = ?, updated_at = ?,
         notes = CASE WHEN ? != '' THEN COALESCE(notes || char(10), '') || ? ELSE notes END
         ${stamp ? `, ${stamp} = COALESCE(${stamp}, ?)` : ''}
       WHERE url_hash = ?`,
    ).bind(...(stamp ? [stage, followUp, ts, note, note, ts, hash] : [stage, followUp, ts, note, note, hash])).run();
    await jobEvent(c.env, hash, `stage:${stage}`, note);
    return c.redirect('/tracker?m=updated');
  });

  // ---------- Week ----------
  app.get('/week', async (c) => {
    const win = async (from: string, to: string) =>
      (await c.env.DB.prepare(
        `SELECT
          (SELECT COUNT(*) FROM jobs WHERE first_seen >= ? AND first_seen < ?) new_jobs,
          (SELECT COUNT(*) FROM jobs WHERE first_seen >= ? AND first_seen < ? AND verdict != 'Skip') survivors,
          (SELECT COUNT(*) FROM jobs WHERE notified_at >= ? AND notified_at < ?) notified,
          (SELECT COUNT(*) FROM applications WHERE applied_at >= ? AND applied_at < ?) applied,
          (SELECT COUNT(*) FROM applications WHERE interview_at >= ? AND interview_at < ?) interviews`,
      ).bind(from, to, from, to, from, to, from, to, from, to).first<Record<string, number>>())!;
    const nowMs = Date.now();
    const iso = (ms: number) => new Date(ms).toISOString();
    const cur = await win(iso(nowMs - 7 * 86400000), iso(nowMs + 1));
    const prev = await win(iso(nowMs - 14 * 86400000), iso(nowMs - 7 * 86400000));
    const tta = (
      await c.env.DB.prepare(
        `SELECT j.notified_at, a.applied_at FROM applications a JOIN jobs j ON j.url_hash = a.url_hash
         WHERE a.applied_at >= ? AND j.notified_at IS NOT NULL`,
      ).bind(iso(nowMs - 30 * 86400000)).all<{ notified_at: string; applied_at: string }>()
    ).results.map((r) => (new Date(r.applied_at).getTime() - new Date(r.notified_at).getTime()) / 3600000).sort((a, b) => a - b);
    const median = tta.length ? tta[Math.floor(tta.length / 2)]!.toFixed(1) : null;
    const aging = await c.env.DB.prepare(
      `SELECT COUNT(*) n FROM applications WHERE stage IN ('prepared','applied') AND updated_at < ?`,
    ).bind(iso(nowMs - 7 * 86400000)).first<{ n: number }>();

    const stagesRow = (label: string, w: Record<string, number>, max: number) => (
      <tr>
        <th>{label}</th>
        {(['new_jobs', 'survivors', 'notified', 'applied', 'interviews'] as const).map((k) => (
          <td>
            <div>{w[k]}</div>
            <div style={`height:6px;border-radius:3px;background:var(--accent);width:${max > 0 ? Math.max(2, (Number(w[k]) / max) * 100) : 2}%`} />
          </td>
        ))}
      </tr>
    );
    const maxVal = Math.max(1, ...Object.values(cur).map(Number), ...Object.values(prev).map(Number));

    return page(c, 'Week', (
      <>
        <div class="statgrid">
          <div class="stat"><div class="n">{cur.applied}</div><div class="l">applied</div></div>
          <div class="stat"><div class="n">{median ?? '—'}{median ? 'h' : ''}</div><div class="l">median time-to-apply (30d)</div></div>
          <div class="stat"><div class="n">{aging?.n ?? 0}</div><div class="l">stalled &gt;7d</div></div>
        </div>
        <div class="card">
          <div class="table-wrap"><table>
            <tr><th>week</th><th>new</th><th>survivors</th><th>notified</th><th>applied</th><th>interviews</th></tr>
            {stagesRow('this', cur, maxVal)}
            {stagesRow('previous', prev, maxVal)}
          </table></div>
        </div>
        <p class="muted">The Monday digest to Telegram summarizes these same numbers.</p>
      </>
    ));
  });

  // ---------- Replay ----------
  app.post('/config/replay', async (c) => {
    const b = await c.req.parseBody();
    try {
      if (b.scoring) {
        // Advanced JSON path: the textarea content becomes the draft.
        const parsed = JSON.parse(String(b.scoring));
        validateScoringConfig(parsed);
        await saveDraft(c.env, parsed);
      } else {
        // Chip-edit path: the accumulated draft is previewed as-is.
        const draft = await c.env.DB.prepare("SELECT value FROM config WHERE key='scoring_draft'").first<{ value: string }>();
        if (!draft) return c.redirect('/config?m=no changes to preview');
        validateScoringConfig(JSON.parse(draft.value));
      }
      const n = Math.min(1000, Math.max(50, Number(b.n ?? 200)));
      return c.redirect(`/config/replay?n=${n}`);
    } catch (err) {
      return c.redirect(`/config?m=${encodeURIComponent(`invalid draft: ${err instanceof Error ? err.message : ''}`)}`);
    }
  });

  app.get('/config/replay', async (c) => {
    const n = Math.min(1000, Math.max(50, Number(c.req.query('n') ?? 200)));
    const runner = `
(async () => {
  const tbody = document.getElementById('diffs');
  const bar = document.getElementById('bar');
  const sum = { total: 0, changed: 0, up: 0, down: 0, byVerdict: {} };
  let cursor = 0;
  for (;;) {
    const r = await fetch('/api/replay-batch?cursor=' + cursor + '&n=${n}');
    if (!r.ok) { bar.textContent = 'error: ' + r.status; return; }
    const d = await r.json();
    sum.total = d.total_target;
    for (const row of d.diffs) {
      sum.changed++;
      const key = row.old_verdict + '→' + row.new_verdict;
      sum.byVerdict[key] = (sum.byVerdict[key] || 0) + 1;
      if (row.new_score > row.old_score) sum.up++; else sum.down++;
      // titles/companies are third-party text: ONLY textContent, never innerHTML
      const tr = document.createElement('tr');
      const td = (parent) => parent.appendChild(document.createElement('td'));
      const t1 = td(tr); t1.textContent = row.title;
      const sub = document.createElement('div'); sub.className = 'muted';
      sub.textContent = row.company; t1.appendChild(sub);
      td(tr).textContent = row.old_score + ' -> ' + row.new_score;
      const t3 = td(tr); t3.textContent = row.old_verdict; t3.className = 'v-' + row.old_verdict;
      const t4 = td(tr); t4.textContent = row.new_verdict; t4.className = 'v-' + row.new_verdict;
      tbody.appendChild(tr);
    }
    cursor = d.next_cursor;
    bar.textContent = 'processed ' + d.processed_total + ' / ' + d.total_target +
      ' · changed ' + sum.changed;
    if (d.done) break;
  }
  const parts = Object.entries(sum.byVerdict).map(([k, v]) => v + ' ' + k).join(' · ');
  bar.textContent = 'done: ' + sum.changed + ' of ' + sum.total + ' change verdict' +
    (parts ? ' (' + parts + ')' : '');
  document.getElementById('summary-input').value = JSON.stringify(sum);
  document.getElementById('apply-form').style.display = 'block';
})();`;
    return page(c, 'Replay (simulation)', (
      <>
        <div class="card">
          <p>Simulating the draft against the last {n} stored jobs. <strong id="bar">starting…</strong></p>
          <div id="apply-form" style="display:none">
            <form method="post" action="/config/replay/apply" class="inline">
              <input type="hidden" name="summary" id="summary-input" />
              <button type="submit" class="primary">Activate</button>
            </form>{' '}
            <form method="post" action="/config/replay/discard" class="inline">
              <button type="submit">Discard draft</button>
            </form>
          </div>
        </div>
        <div class="table-wrap"><table>
          <tr><th>job</th><th>score</th><th>before</th><th>after</th></tr>
          <tbody id="diffs" />
        </table></div>
        <script dangerouslySetInnerHTML={{ __html: runner }} />
      </>
    ));
  });

  app.post('/config/replay/apply', async (c) => {
    const b = await c.req.parseBody();
    const draft = await c.env.DB.prepare("SELECT value FROM config WHERE key='scoring_draft'").first<{ value: string }>();
    if (!draft) return c.redirect('/config?m=no draft');
    const old = await c.env.DB.prepare("SELECT value FROM config WHERE key='scoring'").first<{ value: string }>();
    const { diffScoring } = await import('./config-diff');
    const diff = old ? diffScoring(JSON.parse(old.value), JSON.parse(draft.value)) : 'initial config';
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('scoring', ?)").bind(draft.value),
      c.env.DB.prepare("DELETE FROM config WHERE key='scoring_draft'"),
      c.env.DB.prepare('INSERT INTO config_history (ts, key, old_value, new_value, replay_summary, diff_summary) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(now(), 'scoring', old?.value ?? null, draft.value, String(b.summary ?? ''), diff),
    ]);
    return c.redirect(`/config?m=${encodeURIComponent(`activated: ${diff.slice(0, 120)} — now run Re-score so stored jobs pick it up`)}`);
  });

  app.post('/config/replay/discard', async (c) => {
    await c.env.DB.prepare("DELETE FROM config WHERE key='scoring_draft'").run();
    return c.redirect('/config?m=draft discarded');
  });

  // ---------- Re-score (materialized; unlike Replay it WRITES) ----------
  app.post('/config/rescore', async (c) => c.redirect('/config/rescore'));

  app.get('/config/rescore', async (c) => {
    const runner = `
(async () => {
  const tbody = document.getElementById('changes');
  const bar = document.getElementById('bar');
  let cursor = 0, changed = 0, updated = 0;
  for (;;) {
    const r = await fetch('/api/rescore-batch?cursor=' + cursor, { method: 'POST' });
    if (!r.ok) { bar.textContent = 'error: ' + r.status; return; }
    const d = await r.json();
    updated += d.updated;
    for (const row of d.changes) {
      changed++;
      // titles/companies are third-party text: ONLY textContent, never innerHTML
      const tr = document.createElement('tr');
      const td = (parent) => parent.appendChild(document.createElement('td'));
      const t1 = td(tr); t1.textContent = row.title;
      const sub = document.createElement('div'); sub.className = 'muted';
      sub.textContent = row.company; t1.appendChild(sub);
      td(tr).textContent = row.old_score + ' -> ' + row.new_score;
      td(tr).textContent = row.old;
      td(tr).textContent = row.new;
      tbody.appendChild(tr);
    }
    cursor = d.next_cursor;
    bar.textContent = 'processed ' + d.processed_total + ' / ' + d.total_open +
      ' open jobs · ' + changed + ' track/verdict changes';
    if (d.done) break;
  }
  bar.textContent = 'done: ' + changed + ' track/verdict changes (see the table); rows rewritten in place.';
})();`;
    return page(c, 'Re-score (active config)', (
      <>
        <div class="card">
          <p>Re-scoring every open job (new/notified) with the ACTIVE config. <strong id="bar">starting…</strong></p>
          <p class="muted">Changed rows get their score/track/verdict rewritten and a job event; unchanged rows are untouched. <a href="/config">back to Calibration</a> · <a href="/jobs">see Jobs</a></p>
        </div>
        <div class="table-wrap"><table>
          <tr><th>job</th><th>score</th><th>before</th><th>after</th></tr>
          <tbody id="changes" />
        </table></div>
        <script dangerouslySetInnerHTML={{ __html: runner }} />
      </>
    ));
  });

  app.post('/config/revert', async (c) => {
    const b = await c.req.parseBody();
    const row = await c.env.DB.prepare('SELECT key, old_value FROM config_history WHERE id = ?')
      .bind(Number(b.id)).first<{ key: string; old_value: string | null }>();
    if (!row?.old_value) return c.redirect('/config?m=nothing to revert');
    await saveConfig(c.env, row.key, row.old_value);
    return c.redirect(`/config?m=${encodeURIComponent(`reverted: ${row.key}`)}`);
  });

  // ---------- Bank (v4 2026-07-18, LinkedIn-inspired): collapsed role cards,
  // tap to open, one pencil per item editing in place, EN+ES always, saving IS
  // the approval — no draft/approve cycle. Editor state is server-rendered via
  // query params (?edit=<block> / ?editrole=<code> / ?add=<key> / ?addrole=1).

  app.get('/blocks', async (c) => {
    const q = c.req.query();
    const anchors = await fetchAnchors(c.env);
    const rows = (
      await c.env.DB.prepare(
        `SELECT id, section, anchor_id, skcat, tags, text_en, text_es FROM blocks
         WHERE status != 'retired' ORDER BY section, anchor_id, id`,
      ).all<Record<string, string | null>>()
    ).results;
    const roleCount = anchors.filter((a) => a.kind === 'role').length;

    /** In-place editor for one existing bullet (?edit=<id>). */
    const editPane = (b: Record<string, string | null>) => (
      <div class="editpane">
        <form method="post" action="/blocks/update" id={`bf-${b.id}`}>
          <input type="hidden" name="id" value={String(b.id)} />
          <input type="hidden" name="section" value={String(b.section)} />
          <input type="hidden" name="anchor_id" value={String(b.anchor_id ?? '')} />
          <input type="hidden" name="skcat" value={String(b.skcat ?? '')} />
          <input type="hidden" name="tags" value={String(b.tags ?? '')} />
          <div class="field"><label>Text — English (required)</label><textarea name="text_en" required>{b.text_en}</textarea></div>
          <div class="field"><label>Text — Español (required)</label><textarea name="text_es" required>{b.text_es}</textarea></div>
        </form>
        <div class="rowactions">
          <button type="submit" form={`bf-${b.id}`} class="primary">Save</button>
          <a class="btnlike" href="/blocks">Cancel</a>
          <span class="spacer" />
          <form class="inline" method="post" action="/blocks/delete"
            onsubmit="return confirm('Delete this bullet permanently? This cannot be undone.')">
            <input type="hidden" name="id" value={String(b.id)} />
            <button type="submit">Delete bullet</button>
          </form>
        </div>
      </div>
    );

    /** One responsibility: EN + ES with its pencil — or its open editor. */
    const bulletRow = (b: Record<string, string | null>) =>
      q.edit === b.id ? editPane(b) : (
        <div class="b-row">
          <div class="b-text">{b.text_en}<div class="es">{b.text_es}</div></div>
          <a class="pencil" href={`/blocks?edit=${encodeURIComponent(String(b.id))}`} title="Edit bullet">✏️</a>
        </div>
      );

    /** In-place add form (?add=<key>): EN + ES, both required. */
    const addPane = (hidden: Record<string, string>) => (
      <div class="editpane">
        <form method="post" action="/blocks/create">
          {Object.entries(hidden).map(([k, v]) => <input type="hidden" name={k} value={v} />)}
          <div class="field"><label>Text — English (required)</label><textarea name="text_en" required /></div>
          <div class="field"><label>Text — Español (required)</label><textarea name="text_es" required /></div>
          <div class="rowactions">
            <button type="submit" class="primary">Save</button>
            <a class="btnlike" href="/blocks">Cancel</a>
          </div>
        </form>
      </div>
    );
    const addButton = (key: string, label: string) => (
      <a class="btnlike sec" href={`/blocks?add=${encodeURIComponent(key)}`}>＋ {label}</a>
    );

    /** LinkedIn-style role setup (a = existing role; null = create). */
    const roleEditor = (a: AnchorOpt | null) => {
      const fid = a ? `rf-${a.id}` : 'rf-new';
      return (
        <div class="editpane">
          <form method="post" action={a ? '/roles/update' : '/roles/create'} id={fid}>
            {a ? <input type="hidden" name="id" value={a.id} /> : null}
            <div class="fields2">
              <div class="fld grow"><label>Title</label><input type="text" name="title" value={a?.title ?? ''} /></div>
              <div class="fld grow"><label>Company / name{a ? '' : ' (required)'}</label>
                <input type="text" name="company" value={a?.company ?? ''} required={!a} /></div>
              <div class="fld w-sm"><label>From</label><input type="month" name="date_from" value={a?.date_from ?? ''} /></div>
              <div class="fld w-sm"><label>To</label>
                <input type="month" name="date_to" value={a?.date_to ?? ''} disabled={!!a && !a.date_to && !!a.date_from} /></div>
            </div>
            <label class="chk"><input type="checkbox" name="current" checked={!!a && !a.date_to && !!a.date_from}
              onchange="this.form.elements.date_to.disabled=this.checked; if(this.checked) this.form.elements.date_to.value=''" />
              I currently work here</label>
            <div class="fields2">
              {a ? (
                <div class="fld w-sm"><label>Code (template-coupled)</label>
                  <input type="text" name="new_code" placeholder={a.id} /></div>
              ) : (
                <>
                  <div class="fld w-sm"><label>Code — e.g. TD1 (required)</label><input type="text" name="code" required /></div>
                  <div class="fld"><label>Type</label>
                    <select name="kind"><option value="role">job / role</option><option value="project">project</option></select></div>
                </>
              )}
            </div>
          </form>
          <div class="rowactions">
            <button type="submit" form={fid} class="primary">{a ? 'Save role' : 'Add role'}</button>
            <a class="btnlike" href="/blocks">Cancel</a>
            {a ? (
              <>
                <span class="spacer" />
                <form class="inline" method="post" action="/roles/delete"
                  onsubmit={`return confirm('Delete role ${a.id} AND all its bullets permanently? This cannot be undone.')`}>
                  <input type="hidden" name="id" value={a.id} />
                  <button type="submit">Delete role</button>
                </form>
              </>
            ) : null}
          </div>
        </div>
      );
    };

    const roleCard = (a: AnchorOpt) => {
      const section = a.kind === 'role' ? 'experience' : 'projects';
      const bl = rows.filter((r) => r.anchor_id === a.id && r.section === section);
      const dates = fmtDates(a.date_from, a.date_to);
      const isOpen = q.editrole === a.id || q.add === a.id || bl.some((r) => r.id === q.edit);
      return (
        <details class="rc" open={isOpen}>
          <summary class="rc-head">
            <span class="caret" />
            <span class="rc-title">{a.title ?? a.company ?? a.id}</span>
            {a.title && a.company ? <span class="rc-sub">{a.company}</span> : null}
            {dates ? <span class="rc-dates">{dates}</span> : null}
            <span class="rc-meta">{bl.length} bullets · <span class="chip">{a.id}</span>
              <a class="pencil" href={`/blocks?editrole=${encodeURIComponent(a.id)}`} title="Edit role">✏️</a>
            </span>
          </summary>
          <div class="rc-body">
            {q.editrole === a.id ? roleEditor(a) : null}
            {bl.length === 0 && q.add !== a.id ? <p class="muted">no bullets yet — add the first one</p> : bl.map(bulletRow)}
            {q.add === a.id ? addPane({ section, anchor_id: a.id, tags: '' })
              : <div style="margin-top:10px">{addButton(a.id, 'Add bullet')}</div>}
          </div>
        </details>
      );
    };

    const summaryRows = rows.filter((r) => r.section === 'summary');

    return page(c, 'Blocks bank', (
      <>
        <div class="actions" style="margin-bottom:12px">
          <span><strong>{rows.length}</strong> <span class="muted">bullets</span> · <strong>{roleCount}</strong> <span class="muted">roles</span></span>
          <a class="btnlike sec" href="/blocks?addrole=1">＋ Add role</a>
          <a href="/blocks/template-check">Check template ↗</a>
        </div>
        {q.addrole ? <div class="card">{roleEditor(null)}</div> : null}

        <h2>My roles <span class="muted" style="font-weight:400">— newest first, tap to open</span></h2>
        {anchors.filter((a) => a.kind === 'role').map(roleCard)}

        <h2>My projects</h2>
        {anchors.filter((a) => a.kind === 'project').map(roleCard)}
        <p class="muted">Projects are static text in the CV template for now — these bullets are kept for the future project-tailoring option.</p>

        <h2>My skills</h2>
        {SKCATS.map((cat) => {
          const items = rows.filter((r) => r.section === 'skills' && r.skcat === cat);
          const key = `skl-${cat}`;
          return (
            <div class="card">
              <div class="actions">
                <strong style="text-transform:capitalize">{cat}</strong>
                <span class="muted">{items.length} items</span>
              </div>
              {items.length === 0 && q.add !== key ? <p class="muted">none yet</p> : items.map(bulletRow)}
              {q.add === key ? addPane({ section: 'skills', skcat: cat, tags: '' })
                : <div style="margin-top:10px">{addButton(key, `Add ${cat} skill`)}</div>}
            </div>
          );
        })}

        <h2>My summary</h2>
        <div class="card">
          <p class="muted">the opening bullets of every CV — the AI picks the best ones per job</p>
          {summaryRows.length === 0 && q.add !== 'sum' ? <p class="muted">none yet</p> : summaryRows.map(bulletRow)}
          {q.add === 'sum' ? addPane({ section: 'summary', tags: '' })
            : <div style="margin-top:10px">{addButton('sum', 'Add summary line')}</div>}
        </div>
      </>
    ));
  });

  app.post('/blocks/create', async (c) => {
    const body = await c.req.parseBody();
    const n = normalizeBlockInput(body);
    if ('error' in n) return c.redirect(`/blocks?m=${encodeURIComponent(`add failed: ${n.error}`)}`);
    const id = newBlockId(n.section);
    try {
      // Saving IS the approval (bank v4): owner-authored content enters live.
      await c.env.DB.prepare(
        `INSERT INTO blocks (id, section, anchor_id, skcat, text_en, text_es, es_status, tags, status, updated_at)
         VALUES (?,?,?,?,?,?,'approved',?,'approved',?)`,
      ).bind(id, n.section, n.anchor_id, n.skcat, n.text_en, n.text_es, n.tags, now()).run();
    } catch (err) {
      return c.redirect(`/blocks?m=${encodeURIComponent(`add failed: ${err instanceof Error ? err.message : 'db error'}`)}`);
    }
    return c.redirect(`/blocks?m=${encodeURIComponent('saved')}`);
  });

  app.post('/blocks/update', async (c) => {
    const body = await c.req.parseBody();
    const id = String(body.id ?? '');
    const n = normalizeBlockInput(body);
    if ('error' in n) return c.redirect(`/blocks?edit=${encodeURIComponent(id)}&m=${encodeURIComponent(`save failed: ${n.error}`)}`);
    try {
      const r = await c.env.DB.prepare(
        `UPDATE blocks SET section=?, anchor_id=?, skcat=?, text_en=?, text_es=?,
           es_status='approved', tags=?, status='approved', updated_at=? WHERE id=?`,
      ).bind(n.section, n.anchor_id, n.skcat, n.text_en, n.text_es, n.tags, now(), id).run();
      if (!r.meta.changes) return c.redirect('/blocks?m=block not found');
    } catch (err) {
      return c.redirect(`/blocks?edit=${encodeURIComponent(id)}&m=${encodeURIComponent(`save failed: ${err instanceof Error ? err.message : 'db error'}`)}`);
    }
    return c.redirect('/blocks?m=saved');
  });

  app.post('/blocks/delete', async (c) => {
    const b = await c.req.parseBody();
    await c.env.DB.prepare('DELETE FROM blocks WHERE id = ?').bind(String(b.id ?? '')).run();
    return c.redirect('/blocks?m=bullet deleted');
  });

  // ---------- Roles (anchors) — the missing write path (2026-07-18) ----------
  app.post('/roles/create', async (c) => {
    const b = await c.req.parseBody();
    const code = String(b.code ?? '').trim().toUpperCase();
    const kind = String(b.kind ?? 'role') === 'project' ? 'project' : 'role';
    const company = String(b.company ?? '').trim();
    const title = String(b.title ?? '').trim() || null;
    const dateFrom = normalizeMonth(String(b.date_from ?? ''));
    // "I currently work here" wins over any stale To value.
    const dateTo = b.current != null ? null : normalizeMonth(String(b.date_to ?? ''));
    if (!company) return c.redirect('/blocks?m=add role failed: company/name is required');
    const existing = ((await c.env.DB.prepare('SELECT id FROM anchors').all<{ id: string }>()).results).map((a) => a.id);
    const err = validateRoleCode(code, existing);
    if (err) return c.redirect(`/blocks?m=${encodeURIComponent(`add role failed: ${err}`)}`);
    await c.env.DB.prepare(
      "INSERT INTO anchors (id, kind, company, title, date_from, date_to, status) VALUES (?,?,?,?,?,?,'active')",
    ).bind(code, kind, company, title, dateFrom, dateTo).run();
    return c.redirect(`/blocks?m=${encodeURIComponent(
      `role ${code} added — now paste {{${code}R1}}, {{${code}R2}}, … lines into your CV template Doc (with its static header) and run Check template`,
    )}`);
  });

  app.post('/roles/update', async (c) => {
    const b = await c.req.parseBody();
    const id = String(b.id ?? '');
    const company = String(b.company ?? '').trim();
    const title = String(b.title ?? '').trim() || null;
    const dateFrom = normalizeMonth(String(b.date_from ?? ''));
    // "I currently work here" wins over any stale To value.
    const dateTo = b.current != null ? null : normalizeMonth(String(b.date_to ?? ''));
    const newCode = String(b.new_code ?? '').trim().toUpperCase();
    const row = await c.env.DB.prepare('SELECT id, kind, company FROM anchors WHERE id = ?')
      .bind(id).first<{ id: string; kind: string; company: string | null }>();
    if (!row) return c.redirect('/blocks?m=role not found');
    if (!newCode || newCode === id) {
      // Identity edit only — safe, no template coupling.
      await c.env.DB.prepare('UPDATE anchors SET company = ?, title = ?, date_from = ?, date_to = ? WHERE id = ?')
        .bind(company || row.company, title, dateFrom, dateTo, id).run();
      return c.redirect('/blocks?m=role updated');
    }
    // CODE rename: template-coupled. Refuse while {{OLD…}} tokens remain in the
    // Doc; abort on any Google failure (safe default — never rename blind).
    const existing = ((await c.env.DB.prepare('SELECT id FROM anchors WHERE id != ?').bind(id).all<{ id: string }>()).results).map((a) => a.id);
    const err = validateRoleCode(newCode, existing);
    if (err) return c.redirect(`/blocks?m=${encodeURIComponent(`rename failed: ${err}`)}`);
    try {
      if (!c.env.CV_TEMPLATE_DOC_ID) throw new Error('CV_TEMPLATE_DOC_ID not configured');
      const { googleAccessToken, readPlaceholders } = await import('../gdocs');
      const token = await googleAccessToken(c.env);
      const docTokens = await readPlaceholders(token, c.env.CV_TEMPLATE_DOC_ID);
      const leftovers = tokensOfRole(id, docTokens.map((t) => t.name));
      if (leftovers.length) {
        return c.redirect(`/blocks?m=${encodeURIComponent(
          `rename refused: the template still contains ${leftovers.slice(0, 3).join(', ')}${leftovers.length > 3 ? '…' : ''} — update the Doc to {{${newCode}R…}} first`,
        )}`);
      }
    } catch (err2) {
      return c.redirect(`/blocks?m=${encodeURIComponent(
        `rename aborted (cannot verify the template): ${err2 instanceof Error ? err2.message : 'Google unreachable'}`,
      )}`);
    }
    // FK-safe transaction: insert new id, repoint blocks, delete old id.
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO anchors (id, kind, company, title, date_from, date_to, status) VALUES (?,?,?,?,?,?,'active')")
        .bind(newCode, row.kind, company || row.company, title, dateFrom, dateTo),
      c.env.DB.prepare('UPDATE blocks SET anchor_id = ? WHERE anchor_id = ?').bind(newCode, id),
      c.env.DB.prepare('DELETE FROM anchors WHERE id = ?').bind(id),
    ]);
    return c.redirect(`/blocks?m=${encodeURIComponent(`role renamed ${id} → ${newCode} (bullets repointed)`)}`);
  });

  // Hard delete, LinkedIn-style (owner decision 2026-07-18): the role AND its
  // bullets go, permanently. The confirm dialog names both consequences.
  app.post('/roles/delete', async (c) => {
    const b = await c.req.parseBody();
    const id = String(b.id ?? '');
    if (!id) return c.redirect('/blocks?m=role not found');
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM blocks WHERE anchor_id = ?').bind(id),
      c.env.DB.prepare('DELETE FROM anchors WHERE id = ?').bind(id),
    ]);
    return c.redirect(`/blocks?m=${encodeURIComponent(
      `role ${id} and its bullets deleted — remove its {{${id}R…}} lines from the CV template Doc and run Check template`,
    )}`);
  });

  // ---------- Check template: bank ↔ Google Doc contract, both directions ----------
  app.get('/blocks/template-check', async (c) => {
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
          <p>Compared your CV template Doc ({tokenCount} tokens) against the bank ({roles.length} active roles). <a href="/blocks">← back to the Bank</a></p>
        </div>
        <div class="card">
          {findings.map((f) => <div class={cls[f.level]} style="padding:4px 0">{f.level === 'ok' ? '✓' : f.level === 'warn' ? '⚠' : '✗'} {f.text}</div>)}
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
    const contactSet = await c.env.DB.prepare("SELECT 1 FROM config WHERE key='contact_profile'").first();
    return page(c, 'CV library', (
      <>
        {!contactSet ? (
          <div class="card" style="border-color:var(--warn)">
            ⚠️ No contact profile set — generated CVs will have empty phone/location.{' '}
            <a href="/contact">Set it now →</a>
          </div>
        ) : null}
        <div class="card actions">
          <span class="muted">To generate a CV, open the job (Today or Jobs) and tap <strong>Generate CV</strong> there.</span>
          <a href="/blocks/template-check">Check template ↗</a>
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
        {pager('/cvs', pg, hasNext, {})}
      </>
    ));
  });

  // Generate CV — lives ON the job. Bank v4 (2026-07-18): everything saved is
  // live, so there is no SAMPLE mode anymore — this always queues a REAL build
  // (picked up by the next pipeline run; force one via POST /api/run).
  app.post('/jobs/:hash/cv', async (c) => {
    const hash = c.req.param('hash');
    const b = await c.req.parseBody();
    const back = String(b.back ?? '') === 'today' ? '/' : `/jobs/${hash}`;
    const j = await c.env.DB.prepare(
      'SELECT url_hash, status FROM jobs WHERE url_hash = ?',
    ).bind(hash).first<{ url_hash: string; status: string }>();
    if (!j || !['new', 'notified'].includes(j.status)) {
      return c.redirect(`${back}?m=job not found or closed`);
    }
    await c.env.DB.prepare('UPDATE jobs SET cv_pending = 1 WHERE url_hash = ?').bind(hash).run();
    return c.redirect(`${back}?m=${encodeURIComponent('CV queued — the next pipeline run builds it from your bank')}`);
  });

  // ---------- Applications (step 8: kit queue + answers bank) ----------
  app.get('/applications', async (c) => {
    const rows = (
      await c.env.DB.prepare(
        `SELECT j.url_hash, j.title, j.track, j.score, j.url, co.name company,
                a.stage, k.answers, k.red_questions, k.eeoc_questions, k.cv_doc_url kit_cv, k.deep_link, k.updated_at kit_at
         FROM jobs j JOIN companies co ON co.id = j.company_id
         LEFT JOIN applications a ON a.url_hash = j.url_hash
         LEFT JOIN application_kits k ON k.url_hash = j.url_hash
         WHERE j.verdict = 'Apply' AND j.status IN ('new','notified')
         ORDER BY j.score DESC LIMIT 100`,
      ).all<Record<string, string | number | null>>()
    ).results;
    const answersBank = (
      await c.env.DB.prepare(
        'SELECT id, question_label, answer_en, status FROM profile_answers ORDER BY status, question_label LIMIT 200',
      ).all<Record<string, string | number | null>>()
    ).results;
    // Question census: which unanswered questions recur across kits.
    const census = new Map<string, number>();
    for (const r of rows) {
      try {
        for (const q of JSON.parse(String(r.red_questions ?? '[]')) as string[]) {
          census.set(q, (census.get(q) ?? 0) + 1);
        }
      } catch { /* bad json */ }
    }
    const censusTop = [...census.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);

    return page(c, 'Applications', (
      <>
        <p class="muted">Your Apply-verdict queue. The kit assembles everything to submit in minutes — <strong>the submit click is always yours</strong>.</p>
        {rows.length === 0 ? <div class="card">No Apply-verdict jobs open right now.</div> : rows.map((r) => {
          const answers = (() => { try { return JSON.parse(String(r.answers ?? '[]')) as Array<{ question: string; answer: string | null; red: boolean }>; } catch { return []; } })();
          const red = (() => { try { return JSON.parse(String(r.red_questions ?? '[]')) as string[]; } catch { return []; } })();
          const eeoc = (() => { try { return JSON.parse(String(r.eeoc_questions ?? '[]')) as string[]; } catch { return []; } })();
          const hasKit = r.kit_at != null;
          return (
            <div class="card">
              <div class="actions">
                <a href={`/jobs/${r.url_hash}`}><strong>{r.title}</strong></a>
                <span class="muted">{r.company}</span>
                <span class="chip">{r.track}</span>
                <span class={r.stage === 'applied' ? 'ok' : 'muted'}>{r.stage ?? 'pending'}</span>
                {!hasKit ? (
                  <form class="inline" method="post" action="/applications/build">
                    <input type="hidden" name="hash" value={String(r.url_hash)} />
                    <button type="submit" class="primary">Build kit</button>
                  </form>
                ) : null}
                {r.stage !== 'applied' ? (
                  <form class="inline" method="post" action="/tracker/update">
                    <input type="hidden" name="hash" value={String(r.url_hash)} />
                    <input type="hidden" name="stage" value="applied" />
                    <button type="submit">I applied ✓</button>
                  </form>
                ) : null}
              </div>
              {hasKit ? (
                <details style="margin-top:6px">
                  <summary>Kit — {answers.filter((a) => !a.red).length} matched · {red.length} red · {eeoc.length} EEOC</summary>
                  <div style="margin-top:8px">
                    <div>{r.kit_cv ? <a href={String(r.kit_cv)} target="_blank" rel="noreferrer">CV Doc ↗</a> : <span class="warn">no CV yet — Generate CV on the job page</span>}{' · '}
                      <a href={String(r.deep_link ?? r.url)} target="_blank" rel="noreferrer">application form ↗</a></div>
                    {answers.filter((a) => !a.red).map((a) => (
                      <div class="bullet"><div class="muted">{a.question}</div><div>{a.answer}</div></div>
                    ))}
                    {red.length ? (
                      <div style="margin-top:6px"><strong class="warn">Unanswered:</strong>
                        {red.map((q) => <div class="muted">🔴 {q}</div>)}
                        <div class="muted">answer them from the Telegram kit message, or add answers below</div>
                      </div>
                    ) : null}
                    {eeoc.length ? (
                      <div style="margin-top:6px" class="muted">⚖️ EEOC ({eeoc.length}) — never auto-answered: {eeoc.map((q) => <div>· {q}</div>)}</div>
                    ) : null}
                    <div class="muted" style="margin-top:6px">Checklist: open the form → autofill from this kit → attach the PDF → review EVERYTHING → you click submit.</div>
                  </div>
                </details>
              ) : null}
            </div>
          );
        })}

        {censusTop.length ? (
          <>
            <h2>Recurring unanswered questions</h2>
            <div class="card">
              {censusTop.map(([q, n]) => <div class="bullet"><span class="chip">{n}×</span> {q}</div>)}
              <p class="muted">Add an answer once below — every future kit matches it automatically.</p>
            </div>
          </>
        ) : null}

        <h2>Answers bank ({answersBank.length})</h2>
        <div class="card">
          <form method="post" action="/applications/answer-add">
            <div class="field"><label>Question (as forms ask it)</label><input type="text" name="label" required /></div>
            <div class="field"><label>Your answer</label><textarea name="answer" required /></div>
            <div class="actions">
              <button type="submit" class="primary">Add as draft</button>
              <a href="/applications">Cancel</a>
            </div>
          </form>
        </div>
        {answersBank.map((a) => (
          <div class="card">
            <div class="muted">{a.question_label}</div>
            <div>{a.answer_en}</div>
            <div class="actions" style="margin-top:4px">
              <span class={`pill ${a.status === 'approved' ? 'approved' : 'draft'}`}>{a.status}</span>
              {a.status !== 'approved' ? (
                <form class="inline" method="post" action="/applications/answer-approve">
                  <input type="hidden" name="id" value={String(a.id)} />
                  <button type="submit" class="primary">Approve</button>
                </form>
              ) : null}
              <form class="inline" method="post" action="/applications/answer-delete"
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

  app.post('/applications/build', async (c) => {
    const b = await c.req.parseBody();
    const { buildKit } = await import('../kit/kit');
    const r = await buildKit(c.env, String(b.hash ?? ''));
    const msg = r.ok
      ? (r.detectable
        ? `kit built: ${r.matched} matched · ${r.red} red · ${r.eeoc} EEOC-flagged`
        : `kit built (this ATS does not expose its form publicly — open the form to see the questions)${r.error ? ` · ${r.error}` : ''}`)
      : `kit failed: ${r.error}`;
    return c.redirect(`/applications?m=${encodeURIComponent(msg)}`);
  });

  app.post('/applications/answer-add', async (c) => {
    const b = await c.req.parseBody();
    const label = String(b.label ?? '').trim();
    const answer = String(b.answer ?? '').trim();
    if (!label || !answer) return c.redirect('/applications?m=question and answer are required');
    const { normalizeQuestion } = await import('../kit/questions');
    await c.env.DB.prepare(
      `INSERT INTO profile_answers (question_norm, question_label, answer_en, status, updated_at)
       VALUES (?,?,?,'draft',?)
       ON CONFLICT(question_norm) DO UPDATE SET question_label=excluded.question_label,
         answer_en=excluded.answer_en, status='draft', updated_at=excluded.updated_at`,
    ).bind(normalizeQuestion(label), label, answer, now()).run();
    return c.redirect('/applications?m=answer saved as draft — approve it to use in kits');
  });

  app.post('/applications/answer-approve', async (c) => {
    const b = await c.req.parseBody();
    await c.env.DB.prepare("UPDATE profile_answers SET status='approved', updated_at=? WHERE id=?")
      .bind(now(), Number(b.id)).run();
    return c.redirect('/applications?m=answer approved');
  });

  app.post('/applications/answer-delete', async (c) => {
    const b = await c.req.parseBody();
    await c.env.DB.prepare('DELETE FROM profile_answers WHERE id=?').bind(Number(b.id)).run();
    return c.redirect('/applications?m=answer deleted');
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
    const lastRun = runs[0]?.started_at ? fmt(String(runs[0].started_at)) : '—';
    const next = nextRunAfter(new Date(), sched);
    const hourOpts = Array.from({ length: 24 }, (_, h) => h);

    return page(c, 'Health', (
      <>
        <div class="statgrid">
          <div class="stat"><div class="n">{today?.runs ?? 0}</div><div class="l">runs today</div></div>
          <div class="stat"><div class="n">{today?.peak_subreq ?? 0}/50</div><div class="l">peak subrequests</div></div>
          <div class="stat"><div class="n">{today?.writes ?? 0}</div><div class="l">D1 writes today (limit 100k)</div></div>
          <div class="stat"><div class="n">{today?.reads ?? 0}</div><div class="l">D1 reads today (limit 5M)</div></div>
        </div>
        <form method="post" action="/health/schedule" class="card actions">
          <strong>Schedule</strong>
          <label>run every{' '}
            <select name="every_hours">
              {[1, 2, 3, 4, 6, 12].map((h) => <option value={String(h)} selected={h === sched.every_hours}>{h}h</option>)}
            </select>
          </label>
          <label>from{' '}
            <select name="start_hour">
              {hourOpts.map((h) => <option value={String(h)} selected={h === sched.start_hour}>{h}:00</option>)}
            </select>
          </label>
          <label>to{' '}
            <select name="end_hour">
              {hourOpts.map((h) => <option value={String(h)} selected={h === sched.end_hour}>{h}:00</option>)}
            </select>
          </label>
          <select name="timezone">
            {SCHEDULE_TIMEZONES.map((tz) => <option value={tz} selected={tz === sched.timezone}>{tz}</option>)}
          </select>
          <button type="submit" class="primary">Save schedule</button>
          <span class="muted">last run {lastRun} UTC · next expected {next ? fmt(next.toISOString()) : '—'} UTC</span>
        </form>
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
        {pager('/health', pg, runsHasNext, {})}
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
    const sched = normalizeSchedule({
      every_hours: Number(b.every_hours), start_hour: Number(b.start_hour),
      end_hour: Number(b.end_hour), timezone: String(b.timezone ?? ''),
    });
    await c.env.DB.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('schedule', ?)")
      .bind(JSON.stringify(sched)).run();
    return c.redirect(`/health?m=${encodeURIComponent(
      `schedule saved: every ${sched.every_hours}h, ${sched.start_hour}:00–${sched.end_hour}:00 ${sched.timezone}`,
    )}`);
  });

  return app;
}

// Console v1 (UI.md §2): Today (triage), Jobs, Companies, Calibration, Health.
// Pure server-rendered: every mutation is a real <form>. htmx arrives in v2.

import { Hono, type Context } from 'hono';
import type { Child } from 'hono/jsx';
import { Layout, type FooterStatus } from './layout';
import { authMiddleware, createSession, setSessionCookie, verifyPassword, type ConsoleEnv } from './auth';
import { validateScoringConfig } from '../config-store';
import * as greenhouse from '../connectors/greenhouse';
import type { Company } from '../types';
import type { ScoreResult } from '../scoring';

type App = Hono<{ Bindings: ConsoleEnv }>;

export function consoleApp(): App {
  const app: App = new Hono();
  app.use('*', authMiddleware());

  // ---------- helpers ----------
  const now = () => new Date().toISOString();
  const fmt = (iso: string | null | undefined) => (iso ? iso.slice(5, 16).replace('T', ' ') : '—');

  // Pagination: 50/page. Query with `LIMIT PAGE+1 OFFSET pg*PAGE`, then if
  // more than PAGE rows came back there's a next page (drop the extra row).
  const PAGE = 50;
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
        (SELECT value FROM config WHERE key='weekly_goal') goal,
        (SELECT status FROM runs ORDER BY id DESC LIMIT 1) run_status`,
    ).first<{ applied_week: number; goal: string | null; run_status: string | null }>();

    const rows = (
      await c.env.DB.prepare(
        `SELECT j.url_hash, j.title, j.location, j.track, j.verdict, j.score, j.url, j.posted_at,
                j.why_it_fits, j.positioning_lead, c.name company
         FROM jobs j
         JOIN companies c ON c.id = j.company_id
         LEFT JOIN applications a ON a.url_hash = j.url_hash
         WHERE j.status IN ('new','notified') AND j.verdict != 'Skip'
           AND (a.url_hash IS NULL OR (a.stage='prepared' AND a.snoozed_until IS NOT NULL AND a.snoozed_until <= ?))
         ORDER BY j.score DESC, j.first_seen DESC LIMIT 50`,
      ).bind(nowIso).all<Record<string, string | number>>()
    ).results;

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
      ['System', '/week', `${strip?.applied_week ?? 0}/${strip?.goal ?? '5'}`, 'applied this week'],
      ['System', '/health', strip?.run_status ?? '—', 'last run'],
    ];

    return page(c, 'Today', (
      <>
        <div class="statgrid">
          <div class="stat"><div class="n">{rows.length}</div><div class="l">pending triage</div></div>
          <div class="stat"><div class="n">{strip?.applied_week ?? 0}/{strip?.goal ?? '5'}</div><div class="l">applied this week</div></div>
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
        {rows.length === 0 ? <div class="card">Triage up to date ✓</div> : null}
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
              {(['prepared|Prepare', 'applied|Applied', 'dismissed|Dismiss'] as const).map((x) => {
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
            </div>
          </div>
        ))}
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
        <form method="get" action="/jobs" class="card actions">
          {sel('track', ['canada_coop', 'colombia_perm', 'contractor_usd'], q.track)}
          {sel('verdict', ['Apply', 'Stretch-worth-it', 'Skip'], q.verdict)}
          {sel('status', ['new', 'notified', 'closed', 'skipped'], q.status)}
          <input type="text" name="q" placeholder="search in title" value={q.q ?? ''} />
          <button type="submit" class="primary">Filter</button>
          <a href="/jobs?verdict=Apply&status=new">Apply pending</a>
          <a href="/jobs?status=notified">Notified</a>
        </form>
        <div class="table-wrap"><table>
          <tr><th>title</th><th class="hide-sm">company</th><th class="hide-sm">track</th><th>score</th><th>verdict</th><th class="hide-sm">status</th><th class="hide-sm">stage</th><th class="hide-sm">seen</th></tr>
          {rows.map((j) => (
            <tr>
              <td><a href={`/jobs/${j.url_hash}`}>{j.title}</a><div class="muted">{j.company} · {j.location}</div></td>
              <td class="hide-sm">{j.company}</td>
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
          <div style="margin-top:6px"><a href={String(j.url)} target="_blank" rel="noreferrer">open job ↗</a></div>
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
    const rows = (
      await c.env.DB.prepare(
        `SELECT c.id, c.name, c.ats, c.token, c.active, c.fail_count, c.last_ok_fetch, c.last_error, c.notes,
                COUNT(j.url_hash) jobs_seen,
                SUM(CASE WHEN j.verdict IN ('Apply','Stretch-worth-it') THEN 1 ELSE 0 END) survivors
         FROM companies c
         LEFT JOIN jobs j ON j.company_id = c.id AND j.first_seen >= datetime('now','-90 days')
         GROUP BY c.id ORDER BY survivors DESC, c.name`,
      ).all<Record<string, string | number | null>>()
    ).results;

    return page(c, 'Companies', (
      <>
        <form method="post" action="/companies" class="card actions">
          <input type="text" name="name" placeholder="name" required />
          <select name="ats"><option>greenhouse</option><option>lever</option><option>ashby</option></select>
          <input type="text" name="token" placeholder="board token" required />
          <input type="text" name="notes" placeholder="notes" />
          <button type="submit" class="primary">Add and test</button>
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

  // ---------- Calibration ----------
  app.get('/config', async (c) => {
    const rows = (
      await c.env.DB.prepare("SELECT key, value FROM config WHERE key IN ('scoring','FRESHNESS_MAX_DAYS','weekly_goal')").all<{ key: string; value: string }>()
    ).results;
    const cfg = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    let thresholds = { apply: 75, stretch: 55 };
    try { thresholds = (JSON.parse(cfg.scoring ?? '{}') as { thresholds: typeof thresholds }).thresholds ?? thresholds; } catch { /* raw */ }
    const history = (
      await c.env.DB.prepare('SELECT id, ts, key, replay_summary FROM config_history ORDER BY id DESC LIMIT 10')
        .all<{ id: number; ts: string; key: string; replay_summary: string | null }>()
    ).results;

    return page(c, 'Calibration', (
      <>
        <div class="card actions"><a href="/contact">Contact profile →</a> <span class="muted">phone / location filled into CV templates per track</span></div>
        <form method="post" action="/config/quick" class="card actions">
          <label>Apply ≥ <input type="number" name="apply" value={String(thresholds.apply)} style="width:70px" /></label>
          <label>Stretch ≥ <input type="number" name="stretch" value={String(thresholds.stretch)} style="width:70px" /></label>
          <label>Freshness days <input type="number" name="freshness" value={cfg.FRESHNESS_MAX_DAYS ?? '3'} style="width:60px" /></label>
          <label>Weekly goal <input type="number" name="goal" value={cfg.weekly_goal ?? '5'} style="width:60px" /></label>
          <button type="submit" class="primary">Save</button>
        </form>
        <form method="post" action="/config/scoring" class="card">
          <h2 style="margin-top:0">Scoring config (full JSON — advanced)</h2>
          <textarea name="scoring" rows={22}>{cfg.scoring ?? ''}</textarea>
          <div class="actions" style="margin-top:8px">
            <button type="submit" class="primary">Validate and save</button>
            <button type="submit" formaction="/config/replay">🔬 Simulate with Replay before saving</button>
            <label>against last <input type="number" name="n" value="200" min="50" max="1000" style="width:80px" /> jobs</label>
          </div>
        </form>
        <div class="card">
          <h2 style="margin-top:0">History</h2>
          <div class="table-wrap"><table>
            {history.map((h) => (
              <tr>
                <td class="muted">{fmt(h.ts)}</td>
                <td>{h.key}</td>
                <td class="muted">{h.replay_summary ? 'with replay' : ''}</td>
                <td>
                  <form class="inline" method="post" action="/config/revert">
                    <input type="hidden" name="id" value={String(h.id)} />
                    <button type="submit">revert to previous version</button>
                  </form>
                </td>
              </tr>
            ))}
          </table></div>
        </div>
      </>
    ));
  });

  async function saveConfig(env: ConsoleEnv, key: string, value: string): Promise<void> {
    const old = await env.DB.prepare('SELECT value FROM config WHERE key = ?').bind(key).first<{ value: string }>();
    await env.DB.batch([
      env.DB.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').bind(key, value),
      env.DB.prepare('INSERT INTO config_history (ts, key, old_value, new_value) VALUES (?, ?, ?, ?)')
        .bind(now(), key, old?.value ?? null, value),
    ]);
  }

  // ---------- Contact profile (private; fills CV template placeholders) ----------
  // Top-level simple fields (phone/location feed the CV header per track).
  const CONTACT_FIELDS: Array<[string, string]> = [
    ['phone_ca', 'Canadian phone (canada_coop)'],
    ['phone_co', 'Colombian phone (colombia_perm & contractor_usd)'],
    ['location_ca', 'Canada location for CV header (e.g. Vancouver, BC, Canada)'],
    ['location_co', 'Colombia location for CV header (e.g. Medellín, Colombia)'],
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
      <div style="margin-bottom:10px">
        <label style="display:block; font-size:13px; color:var(--muted)">{label}</label>
        <input type="text" name={name} value={value} style="width:100%; max-width:520px" />
      </div>
    );
    return page(c, 'Contact profile', (
      <>
        <div class="card">
          <p class="muted">Private data — stored only in D1, never in the repo. The CV header uses <code>{'{{phone}}'}</code> and <code>{'{{location}}'}</code> filled per track (name/email/LinkedIn are hardcoded in the template). The structured addresses below are stored only for step-8 application forms and never shown in the CV.</p>
        </div>
        <form method="post" action="/contact" class="card">
          <h2 style="margin-top:0">Phone & CV location</h2>
          {CONTACT_FIELDS.map(([key, label]) => field(key, label, str(profile[key])))}
          <h2>Canada address (forms)</h2>
          {ADDR_CA.map(([key, label]) => field(`address_ca__${key}`, label, addr('address_ca')[key] ?? ''))}
          <h2>Colombia address (forms)</h2>
          {ADDR_CO.map(([key, label]) => field(`address_co__${key}`, label, addr('address_co')[key] ?? ''))}
          <button type="submit" class="primary">Save contact profile</button>
        </form>
      </>
    ));
  });

  app.post('/contact', async (c) => {
    const b = await c.req.parseBody();
    const profile: Record<string, unknown> = {};
    for (const [key] of CONTACT_FIELDS) profile[key] = String(b[key] ?? '').trim();
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
      const cfg = JSON.parse(raw.value) as { thresholds: { apply: number; stretch: number } };
      cfg.thresholds = { apply: Number(b.apply), stretch: Number(b.stretch) };
      validateScoringConfig(cfg);
      await saveConfig(c.env, 'scoring', JSON.stringify(cfg));
    }
    await saveConfig(c.env, 'FRESHNESS_MAX_DAYS', String(Number(b.freshness ?? 3)));
    await saveConfig(c.env, 'weekly_goal', String(Number(b.goal ?? 5)));
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
         WHERE a.stage != 'dismissed' ORDER BY a.updated_at DESC`,
      ).all<Record<string, string | number | null>>()
    ).results;
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
    const goal = Number((await c.env.DB.prepare("SELECT value FROM config WHERE key='weekly_goal'").first<{ value: string }>())?.value ?? 5);
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
          <div class="stat"><div class="n">{cur.applied}/{goal}</div><div class="l">applied vs goal</div></div>
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
      const parsed = JSON.parse(String(b.scoring ?? ''));
      validateScoringConfig(parsed);
      await c.env.DB.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('scoring_draft', ?)")
        .bind(JSON.stringify(parsed)).run();
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
              <button type="submit" class="primary">Save and activate</button>
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
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('scoring', ?)").bind(draft.value),
      c.env.DB.prepare("DELETE FROM config WHERE key='scoring_draft'"),
      c.env.DB.prepare('INSERT INTO config_history (ts, key, old_value, new_value, replay_summary) VALUES (?, ?, ?, ?, ?)')
        .bind(now(), 'scoring', old?.value ?? null, draft.value, String(b.summary ?? '')),
    ]);
    return c.redirect('/config?m=draft activated (replay saved to history)');
  });

  app.post('/config/replay/discard', async (c) => {
    await c.env.DB.prepare("DELETE FROM config WHERE key='scoring_draft'").run();
    return c.redirect('/config?m=draft discarded');
  });

  app.post('/config/revert', async (c) => {
    const b = await c.req.parseBody();
    const row = await c.env.DB.prepare('SELECT key, old_value FROM config_history WHERE id = ?')
      .bind(Number(b.id)).first<{ key: string; old_value: string | null }>();
    if (!row?.old_value) return c.redirect('/config?m=nothing to revert');
    await saveConfig(c.env, row.key, row.old_value);
    return c.redirect(`/config?m=${encodeURIComponent(`reverted: ${row.key}`)}`);
  });

  // ---------- Bank ----------
  app.get('/blocks', async (c) => {
    const total = await c.env.DB.prepare('SELECT COUNT(*) n FROM blocks').first<{ n: number }>();
    if ((total?.n ?? 0) === 0) {
      return page(c, 'Blocks bank', (
        <div class="card"><p>The bank is not yet seeded in the database (step 6 seeds).</p></div>
      ));
    }
    const q = c.req.query();
    const where: string[] = ['1=1'];
    const binds: unknown[] = [];
    for (const f of ['section', 'anchor_id', 'angle', 'status', 'es_status'] as const) {
      if (q[f]) { where.push(`${f} = ?`); binds.push(q[f]); }
    }
    // Filter option lists (distinct values)
    const distinct = async (col: string) =>
      (await c.env.DB.prepare(`SELECT DISTINCT ${col} v FROM blocks WHERE ${col} IS NOT NULL ORDER BY ${col}`).all<{ v: string }>())
        .results.map((r) => r.v);
    const [anchors, angles] = await Promise.all([distinct('anchor_id'), distinct('angle')]);

    const counts = await c.env.DB.prepare(
      "SELECT COUNT(*) total, SUM(status='approved') approved, SUM(es_status='approved') es_ok FROM blocks",
    ).first<{ total: number; approved: number; es_ok: number }>();

    const pg = pageNum(c);
    const rows = (
      await c.env.DB.prepare(
        `SELECT id, section, anchor_id, angle, status, es_status, tags, text_en FROM blocks
         WHERE ${where.join(' AND ')} ORDER BY section, anchor_id, id LIMIT ${PAGE + 1} OFFSET ${pg * PAGE}`,
      ).bind(...binds).all<Record<string, string | null>>()
    ).results;
    const hasNext = rows.length > PAGE;
    if (hasNext) rows.pop();

    const sel = (name: string, opts: string[], current?: string) => (
      <select name={name}>
        <option value="">({name})</option>
        {opts.map((o) => <option value={o} selected={o === current}>{o}</option>)}
      </select>
    );
    // Group visible rows by section for readability
    const bySection = new Map<string, typeof rows>();
    for (const b of rows) {
      const s = String(b.section);
      if (!bySection.has(s)) bySection.set(s, []);
      bySection.get(s)!.push(b);
    }

    return page(c, 'Blocks bank', (
      <>
        <div class="statgrid">
          <div class="stat"><div class="n">{counts?.approved ?? 0}/{counts?.total ?? 0}</div><div class="l">approved blocks</div></div>
          <div class="stat"><div class="n">{counts?.es_ok ?? 0}/{counts?.total ?? 0}</div><div class="l">ES parity approved</div></div>
        </div>
        <form method="get" action="/blocks" class="card actions">
          {sel('section', ['summary', 'skills', 'experience', 'projects'], q.section)}
          {sel('anchor_id', anchors, q.anchor_id)}
          {sel('angle', angles, q.angle)}
          {sel('status', ['draft', 'review', 'approved', 'retired'], q.status)}
          {sel('es_status', ['missing', 'draft', 'approved'], q.es_status)}
          <button type="submit" class="primary">Filter</button>
          <a href="/blocks">Clear</a>
        </form>
        <div class="card actions">
          <form class="inline" method="post" action="/blocks/approve-all">
            <button type="submit" class="primary">Approve the ENTIRE bank (EN + ES)</button>
          </form>
          <span class="muted">Light review: look at the SAMPLE CVs in /cvs; if they represent you, approve everything here.</span>
        </div>
        {[...bySection.entries()].map(([section, brows]) => (
          <>
            <h2>{section} ({brows.length})</h2>
            <div class="table-wrap"><table>
              <tr><th>id</th><th class="hide-sm">anchor</th><th class="hide-sm">angle</th><th>status</th><th>ES</th><th class="hide-sm">text (EN)</th><th></th></tr>
              {brows.map((b) => (
                <tr>
                  <td class="muted">{b.id}</td>
                  <td class="hide-sm muted">{b.anchor_id ?? '—'}</td>
                  <td class="hide-sm">{b.angle ?? '—'}</td>
                  <td class={b.status === 'approved' ? 'ok' : 'warn'}>{b.status}</td>
                  <td class={b.es_status === 'approved' ? 'ok' : 'muted'}>{b.es_status}</td>
                  <td class="hide-sm">{String(b.text_en ?? '').slice(0, 90)}…</td>
                  <td>
                    {b.status !== 'approved' ? (
                      <form class="inline" method="post" action="/blocks/approve">
                        <input type="hidden" name="id" value={String(b.id)} />
                        <button type="submit">approve</button>
                      </form>
                    ) : (
                      <form class="inline" method="post" action="/blocks/retire">
                        <input type="hidden" name="id" value={String(b.id)} />
                        <button type="submit">retire</button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </table></div>
          </>
        ))}
        {pager('/blocks', pg, hasNext, { section: q.section, anchor_id: q.anchor_id, angle: q.angle, status: q.status, es_status: q.es_status })}
      </>
    ));
  });

  app.post('/blocks/approve', async (c) => {
    const b = await c.req.parseBody();
    await c.env.DB.prepare(
      "UPDATE blocks SET status='approved', es_status = CASE WHEN text_es IS NOT NULL THEN 'approved' ELSE es_status END, updated_at=? WHERE id=?",
    ).bind(now(), String(b.id)).run();
    return c.redirect('/blocks?m=approved');
  });

  app.post('/blocks/retire', async (c) => {
    const b = await c.req.parseBody();
    await c.env.DB.prepare("UPDATE blocks SET status='retired', updated_at=? WHERE id=?")
      .bind(now(), String(b.id)).run();
    return c.redirect('/blocks?m=retired (never deleted)');
  });

  app.post('/blocks/approve-all', async (c) => {
    await c.env.DB.prepare(
      "UPDATE blocks SET status='approved', es_status = CASE WHEN text_es IS NOT NULL THEN 'approved' ELSE es_status END, updated_at=? WHERE status IN ('draft','review')",
    ).bind(now()).run();
    return c.redirect('/blocks?m=entire bank approved');
  });

  // ---------- CVs ----------
  app.get('/cvs', async (c) => {
    const cvs = (
      await c.env.DB.prepare(
        `SELECT v.id, v.doc_url, v.lang, v.sample, v.pending, v.created_at, v.rationale, v.verifier_notes,
                j.title, co.name company
         FROM cvs v JOIN jobs j ON j.url_hash = v.url_hash JOIN companies co ON co.id = j.company_id
         ORDER BY v.id DESC LIMIT 50`,
      ).all<Record<string, string | number | null>>()
    ).results;
    const candidates = (
      await c.env.DB.prepare(
        `SELECT j.url_hash, j.title, co.name company FROM jobs j JOIN companies co ON co.id = j.company_id
         WHERE j.verdict IN ('Apply','Stretch-worth-it') AND j.status IN ('new','notified')
         ORDER BY j.score DESC LIMIT 30`,
      ).all<Record<string, string>>()
    ).results;
    const contactSet = await c.env.DB.prepare("SELECT 1 FROM config WHERE key='contact_profile'").first();
    return page(c, 'CV library', (
      <>
        {!contactSet ? (
          <div class="card" style="border-color:var(--warn)">
            ⚠️ No contact profile set — generated CVs will have empty phone/location.{' '}
            <a href="/contact">Set it now →</a>
          </div>
        ) : null}
        <form method="post" action="/cvs/sample" class="card actions">
          <strong>Generate SAMPLE CV</strong>
          <select name="hash">
            {candidates.map((j) => <option value={j.url_hash}>{`${j.title!.slice(0, 50)} @ ${j.company}`}</option>)}
          </select>
          <select name="lang"><option value="en">EN</option><option value="es">ES</option></select>
          <button type="submit" class="primary">Generate (uses draft blocks — review only)</button>
        </form>
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
      </>
    ));
  });

  app.post('/cvs/sample', async (c) => {
    const b = await c.req.parseBody();
    const hash = String(b.hash ?? '');
    const lang = b.lang === 'es' ? 'es' : 'en';
    const j = await c.env.DB.prepare(
      `SELECT j.url_hash, j.title, j.location, j.description_text, j.track, j.url, j.ext_id, j.ats, co.name company
       FROM jobs j JOIN companies co ON co.id = j.company_id WHERE j.url_hash = ?`,
    ).bind(hash).first<Record<string, string | null>>();
    if (!j) return c.redirect('/cvs?m=job not found');
    const { generateCv } = await import('../ia/cv_factory');
    const fx = await generateCv(c.env, {
      id: String(j.ext_id ?? ''), company: String(j.company), title: String(j.title),
      location: String(j.location ?? ''), url: String(j.url), description: String(j.description_text ?? ''),
      posted_at: null, ats: (j.ats ?? 'greenhouse') as 'greenhouse', raw: null,
      url_hash: hash, track: j.track ?? null,
    }, lang, true);
    return c.redirect(`/cvs?m=${encodeURIComponent(fx.ok ? `sample generated: review it in Drive` : `FAILED: ${fx.error}`)}`);
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
        'SELECT ts, type, severity, detail FROM events ORDER BY id DESC LIMIT 20',
      ).all<Record<string, string>>()
    ).results;
    const today = await c.env.DB.prepare(
      "SELECT MAX(subrequests) peak_subreq, SUM(d1_reads) reads, SUM(d1_writes) writes, COUNT(*) runs FROM runs WHERE date(started_at) = date('now')",
    ).first<{ peak_subreq: number; reads: number; writes: number; runs: number }>();

    return page(c, 'Health', (
      <>
        <div class="statgrid">
          <div class="stat"><div class="n">{today?.runs ?? 0}</div><div class="l">runs today</div></div>
          <div class="stat"><div class="n">{today?.peak_subreq ?? 0}/50</div><div class="l">peak subrequests</div></div>
          <div class="stat"><div class="n">{today?.writes ?? 0}</div><div class="l">D1 writes today (limit 100k)</div></div>
          <div class="stat"><div class="n">{today?.reads ?? 0}</div><div class="l">D1 reads today (limit 5M)</div></div>
        </div>
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

  // Redirects from the old Spanish routes (bookmarks)
  app.get('/semana', (c) => c.redirect('/week'));
  app.get('/salud', (c) => c.redirect('/health'));

  return app;
}

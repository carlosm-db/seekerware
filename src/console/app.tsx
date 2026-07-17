// Consola v1 (UI.md §2): Hoy (triage), Vacantes, Empresas, Calibracion, Salud.
// Server-rendered puro: cada mutacion es un <form> real. htmx llega en v2.

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
            <input type="password" name="password" placeholder="contraseña" autofocus />
            <button type="submit">Entrar</button>
          </form>
        </body>
      </html>,
    ),
  );

  app.post('/login', async (c) => {
    const body = await c.req.parseBody();
    const ok = await verifyPassword(c.env, String(body.password ?? ''));
    if (!ok) {
      await new Promise((r) => setTimeout(r, 500)); // freno anti fuerza bruta
      return c.redirect('/login');
    }
    setSessionCookie(c, await createSession(c.env));
    return c.redirect('/');
  });

  // ---------- Hoy (triage) ----------
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

    const health = strip?.run_status === 'ok' ? <span class="ok">verde</span>
      : strip?.run_status ? <span class="warn">{strip.run_status}</span> : <span class="muted">sin runs</span>;

    return page(c, 'Hoy', (
      <>
        <div class="statgrid">
          <div class="stat"><div class="n">{rows.length}</div><div class="l">pendientes de triage</div></div>
          <div class="stat"><div class="n">{strip?.applied_week ?? 0}/{strip?.goal ?? '5'}</div><div class="l">aplicadas esta semana</div></div>
          <div class="stat"><div class="n">{health}</div><div class="l">salud del sistema</div></div>
        </div>
        {rows.length === 0 ? <div class="card">Triage al dia ✓</div> : null}
        {rows.map((j) => (
          <div class="card">
            <div>
              <a href={`/jobs/${j.url_hash}`}><strong>{j.title}</strong></a> — {j.company}
              {' '}<span class="muted">📍 {j.location || 'sin ubicacion'}</span>
            </div>
            <div style="margin:4px 0">
              <span class={`v-${j.verdict}`}>{j.verdict}</span> · {j.score}/100 ·{' '}
              <span class="chip">{j.track}</span>
              {' '}<a href={String(j.url)} target="_blank" rel="noreferrer">ver vacante ↗</a>
            </div>
            <div class="muted">{j.why_it_fits} · {j.positioning_lead}</div>
            <div class="actions" style="margin-top:8px">
              {(['prepared|Preparar', 'applied|Aplicado', 'dismissed|Descartar'] as const).map((x) => {
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
                <button type="submit">Posponer 3d</button>
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
    if (!hash || !action) return c.redirect('/?m=accion invalida');
    if (action === 'snooze3') {
      const until = new Date(Date.now() + 3 * 86400000).toISOString();
      await c.env.DB.prepare(
        `INSERT INTO applications (url_hash, stage, snoozed_until, updated_at) VALUES (?, 'prepared', ?, ?)
         ON CONFLICT(url_hash) DO UPDATE SET snoozed_until = ?, updated_at = ?`,
      ).bind(hash, until, ts, until, ts).run();
      await jobEvent(c.env, hash, 'snoozed', 'hasta ' + until.slice(0, 10));
      return c.redirect('/?m=pospuesto 3 dias');
    }
    const appliedAt = action === 'applied' ? ts : null;
    await c.env.DB.prepare(
      `INSERT INTO applications (url_hash, stage, applied_at, snoozed_until, updated_at) VALUES (?, ?, ?, NULL, ?)
       ON CONFLICT(url_hash) DO UPDATE SET stage = ?, applied_at = COALESCE(?, applied_at), snoozed_until = NULL, updated_at = ?`,
    ).bind(hash, action, appliedAt, ts, action, appliedAt, ts).run();
    await jobEvent(c.env, hash, `stage:${action}`);
    return c.redirect(`/?m=${action}`);
  });

  // ---------- Vacantes ----------
  app.get('/jobs', async (c) => {
    const q = c.req.query();
    const where: string[] = ['1=1'];
    const binds: unknown[] = [];
    if (q.track) { where.push('j.track = ?'); binds.push(q.track); }
    if (q.verdict) { where.push('j.verdict = ?'); binds.push(q.verdict); }
    if (q.status) { where.push('j.status = ?'); binds.push(q.status); }
    if (q.q) { where.push('j.title LIKE ?'); binds.push(`%${q.q}%`); }
    const rows = (
      await c.env.DB.prepare(
        `SELECT j.url_hash, j.title, j.location, j.track, j.verdict, j.score, j.status, j.posted_at,
                j.first_seen, c.name company, a.stage
         FROM jobs j JOIN companies c ON c.id = j.company_id
         LEFT JOIN applications a ON a.url_hash = j.url_hash
         WHERE ${where.join(' AND ')}
         ORDER BY j.first_seen DESC, j.score DESC LIMIT 100`,
      ).bind(...binds).all<Record<string, string | number | null>>()
    ).results;

    const sel = (name: string, opts: string[], current?: string) => (
      <select name={name}>
        <option value="">({name})</option>
        {opts.map((o) => <option value={o} selected={o === current}>{o}</option>)}
      </select>
    );

    return page(c, 'Vacantes', (
      <>
        <form method="get" action="/jobs" class="card actions">
          {sel('track', ['canada_coop', 'colombia_perm', 'contractor_usd'], q.track)}
          {sel('verdict', ['Apply', 'Stretch-worth-it', 'Skip'], q.verdict)}
          {sel('status', ['new', 'notified', 'closed', 'skipped'], q.status)}
          <input type="text" name="q" placeholder="buscar en titulo" value={q.q ?? ''} />
          <button type="submit" class="primary">Filtrar</button>
          <a href="/jobs?verdict=Apply&status=new">Apply pendientes</a>
          <a href="/jobs?status=notified">Notificados</a>
        </form>
        <table>
          <tr><th>titulo</th><th>empresa</th><th>track</th><th>score</th><th>verdict</th><th>status</th><th>stage</th><th>visto</th></tr>
          {rows.map((j) => (
            <tr>
              <td><a href={`/jobs/${j.url_hash}`}>{j.title}</a><div class="muted">{j.location}</div></td>
              <td>{j.company}</td>
              <td>{j.track ?? '—'}</td>
              <td>{j.score}</td>
              <td class={`v-${j.verdict}`}>{j.verdict}</td>
              <td class={`s-${j.status}`}>{j.status}</td>
              <td>{j.stage ?? '—'}</td>
              <td class="muted">{fmt(String(j.first_seen))}</td>
            </tr>
          ))}
        </table>
        <p class="muted">{rows.length} filas (max 100)</p>
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
    try { breakdown = JSON.parse(String(j.score_breakdown ?? '')) as ScoreResult; } catch { /* sin breakdown */ }

    return page(c, String(j.title), (
      <>
        <div class="card">
          <div><strong>{j.company}</strong> · 📍 {j.location || '—'} · <span class={`v-${j.verdict}`}>{j.verdict}</span> · {j.score}/100 · <span class="chip">{j.track ?? '—'}</span> · <span class={`s-${j.status}`}>{j.status}</span></div>
          <div class="muted">publicado: {fmt(j.posted_at as string)} · visto: {fmt(j.first_seen as string)} · notificado: {fmt(j.notified_at as string)}</div>
          <div style="margin-top:6px"><a href={String(j.url)} target="_blank" rel="noreferrer">abrir vacante ↗</a></div>
        </div>
        {breakdown ? (
          <div class="card">
            <h2 style="margin-top:0">Desglose del score</h2>
            <table>
              <tr><th>categoria</th><th>matches</th><th>norm</th><th>puntos</th></tr>
              {Object.entries(breakdown.breakdown).map(([cat, b]) => (
                <tr>
                  <td>{cat}</td>
                  <td>{b.matches.map((m) => <span class="chip">{m.term}{m.in_title ? ' ×2' : ''}{m.weight < 0 ? ' (−)' : ''}</span>)}</td>
                  <td>{b.normalized.toFixed(2)}</td>
                  <td>{b.points.toFixed(1)}</td>
                </tr>
              ))}
            </table>
            <h2>Gates por track</h2>
            <table>
              <tr><th>track</th><th>verdict</th><th>score aj.</th><th>gates</th></tr>
              {Object.entries(breakdown.tracks).map(([t, r]) => (
                <tr>
                  <td>{t}</td>
                  <td class={`v-${r.verdict}`}>{r.verdict}</td>
                  <td>{r.adjusted_score}</td>
                  <td>{r.gates.map((g) => <div class={g.passed ? 'ok' : 'bad'}>{g.passed ? '✓' : '✗'} {g.id} <span class="muted">({g.evidence})</span></div>)}</td>
                </tr>
              ))}
            </table>
            {breakdown.near_miss_reason ? <p class="warn">por que no: {breakdown.near_miss_reason}</p> : null}
          </div>
        ) : null}
        <div class="card">
          <details><summary>descripcion completa</summary><p>{j.description_text}</p></details>
        </div>
        <div class="card">
          <h2 style="margin-top:0">Historial</h2>
          {events.length === 0 ? <p class="muted">sin eventos</p> : (
            <table>{events.map((e) => <tr><td class="muted">{fmt(e.ts)}</td><td>{e.actor}</td><td>{e.event}</td><td class="muted">{e.detail}</td></tr>)}</table>
          )}
        </div>
      </>
    ));
  });

  // ---------- Empresas ----------
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

    return page(c, 'Empresas', (
      <>
        <form method="post" action="/companies" class="card actions">
          <input type="text" name="name" placeholder="nombre" required />
          <select name="ats"><option>greenhouse</option><option>lever</option><option>ashby</option></select>
          <input type="text" name="token" placeholder="token del board" required />
          <input type="text" name="notes" placeholder="notas" />
          <button type="submit" class="primary">Agregar y probar</button>
        </form>
        <table>
          <tr><th>empresa</th><th>ats</th><th>token</th><th>activa</th><th>salud</th><th>jobs 90d</th><th>survivors</th><th>yield</th></tr>
          {rows.map((r) => (
            <tr>
              <td>{r.name}<div class="muted">{r.notes}</div></td>
              <td>{r.ats}</td>
              <td class="muted">{r.token}</td>
              <td>
                <form class="inline" method="post" action="/companies/toggle">
                  <input type="hidden" name="id" value={String(r.id)} />
                  <button type="submit">{r.active ? '✅ si' : '⛔ no'}</button>
                </form>
              </td>
              <td>{Number(r.fail_count) > 0 ? <span class="bad">{r.fail_count} fallos · {r.last_error}</span> : <span class="ok">ok {fmt(r.last_ok_fetch as string)}</span>}</td>
              <td>{r.jobs_seen}</td>
              <td>{r.survivors ?? 0}</td>
              <td>{Number(r.jobs_seen) > 0 ? `${((Number(r.survivors ?? 0) / Number(r.jobs_seen)) * 100).toFixed(1)}%` : '—'}</td>
            </tr>
          ))}
        </table>
      </>
    ));
  });

  app.post('/companies', async (c) => {
    const b = await c.req.parseBody();
    const name = String(b.name ?? '').trim();
    const ats = String(b.ats ?? 'greenhouse');
    const token = String(b.token ?? '').trim();
    const notes = String(b.notes ?? '');
    if (!name || !token) return c.redirect('/companies?m=faltan campos');
    let probe = 'connector pendiente (paso 5): guardada inactiva';
    let active = 0;
    if (ats === 'greenhouse') {
      try {
        const jobs = await greenhouse.fetchJobs({ id: 0, name, ats: 'greenhouse', token, active: true } as Company);
        probe = `token OK: ${jobs.length} jobs en el board`;
        active = 1;
      } catch (err) {
        probe = `token FALLO: ${err instanceof Error ? err.message : 'error'} — guardada inactiva`;
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
    return c.redirect('/companies?m=actualizada');
  });

  // ---------- Calibracion ----------
  app.get('/config', async (c) => {
    const rows = (
      await c.env.DB.prepare("SELECT key, value FROM config WHERE key IN ('scoring','FRESHNESS_MAX_DAYS','weekly_goal')").all<{ key: string; value: string }>()
    ).results;
    const cfg = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    let thresholds = { apply: 75, stretch: 55 };
    try { thresholds = (JSON.parse(cfg.scoring ?? '{}') as { thresholds: typeof thresholds }).thresholds ?? thresholds; } catch { /* raw */ }
    const history = (
      await c.env.DB.prepare('SELECT ts, key FROM config_history ORDER BY id DESC LIMIT 10').all<{ ts: string; key: string }>()
    ).results;

    return page(c, 'Calibracion', (
      <>
        <form method="post" action="/config/quick" class="card actions">
          <label>Apply ≥ <input type="number" name="apply" value={String(thresholds.apply)} style="width:70px" /></label>
          <label>Stretch ≥ <input type="number" name="stretch" value={String(thresholds.stretch)} style="width:70px" /></label>
          <label>Freshness dias <input type="number" name="freshness" value={cfg.FRESHNESS_MAX_DAYS ?? '3'} style="width:60px" /></label>
          <label>Objetivo semanal <input type="number" name="goal" value={cfg.weekly_goal ?? '5'} style="width:60px" /></label>
          <button type="submit" class="primary">Guardar</button>
        </form>
        <form method="post" action="/config/scoring" class="card">
          <h2 style="margin-top:0">Config de scoring (JSON completo — avanzado)</h2>
          <textarea name="scoring" rows={22}>{cfg.scoring ?? ''}</textarea>
          <div style="margin-top:8px"><button type="submit" class="primary">Validar y guardar</button> <span class="muted">el Replay contra el historico llega en v2 (paso 7)</span></div>
        </form>
        <div class="card">
          <h2 style="margin-top:0">Historial</h2>
          {history.map((h) => <div class="muted">{fmt(h.ts)} · {h.key}</div>)}
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
    return c.redirect('/config?m=guardado');
  });

  app.post('/config/scoring', async (c) => {
    const b = await c.req.parseBody();
    try {
      const parsed = JSON.parse(String(b.scoring ?? ''));
      validateScoringConfig(parsed);
      await saveConfig(c.env, 'scoring', JSON.stringify(parsed));
      return c.redirect('/config?m=scoring valido y guardado');
    } catch (err) {
      return c.redirect(`/config?m=${encodeURIComponent(`ERROR: ${err instanceof Error ? err.message : 'invalido'}`)}`);
    }
  });

  // ---------- Salud ----------
  app.get('/salud', async (c) => {
    const runs = (
      await c.env.DB.prepare(
        'SELECT id, started_at, status, trigger, duration_ms, companies_ok, companies_fail, jobs_seen, jobs_new, survivors, notified, closed, subrequests, d1_reads, d1_writes, errors FROM runs ORDER BY id DESC LIMIT 30',
      ).all<Record<string, string | number | null>>()
    ).results;
    const events = (
      await c.env.DB.prepare(
        'SELECT ts, type, severity, detail FROM events ORDER BY id DESC LIMIT 20',
      ).all<Record<string, string>>()
    ).results;
    const today = await c.env.DB.prepare(
      "SELECT MAX(subrequests) peak_subreq, SUM(d1_reads) reads, SUM(d1_writes) writes, COUNT(*) runs FROM runs WHERE date(started_at) = date('now')",
    ).first<{ peak_subreq: number; reads: number; writes: number; runs: number }>();

    return page(c, 'Salud', (
      <>
        <div class="statgrid">
          <div class="stat"><div class="n">{today?.runs ?? 0}</div><div class="l">runs hoy</div></div>
          <div class="stat"><div class="n">{today?.peak_subreq ?? 0}/50</div><div class="l">pico subrequests</div></div>
          <div class="stat"><div class="n">{today?.writes ?? 0}</div><div class="l">escrituras D1 hoy (límite 100k)</div></div>
          <div class="stat"><div class="n">{today?.reads ?? 0}</div><div class="l">lecturas D1 hoy (límite 5M)</div></div>
        </div>
        <table>
          <tr><th>run</th><th>inicio</th><th>estado</th><th>ms</th><th>empresas</th><th>vistos</th><th>nuevos</th><th>surv.</th><th>notif.</th><th>cerrados</th><th>subreq</th><th>errores</th></tr>
          {runs.map((r) => (
            <tr>
              <td>{r.id} <span class="muted">{r.trigger}</span></td>
              <td class="muted">{fmt(String(r.started_at))}</td>
              <td class={r.status === 'ok' ? 'ok' : r.status === 'running' ? 'muted' : 'bad'}>{r.status}</td>
              <td>{r.duration_ms ?? '—'}</td>
              <td>{r.companies_ok}/{Number(r.companies_ok) + Number(r.companies_fail)}</td>
              <td>{r.jobs_seen}</td><td>{r.jobs_new}</td><td>{r.survivors}</td>
              <td>{r.notified}</td><td>{r.closed}</td><td>{r.subrequests}</td>
              <td class={Number(r.errors) > 0 ? 'bad' : ''}>{r.errors}</td>
            </tr>
          ))}
        </table>
        <h2>Eventos recientes</h2>
        {events.length === 0 ? <p class="muted">sin eventos</p> : (
          <table>{events.map((e) => (
            <tr><td class="muted">{fmt(e.ts)}</td><td class={e.severity === 'error' ? 'bad' : e.severity === 'warn' ? 'warn' : ''}>{e.type}</td><td class="muted">{e.detail}</td></tr>
          ))}</table>
        )}
      </>
    ));
  });

  return app;
}

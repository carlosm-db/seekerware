// Console shell: nav, light/dark theme, wide layout, footer with last run status.
import type { FC, Child } from 'hono/jsx';

const CSS = `
:root { --bg:#f7f7f5; --fg:#1b1b1f; --muted:#6b6b76; --card:#ffffff; --line:#e4e4e8;
  --accent:#0f6bff; --ok:#1a7f37; --warn:#b45309; --bad:#b91c1c; --chip:#eef2ff; }
[data-theme="dark"] { --bg:#101014; --fg:#ececf1; --muted:#9a9aa6; --card:#1a1a21;
  --line:#2a2a33; --accent:#5c9bff; --ok:#3fb950; --warn:#d29922; --bad:#f85149; --chip:#1e2438; }
* { box-sizing:border-box }
body { margin:0; background:var(--bg); color:var(--fg);
  font:15px/1.45 system-ui, "Segoe UI", sans-serif; }
a { color:var(--accent); text-decoration:none } a:hover { text-decoration:underline }
nav { display:flex; gap:18px; align-items:center; padding:10px 22px; background:var(--card);
  border-bottom:1px solid var(--line); position:sticky; top:0; flex-wrap:wrap }
nav .brand { font-weight:700 } nav .sep { color:var(--line) }
nav a.active { font-weight:600; border-bottom:2px solid var(--accent) }
nav .badge { background:var(--accent); color:#fff; border-radius:9px; font-size:11px;
  padding:1px 7px; margin-left:4px }
main { padding:20px 22px; max-width:none }
h1 { font-size:20px; margin:0 0 14px } h2 { font-size:16px; margin:22px 0 8px }
table { border-collapse:collapse; width:100%; background:var(--card);
  border:1px solid var(--line); border-radius:8px; overflow:hidden }
th, td { text-align:left; padding:8px 12px; border-bottom:1px solid var(--line);
  vertical-align:top }
th { font-size:12px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted) }
tr:last-child td { border-bottom:none }
.card { background:var(--card); border:1px solid var(--line); border-radius:8px;
  padding:14px 16px; margin-bottom:14px }
.chip { background:var(--chip); border-radius:6px; padding:2px 8px; font-size:12px;
  display:inline-block; margin:1px 3px 1px 0 }
.v-Apply { color:var(--ok); font-weight:700 } .v-Stretch-worth-it { color:var(--warn); font-weight:600 }
.v-Skip { color:var(--muted) }
.s-new { color:var(--accent) } .s-notified { color:var(--ok) } .s-closed { color:var(--muted) }
.s-skipped { color:var(--muted) }
.muted { color:var(--muted) } .ok { color:var(--ok) } .warn { color:var(--warn) } .bad { color:var(--bad) }
form.inline { display:inline } button, input[type=submit] { cursor:pointer; border:1px solid var(--line);
  background:var(--card); color:var(--fg); border-radius:6px; padding:5px 11px; font-size:13px }
button.primary { background:var(--accent); color:#fff; border-color:var(--accent) }
input[type=text], input[type=password], input[type=number], input[type=date], select, textarea {
  background:var(--bg); color:var(--fg); border:1px solid var(--line); border-radius:6px;
  padding:6px 9px; font-size:14px }
textarea { width:100%; font-family:ui-monospace, monospace; font-size:12px }
.statgrid { display:flex; gap:12px; flex-wrap:wrap; margin-bottom:16px }
.stat { background:var(--card); border:1px solid var(--line); border-radius:8px;
  padding:10px 16px; min-width:130px }
.stat .n { font-size:22px; font-weight:700 } .stat .l { font-size:12px; color:var(--muted) }
footer { padding:12px 22px; color:var(--muted); font-size:12px; border-top:1px solid var(--line);
  margin-top:26px }
.flash { background:var(--chip); border:1px solid var(--accent); padding:8px 14px;
  border-radius:8px; margin-bottom:14px }
.actions { display:flex; gap:6px; flex-wrap:wrap }
details > summary { cursor:pointer; color:var(--accent) }
`;

export interface FooterStatus {
  lastRun: string | null;
  companiesOk: number;
  errors: number;
}

export const Layout: FC<{
  title: string;
  path: string;
  pendingTriage: number;
  footer: FooterStatus;
  flash?: string;
  children?: Child;
}> = ({ title, path, pendingTriage, footer, flash, children }) => {
  const links: Array<[string, string]> = [
    ['/', 'Today'],
    ['/tracker', 'Tracker'],
    ['/jobs', 'Jobs'],
    ['/companies', 'Companies'],
    ['/config', 'Calibration'],
    ['/blocks', 'Bank'],
    ['/cvs', 'CVs'],
    ['/semana', 'Week'],
    ['/salud', 'Health'],
  ];
  return (
    <html data-theme="">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex" />
        <title>{title} · Seekerware</title>
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
        <script
          dangerouslySetInnerHTML={{
            __html: `const t=localStorage.getItem('theme')||(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');document.documentElement.dataset.theme=t;`,
          }}
        />
      </head>
      <body>
        <nav>
          <span class="brand">Seekerware</span>
          {links.map(([href, label]) => (
            <a href={href} class={path === href ? 'active' : ''}>
              {label}
              {href === '/' && pendingTriage > 0 ? <span class="badge">{pendingTriage}</span> : null}
            </a>
          ))}
          <span style="flex:1" />
          <button
            type="button"
            dangerouslySetInnerHTML={{ __html: '🌓' }}
            onclick="const d=document.documentElement;const n=d.dataset.theme==='dark'?'light':'dark';d.dataset.theme=n;localStorage.setItem('theme',n)"
          />
        </nav>
        <main>
          {flash ? <div class="flash">{flash}</div> : null}
          <h1>{title}</h1>
          {children}
        </main>
        <footer>
          last run:{' '}
          {footer.lastRun ? `${footer.lastRun} UTC · ${footer.companiesOk} companies OK · ${footer.errors} errors` : 'no runs yet'}
        </footer>
      </body>
    </html>
  );
};

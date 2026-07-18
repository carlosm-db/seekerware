// Console shell: mobile-first responsive nav (grouped hamburger), theme, footer.
import type { FC, Child } from 'hono/jsx';

const CSS = `
:root { --bg:#f7f7f5; --fg:#1b1b1f; --muted:#6b6b76; --card:#ffffff; --line:#e4e4e8;
  --accent:#0f6bff; --ok:#1a7f37; --warn:#b45309; --bad:#b91c1c; --chip:#eef2ff; }
[data-theme="dark"] { --bg:#101014; --fg:#ececf1; --muted:#9a9aa6; --card:#1a1a21;
  --line:#2a2a33; --accent:#5c9bff; --ok:#3fb950; --warn:#d29922; --bad:#f85149; --chip:#1e2438; }
* { box-sizing:border-box }
body { margin:0; background:var(--bg); color:var(--fg);
  font:16px/1.5 system-ui, "Segoe UI", sans-serif; -webkit-text-size-adjust:100%; }
a { color:var(--accent); text-decoration:none } a:hover { text-decoration:underline }

/* ---- top bar + hamburger drawer (mobile-first) ---- */
#navtoggle { display:none }
.topbar { display:flex; align-items:center; gap:12px; padding:12px 16px; background:var(--card);
  border-bottom:1px solid var(--line); position:sticky; top:0; z-index:20 }
.topbar .brand { font-weight:700; font-size:18px; flex:1 }
.hamburger { display:inline-flex; align-items:center; justify-content:center; min-width:44px;
  min-height:44px; border:1px solid var(--line); border-radius:8px; background:var(--card);
  color:var(--fg); font-size:20px; cursor:pointer }
.theme-btn { min-width:44px; min-height:44px }
.drawer { display:none; background:var(--card); border-bottom:1px solid var(--line); padding:8px 10px }
#navtoggle:checked ~ .drawer { display:block }
.navgroup { margin:6px 0 10px }
.navgroup .ghdr { font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted);
  padding:6px 10px 2px }
.drawer a { display:block; padding:11px 12px; min-height:44px; border-radius:8px; color:var(--fg) }
.drawer a.active { background:var(--chip); font-weight:600 }
.drawer a .badge, .topbar .badge { background:var(--accent); color:#fff; border-radius:9px;
  font-size:11px; padding:1px 7px; margin-left:6px }

main { padding:16px }
h1 { font-size:20px; margin:0 0 14px } h2 { font-size:16px; margin:20px 0 8px }

/* ---- tables: scroll inside their box on narrow screens ---- */
.table-wrap { overflow-x:auto; -webkit-overflow-scrolling:touch; border-radius:8px;
  border:1px solid var(--line) }
table { border-collapse:collapse; width:100%; background:var(--card) }
.table-wrap table { border:none }
th, td { text-align:left; padding:10px 12px; border-bottom:1px solid var(--line); vertical-align:top }
th { font-size:12px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); white-space:nowrap }
tr:last-child td { border-bottom:none }
.hide-sm { display:none }

.card { background:var(--card); border:1px solid var(--line); border-radius:10px;
  padding:14px 16px; margin-bottom:14px }
.chip { background:var(--chip); border-radius:6px; padding:2px 8px; font-size:12px;
  display:inline-block; margin:1px 3px 1px 0 }
button.chipx { border:none; background:none; padding:0 0 0 5px; min-height:0;
  font-size:11px; color:var(--muted); cursor:pointer }
button.chipx:hover { color:var(--bad) }
.v-Apply { color:var(--ok); font-weight:700 } .v-Stretch-worth-it { color:var(--warn); font-weight:600 }
.v-Skip { color:var(--muted) }
.s-new { color:var(--accent) } .s-notified { color:var(--ok) } .s-closed { color:var(--muted) }
.s-skipped { color:var(--muted) }
.muted { color:var(--muted) } .ok { color:var(--ok) } .warn { color:var(--warn) } .bad { color:var(--bad) }
form.inline { display:inline }
button, input[type=submit] { cursor:pointer; border:1px solid var(--line);
  background:var(--card); color:var(--fg); border-radius:8px; padding:10px 14px; font-size:15px;
  min-height:44px }
button.primary { background:var(--accent); color:#fff; border-color:var(--accent) }
button.danger { background:var(--bad); color:#fff; border-color:var(--bad) }
input[type=text], input[type=password], input[type=number], input[type=date], select, textarea {
  background:var(--bg); color:var(--fg); border:1px solid var(--line); border-radius:8px;
  padding:10px 12px; font-size:16px; min-height:44px; max-width:100% }
textarea { width:100%; font-family:ui-monospace, monospace; font-size:13px; min-height:120px }
.field { display:block; margin-bottom:10px }
.field label { display:block; font-size:13px; color:var(--muted); margin-bottom:4px }
.field select, .field input, .field textarea { width:100% }

/* ---- responsive grids: single column on phone, multi on desktop ---- */
.statgrid, .cardgrid { display:grid; grid-template-columns:1fr; gap:12px; margin-bottom:16px }
.stat { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:12px 16px }
.stat .n { font-size:22px; font-weight:700 } .stat .l { font-size:13px; color:var(--muted) }
.panelcard { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px;
  display:block; color:var(--fg) }
.panelcard:hover { border-color:var(--accent); text-decoration:none }
.panelcard .pg { font-size:12px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted) }
.panelcard .pn { font-size:20px; font-weight:700; margin:4px 0 2px }
.panelcard .pl { color:var(--muted); font-size:14px }
.actions { display:flex; gap:8px; flex-wrap:wrap; align-items:center }
/* Distribution primitives: single column on phone (inert), side-by-side on desktop */
.controls { display:grid; grid-template-columns:1fr; gap:12px; margin-bottom:16px }
.controls > * { margin-bottom:0 }
.formgrid { display:block }
.cols-2, .twoup { display:block }
.kanban { display:flex; flex-direction:column; gap:14px }
.kancol { min-width:0 }
.pager { display:flex; gap:10px; align-items:center; margin:12px 0 }
.bullet { border-top:1px solid var(--line); padding:9px 0 }
.bullet:first-of-type { border-top:none }
.inlinedet { display:inline-block }
.inlinedet > summary { min-height:0; display:inline-flex }
.flash { background:var(--chip); border:1px solid var(--accent); padding:10px 14px;
  border-radius:8px; margin-bottom:14px }
details > summary { cursor:pointer; color:var(--accent); min-height:44px; display:flex; align-items:center }
footer { padding:14px 16px; color:var(--muted); font-size:13px; border-top:1px solid var(--line); margin-top:26px }

@media (min-width:720px) {
  main { padding:22px 26px }
  .hamburger { display:none }
  .drawer { display:flex !important; flex-wrap:wrap; gap:4px; align-items:center;
    padding:8px 16px; background:var(--card) }
  .navgroup { display:flex; align-items:center; margin:0 }
  .navgroup .ghdr { padding:0 6px 0 10px; border-left:1px solid var(--line) }
  .navgroup:first-of-type .ghdr { border-left:none }
  .drawer a { display:inline-flex; align-items:center; padding:8px 10px; min-height:38px }
  .statgrid { grid-template-columns:repeat(auto-fit, minmax(150px, 1fr)) }
  .cardgrid { grid-template-columns:repeat(auto-fit, minmax(240px, 1fr)) }
  .hide-sm { display:table-cell }
  .kanban { flex-direction:row; align-items:flex-start; overflow-x:auto }
  .kancol { flex:1; min-width:230px }
}

/* ---- desktop: DISTRIBUTE the width (never cap/center the page) ---- */
@media (min-width:1024px) {
  .controls { grid-template-columns:repeat(auto-fit, minmax(230px, 1fr)); align-items:stretch }
  .controls:not(.bankhead) > details[open], .controls:not(.bankhead) > *:has(details[open]) { grid-column:1 / -1 }
  /* Bank header per the owner's sketch: stats pair | wide Add; wide Approve | filters */
  .controls.bankhead { grid-template-columns:1fr 1fr 1.6fr;
    grid-template-areas:"s1 s2 add" "ap ap filt" }
  .bankhead > .c-s1 { grid-area:s1 } .bankhead > .c-s2 { grid-area:s2 }
  .bankhead > .c-add { grid-area:add } .bankhead > .c-approve { grid-area:ap }
  .bankhead > .c-filter { grid-area:filt }
  .controls.bankhead:has(details[open]) { grid-template-columns:1fr;
    grid-template-areas:"s1" "s2" "add" "ap" "filt" }
  .formgrid { display:grid; grid-template-columns:1fr 1fr; column-gap:18px;
    grid-template-areas: "sec anc" "cat cat" "en es" }
  .f-section { grid-area:sec } .f-anchor { grid-area:anc } .f-cat { grid-area:cat }
  .f-en { grid-area:en } .f-es { grid-area:es }
  .cols-2 { display:grid; grid-template-columns:1fr 1fr; gap:14px; align-items:start }
  .cols-2.main-side { grid-template-columns:3fr 2fr }
  .twoup { display:grid; grid-template-columns:1fr 1fr; gap:14px; align-items:start }
  .twoup > .card { margin-bottom:0 }
  .filterbar input[type=text] { flex:1 1 240px }
}
`;

export interface FooterStatus {
  lastRun: string | null;
  companiesOk: number;
  errors: number;
}

const NAV_GROUPS: Array<[string, Array<[string, string]>]> = [
  ['Operate', [['/', 'Today'], ['/applications', 'Applications'], ['/tracker', 'Tracker'], ['/jobs', 'Jobs']]],
  ['Profile & setup', [['/contact', 'Contact'], ['/companies', 'Companies'], ['/config', 'Calibration'], ['/blocks', 'Bank']]],
  ['Output', [['/cvs', 'CVs']]],
  ['System', [['/week', 'Week'], ['/health', 'Health']]],
];

export const Layout: FC<{
  title: string;
  path: string;
  pendingTriage: number;
  footer: FooterStatus;
  flash?: string;
  children?: Child;
}> = ({ title, path, pendingTriage, footer, flash, children }) => (
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
      <input type="checkbox" id="navtoggle" />
      <div class="topbar">
        <label class="hamburger" for="navtoggle" aria-label="menu" dangerouslySetInnerHTML={{ __html: '☰' }} />
        <span class="brand">Seekerware{pendingTriage > 0 ? <span class="badge">{pendingTriage}</span> : null}</span>
        <button
          type="button"
          class="theme-btn"
          dangerouslySetInnerHTML={{ __html: '🌓' }}
          onclick="const d=document.documentElement;const n=d.dataset.theme==='dark'?'light':'dark';d.dataset.theme=n;localStorage.setItem('theme',n)"
        />
      </div>
      <nav class="drawer">
        {NAV_GROUPS.map(([group, links]) => (
          <div class="navgroup">
            <span class="ghdr">{group}</span>
            {links.map(([href, label]) => (
              <a href={href} class={path === href ? 'active' : ''}>
                {label}
                {href === '/' && pendingTriage > 0 ? <span class="badge">{pendingTriage}</span> : null}
              </a>
            ))}
          </div>
        ))}
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

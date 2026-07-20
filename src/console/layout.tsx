// Console shell: mobile-first responsive nav (grouped hamburger), theme, footer.
import type { FC, Child } from 'hono/jsx';

const CSS = `
:root { --bg:#f7f7f5; --fg:#1b1b1f; --muted:#6b6b76; --card:#ffffff; --line:#e4e4e8;
  --accent:#0f6bff; --ok:#1a7f37; --warn:#b45309; --bad:#b91c1c; --chip:#eef2ff;
  --ok-soft:#e2f2e6; --warn-soft:#f8ecd9; --bad-soft:#f9e4e2; }
:root { --sp-1:4px; --sp-2:6px; --sp-3:8px; --sp-4:10px; --sp-5:14px; --sp-6:16px; --sp-7:22px;
  --r-1:6px; --r-2:8px; --r-3:10px; --r-4:12px; --r-pill:999px;
  --fs-xs:11px; --fs-sm:13px; --fs-md:15px; --fs-lg:16px; --fs-xl:20px; --fs-2xl:22px; --z-nav:20 }
[data-theme="dark"] { --bg:#101014; --fg:#ececf1; --muted:#9a9aa6; --card:#1a1a21;
  --line:#2a2a33; --accent:#5c9bff; --ok:#3fb950; --warn:#d29922; --bad:#f85149; --chip:#1e2438;
  --ok-soft:#152a1c; --warn-soft:#2d2413; --bad-soft:#321714; }
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
button.secondary { background:var(--card); color:var(--accent); border-color:var(--accent) }
button.danger { background:var(--bad); color:#fff; border-color:var(--bad) }

/* ---- control language (2026-07-18): actions LOOK like buttons; links navigate.
   a.btnlike / details.btnlike>summary render with the quiet-button skin so
   every action has the same affordance without JS. .sec = secondary skin. ---- */
a.btnlike, details.btnlike > summary { display:inline-flex; align-items:center; gap:5px;
  border:1px solid var(--line); background:var(--card); color:var(--fg); border-radius:8px;
  padding:10px 14px; font-size:15px; min-height:44px; cursor:pointer }
a.btnlike:hover { text-decoration:none; border-color:var(--accent) }
details.btnlike { display:inline-block }
details.btnlike[open] > summary { border-color:var(--accent) }
details.btnlike.sec > summary, a.btnlike.sec { color:var(--accent); border-color:var(--accent) }
details.btnlike > form, details.btnlike > .panel { margin-top:8px }

/* Status pills: language + state fused in ONE badge (EN · draft). */
.pill { display:inline-block; font-size:11px; font-weight:600; border-radius:999px;
  padding:1px 9px; white-space:nowrap; vertical-align:1px }
.pill.draft { background:var(--warn-soft); color:var(--warn) }
.pill.approved { background:var(--ok-soft); color:var(--ok) }
.pill.missing { background:var(--bad-soft); color:var(--bad) }
.pill.retired { background:var(--chip); color:var(--muted) }

/* Blocks Bank v4 (2026-07-18, LinkedIn-inspired): collapsible role cards, one pencil
   per item, in-place editors. Summary = the whole header row; caret via CSS. */
details.rc { background:var(--card); border:1px solid var(--line); border-radius:10px; margin-bottom:12px }
details.rc > summary { list-style:none; display:flex; gap:10px; align-items:baseline; flex-wrap:wrap;
  padding:14px 16px; cursor:pointer; min-height:44px; color:var(--fg) }
details.rc > summary::-webkit-details-marker { display:none }
details.rc > summary:hover { background:var(--bg); border-radius:10px }
.caret::before { content:'▸'; color:var(--muted); font-size:13px }
details[open] > summary .caret::before { content:'▾' }
.rc-title { font-weight:700 }
.rc-sub { color:var(--muted); font-size:14px }
.rc-dates { color:var(--muted); font-size:13.5px; font-variant-numeric:tabular-nums }
.rc-meta { margin-left:auto; display:flex; gap:8px; align-items:center; color:var(--muted); font-size:13px }
.rc-body { border-top:1px solid var(--line); padding:6px 16px 14px }
.pencil { border:1px solid var(--line); border-radius:8px; min-width:36px; min-height:36px;
  display:inline-flex; align-items:center; justify-content:center; font-size:14px; color:var(--fg) }
.pencil:hover { border-color:var(--accent); text-decoration:none }
.b-row { display:flex; gap:10px; padding:10px 0; border-top:1px solid var(--line); align-items:flex-start }
.b-row:first-of-type { border-top:none }
.b-text { flex:1 }
.b-text .es { color:var(--muted); font-size:14px; margin-top:2px }
/* v6: bullet boxes inside the ONE role/group form (owner's sketch). */
.bsecthead { display:flex; align-items:center; gap:10px; border-top:1px solid var(--line);
  margin-top:12px; padding-top:10px }
.bsecthead .t { font-size:12px; text-transform:uppercase; letter-spacing:.05em;
  color:var(--muted); font-weight:700; flex:1 }
.addbullet { min-height:38px; padding:6px 12px; font-size:14px }
.bbox { border:1px solid var(--line); border-radius:8px; padding:10px 12px; margin:10px 0 }
.btokenrow { display:flex; align-items:center; gap:8px; margin-bottom:6px }
.btoken { font-size:12px; color:var(--muted); font-family:ui-monospace, monospace; flex:1 }
.bdel { min-height:0; padding:5px 12px; font-size:13px }
/* EN | ES: stacked on phone, side by side on desktop (see media query). */
.bbox-langs { display:grid; grid-template-columns:1fr; gap:12px }
.bbox-langs .field { margin-bottom:0 }
/* Textareas follow their text: field-sizing where supported + JS fallback. */
textarea.bank-ta { min-height:2.6em; max-height:40vh; field-sizing:content; overflow-y:auto }
/* Editors live in native <dialog> popups: no reload, no scroll jump.
   Mobile: near full screen. Desktop (>=720px): 80% (see media query). */
dialog { border:1px solid var(--line); border-radius:12px; background:var(--card); color:var(--fg);
  width:calc(100vw - 24px); max-height:calc(100vh - 32px); overflow-y:auto; padding:16px }
dialog::backdrop { background:rgba(0,0,0,.45) }
dialog .editpane { border:none; padding:0; margin:0 }
/* Top-level section toggles: Summary / Skills / Roles / Projects. */
details.sect { margin-bottom:18px }
details.sect > summary { list-style:none; font-size:17px; font-weight:700; color:var(--fg);
  padding:6px 0; min-height:44px; display:flex; align-items:center; gap:8px }
details.sect > summary::before { content:'▸'; color:var(--muted); font-size:14px }
details.sect[open] > summary::before { content:'▾' }
details.sect > summary::-webkit-details-marker { display:none }
.editpane { border:1px solid var(--accent); border-radius:10px; padding:12px 14px; margin:10px 0; background:var(--card) }
.fields2 { display:flex; flex-wrap:wrap; gap:10px 14px; align-items:flex-end }
.fld { display:flex; flex-direction:column; gap:3px }
.fld label { font-size:12px; color:var(--muted) }
.fld.grow { flex:1 1 240px }
.fld.w-sm { width:160px }
.fld input { width:100% }
.chk { display:flex; gap:8px; align-items:center; font-size:14px; padding:8px 0 2px }
.chk input[type=checkbox] { min-height:0; width:18px; height:18px }
.rowactions { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-top:10px }
.rowactions .spacer { flex:1 }

/* Calibration matrix (2026-07-19): BANK-style collapsible groups (reuse details.rc);
   each concept is ONE row — English | Español | Strength | Path — with ✏️ inline edit.
   Location rows are gates (no Strength). */
.matrix-groups { margin-bottom:14px }
.mside + .mside { margin-top:16px }
.msidehead { font-size:11px; text-transform:uppercase; letter-spacing:.05em;
  color:var(--muted); font-weight:700; margin:6px 0 4px }
.mgrid { display:grid; grid-template-columns:1fr 1fr 74px 132px 64px; gap:10px;
  align-items:center; padding:7px 0; border-top:1px solid var(--line) }
.mgrid.loc { grid-template-columns:1fr 1fr 132px 64px }
.mside .mconcept-wrap:first-of-type .mgrid { border-top:none }
.mgrid.mchead { border-top:none; font-size:11px; text-transform:uppercase;
  letter-spacing:.04em; color:var(--muted); font-weight:700 }
.mc-en, .mc-es { min-width:0; overflow-wrap:anywhere; font-size:14px }
.mc-str { font-variant-numeric:tabular-nums; font-size:14px }
.mc-empty { color:var(--warn); font-weight:700 }
.mc-actions { display:flex; gap:6px; justify-content:flex-end; align-items:center }
.mc-edit { display:none }
.mconcept-wrap.editing .mc-read { display:none }
.mconcept-wrap.editing .mc-edit { display:grid }
.mc-in { min-height:34px; padding:5px 8px; font-size:13px; width:100%;
  border:1px solid var(--line); border-radius:8px; background:var(--card); color:var(--fg) }
.mc-btn { min-height:30px; padding:3px 9px; font-size:13px }
.legend { list-style:none; padding:0; margin:2px 0 14px; color:var(--muted); font-size:13.5px }
.legend li { padding:3px 0 }
.path { display:inline-block; font-size:10px; font-weight:700; border-radius:4px;
  padding:0 5px; margin-left:4px; white-space:nowrap }
.p-0 { background:var(--bad-soft); color:var(--bad) }
.p-1 { background:var(--warn-soft); color:var(--warn) }
.p-2 { background:var(--ok-soft); color:var(--ok) }
.calsearch { display:flex; align-items:center; gap:10px; width:100%; margin-bottom:10px;
  background:var(--card); border:1px solid var(--line); border-radius:8px; padding:0 12px; min-height:44px }
.calsearch .cs-ic { flex:none; color:var(--accent); font-size:15px; line-height:1 }
.calsearch input[type=search] { flex:1; border:none; background:none; outline:none; box-shadow:none;
  min-height:42px; padding:0; font-size:16px; color:var(--fg); appearance:none; -webkit-appearance:none }
.calsearch input[type=search]::-webkit-search-cancel-button { -webkit-appearance:none; display:none }
.calsearch .cs-x { flex:none; background:none; border:none; color:var(--muted); font-size:20px;
  line-height:1; cursor:pointer; padding:0 4px; min-height:0 }
.calsearch .cs-x:hover { color:var(--fg) }
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

/* ---- utilities (design tokens; retire inline style= progressively) ---- */
.card h2:first-child, .card h1:first-child { margin-top:0 }
.mt-0 { margin-top:0 } .mt-1 { margin-top:var(--sp-3) } .mt-2 { margin-top:var(--sp-2) } .mt-3 { margin-top:var(--sp-1) }
.my-1 { margin:var(--sp-1) 0 } .my-2 { margin:var(--sp-2) 0 }
.mb-1 { margin-bottom:var(--sp-4) } .mb-2 { margin-bottom:var(--sp-2) } .mb-3 { margin-bottom:var(--sp-3) } .mb-4 { margin-bottom:var(--sp-5) }
.py-1 { padding:var(--sp-1) 0 }
.stackform { margin-top:var(--sp-2); display:grid; gap:var(--sp-1) }
.w-full { width:100% } .w-xs { width:60px } .w-sm { width:70px } .w-md { width:80px }
.right { margin-left:auto; display:flex; gap:var(--sp-3); align-items:center }
.hidden { display:none } .cap { text-transform:capitalize } .bd-warn { border-color:var(--warn) }
.kv { display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:var(--sp-2) var(--sp-6); margin:var(--sp-4) 0 }
.kv .k { color:var(--muted); font-size:var(--fs-sm); margin-right:var(--sp-2) }
.jobmeta { display:grid; grid-template-columns:repeat(3, minmax(0,1fr)); gap:var(--sp-3) var(--sp-6); margin:var(--sp-4) 0; max-width:920px }
.jobmeta .span2 { grid-column:span 2 }
.jobmeta .k { color:var(--muted); font-size:var(--fs-sm); text-transform:uppercase; letter-spacing:.03em; margin-right:var(--sp-2) }
@media (max-width:719px) { .jobmeta { grid-template-columns:1fr } .jobmeta .span2 { grid-column:auto } }

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
  /* Blocks Bank editors: 80% of the screen; EN | ES side by side. */
  dialog { width:80vw; height:80vh; max-height:none; padding:20px }
  .bbox-langs { grid-template-columns:1fr 1fr }
}

/* ---- desktop: DISTRIBUTE the width (never cap/center the page) ---- */
@media (min-width:1024px) {
  .controls { grid-template-columns:repeat(auto-fit, minmax(230px, 1fr)); align-items:stretch }
  .controls > details[open], .controls > *:has(details[open]) { grid-column:1 / -1 }
  .formgrid { display:grid; grid-template-columns:1fr 1fr; column-gap:18px;
    grid-template-areas: "sec anc" "cat cat" "en es" }
  .f-section { grid-area:sec } .f-anchor { grid-area:anc } .f-cat { grid-area:cat }
  .f-en { grid-area:en } .f-es { grid-area:es }
  .cols-2 { display:grid; grid-template-columns:1fr 1fr; gap:14px; align-items:start }
  .cols-2.main-side { grid-template-columns:3fr 2fr }
  .twoup { display:grid; grid-template-columns:1fr 1fr; gap:14px; align-items:start }
  .twoup > .card { margin-bottom:0 }
  .filterbar input[type=text] { flex:0 1 240px }
}
`;

export interface FooterStatus {
  lastRun: string | null;
  companiesOk: number;
  errors: number;
}

const NAV_GROUPS: Array<[string, Array<[string, string]>]> = [
  ['Operate', [['/overview', 'Overview'], ['/jobs', 'Jobs'], ['/tracker', 'Tracker']]],
  ['Profile & setup', [['/contact', 'Contact'], ['/companies', 'Companies'], ['/calibration', 'Calibration'], ['/blocks_bank', 'Blocks Bank'], ['/qa', 'Q&A']]],
  ['System', [['/intelligence', 'Intelligence'], ['/health', 'Health']]],
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
        <span class="brand">Seekerware</span>
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
                {href === '/jobs' && pendingTriage > 0 ? <span class="badge">{pendingTriage}</span> : null}
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

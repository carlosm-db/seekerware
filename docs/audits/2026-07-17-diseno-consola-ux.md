# Seekerware — Multipage Operating Console: Product/UX Design

Design report for the dashboard v1 (paso 4) and v2 (paso 7), enriched per the
owner's ask: a multipage command center that visualizes everything from one
place, plus a concrete path toward (semi-)automatic application. Written
2026-07-17 against the docs (PRD/TRD/UI/DATABASE/IMPLEMENTATION_PLAN/CONVENTIONS)
and the shipped step-1 code (`src/index.ts`: Bearer `API_TOKEN`, `/api/health`,
`/api/dry-run`; no router lib yet).

Report language: English. All UI copy shown in Spanish (mandatory). Terms
follow `docs/CONVENTIONS.md` §1; new concepts this design introduces are listed
in §10 as proposed glossary rows (one term per concept, as required).

---

## 1. Design principles

1. **The console is the whole product surface.** Telegram is push-only
   awareness; everything else — triage, tracking, calibration, bank governance,
   CV artifacts, system health — lives here. It replaces spreadsheets 100%.
2. **One morning page.** A solo, high-conscientiousness operator needs ONE page
   to open daily that answers: what arrived, what needs my action, is the
   system healthy, am I on pace. Everything else is drill-down.
3. **Rules stay transparent.** Every score is explainable (breakdown by
   category, gate results per track); every non-notification is explainable
   ("why NOT"). Trust in the engine comes from transparency, and calibration
   quality comes from trust.
4. **The console never violates the domain rules.** IA never writes CV content;
   verdicts come from rules; suggested content is always a review queue, never
   auto-applied. The console is where these guarantees become *visible*
   (approval flows, parity reports, evidence surfacing).
5. **Progressive enhancement, server-first.** Every mutation is a real HTML
   form that works with JS disabled; htmx upgrades to partial swaps; vanilla JS
   adds keyboard-first speed. No SPA, no build pipeline beyond wrangler's
   bundler.
6. **Free tier is a feature.** Page = 1 invocation (~10 ms CPU budget); D1
   reads don't count as subrequests; the only CPU-heavy feature (replay) is
   designed as batched requests from day one.

---

## 2. Information architecture — overview

```
Hoy (/)                      ← morning page: overview strip + triage inbox
├── Tracker (/tracker)       ← kanban of applications (user-owned lifecycle)
├── Jobs (/jobs)             ← explorer of ALL seen jobs + filters
│   └── /jobs/:hash          ← job detail: score breakdown, why-not, history,
│                              CV, prep de entrevista, similares
├── Empresas (/companies)    ← CRUD + health + yield/ROI
├── Calibración (/config)    ← scoring studio: editor + REPLAY + historial
├── Banco (/blocks)          ← blocks bank manager + suggested queue + reports
│   └── /blocks/anchors      ← anchors registry
├── CVs (/cvs)               ← CV library (Docs generated, verifier notes)
├── Semana (/semana)         ← funnel analytics + weekly digest + momentum
└── Salud (/salud)           ← self-monitoring: runs, errors, quotas, cron
```

Nav model: single top bar (wide layout), two visual groups + a right cluster:

```
[Seekerware]  Hoy · Tracker · Jobs · Empresas   |   Calibración · Banco · CVs   |   Semana · Salud   [🌓] [⌘K buscar]
   operación diaria                                  motor y contenido               sistema
```

- Badge counts on nav items: `Hoy (3)` pending triage, `Banco (2)` suggested
  pending, `Salud (!)` if last run had errors or a company crossed fail_count.
- Global search (v2): `/` or `Ctrl+K` opens a palette searching jobs (title,
  company), companies, blocks (text/tags). Server-rendered results via htmx.
- Footer on every page: `último run: hace 12 min · 14 empresas OK · 0 errores`
  (one D1 read from `runs`) — ambient self-monitoring without visiting Salud.

---

## 3. Pages

Format per page: **Purpose · Key components · Data · Interactions**.

### 3.0 Shell (cross-cutting)

- **Purpose**: consistent chrome: nav, theme, auth, flash messages, empty/error
  states, keyboard help (`?` overlay listing shortcuts).
- **Components**: top nav with badges; theme toggle (light/dark); flash region
  (post-action confirmations via htmx swap); `<dialog>`-based confirm for
  destructive actions; footer run-status line.
- **Data**: nav badges = 3 cheap D1 counts; footer = latest `runs` row.
- **Interactions**: theme toggle sets cookie + flips `data-theme` instantly
  (server renders correct theme on next load — no flash); `g` then key for
  go-to navigation (`g h` Hoy, `g t` Tracker, `g j` Jobs…), Gmail-style.

### 3.1 Hoy — home/overview + daily triage inbox (`/`)

The merged home: the spec's "home/overview" and "triage inbox" are two zones of
one page, because the solo owner's daily loop is *open → assess → act → done*.
Splitting them would add a click to every morning of the system's life.

- **Purpose**: process every pending survivor to a decision in minutes,
  keyboard-first; see at a glance that the system is alive and you're on pace.
- **Key components**:
  1. **Estado strip** (top, one row of stat tiles): pendientes de triage ·
     aplicaciones esta semana vs objetivo · racha de triage al día ·
     salud del sistema (verde/ámbar/rojo + link a Salud) · próximos
     seguimientos/entrevistas (2 más cercanos).
  2. **Triage list**: fresh survivors with `status = notified` and no
     application decision yet, newest first. Each row (expanded card for the
     focused one): title — company · 📍 location · track badge · score/100 ·
     verdict badge · "publicado hace X h" · `why_it_fits`, `gap_to_address`,
     `positioning_lead`, `project_to_feature` inline · 📄 CV doc link (Apply)
     · 🔗 job URL · botones: **Preparar · Aplicado · Descartar · Posponer ·
     Nota**.
  3. **Pospuestos que vencen hoy** section below the fold (snoozed items
     returning).
  4. Empty state when inbox is clear: "Triage al día ✓" + streak + shortcut
     hints + link to Tracker follow-ups due.
- **Data**: `jobs` (notified, not yet in `applications` or snoozed),
  `applications` (for strip + follow-ups), `runs` (health), goal from `config`.
- **Interactions** (keyboard-first; every action also a plain form button):
  - `j`/`k` move focus; `o`/`Enter` open job URL (new tab); `c` open CV Doc.
  - `p` → Preparar (creates `applications` row, stage `prepared` — moves to
    Tracker); `a` → Aplicado (stage `applied`, sets `applied_at`, schedules
    default follow-up +7d); `x` → Descartar (application decision `dismissed`;
    the job's pipeline `status` is untouched — see §6 writer separation);
    `s` → Posponer (menu: 1d/3d/próx. lunes → `snoozed_until`); `n` → quick
    note (inline textarea, saved to `applications.notes`).
  - Each action removes the row via htmx swap and advances focus — inbox-zero
    mechanics.
  - Undo: flash message with "deshacer" (reverts last action, 30 s window).

### 3.2 Tracker — application kanban (`/tracker`)

- **Purpose**: own the human side of the funnel: from notified to
  offer/rejection, with notes, dates and follow-up discipline. This implements
  PRD §8 "tracking de estado de aplicaciones" as a first-class page.
- **Key components**:
  1. Kanban columns: **Notificado → Preparado → Aplicado → Entrevista →
     Oferta / Rechazado** (terminal column split visually; `ghosted` is a
     substate of Aplicado shown as a gray clock after N days of silence).
  2. Card: company — title · track badge · days-in-stage · next follow-up date
     (red if overdue) · note count · CV icon (links Doc) · prep icon (links
     `/jobs/:hash/prep` when stage ≥ Entrevista).
  3. **Seguimientos** rail (right side, v2): due/overdue follow-ups across all
     stages ("Aplicado hace 8 días, sin respuesta — ¿seguimiento?"), with
     "hecho / posponer" actions. Follow-up dates are console reminders only —
     the system never contacts companies (PRD actor model).
  4. Filters: track, company, active-only toggle; sort by staleness.
  5. Board totals per column + conversion % between columns (mini funnel).
- **Data**: `applications` joined to `jobs` + `companies`; `job_events` for
  days-in-stage; `cvs` for Doc links.
- **Interactions**: move card = form select/buttons (v1 of the page) upgraded
  with HTML5 drag-and-drop (~60 lines vanilla JS posting the same form on
  drop); stage change prompts optional note + relevant date (interview date
  when → Entrevista, outcome when → Oferta/Rechazado); every change appends a
  `job_events` row (audit trail, feeds analytics); card click opens job detail.

### 3.3 Jobs — explorer (`/jobs`) and job detail (`/jobs/:hash`)

- **Purpose**: the memory of the system. Every job ever seen, queryable;
  every verdict explainable. This is where calibration insight is born.
- **Key components (explorer)**:
  1. Wide table: title · company · track · score · verdict · pipeline status
     badge (`new` azul · `notified` verde · `closed` gris · `skipped` neutro)
     · application stage (if any) · posted_at · first_seen · freshness.
  2. Filter bar (all combinable, GET params, bookmarkable): track, verdict,
     status, application stage, company, ATS, date range, text search on title;
     saved views as links: "Notificados esta semana", "Apply pendientes",
     "Cerrados sin aplicar", **"Casi (near-miss)"** (Skip with score within
     `stretch_threshold − 10`), "Freshness unknown".
  3. **"Por qué NO" column** on near-misses: compressed reason chip —
     `gate: ubicación (colombia_perm)` / `score 51 < 55` / `viejo (5d)` /
     `verify falló` / `seeding` — full explainer in detail view.
  4. Pagination (cursor by `last_seen`), 50/page; CSV export of current filter
     (replaces the last spreadsheet excuse).
- **Key components (detail `/jobs/:hash`)**:
  1. Header: title, company, location, URL, ATS, ext_id, dates
     (posted/first_seen/last_seen/notified), pipeline status, freshness.
  2. **Score breakdown panel** (transparency core): per category — domain /
     role_type / tool_overlap / level_fit — matched keywords (with
     title-multiplier flags), normalized 0–1, weight, contributed points; total
     score bar. Rendered from the persisted `score_breakdown` JSON (§6), not
     recomputed.
  3. **Per-track gate table**: each track × each gate → pass/fail/penalty
     with the matched evidence text; final verdict per track; winning track
     highlighted. For non-notified jobs this IS the "why NOT notified"
     explainer, plus freshness/verify/seed reasons from `job_events`.
  4. Stored description text (collapsible, stripped plain text).
  5. Application panel: stage, dates, notes timeline (from `job_events`),
     follow-ups; actions (change stage, add note).
  6. CV panel: generated Docs for this job (from `cvs`), verifier notes,
     blocks used (chips → bank), **Regenerar CV** button, cv_pending retry.
  7. **Similares** strip: other jobs in the same cluster (§4.3).
  8. **Prep de entrevista** link (§4.2) when stage ≥ Entrevista.
  9. History: full `job_events` timeline (status transitions, notify, verify
     results, expiry) — the audit trail made visible.
- **Data**: `jobs` (now with `description_text`, `score_breakdown`,
  `title_norm` — §6), `applications`, `job_events`, `cvs`, `blocks` (chips).
- **Interactions**: filters via GET + htmx partial table swap; row click →
  detail; `skipped` toggle per row (the one user-editable pipeline field, as
  today); bulk select → descartar (v2); export CSV.

### 3.4 Empresas (`/companies`)

- **Purpose**: manage the watchlist and prune noise with evidence: which
  boards produce fits, which produce only fetches.
- **Key components**:
  1. Table: name · ats · token · active toggle · notes · **salud** (last_ok_fetch
     age + fail_count; ámbar at 1–2 fails, rojo at MANTENIMIENTO threshold) ·
     **yield columns**: jobs vistos (90d) · survivors · notificados · aplicados
     · survivor rate % · último survivor hace X días.
  2. **Sugerencias de poda** panel: rule-driven, e.g. "0 survivors en 90 días
     sobre 47 jobs → considerar `active = 0`" / "token con 3 fallos — ¿cambió
     el board?" One-click deactivate (never delete — history stays).
  3. Add/edit form: name, ats (enum), token, notes; **"Probar token"** button =
     dry-run preview (count + 3 sample titles) before saving — kills the #1
     onboarding error (bad slug) instantly.
  4. Per-company drawer: recent jobs (link to prefiltered explorer), fetch
     history from `runs` detail, notes.
- **Data**: `companies` + aggregates over `jobs`/`applications` (90d window;
  one GROUP BY query) + `runs` per-company results.
- **Interactions**: CRUD forms (unique `(ats, token)` enforced); active
  toggle; dry-run button (user-triggered invocation → its own subrequest
  budget, so it never competes with the cron); "ver jobs" deep-link.

### 3.5 Calibración — scoring studio (`/config`)

- **Purpose**: tune keywords/weights/gates/thresholds without deploy and
  WITHOUT fear — every change is previewed against real stored jobs before it
  lands. This page is the difference between a scoring engine that gets tuned
  weekly and one that fossilizes.
- **Key components**:
  1. **Structured editors** (not raw JSON): category weights (4 sliders that
     visually renormalize to 100); keywords per category grouped by family
     (domain/tool/signal), chips with per-keyword weight, add/remove;
     `title_multiplier`; per-track gate editor (type hard/penalty, pattern,
     penalty points); verdict thresholds (apply/stretch) on a visual scale with
     the current score distribution histogram behind it (see where the cut
     falls); operación: `FRESHNESS_MAX_DAYS`, objetivo semanal.
     Raw JSON view behind an "avanzado" toggle for exotic edits.
  2. **REPLAY (the killer feature)**: button "Simular contra últimos N jobs"
     (N default 200, max 1000). Draft config (server-side draft row, not yet
     active) is re-scored against stored jobs (`description_text` + title +
     location) with the SAME pure `scoreJob()` used by the pipeline. Output:
     - Summary: `12 cambian de verdict: 5 Skip→Stretch, 3 Stretch→Apply,
       4 Apply→Skip · score medio 48→53 · survivors/semana estimados 6→9`.
     - Diff table: only changed jobs — title/company, score antes→después,
       verdict antes→después, and the delta driver ("keyword nueva 'dbt'
       +8 en tool_overlap"). Row click → full breakdown with draft config.
     - Notification-volume projection per track (guards against opening the
       floodgates or muting everything).
     - Actions: **Guardar y activar** (writes `config`, appends
       `config_history` with the replay summary snapshot) · Descartar borrador.
  3. **Historial**: `config_history` timeline — when, what changed (key-level
     diff), replay summary at save time, "revertir a esta versión" button.
- **Data**: `config` (+ draft), `jobs` with `description_text`, `config_history`.
- **Interactions & free-tier mechanics**: replay runs in **batches of 50 jobs
  per request** (~50 × well-under-200µs of pure string matching keeps each
  invocation safely inside the ~10 ms CPU cap); htmx chains batch requests via
  a cursor and accumulates into a server-side draft-result table (or streams
  rows into the diff table as they arrive, with a progress bar — nice UX for
  free). D1 reads don't count against subrequests; replay makes zero external
  calls. Re-score of stored verdicts stays manual-only (PRD: config changes
  apply to future jobs; replay is preview, it never mutates `jobs`).

### 3.6 Banco — blocks bank manager (`/blocks`)

- **Purpose**: govern the core asset: browse, edit, approve, retire blocks;
  process IA suggestions; keep coverage and EN/ES parity honest. The select-only
  guarantee is worth exactly what this page makes easy to maintain.
- **Key components**:
  1. **Bank browser**: table/cards filterable by section, anchor, angle,
     status, es_status, tag; grouped by `fact_key` (all phrasings of one fact
     side-by-side — enforces "métrica exacta única" visually: if two phrasings
     of a fact show different numbers, you see it immediately).
  2. Block editor (drawer): text_en / text_es side-by-side, tags (chips
     validated against the shared vocabulary from `config` — free-typed tags
     warn "tag no existe en config: ¿agregarlo allá también?" honoring the
     shared-vocabulary rule), evidence, source, angle, anchor, status
     transitions. **Approval checklist enforced in UI**: `approved` requires
     evidence + fact_key + ≥1 tag (DATABASE §7) — the button stays disabled
     with the missing items listed.
  3. **Cola de sugerencias**: every `suggested` value (IA tweak or new-block
     proposal) as a review card: side-by-side current vs suggested, provenance
     (which job triggered it). Actions: **Convertir en borrador** (creates a
     draft block the owner then edits/approves — never straight to approved),
     **Descartar**. Nothing here ever touches render until the owner approves.
  4. **Reporte de cobertura de tags**: matrix of config keywords/tags ×
     approved blocks carrying that tag, split EN/ES. Gaps = "the engine can
     match a job on 'reconciliation' but the bank has no approved block to back
     it" → direct to-do list for content work. Inverse view: approved blocks
     whose tags no longer exist in config (dead weight).
  5. **Reporte de paridad EN/ES**: per fact_key: es_status rollup; explicit
     list "estos N blocks bloquean renders de colombia_perm" (render ES
     requires es_status=approved on every selected block).
  6. **Anchors registry** (`/blocks/anchors`): CRUD of anchors, `titles` JSON
     edited as four labeled fields (internal / market_canada / market_colombia
     / contractor); usage count per anchor.
  7. Usage stats per block (v2): times selected by cv_selector, last used —
     surfaces dead blocks and over-used ones (from `cvs.blocks_used`).
- **Data**: `blocks`, `anchors`, `config` (tag vocabulary), `cvs` (usage).
- **Interactions**: inline status transitions with guardrails (retire asks
  confirmation, delete doesn't exist — audit trail); suggested queue actions;
  reports are read-only with deep links into the editor; bulk tag rename (v2)
  updates blocks + warns to update config in the same session.

### 3.7 CVs — CV library (`/cvs`)

- **Purpose**: every generated CV, in job context, with verifier feedback —
  the artifact shelf plus quality feedback loop for the bank.
- **Key components**:
  1. Card grid/table: Doc name (`CV — {company} — {title} — {yyyy-mm-dd}`),
     link to Doc in Drive, job link, track, verdict, language, created_at,
     estado (ok / cv_pending reintento / superseded).
  2. Detail drawer: blocks used per section (chips → bank), **verifier notes**
     (the "Suggested tweaks" summary persisted to D1 at generation time — so
     tweaks survive after the owner deletes the appendix in the Doc, and feed
     the bank's improvement loop), selection rationale ("el job enfatiza X").
  3. Actions: **Regenerar** (re-runs cv_selector + render + verifier for that
     job; new `cvs` row supersedes the old, old Doc link kept), retry when
     `cv_pending = 1`; diff vs previous generation (which blocks changed).
  4. Filter: company, track, language, pending-only.
  5. Tweak triage shortcut: verifier notes that recur (same suggestion twice)
     get a "→ crear sugerencia en el banco" action, closing the loop
     verifier → bank improvement, still owner-gated.
- **Data**: new `cvs` table (§6), `blocks`, `jobs`.
- **Interactions**: regenerate is a user-triggered invocation (its own
  50-subrequest budget: ~2 Gemini + ~4 Google calls — comfortable); everything
  else is reads.

### 3.8 Salud — self-monitoring (`/salud`)

- **Purpose**: answer "is the machine working?" without opening Cloudflare's
  dashboard or `wrangler tail`. Detect broken tokens, quota drift, and silent
  failures the day they happen — the owner-ask "app self-monitoring" page.
- **Key components**:
  1. **Status header**: last run time + result; cron cadence; next expected
     run; alarm if `now − last run > 2 × cadence` ("cron no está corriendo").
  2. **Runs table** (from new `runs` table): started_at, duración, empresas
     OK/fallidas, jobs vistos/nuevos/survivors/notificados, subrequests usados
     vs 50, llamadas Gemini (+ modelUsed y fallbacks), errores (expandable
     JSON detail per company).
  3. **Quota panel**: today's Worker invocations estimate, D1 reads/writes
     from run summaries vs free-tier ceilings, Gemini calls/day — trend
     sparkline 14 days. All computed from `runs`, no external API needed.
  4. **Empresas con problemas**: fail_count > 0 list with last error and
     deep-link to Empresas; MANTENIMIENTO events log.
  5. **Integridad**: nightly-run self-checks rendered here: jobs notified with
     missing breakdown, approved blocks violating the checklist, applications
     referencing closed jobs, cv_pending older than 3 runs.
  6. Dry-run console (v2): pick company → run → normalized jobs + scores
     rendered (the existing `/api/dry-run` with a UI).
- **Data**: `runs`, `companies`, integrity queries; zero external calls.
- **Interactions**: read-mostly; "reintentar empresa ahora" button (one-off
  fetch of a single company, user-triggered invocation); acknowledge errors.

### 3.9 Semana — funnel analytics + digest (`/semana`)

- **Purpose**: the weekly retro instrument: is the strategy working, where
  does the funnel leak, is effort trending the right way. (Justification in
  §4.1 — this is creative feature #1.)
- **Key components**:
  1. **Funnel**: vistos → frescos → survivors → notificados → aplicados →
     entrevistas → ofertas, this week vs last (server-rendered inline SVG
     bars — no chart library), per-track split.
  2. Conversion table with deltas: notified→applied rate (the owner's own
     execution metric), applied→interview (market feedback metric).
  3. **Momentum panel** (§4.4): triage streak, weekly applied vs objetivo
     (config), median time-to-apply (notified_at → applied_at), oldest
     un-triaged item.
  4. Aging WIP: applications stuck in a stage > N days.
  5. Track comparison: which of the 3 tracks actually produces interviews —
     evidence for strategy rebalancing.
  6. **Digest semanal a Telegram**: Monday cron branch sends a compact summary
     of the same numbers ("Semana: 214 vistos · 9 survivors · 5 aplicadas (obj
     5 ✓) · 1 entrevista · racha 21d"). The console page is the deep version.
- **Data**: aggregates over `jobs`, `applications`, `job_events`, `runs`;
  goal from `config`.
- **Interactions**: week navigation; click any funnel stage → prefiltered
  explorer/tracker; toggle per-track.

---

## 4. Creative features (beyond the asked minimum) — with justification

### 4.1 Semana: weekly funnel digest (page + Telegram push)
A discovery engine optimizes *inputs*; a job search succeeds on *outcomes*.
Without a funnel view the owner can't tell "scoring is too strict" from "I'm
not applying to what I'm notified" from "applications aren't converting" —
three different problems with three different fixes (calibración, momentum,
positioning/bank). Cost is trivial (aggregate queries + one Telegram message
reusing `notify.ts`). This is the page that makes the system a *strategy*
tool, not just an alert pipe.

### 4.2 Prep de entrevista — evidence dossier (`/jobs/:hash/prep`)
When an application reaches Entrevista, the console assembles a printable
dossier: the job's stored description; the positioning used (why_it_fits /
positioning_lead as notified); the exact blocks in the CV they read — **each
with its `evidence` field surfaced** (the verifiable fact behind every claim);
the anchor titles as projected for that market; other jobs seen at that
company (hiring context: teams, stacks, volume); owner's notes. Justification:
the bank's `evidence` column is the highest-value interview asset the system
already owns — the owner walks in able to back every line of the CV with the
underlying fact, which is precisely the high-conscientiousness playbook. Zero
new content is generated (rule 1 untouched); it's a projection of approved
data. v2 optional: a Gemini "likely questions" section, clearly marked as
suggestions — allowed (it's not CV content) but flagged for the owner since it
sends the same job text already sent to the enricher.

### 4.3 Radar de similares — cross-company role clustering
At ingest, store `title_norm` (lowercased, de-parenthesized, seniority tokens
stripped) and cluster jobs by `title_norm` + top matched tags. Explorer and
job detail show the cluster: "Data Analyst — 7 empresas (3 aplicadas, 2
casi)". Justification: (a) positioning reuse — an application prepared for one
cluster member is 80% prepared for the rest; (b) calibration signal — a
cluster where everything lands at 50–54 screams threshold/keyword problem;
(c) prevents duplicate effort on effectively identical roles. Dedup by URL
hash stays untouched (different jobs remain different rows); this is a soft,
read-time grouping. Cheap: one stored column + GROUP BY.

### 4.4 Momentum — streaks, pace, and time-to-apply
Small panel on Hoy + full version on Semana: triage streak (days inbox reached
zero), weekly applications vs a self-set objetivo (config key), median
time-to-apply, "oldest pending" nudge. Justification: the owner profile is
high-conscientiousness — pace visibility and unbroken-chain mechanics are the
matching motivational instrument (honest metrics, no gamification noise). The
system already timestamps everything; this is pure presentation.

### 4.5 Kit de aplicación + banco de respuestas (the auto-apply on-ramp)
Per-job "Kit" view: CV Doc + PDF export link (Drive `export?format=pdf`),
job URL, positioning summary, and a **banco de respuestas** — a new
owner-approved table of standard application answers (work auth per track,
salary expectations per track/currency, "why us" skeleton, notice period,
links portfolio/LinkedIn/GitHub), each with copy-to-clipboard buttons, EN/ES,
governed with the same lifecycle discipline as blocks (draft/approved; IA may
suggest, never auto-approve). Justification: measured in minutes-per-
application, the biggest lever after CV generation is re-typing the same
answers into every ATS form; the kit cuts apply time to <5 minutes with ZERO
rule changes — the human still applies. It is also deliberately the first
rung of the auto-apply ladder (§5): whatever the owner decides there, this
rung pays off immediately and nothing is wasted.

---

## 5. Toward automatic application — decision framework (owner call)

Current PRD §6 is explicit: **no auto-apply**, "nada automatico hacia
empresas", "el usuario decide y aplica". The owner is questioning it. This is
a rule change, so it is presented as a decision ladder, not assumed. Each
level is independently shippable; each states what must change.

| Nivel | What it is | Human role | Rule changes needed | Risk/effort |
|---|---|---|---|---|
| **0** | Status quo: notify + CV Doc | does everything | none | — |
| **1 — Kit de aplicación** (§4.5) | One page with CV PDF, answers, links, checklist | copies/pastes, submits | none (new `answers` table + governance note) | Low / Low. **Recommend now (v2)** |
| **2 — Prefill asistido** | Bookmarklet/userscript reads a per-job JSON from the console (auth'd) and fills Greenhouse/Lever/Ashby forms; owner reviews and clicks submit | reviews + submits | PRD wording only ("assisted fill"); contact data enters D1 as runtime data (allowed by CLAUDE.md §4 — needed *in operation*; still never in repo) | Medium effort (3 ATS form layouts + drift), Low ethical risk; CAPTCHA-immune because the human is present. **Recommend as the "automatic" feeling step** |
| **2.5 — Aprobar desde Telegram** | Notification carries an "Aplicar" inline button; callback webhook → worker submits a fully-prepared application (Greenhouse Job Board POST API / Lever apply endpoints where available) | one explicit decision per job | PRD §6 rewrite; actor-model row change; per-company allowlist; audit log mandatory | High: ATS apply APIs are not universally enabled per board; multipart resume upload from Worker (fetch PDF bytes from Drive → POST) is feasible but failure cost is a bad first impression that cannot be retracted |
| **3 — Full auto-apply** | Rules auto-submit Apply verdicts | none | PRD/actor model rewrite + owner accepts misfire risk | **Not recommended**: CAPTCHA/custom questions break silently; irreversible errors; ToS gray zone; Workers free tier has no browser rendering; contradicts the system's core quality thesis (verdicts are conservative precisely because a human converts them) |

Recommendation: ship **Level 1 in v2**, design the per-job JSON payload so
**Level 2** is a bookmarklet away, and treat **2.5** as a research spike per
ATS (it only makes sense for boards whose apply API is confirmed enabled).
Level 3 is the only rung that actually deletes the human decision, and it is
the rung where every risk lives; the honest translation of "automatic" for
this system is *the decision takes one click and the paperwork takes zero*.

Open decision for the owner captured in §11.

---

## 6. Schema deltas required (surface for pasos 2–4, before data accumulates)

The console's most valuable features depend on data that must be persisted at
ingest/scoring time. Deltas ordered by urgency — the first three should land
with pasos 2–3, or replay/transparency will only cover jobs seen after the
migration:

| # | Delta | Enables | Notes |
|---|-------|---------|-------|
| 1 | `jobs.description_text` (stripped plain text) | **Replay**, why-not explainer, prep dossier, similar radar | Size fine: ~3–5 KB × thousands of jobs ≪ 5 GB. Write once at ingest |
| 2 | `jobs.score_breakdown` (JSON: per-category matches/normalized/points + per-track gate results + verdicts_by_track) | Score transparency, "por qué NO", calibration insight | Produced by `scoreJob()` anyway — persist instead of discarding |
| 3 | `runs` table (id, started_at, duration_ms, companies_ok/failed, jobs_seen/new/survivors/notified, subrequests_used, gemini_calls, errors JSON) | Salud page, footer status, quota panel, digest | One row per run, written in the same `db.batch()` |
| 4 | `applications` table (url_hash PK/FK, stage enum `prepared\|applied\|interview\|offer\|rejected\|dismissed`, applied_at, interview_at, outcome_at, follow_up_at, snoozed_until, notes) | Triage actions, Tracker, funnel | Keeps `jobs.status` purely system-written (one-writer rule intact); user-owned lifecycle lives here |
| 5 | `job_events` table (url_hash, ts, event, detail) | History timeline, audit, days-in-stage, funnel timings | Append-only; both system and user events |
| 6 | `cvs` table (id, url_hash, doc_url, lang, blocks_used JSON, verifier_notes, rationale, created_at, superseded_by, pending) | CV library, regenerate, block usage stats | Replaces/extends `jobs.cv_doc_url` (keep column as "latest" cache) |
| 7 | `config_history` (ts, key, old_value, new_value, replay_summary JSON) | Calibration historial, revert | Written on every config save |
| 8 | `jobs.title_norm` | Radar de similares | Computed at ingest |
| 9 | `answers` table (id, question_key, track, text_en, text_es, status) | Kit de aplicación (v2) | Same governance pattern as blocks |

All are additive migrations; none touch existing invariants. The state machine
in DATABASE §4 is unchanged — application stages are a parallel, user-owned
axis, which also resolves the ambiguity of overloading `skipped`.

---

## 7. Route map and navigation

| Ruta | Página | Paso |
|------|--------|------|
| `/login` | Formulario de login (única ruta sin auth) | 4 |
| `/` | Hoy (overview strip + triage) | 4 (triage básico) |
| `/tracker` | Kanban de aplicaciones | 7 |
| `/jobs`, `/jobs/:hash` | Explorador + detalle | 4 (tabla+filtros) / 7 (detalle rico) |
| `/jobs/:hash/prep` | Prep de entrevista | 7 |
| `/companies` | Empresas | 4 |
| `/config` | Calibración (editor) · replay | 4 (editor) / 7 (replay+historial) |
| `/blocks`, `/blocks/anchors` | Banco | 7 (con paso 6) |
| `/cvs` | Biblioteca CV | 7 (con paso 6) |
| `/salud` | Runs y salud | 4 (tabla runs) / 7 (quotas+integridad) |
| `/semana` | Funnel + momentum | 7 |
| `/api/*` | JSON (mismas entidades; Bearer sigue funcionando para scripts) | ya existe, crece |

Docs note: UI.md §2 currently maps `/` to jobs — this design moves jobs to
`/jobs` and makes `/` the morning page; update UI.md in the same change
(docs follow code rule).

---

## 8. V1 (paso 4) vs V2 (paso 7)

Guiding rule: v1 = "operate the system daily without SQL and know it's alive";
v2 = "operate the *search* — tracking, calibration at depth, content
governance, analytics". Avoid v1 scope creep (IMPLEMENTATION_PLAN §6 risk).

**V1 — paso 4 (minimal but daily-usable):**
1. Shell: nav, wide layout, light/dark (CSS-only via cookie), flash, empty
   states, login (signed cookie, §9).
2. Hoy: estado strip (counts + last run) + triage list with the five actions
   (plain forms + htmx; keyboard nav can slip to v2 if needed — forms first).
3. Jobs explorer: table, filters, saved views, `skipped` toggle, near-miss
   chip (from breakdown JSON), pagination. Minimal detail view: header +
   score breakdown + gate table (data is already there if delta #2 landed).
4. Empresas: CRUD + health columns + "probar token" dry-run preview.
5. Config: structured editor + raw JSON fallback; save writes config_history.
   No replay yet.
6. Salud: runs table (needs delta #3 from paso 3) + footer status.
Acceptance (superset of plan): add company, tune threshold, mark skipped,
triage a survivor to Aplicado — all from the browser; no route unauthenticated.

**V2 — paso 7 (full console):**
Tracker kanban + seguimientos; job detail full (history, CV panel, similares,
prep); **Replay** + historial + revert; Banco completo (browser, editor with
enforced checklist, suggested queue, coverage + parity reports, anchors);
Biblioteca CV (needs paso 6); Semana + digest + momentum; Radar de similares;
Kit de aplicación + banco de respuestas (if owner approves §5 L1); global
search; dry-run console; bulk actions; visual polish pass.

Dependencies to flag: `/blocks` and `/cvs` are gated on paso 6 (bank seeded,
factory live) — if paso 7 starts first, ship them behind an empty state.
Replay needs deltas #1–2 collecting data from paso 2 — that's why the deltas
must land now even though the studio ships in v2.

---

## 9. Tech recommendation — multipage on the Worker

### Recommended stack

**Hono + hono/jsx (server-rendered) + htmx (vendored) + one hand-written CSS
file + ~200 lines of vanilla JS.**

- **Hono** (~20 KB, zero transitive deps, built for Workers): typed router,
  middleware (auth cookie check in one place for all routes + `/api/*`),
  `hono/jsx` renders JSX to strings on the server with auto-escaping — no
  React, no hydration, no client runtime.
- **Zero build pipeline added**: wrangler already bundles with esbuild; JSX
  needs only tsconfig `"jsx": "react-jsx", "jsxImportSource": "hono/jsx"`.
  `tsc --noEmit` and vitest keep working; components are unit-testable as
  string renders (fits the existing vitest setup).
- **htmx** (~14 KB gz, vendored file — CSP-friendly, no CDN): every mutation
  is a real `<form method="post">` that works without JS; htmx upgrades to
  partial swaps (triage row removal, filter table refresh, replay batch
  chaining via cursor). This is exactly UI.md's "interacción progresiva"
  principle with a name.
- **Vanilla JS islands**: keyboard nav (Hoy), theme toggle, kanban
  drag-and-drop (HTML5 DnD posting the same form as the buttons), copy
  buttons. No framework state — the server is the state.
- **CSS**: single stylesheet, custom properties for theming;
  `prefers-color-scheme` default + explicit `data-theme` override from a
  cookie so SSR renders the right theme (no flash). Wide layout = fluid
  containers, `max-width: none`, density-first tables. No Tailwind (its CLI
  is a build pipeline; unnecessary at this scale).

### Alternatives considered

| Option | Verdict |
|---|---|
| Raw template literals + hand router (extend current `index.ts` style) | Workable, zero deps, but manual escaping is an XSS foot-gun on a page that renders third-party job text; routing/auth middleware gets hand-rolled. Hono buys safety for ~20 KB |
| Hono + Alpine.js instead of htmx | Alpine moves templating/state client-side — duplicates rendering logic; htmx keeps one rendering brain (server) |
| Preact/React SSR + islands | Needs a real client build + hydration; violates "no heavy frontend build"; nothing here needs client state of that order |
| HonoX / Vite-based meta-framework | Introduces the exact build pipeline we're avoiding; too young |
| Pure `/api/*` JSON + SPA | Worst fit: build pipeline, auth complexity, and the console is read-mostly server-renderable |

### Free-tier and platform tradeoffs

- **Invocations**: every page and htmx partial = 1 invocation. One user ×
  heavy daily use ≈ hundreds/day vs 100k/day — irrelevant.
- **CPU ~10 ms**: SSR of a few-hundred-row table in JSX-to-string is
  sub-millisecond territory; the only risky endpoint is replay → batched at 50
  jobs/request by design (§3.5). Avoid rendering unbounded tables (paginate at
  50 everywhere).
- **Subrequests (50)**: console pages make ~0 (D1 doesn't count). Dry-run,
  regenerate-CV, retry-company are separate user-triggered invocations, each
  with a fresh budget — never piggyback them on the cron run.
- **D1 free**: console reads are trivial vs 5M/day; analytics aggregates are
  simple GROUP BYs over thousands of rows.
- **Static assets** (htmx.js, CSS): use Workers Static Assets **with
  `run_worker_first: true`** so the auth middleware also gates assets —
  "nada público" stays literally true (default assets-first serving would
  expose them unauthenticated; they're non-sensitive, but the rule is
  absolute). Asset requests then consume invocations — irrelevant at this
  scale. Alternative if preferred: import CSS/JS as strings into the bundle
  and serve from the worker (same effect, no assets config).

### Auth (no custom domain → no Cloudflare Access)

Signed-cookie session, the TRD §8 fallback, formalized:
- `/login`: POST password → verify against `LOGIN_PASSWORD_HASH` worker secret
  (SHA-256 via `crypto.subtle`, constant-time compare) → set cookie
  `session = expiry.nonce.HMAC-SHA256(expiry.nonce, SESSION_SECRET)`;
  `HttpOnly; Secure; SameSite=Lax; Max-Age=30d`.
- Middleware validates on every route; `/api/*` additionally accepts the
  existing `Bearer API_TOKEN` (scripts/curl keep working; Telegram webhook, if
  2.5 ever ships, uses its own secret path token).
- CSRF: SameSite=Lax + verify `Origin`/`Sec-Fetch-Site` on mutating methods
  (htmx posts are same-origin).
- Brute force: fixed sleep + attempt counter in D1 (e.g., 10/hour) — cheap and
  sufficient for a workers.dev hostname behind an unguessable-enough URL that
  is still treated as public-facing.
- Rotation: change the two secrets via `wrangler secret put`; all sessions die.

### Testing

- Pure-function components: vitest snapshot/string tests (JSX → HTML).
- Route tests with Workers pool vitest (already configured): auth 401s,
  filters, form posts, replay batch cursor.
- `wrangler dev` for manual passes; no browser test rig needed at this scale.

---

## 10. Glossary additions to propose (CONVENTIONS §1, same-commit rule)

| Término | Significado | Evitar |
|---|---|---|
| triage | revisión diaria de survivors notificados hasta decisión (preparar/aplicar/descartar/posponer) | inbox, revisión, bandeja |
| application | ciclo de vida de postulación de un job, propiedad del usuario (tabla `applications`, stages prepared→…→offer/rejected) | postulación, candidatura, proceso |
| stage | etapa de una application: `prepared\|applied\|interview\|offer\|rejected\|dismissed` | fase, estado (reservado a jobs.status), columna |
| snooze | posponer un item de triage hasta una fecha (`snoozed_until`) | posponer (en código), recordatorio |
| replay | re-score simulado de jobs almacenados contra una config borrador; nunca escribe en `jobs` | simulación, preview, what-if |
| run log | registro por run en la tabla `runs` (salud y cuotas) | historial de ejecución, telemetry |
| digest | resumen semanal del funnel (página Semana + mensaje Telegram) | reporte, resumen semanal |
| cluster | agrupación soft de jobs por `title_norm` + tags (radar de similares) | grupo, familia de roles |
| answer | respuesta estándar aprobada para formularios de aplicación (tabla `answers`) | respuesta enlatada, plantilla |
| kit | vista por job con CV, answers y links para aplicar en minutos | paquete, bundle |

---

## 11. Open questions (owner decisions)

1. **Auto-apply level** (§5): approve Level 1 (kit + answers, no rule change)?
   Authorize research spike for Level 2 prefill / 2.5 Telegram-approve
   (requires PRD §6 rewrite)? Level 3 is recommended-against.
2. **Contact data in runtime D1** for kit/prefill (name, email, phone, links):
   acceptable under CLAUDE.md §4 as operational runtime data (private DB,
   never repo), or keep contact fields exclusively in the Doc template and
   browser-side?
3. **Schema deltas timing**: confirm deltas #1–3 (description_text,
   score_breakdown, runs) land in pasos 2–3 so replay/transparency cover the
   full history — they are cheap now and impossible to backfill later.
4. **`/` becomes Hoy** and jobs moves to `/jobs` (UI.md update) — confirm.
5. **Weekly application objetivo**: self-set number in config (used by
   momentum/digest) — what's the starting value?
6. **Digest push day/time** (proposal: lunes 07:00 America/Bogota) and whether
   MANTENIMIENTO alerts should also appear as a persistent banner in the shell.
7. **Replay N default/max** (200/1000 proposed) — enough history to trust
   diffs vs CPU comfort.
8. **Prep dossier IA section** ("likely questions", clearly-marked
   suggestions): include, or keep prep 100% rule-based?

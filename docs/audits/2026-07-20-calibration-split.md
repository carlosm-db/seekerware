# Audit — Calibration page + "Keyword impact" block (for a planned split)

Date: 2026-07-20 · Agent B · Scope: read-only, code AS-IS.
Files: `src/console/app.tsx` (Calibration `/calibration` L833-1169; Intelligence
`/intelligence` L1913-2010), `src/console/matrix.ts` (`buildMatrix`), types in
`src/scoring.ts`.

---

## 1. Current Calibration page — every section, top to bottom

Route: **`GET /calibration`** — `src/console/app.tsx:833-1021`.

Setup before render:
- `src/console/app.tsx:834-837` — reads `FRESHNESS_MAX_DAYS` from `config`
  (`SELECT key, value FROM config WHERE key IN ('FRESHNESS_MAX_DAYS')`), default `'3'`.
- `:838` — `const cfg = await loadLive(c.env)` — loads live scoring config
  (`SELECT value FROM config WHERE key='scoring'`, normalized). `loadLive` defined `:821-825`.
- `:839` — `const matrix = buildMatrix(cfg)` — the keyword matrix projection.

Rendered sections (JSX returned from `page(c, 'Calibration', …)` at `:928-1020`),
in DOM order:

1. **Thresholds + freshness quick form** — `:930-936`. `<form method="post"
   action="/calibration/quick">` with three number inputs:
   `apply` (`Notify me at score ≥`, `cfg.thresholds.apply`), `stretch`
   (`Show borderline from ≥`, `cfg.thresholds.stretch`), `freshness`
   (`Ignore postings older than … days`). Save button + `Config v{cfg.version}` label.
2. **`<h2>Keyword matrix (ATS)</h2>`** heading (`:938`) + muted note "Changes save
   immediately…" (`:939`).
3. **Search filter box** — `:940-944`. `<input type="search" id="calsearch-input">`
   + clear button `#calsearch-clear`. Client-side only (filters rows via the script below).
4. **Matrix groups grid** — `:946-948`. `<div class="matrix-groups">{matrix.map(groupCard)}</div>`.
   - `groupCard` (`:909-926`) renders one collapsible `<details class="rc">` per
     `MatrixGroup` (category): summary shows label, sub-label, `{count} concepts`
     (`+ · gates (pass/fail)` for location). Body = `sideBlock('In favor', g.favor)`
     + `sideBlock('Against', g.against)` + empty-state.
   - `sideBlock` (`:895-907`) renders a header row (English / Español / Strength /
     Path) then `rows.map(conceptRow)`.
   - `conceptRow` (`:858-893`) renders per concept: a read row (`.mc-read`) with
     `en`, `es`, strength text, path badge, an **✏️ edit** button (`.mc-editbtn`,
     toggles inline edit via script) and a **✕ remove** form
     (`<form method="post" action="/calibration/word-remove">`, `:867-872`); plus an
     inline **edit** form (`<form method="post" action="/calibration/word-edit">`,
     `:875-891`) carrying `kind`, hidden target (`category` for keyword; `track`+`gate`
     for gate — `hiddenTarget` `:845-854`), `old_en`, `en`, `es`, and a `weight`
     select (non-location).
5. **Legend** — `<ul class="legend">` `:950-955` (explains EN/ES both required,
   strength scale, ✏️/✕, path badge).
6. **"＋ Add word" card** — `:957-991`. `<form method="post"
   action="/calibration/word-add">` with `term_en`, `term_es`, and selects
   `category` (from `MATRIX_CATEGORIES`), `dir` (favor/against, `#dir-sel`),
   `weight` (`#str-sel`), `path` (— every track — / each `cfg.tracks`). Add button.
7. **Inline `<script>`** — `:993-1018`. Client behaviours: (a) live filter of
   `.mconcept-wrap` rows by text, auto-opening `details` while filtering; (b) clear
   button; (c) ✏️ toggles `.editing` on the wrapper; (d) ✗ cancel; (e) `dir`→`weight`
   option swap (favor `+3/+2/+1` vs against `−2/−3`).

**POST routes that back the page** (all `parseBody` → mutate live cfg → validate →
save → `redirect('/calibration?m=…')`):

| Route | Line | What it persists |
|---|---|---|
| `POST /calibration/quick` | `:1159-1169` | `cfg.thresholds = {apply, stretch}` via `saveLive`; `FRESHNESS_MAX_DAYS` via `saveConfig` |
| `POST /calibration/word-add` | `:1025-1044` | `applyWordAdd(cfg, …)` → `validateScoringConfig` → `saveLive` |
| `POST /calibration/word-remove` | `:1046-1060` | `applyPairRemove(cfg, target)` → `saveLive` |
| `POST /calibration/word-edit` | `:1062-1081` | `applyWordEdit(cfg, target)` → `validateScoringConfig` → `saveLive` |

`saveLive` (`:827-831`) bumps `cfg.version` and writes `config['scoring']`.
`saveConfig` (`:1083-1085`) is the generic `INSERT OR REPLACE INTO config`.
Note: the `GET /calibration` handler renders `?m=` toast via the shared `page()` layout;
the message string is passed through the query param, not fetched in the handler.

Nothing on the current Calibration page reads `jobs` / `score_breakdown` — it is
purely config-driven (`cfg` + `matrix`). No ML/impact computation lives here today.

---

## 2. The "Keyword matrix" — what `buildMatrix` produces & how it renders

`buildMatrix(cfg: ScoringConfig): MatrixGroup[]` — `src/console/matrix.ts:65-114`.

**Output shape** (NOT a numeric grid; a list of concept rows grouped by category and side):
- Returns one `MatrixGroup` per `MATRIX_CATEGORIES` = `['location', 'role_type',
  'level_fit', 'domain', 'tool_overlap']` (`matrix.ts:12`), in that fixed order.
- `MatrixGroup` (`:33-38`): `{ category, favor: ConceptRow[], against: ConceptRow[], count }`.
- `ConceptRow` (`:20-30`): `{ category, favor: boolean, en, es, weight?, path?, source }`.
  `source` is `{kind:'keyword'}` or `{kind:'gate', track, gate, list}` (`:15-17`).

So the "matrix" dimensions are **category × side(favor/against) × row**, where each
row carries **two language columns (en, es)** plus `weight` and `path`. It is not a
hits/scores matrix — it is a projection of the config's vocabulary.

**Data source** (config only, DB-free by design — `:6`):
- Keyword concepts: `cfg.keywords[cat]` for the 4 scoring `CATEGORIES`
  (`domain, role_type, tool_overlap, level_fit` — `scoring.ts:6-7`), pushed at
  `matrix.ts:76-86`. Split favor/against by `k.weight > 0` (`:81`). `path` derived from
  gate membership via `indexGates` (`:43-58`, looked up `:82`).
- Gate-only concepts: `cfg.tracks[].gates[].require|reject` terms not already a keyword
  (`:91-106`). Title-scope gates project into `role_type`; others into `location`
  (`:93-94`). Favor/against by `list === 'require'` (`:100`).
- Rows sorted by `|weight|` desc (`sortRows` `:60-62`, applied `:110-111`); gate rows
  have no weight so sort last.

**Rendering:** entirely in `app.tsx` via `groupCard`/`sideBlock`/`conceptRow`
(section 1, item 4). `matrix.ts` is pure projection; mutations (`applyWordAdd`,
`applyPairRemove`, `applyWordEdit`) also live in `matrix.ts` (`:144-257`) and are
invoked by the POST routes.

---

## 3. The "Keyword impact" block (Intelligence) — exact computation & inputs

Located inside **`GET /intelligence`** (`app.tsx:1913-2010`). Render card at `:1988-1997`.

**Input query** — `app.tsx:1930-1936` (comment "last 400 stored breakdowns"):
```
SELECT j.url_hash, j.title, j.verdict, j.score, j.score_breakdown, c.name company
FROM jobs j JOIN companies c ON c.id = j.company_id
ORDER BY j.first_seen DESC LIMIT 400
```
→ the newest 400 jobs by `first_seen`. This same `rows` result also feeds the
Near-miss block (see §4).

**Computation** — `app.tsx:1937-1956`:
```
const impact = new Map<string, { hits: number; surv: number; cat: string }>();
…
for (const r of rows) {
  let b = JSON.parse(r.score_breakdown) as ScoreResult;   // skip on parse fail / no breakdown
  const surv = r.verdict !== 'Skip';
  for (const [cat, cb] of Object.entries(b.breakdown)) {
    for (const m of cb.matches) {
      if (m.weight <= 0) continue;                          // FAVOR keywords only
      const e = impact.get(m.term) ?? { hits: 0, surv: 0, cat };
      e.hits++; if (surv) e.surv++;
      impact.set(m.term, e);
    }
  }
  …near-miss push…
}
const topImpact = [...impact.entries()].sort((a, b) => b[1].hits - a[1].hits).slice(0, 20);
```

Precise semantics:
- Key `m.term` = the keyword's English string `kw.en` (set in `scoring.ts:181`:
  `matches.push({ term: kw.en, weight: contribution, in_title: inTitle })`). A job that
  matched only via the Spanish `es` is still recorded under `en`.
- `hits` = count of jobs (within the 400) whose breakdown contains that term with
  positive contribution. `surv` = subset of those where `verdict !== 'Skip'`.
- `cat` = the category under which the term was **first inserted** into the map
  (captured in the `?? {…, cat}` default; never updated afterward). It comes from
  `Object.entries(b.breakdown)` keys = the 4 scoring categories.
- `m.weight` here is the per-job *contribution* (weight × title_multiplier), not the
  config weight; the block only tests `> 0` to keep favor matches. Against/negative
  keywords (`weight <= 0`) are entirely excluded from the map.
- Types: `ScoreResult` / `CategoryBreakdown` / `KeywordMatch` from `scoring.ts:58-98`.
  `breakdown: Record<Category, CategoryBreakdown>`; `CategoryBreakdown.matches:
  KeywordMatch[]`; `KeywordMatch = { term, weight, in_title }`.

**Render** — `app.tsx:1988-1997`: a card titled `Keyword impact (last {rows.length}
jobs)` with a 4-column table (`keyword`, `category`, `matches`, `in survivors`)
iterating `topImpact` (top-20 by hits). Links to `/calibration` in the sub-note (`:1990`).

---

## 4. Moving "Keyword impact" into Calibration — what moves, what is shared

**Blocks that constitute Keyword impact:**
- The `rows` query — `app.tsx:1930-1936`.
- `impact` map declaration + population — `:1937` and the `impact` half of the loop
  `:1944-1951` (plus the `try/parse/surv` preamble `:1939-1943`).
- `topImpact` — `:1956`.
- The render card — `:1988-1997`.
- Type dependency `ScoreResult` — already imported/used in `app.tsx` (`:1940`), so no
  new import for the type itself.

**Shared data / entanglement (the key constraint):**
- The `rows` query (`:1930-1936`) is **shared** with the **Near-miss mining** block.
  The single `for (const r of rows)` loop (`:1939-1955`) populates BOTH `impact`
  (Keyword impact) and `nearMiss` (`:1938`, pushed `:1952-1954`, sorted/sliced
  `:1957-1958`, rendered `:1998-2007`). Near-miss also parses the same
  `score_breakdown` and reads `verdict`/`score`/`near_miss_reason`.
- Therefore a clean move requires one of: (a) duplicate the `rows` query + parse loop
  into `GET /calibration` (accepting two 400-row scans, once per page), or (b) extract
  a shared helper (e.g. `computeImpactAndNearMiss(env)` or just `loadRecentBreakdowns`)
  and call it from both routes. If only Keyword impact moves and Near-miss stays in
  Intelligence, the `rows` query must remain in Intelligence for Near-miss and be
  re-issued in Calibration.
- No other Intelligence-only data (`enabled`/`calls`/`prov`/`aiEvents`, `:1914-1927`)
  is used by the impact computation — those stay put.
- Convenient for the move: `GET /calibration` already computes `cfg = loadLive()` and
  `matrix = buildMatrix(cfg)` — exactly the full-vocabulary source needed to enrich the
  impact table (see §5). No new config fetch required in Calibration.

---

## 5. Recommendation feasibility (dead keywords / strong signals)

### (a) "Dead" keywords with 0 matches — currently INVISIBLE
The `impact` map is populated **only from `cb.matches`** — i.e. only keywords that
actually matched at least one of the 400 sampled jobs (`app.tsx:1944-1951`). The **full
keyword set from config is NOT joined** against the hits. A config keyword that never
matched simply never becomes a map key, so it cannot appear in the table and its zero
is invisible. `topImpact` further truncates to top-20 by hits (`:1956`), so even low-hit
survivors drop off.

To flag dead keywords, the missing piece is the **anti-join** against the full config
vocabulary — which is already trivially available where Calibration lives:
- `cfg.keywords[cat]` (all `CATEGORIES`) and/or `buildMatrix(cfg)` already enumerate
  every configured concept (`en` + `es` + weight + category). Both are already loaded in
  `GET /calibration` (`app.tsx:838-839`).
- Join key: `impact` is keyed on `kw.en`; matches record `term = kw.en`
  (`scoring.ts:181`). So iterate favor keywords (`weight > 0`) per category and mark any
  whose `en` is absent from `impact` (or has `hits === 0`) as **dead within the sample**.
- Caveats to encode in any recommendation: (i) impact only tracks **favor** keywords
  (`m.weight <= 0` skipped, `:1946`) — against/negative keywords have **no hit data at
  all** here, so "dead" cannot be assessed for them from this source; (ii) the sample is
  bounded to the **newest 400 jobs by `first_seen`** — "dead" means "unmatched in that
  window", not provably dead forever; (iii) gate terms are not in `cfg.keywords` and are
  not counted by impact (impact iterates `breakdown` categories, not gates).

### (b) Strong signals (high hits / high survivor rate) — ALREADY AVAILABLE
The `impact` map already carries `hits` and `surv` per term. `topImpact` already ranks
by `hits` desc. A survivor rate `surv / hits` is computable directly from existing
fields with no new query. Only presentation limits exist today: the table shows top-20
by raw hits and does not surface the `surv/hits` ratio as a column or sort key.

### Available vs. needs-computing summary
| Signal | Data available today | Needs adding |
|---|---|---|
| Per-keyword `hits`, `surv`, `cat` | Yes — `impact` map (favor keywords, last 400 jobs) | — |
| Strong-signal ranking | Yes — `topImpact` by hits | `surv/hits` ratio column/sort (trivial from existing fields) |
| Full favor-keyword roster | Yes — `cfg.keywords` / `buildMatrix(cfg)` (already loaded in Calibration) | The anti-join (config − matched) to surface zeros |
| Against/negative keyword hits | No — excluded by `m.weight <= 0` guard | Drop/relax the guard if against-keyword impact is wanted |
| Gate-term usage | No — impact iterates scoring categories only | Separate accounting if desired |

**Feasibility verdict:** Moving Keyword impact into Calibration is low-friction — the
impact loop has no config dependency and Calibration already loads exactly the config
needed to enrich it. Flagging dead keywords and strong signals is feasible with data
already fetched on both sides; the only genuinely new computation is the anti-join
(config keywords minus matched terms) plus a survivor-rate field. The one real design
decision is how to handle the `rows`-query sharing with Near-miss mining (duplicate the
query in Calibration vs. extract a shared helper).

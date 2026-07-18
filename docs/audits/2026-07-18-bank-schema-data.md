# Audit — Bank schema & data cleanliness (blocks/anchors)

Date: 2026-07-18. Scope: dead columns in `blocks`/`anchors`, `tags` consumption,
Spanish-language metadata inventory, and DROP COLUMN migration feasibility.
Method: full grep of `src/` + `test/` + `migrations/`, read of every consumer,
read-only SELECTs against local D1 (`npx wrangler d1 execute seekerware --local`).
Read-only audit: nothing was modified. Context: fill-in-place CV factory
(`src/gdocs.ts` `readPlaceholders()` + `src/ia/cv_factory.ts` `buildSlotMap()`);
owner judged the `/blocks` console page unfit for its goal.

Local D1 ground truth at audit time: **86 blocks / 9 anchors, all 86 blocks
`status='draft'`, `es_status='draft'`, no NULL `text_en`/`text_es`,
`suggested` NULL in all 86 rows.** Seed (`seeds/seed_blocks.sql`, gitignored)
contains exactly 86 block INSERTs + 9 anchor INSERTs, matching the DB.

---

## 1. Column-by-column verdicts — `blocks`

Every read/write of each column was traced. "Form round-trip" means: written by
the `/blocks` create/update routes and the seed, read back ONLY to prefill the
edit form — no pipeline, selector, render, filter, or display logic consumes it.

### 1.1 `blocks.fact_key` — verdict: **completely dead at runtime** (form round-trip only)

- Writes: seed; `INSERT` app.tsx:1104-1106; `UPDATE` app.tsx:1120-1121 (both
  fill empty value with the block id, per blocks-form.ts:30-31, 48).
- Reads: edit-form prefill only (app.tsx:1062 SELECT → blockFields
  app.tsx:80-81 renders it as an input).
- NOT selected by the factory catalog query (cv_factory.ts:88-89), NOT in
  `CatalogBlock` (agents.ts:47-54), NOT a `/blocks` list filter
  (app.tsx:923 filters: section/anchor_id/angle/status/es_status), NOT shown in
  the list table (app.tsx:1004-1012).
- Its documented purpose — "Groups all phrasings/languages of the same fact"
  (docs/DATABASE.md:185, 218-220) — is implemented NOWHERE. See finding F1.

### 1.2 `blocks.evidence` — verdict: **completely dead at runtime** (form round-trip only)

- Writes: seed; app.tsx:1106, 1121 (from blocks-form.ts:53).
- Reads: edit-form prefill only (app.tsx:1062 → blockFields app.tsx:82-83).
- Disambiguation checked: the `evidence` seen in scoring.ts:70, 185-201, 271,
  index.ts:156 and app.tsx:395 is the in-memory `GateResult.evidence` of the
  scoring engine (gate pass/fail explanation) — a different concept sharing the
  name, never touching `blocks.evidence`. (Terminology collision worth noting
  under CONVENTIONS "one term per concept".)
- docs/DATABASE.md:247 says "An `approved` block MUST have `evidence`,
  `fact_key`, and >= 1 tag" — no code enforces this. See finding F4.

### 1.3 `blocks.source` — verdict: **completely dead at runtime** (form round-trip only)

- Writes: seed; app.tsx:1106, 1121 (from blocks-form.ts:54).
- Reads: edit-form prefill only (app.tsx:1062 → blockFields app.tsx:84-85).
- No other `\bsource\b` hit in `src/` touches this column.

### 1.4 `blocks.suggested` — verdict: **completely dead, never populated**

- Zero occurrences of `suggested` anywhere in `src/` or `test/` (grep of both
  trees). The seed's INSERT column list omits it. Local D1: 0 non-NULL rows
  out of 86.
- docs/DATABASE.md:193 describes it as the landing slot for AI proposals
  ("NEVER used in render") — that feature was never built; verifier tweaks
  actually go to `cvs.verifier_notes` (cv_factory.ts:154-159). Dropping the
  column forecloses nothing today but does delete the designed home for the
  step-8 suggestion flow; a decision, not a mechanical cleanup.

### 1.5 `blocks.angle` — verdict: **soft-hint-only** (advisory to the AI + console filter; no deterministic consumer)

Live consumers, all non-load-bearing:
- Catalog text for the AI selector: agents.ts:71 embeds it as
  `[section/angle]`, and the instruction tells the model to prioritize "the
  angle the job calls for" (agents.ts:77). Advisory prose only — the
  `responseSchema` enum (agents.ts:83-93) constrains by section, never by angle.
- Console `/blocks`: filter (app.tsx:923, 930, 979, 1032) and a list column
  (app.tsx:1004, 1009).
- Form enum validation: blocks-form.ts:8, 41-42; app.tsx:69-73.
- Fetched into the factory catalog (cv_factory.ts:88, 102) but `buildSlotMap()`
  (cv_factory.ts:187-228) never reads `angle` — slot filling is driven only by
  `section`, `anchor_id`, and `skcat:` tags.

Data: angle is set on all experience (36) and projects (8) rows and on 9 of 12
summary rows; all 30 skills rows are NULL (per-section distribution query).

### 1.6 `blocks.tags` — split verdict: **`skcat:` prefix is load-bearing; everything else is advisory**

- **Load-bearing**: `skcatOf()` cv_factory.ts:170-174 parses `skcat:<cat>` from
  the comma/space-separated tags; buildSlotMap uses it (cv_factory.ts:203-210)
  to group selected skills into the template's `{{skills_<cat>}}` lines
  (cv_factory.ts:218-219). **A selected skills block whose tags lack `skcat:`
  is silently dropped from the CV** (cv_factory.ts:205-206 `if (!cat) continue;`).
  See finding F3.
- **Advisory**: agents.ts:71 puts `tags:${b.tags}` in the catalog text shown to
  Gemini — a relevance hint, nothing enforced.
- **Dead fetch**: the `/blocks` list SELECT retrieves `tags` (app.tsx:940) but
  the table (app.tsx:1004-1012) never renders it. Only the edit form shows it
  (app.tsx:78-79).
- No other consumer (config keyword matching in scoring never touches
  `blocks.tags`).

---

## 2. Column-by-column verdicts — `anchors`

Runtime readers of `anchors` (exhaustive):
- cv_factory.ts:114 — `SELECT id FROM anchors` (role codes validating
  `{{<CODE>R<N>}}` tokens, buildSlotMap cv_factory.ts:221).
- app.tsx:53-54 — `fetchAnchors`: `SELECT id, company, kind` (edit/add form
  dropdown label, app.tsx:67).
- store.ts:206-214 — `COUNT(*)` only (health).
There is NO console CRUD for anchors; rows exist only via the seed.

| Column | Verdict | Proof |
|---|---|---|
| `id` | **load-bearing** | role-code slot matching cv_factory.ts:114, 221; FK target of `blocks.anchor_id` (migrations/0001_initial.sql:54); form dropdown |
| `kind` | UI-only, in use | dropdown label + ordering, app.tsx:54, 67 |
| `company` | UI-only, in use | dropdown label, app.tsx:67 |
| `dates` | **completely dead** | zero reads in `src/` (grep `titles\|dates`: no anchor-column hit) |
| `titles` | **completely dead** | zero reads in `src/`; docs/DATABASE.md:160 claims it is "Retained for the console" — false per code, the console selects only id/company/kind (app.tsx:54) |

---

## 3. Data inventory (read-only local D1)

### 3.1 Counts and skcat distribution — as expected

- 86 blocks, 9 anchors (5 roles: DLAB1, BNS2, BNS1, UPS1, BAC1 + 4 projects).
- Sections (derived from the per-section/angle GROUP BY): summary 12,
  skills 30, experience 36, projects 8 — total 86.
- `skcat:` distribution over skills: **technical 11, methodologies 10,
  academic 5, emerging 4 = 30**, matching the expected 11/10/5/4. Every
  skills row has a `skcat:` tag; no non-skills row has one
  (`skills_without_skcat = 0`, `nonskills_with_skcat = 0`).

### 3.2 Spanish-language metadata (fields the English-language policy misses)

`blocks.evidence` — 33 distinct values; **63 of 86 rows (73%) are Spanish**.
Top values: `trayectoria` (14), `rol` (13), `repo del proyecto` (8),
`DiversoLab + proyectos` (4), `rol 3 anos` (3), `framework 4 escenarios` (2),
`transicion completada` (2), plus 17 singleton Spanish values
(`uso en 4 roles`, `portfolio caso 1/2/3`, `evaluacion Scotiabank`,
`politicas entregadas`, `sistema en produccion`, `pipelines en uso`,
`plataforma operativa`, `sheets entregadas`, `casos Scotiatech`,
`5 casos STAR`, `3 assessments convergen`, `rol 2 anos`,
`rol frontline Vancouver`, `transicion`, `diploma + proyectos`, …).
Remaining 23 rows are language-neutral (`Scotiatech`, `diploma`, `CCTB`,
`portfolio + CVs`, one `—` placeholder). Note the stripped diacritics
(`anos` for "años", `transicion`, `politicas`, `evaluacion`, `produccion`).

`blocks.source` — 11 distinct values; **34 of 86 rows (40%) are Spanish**:
`CV ambos` (16), `CV todos` (15), `CV ambos + portfolio` (3). The rest are
codes/neutral: `CV-COP` (33), `CV-CAD` (10), `CV-CAD/compliance` (2),
`CV-COP (600) + CAD (600/1000)` (2), `portfolio` (2), `CV compliance` (1),
`portfolio + CV` (1), `portfolio + CV-CAD` (1).

`anchors` — Spanish also present in the (dead) metadata: `dates` uses
`Jun 2025 – presente`; `company` includes `S&A para Banco Agrario de Colombia`;
`titles` JSON legitimately contains ES market titles (content, not metadata).

### 3.3 fact_key duplication groups (relevant to F1)

11 fact_keys have >1 block: `sum-profile` (6), `st-scope` (3), and 9 pairs
(`st-automation`, `st-escalations`, `ups-migration`, `ups-matrix`, `sum-bi`,
`prj-rec`, `prj-corex`, `prj-cga`, `prj-biq`). Example: `exp-st-03-data` and
`exp-st-04-compliance` are two phrasings of the same "~93% automation" fact
(both `fact_key='st-automation'`, both anchored to BNS1).

---

## 4. Findings, ranked

### F1 (major) — fact_key's documented purpose (one fact → one phrasing per CV) is unimplemented; a CV can carry the same fact twice
`fact_key` exists precisely to group phrasings of one fact
(docs/DATABASE.md:185, 218-220), but nothing dedups by it: the selector schema
constrains only by section (agents.ts:83-93), the factory never selects the
column (cv_factory.ts:88), and buildSlotMap fills role slots in selection
order (cv_factory.ts:196-202, 220-224). With 11 multi-block fact groups
(§3.3), Gemini can — and with `maxItems: 24` for experience plausibly will —
pick both `exp-st-03-data` and `exp-st-04-compliance`, rendering the "~93% of
cheque returns" claim twice under BNS1. Direct hit on CV quality, the goal the
owner says the tool fails. Fix direction (needs owner approval): either enforce
`fact_key` dedup post-selection in `generateCv()`/`buildSlotMap()`, or drop the
column and accept the AI-hint-only model.

### F2 (major) — 4 of the 6 audited blocks columns do no runtime work, yet the /blocks form demands them
`fact_key`, `evidence`, `source` are form round-trips (§1.1-1.3); `suggested`
is entirely unpopulated and unread (§1.4). The add/edit form (app.tsx:78-85)
still presents Tags/fact_key/Evidence/Source as fields to fill, inflating the
authoring burden of every block with metadata the engine ignores — a concrete
contributor to the "/blocks is a terrible tool" verdict. Cleanup options:
drop dead columns (see §5) or make them earn their keep (F1 for fact_key,
F4 for evidence).

### F3 (major) — a skills block without a `skcat:` tag silently vanishes from rendered CVs
cv_factory.ts:205-206 drops any selected skills block whose tags lack
`skcat:`; nothing warns. All 86 seeded rows are fine today (§3.1), but a block
created via the console has no validation requiring `skcat:` on
section='skills' (blocks-form.ts:33-56 checks section/text_en/angle only; the
only guard is a form label hint, app.tsx:78). One owner-added skill without the
tag = a skill the AI selects and the CV never shows, with no error anywhere.

### F4 (major) — governance rules in the docs are not enforced by the approve routes
docs/DATABASE.md:246-247: only `approved` enters the selector (true —
cv_factory.ts:85, except SAMPLE mode by design) and "an `approved` block MUST
have `evidence`, `fact_key`, and >= 1 tag" (false — `/blocks/approve`
app.tsx:1037-1043 and `/blocks/approve-all` app.tsx:1052-1057 set
status unconditionally). Also `retired` "never deleted" (DATABASE.md:250)
coexists with a hard-delete route `/blocks/delete` (app.tsx:1128-1132). Code
is truth per CLAUDE.md §1 — so the docs overstate the governance the system
actually has; either enforce or amend the doc.

### F5 (major) — anchors.titles and anchors.dates are dead, and DATABASE.md:160 asserts the opposite
Zero readers in `src/` (§2). The doc row "Retained for the console" is
contradicted by app.tsx:54 (`SELECT id, company, kind`). Since the 2026-07-18
fill-in-place model, role headers/dates/titles live statically in the Doc
template. The columns carry non-trivial JSON (4 market titles per anchor) that
misleads any future reader into thinking per-market titles are still a live
feature.

### F6 (minor) — bank metadata is majority-Spanish against the 2026-07-18 English-language decision
63/86 `evidence` and 34/86 `source` values are Spanish (§3.2), plus stripped
diacritics. Only relevant if the columns survive the cleanup; if they are
dropped, the finding dissolves. Both live only in local D1 + the gitignored
seed, so a regenerated seed fixes it everywhere.

### F7 (minor) — /blocks list query fetches `tags` and never displays it
app.tsx:940 selects `tags`; the table (app.tsx:1004-1012) has no tags column.
Harmless waste today; also means the ONE load-bearing metadata field (skcat)
is invisible in the list view where approval decisions happen.

### F8 (minor) — block id conventions drifted
docs/DATABASE.md:182 documents `{sec}-{anchor|topic}-{nn}[-{angle}]`
(e.g. `exp-BNS1-01-data`); the seed uses `exp-st-01-operations`, `skl-excel`
(no `nn`); console-created ids are `skl-<uuid8>` (blocks-form.ts:59-61).
Also `sum-automation-01-data` carries `fact_key='sum-profile'`
(seeds/seed_blocks.sql:20) — id/fact_key naming drift. Cosmetic unless
fact_key becomes load-bearing (F1).

---

## 5. Migration feasibility — `ALTER TABLE ... DROP COLUMN` on D1

D1 runs modern SQLite (well past 3.35.0, where DROP COLUMN landed).
SQLite refuses DROP COLUMN when the column is a PK, UNIQUE, indexed, named in
another constraint, an FK side, or referenced by a view/trigger/generated
column. Verified against the actual schema:

- `sqlite_master` (local D1): the only indexes touching `blocks`/`anchors` are
  the implicit PK autoindexes (`sqlite_autoindex_blocks_1`,
  `sqlite_autoindex_anchors_1`). No views, no triggers anywhere in the schema;
  migrations/0005_indexes.sql indexes `jobs` only.
- `blocks.fact_key`: NOT NULL only → droppable.
- `blocks.evidence`, `blocks.source`, `blocks.suggested`: bare TEXT → droppable.
- `blocks.angle`: its CHECK (migrations/0001_initial.sql:56) is an inline
  single-column constraint referencing only itself, which SQLite drops together
  with the column → droppable. (Belt-and-braces: verify once on local D1; the
  universal fallback is the rebuild pattern — CREATE new table, INSERT…SELECT,
  DROP old, RENAME.)
- `anchors.titles`, `anchors.dates`: bare TEXT; `blocks.anchor_id → anchors(id)`
  FK is untouched by dropping them → droppable.
- Note: `sqlite_version()` is blocked by D1's SQL authorizer
  ("not authorized to use function"), so version was not queried directly;
  feasibility rests on the schema inspection above.

### Minimal cleanup outline (NOT executed — owner approval required first; drop list itself is a product decision, see §1.4/§1.5 caveats)

1. **Migration** `migrations/0007_bank_cleanup.sql`: one
   `ALTER TABLE blocks DROP COLUMN x;` per dropped column (+ the two
   `ALTER TABLE anchors DROP COLUMN` lines). Sequential single statements —
   wrangler d1 migrations handles them fine. Applied locally via
   `wrangler d1 migrations apply seekerware --local`; remote ONLY via the CI
   pipeline (CLAUDE.md §5).
2. **Seed regeneration** — mandatory, not optional: `seeds/seed_blocks.sql`
   (gitignored, .gitignore:6) is a full DELETE+INSERT reseed whose INSERTs name
   the dropped columns explicitly; any reseed after the migration would fail
   with "table blocks has no column named …". Regenerate with the new column
   list (and, per F6, English metadata for whatever survives). Operational
   caution: reseeding resets `status` to draft, wiping approvals once the owner
   has approved the production bank.
3. **Code**: blocks-form.ts (`NormalizedBlock`, `normalizeBlockInput`, `ANGLES`
   if angle goes), app.tsx (`BlockEdit`, `blockFields`, filter list :923,
   SELECTs/INSERT/UPDATE :940/:1062/:1104/:1120), cv_factory.ts (`BlockRow`,
   SELECT :88, catalog map :102), agents.ts (`CatalogBlock`, catalog text :71,
   instruction :77) if angle goes.
4. **Tests**: test/blocks-form.test.ts, test/cv_factory.test.ts reference the
   columns and would need the same trim.
5. **Docs**: docs/DATABASE.md §5 tables + DDL + §7 rules; docs/UI.md §2 form
   description.

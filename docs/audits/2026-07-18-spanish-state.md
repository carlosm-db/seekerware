# Audit — Spanish state: content vs leftovers vs missing ES template

Date: 2026-07-18 · Scope: everything Spanish in the repo and the local D1 —
classified as (1) intentional content to KEEP, (2) MISSING FEATURE (the ES
template / real-ES path), (3) unintentional LEFTOVERS to clean. Read-only
audit; no file other than this report was created or modified. All claims
verified against code and local D1 (`npx wrangler d1 execute seekerware
--local`, SELECT only).

Owner's standing decision (2026-07-18): **project language is English
everywhere EXCEPT CV content (`blocks.text_es` and per-market anchor
titles)**.

---

## 1. KEEP — intentional Spanish (CV content and content-adjacent)

### 1.1 D1 state verified (local)

| Check | Result |
|---|---|
| Total blocks | **86** |
| Blocks with non-empty `text_es` | **86 / 86** |
| `es_status = 'draft'` | **86** (approved: 0, missing: 0) |
| Overall `status` | all 86 `'draft'` |
| By section | summary 12 · skills 30 · experience 36 · projects 8 |

So ES parity **text** is complete: every block has a Spanish twin, all
awaiting approval. Seed source: `seeds/seed_blocks.sql` (gitignored via
`.gitignore:6` `seeds/` — local-only, honoring its "NEVER commit" header).

### 1.2 Intentional Spanish content inventory (keep as-is)

1. **`blocks.text_es`** — 86 values, `seeds/seed_blocks.sql:15-108`. The CV
   content itself.
2. **`anchors.titles` → `market_colombia`** — Spanish job titles per role
   (`seeds/seed_blocks.sql:6-10`, e.g. `"Analista de Negocio Senior
   (Banca)"`). Per `docs/DATABASE.md:160` titles are console-only since the
   fill-in-place model (role headers are static in the template) — they would
   become the static role headers of a future ES template.
3. **Spanish scoring keywords** in `seeds/seed_config.sql` (`conciliacion`,
   `banca`, `credito`, `cobranzas`, `cartera`, `riesgo`, `nomina`,
   `facturacion`, `analista de operaciones`, …) — intentional: they match
   Spanish-language job posts for `colombia_perm`/`contractor_usd`.
   Accent-insensitive matching is a designed, tested feature
   (`test/scoring.test.ts:162-166`).
4. **Spanish test data** — `test/scoring.test.ts:162-166` (accented-keyword
   test), `test/contact.test.ts:7-9,19-27,51-57` and
   `test/cv_factory.test.ts:28,38` (`Medellín`, `Calle 10`, Colombian address
   fixtures). Test DATA, not code language.
5. **`src/console/app.tsx:573`** — `'Colombia location for CV header (e.g.
   Medellín, Colombia)'`: an example of CV content inside an English label.
   Fine.

### 1.3 The ES flow as implemented (code documentation)

- **Schema**: `migrations/0001_initial.sql:57-60` — `text_es TEXT`,
  `es_status TEXT NOT NULL DEFAULT 'missing' CHECK (es_status IN
  ('missing','draft','approved'))`.
- **Entry/edit derivation**: `src/console/blocks-form.ts:43-51` — the add/edit
  forms never accept `es_status` directly; it is derived: `text_es` present →
  `'draft'`, absent → `'missing'`. Tested in
  `test/blocks-form.test.ts:10-24`.
- **Approve (single)**: `src/console/app.tsx:1037-1043` — `UPDATE blocks SET
  status='approved', es_status = CASE WHEN text_es IS NOT NULL THEN 'approved'
  ELSE es_status END`. **Approving EN auto-approves ES in the same click**
  whenever Spanish text exists.
- **Approve (bulk)**: `src/console/app.tsx:1052-1057` — same CASE over every
  `draft`/`review` block; the button is explicitly labeled "Approve the ENTIRE
  bank (EN + ES)" (`app.tsx:996`).
- **Edit demotes ES**: `src/console/app.tsx:1113-1121` +
  `blocks-form.ts:51` — any edit resets `es_status` to `'draft'` (re-review),
  but the UPDATE does not touch `status`, so the EN approval survives the same
  edit (asymmetry noted in §4, finding F2).
- **Factory ES path**: `src/ia/cv_factory.ts:74-104` — `generateCv(env, job,
  lang: 'en'|'es', sample)`. Line 93 picks `text_es` when `lang==='es'`; line
  95 is the **parity gate**: `if (lang === 'es' && !sample && b.es_status !==
  'approved') return false; // mandatory ES parity`. Real (non-sample) ES CVs
  only use ES-approved blocks; SAMPLE ES CVs may use drafts (the light-review
  loop). Line 98 fails safe (`insufficient bank to render es`) below 8 usable
  blocks — today a real ES render correctly refuses (0 approved).
- **Console selector**: `src/console/app.tsx:1168` — `/cvs` sample form has
  the `EN`/`ES` `<select name="lang">`; handler `app.tsx:1193-1210` coerces
  `lang = b.lang === 'es' ? 'es' : 'en'` (line 1196) and calls
  `generateCv(..., lang, true)` — **sample only**.
- **Real generation**: `src/pipeline.ts:45-51` — the only non-sample call
  site, hardcoded `generateCv(..., 'en', false, doFetch)`. **There is no code
  path that produces a real ES CV** (see §2).
- **Console visibility**: `/blocks` shows an "ES parity approved" stat
  (`app.tsx:934,965`), an `es_status` filter (`app.tsx:981`) and a per-row ES
  column (`app.tsx:1011`).

---

## 2. MISSING FEATURE — one English template ⇒ Spanglish ES renders

### 2.1 Verified: exactly ONE template, English skeleton

- `src/gdocs.ts:74-83` `copyTemplate()` copies
  `env.CV_TEMPLATE_DOC_ID` — the only template reference in the codebase.
- `src/types.ts:42` — single optional binding `CV_TEMPLATE_DOC_ID?: string`;
  no `_ES` variant anywhere (grep across repo: only `types.ts`, `gdocs.ts:78`,
  docs).
- The factory only fires `replaceAllText` on `{{...}}` tokens
  (`gdocs.ts:91-102`, `cv_factory.ts:137-139`); **all static text of the copy
  is untouched**. Per `docs/TRD.md:151-152` and `docs/UI.md:91-100`, the
  static skeleton includes: header name/email/LinkedIn, section headings,
  **role headers** (company, English title, dates), the **Languages** line,
  **Projects** and **Education**.
- `anchors.titles.market_colombia` (the Spanish titles) is NOT used in
  rendering (`docs/DATABASE.md:160` — console-only since fill-in-place).

**Consequence**: selecting ES on `/cvs` today produces Spanish bullets and
summary under an English skeleton — English section headings, English role
titles, English education/projects/Languages lines. A Spanglish document,
unusable as a real Colombian-market CV. (Also note the appendix header
"SUGGESTED TWEAKS (delete before sending)", `cv_factory.ts:143-148`, is
English regardless of lang — acceptable since it is owner-facing and deleted.)

### 2.2 Verified: no trigger for a REAL ES CV at all

Even with a translated template and full ES approval, nothing would produce
one:

- `src/pipeline.ts:51` hardcodes `'en', false` for the cv_pending queue.
- `/cvs` only exposes `POST /cvs/sample` (`app.tsx:1193`), always
  `sample=true`.
- `docs/TRD.md:139` promises "language per the job (ES render requires
  es_status approved)" and `docs/DATABASE.md:248-249` promises "parity report
  before rendering colombia_perm" — neither the job-language decision nor the
  parity report exists in code. Docs ahead of code here (code is truth: the
  feature is missing).

### 2.3 What per-language templates would require

1. **Owner-side (no code)**: duplicate the current Google Doc; translate the
   static skeleton (headings, role headers — the `market_colombia` titles in
   `anchors.titles` are the ready-made source — dates ("presente"), Languages
   line, Education, Projects). Keep the **exact same `{{...}}` token names**
   (`{{phone}}`, `{{location}}`, `{{sum_N}}`, `{{skills_<cat>}}`,
   `{{<CODE>R<N>}}`) — then `readPlaceholders()`/`buildSlotMap()` need zero
   changes. Share the ES Doc with the service account as editor (same step
   that is currently blocking the EN template at runtime).
2. **Config surface**: new binding `CV_TEMPLATE_DOC_ID_ES?: string` in
   `src/types.ts` Env + owner sets it (Worker var/secret, like the EN id).
3. **Code (small)**: `copyTemplate()` (`gdocs.ts:74`) takes the template id
   (or lang) as a parameter; `generateCv()` picks
   `lang === 'es' ? env.CV_TEMPLATE_DOC_ID_ES : env.CV_TEMPLATE_DOC_ID` at
   `cv_factory.ts:127`, failing safe when the ES id is unset.
4. **A lang decision rule for real CVs**: today nothing chooses `es`. Options:
   track-based default (`colombia_perm` → check job-description language),
   detection over `description_text`, or an explicit per-job choice in the
   console. Must be decided with the owner before wiring `pipeline.ts:51`.
5. **Review loop**: ES SAMPLE CVs against the ES template become the ES
   approval mechanism (mirroring the EN light-review flow), ideally decoupled
   from the current auto-approval (finding F2).

### 2.4 When is the ES template actually needed? Recommendation: DEFER

Needed **only** for `colombia_perm` applications where the employer expects a
Spanish CV (Spanish-language posting / local company). Not needed for
`canada_coop` or `contractor_usd`, and many Colombia/LATAM postings from
international companies accept English CVs.

Current reality: 0 blocks approved (EN or ES), the single EN template is
itself runtime-blocked (step 6: Doc not yet shared with the service account),
0 real CVs generated, and step 8 (application kit) is pending. The ES template
is at least three prerequisites away. **Defer it** until the first
`colombia_perm` Apply-verdict job that genuinely warrants a Spanish CV;
sequence: unblock EN template → approve EN bank via samples → prove the real
EN flow → only then invest in the ES Doc + the small factory change (§2.3).
Until then, the ES sample selector working against the EN skeleton is
acceptable as a text-review tool, as long as the owner knows the output is
deliberately Spanglish.

---

## 3. CLEANUP — unintentional Spanish leftovers

Everything below violates the 2026-07-18 English-everywhere decision. None of
it reaches the AI (the Gemini catalog is only `id, section, anchor_id, angle,
tags, text` — `cv_factory.ts:101-104`) and none reaches a rendered CV; impact
is owner-facing consistency (CONVENTIONS one-term rule) only.

### 3.1 Tracked repo files (visible on GitHub) — 3 locations

| # | Location | Leftover |
|---|---|---|
| 1 | `wrangler.jsonc:1` | Full Spanish comment: `// Config del worker. Secretos NUNCA aqui (van en Worker secrets, ver TRD §9).` — the **only tracked code file** with a Spanish comment |
| 2 | `src/console/app.tsx:1266-1267` | Legacy Spanish route redirects `GET /semana → /week`, `GET /salud → /health`. No nav link points at them (nav uses `/week`, `/health`: `app.tsx:201-202`); keep only if the owner still has bookmarks, otherwise delete |
| 3 | `test/scoring.test.ts:103-115` | Spanish variable names `conJob`/`sinJob`/`con`/`sin` ("with/without") — trivial rename |

`migrations/0005_indexes.sql:2` mentions `/semana` in a comment — historical
reference inside an already-applied migration; **leave** (applied migrations
should not be edited).

### 3.2 Local-only seed files (gitignored, but they feed production D1)

| # | Location | Leftover |
|---|---|---|
| 4 | `seeds/seed_companies.sql:1-2` | Spanish header comments (`Seed local (NUNCA al repo): empresas ★ … verificadas`, `Greenhouse activas; … hasta el paso 5`) |
| 5 | `seeds/seed_config.sql:1-2` | Spanish header comments (`configuracion de scoring v1 derivada del perfil`, `Editable sin deploy; el formato es…`) — the Spanish **keywords inside the config values are content, keep** (§1.2.3) |
| 6 | `seeds/seed_blocks.sql` metadata → **live D1** | **63 of 86 blocks** carry Spanish `evidence` values (~24 distinct: `trayectoria` ×14, `rol` ×13, `repo del proyecto` ×8, `DiversoLab + proyectos` ×4, plus `uso en 4 roles`, `portfolio caso 1/2/3`, `transicion completada`, `rol 3 anos`, `evaluacion Scotiabank`, `politicas entregadas`, `sheets entregadas`, `sistema en produccion`, `plataforma operativa`, `pipelines en uso`, `5 casos STAR`, `framework 4 escenarios`, `casos Scotiatech`, `3 assessments convergen`, `diploma + proyectos`, …). **34 blocks** carry Spanish `source` values (`CV ambos` ×16, `CV todos` ×15, `CV ambos + portfolio` ×3). Owner-facing in the `/blocks` edit form (`app.tsx:82-85`) |
| 7 | `seeds/seed_blocks.sql:6` → live D1 | Anchor `DLAB1` `dates = 'Jun 2025 – presente'` — Spanish `presente` mixed with English month abbreviations (other anchors are English). Displayed in the console anchor dropdown context; would become CV-visible only if a future template made dates dynamic |

Fixing 6-7 means editing the seed AND re-running it (or UPDATEs) against
local + remote D1 — owner approval required; cosmetic, so it can ride along
with the next bank-tool rework (the owner already wants `/blocks` redone).

### 3.3 Docs

| # | Location | Leftover |
|---|---|---|
| 8 | `docs/UI.md:64-66` | Route table still lists `/salud`, `/semana`, `/aplicaciones` — code's canonical routes are `/health`, `/week` (redirects only), and step 8's route name should be decided as `/applications` |
| 9 | `docs/audits/2026-07-17-diseno-auto-apply.md`, `docs/audits/2026-07-17-diseno-monitoreo-datos.md` | Entirely Spanish documents; `2026-07-17-diseno-consola-ux.md` is mixed (English body, Spanish fragments and examples). Spanish filenames (`diseno-…`). They are load-bearing historical records referenced from `CLAUDE.md:108`, `docs/PRD.md:94`, `docs/TRD.md:229`, `docs/DATABASE.md:270`, `docs/UI.md:7`, `docs/IMPLEMENTATION_PLAN.md:180` — **recommend keeping as-is** (renaming/rewriting breaks citations and destroys evidence value); optionally prepend a one-paragraph English abstract to each |

Everything else checked clean: `README.md`, `CLAUDE.md`, `docs/CONVENTIONS.md`,
`docs/DATABASE.md`, `docs/TRD.md`, `docs/PRD.md`, `docs/IMPLEMENTATION_PLAN.md`
(only proper nouns like "Banco Agrario" and citations of the Spanish audit
filenames), all of `src/` and `migrations/` (grep for accented characters and
Spanish stopwords: only the intentional items of §1.2).

---

## 4. Findings ranked

### Major

- **F1 — No real-ES path exists (missing feature, docs overpromise).** The
  only real (non-sample) CV call is hardcoded English
  (`src/pipeline.ts:51`); the console only generates samples
  (`app.tsx:1193-1210`); there is a single English-skeleton template
  (`src/gdocs.ts:78`, `src/types.ts:42`), so even the ES sample is Spanglish.
  Meanwhile `docs/TRD.md:139` and `docs/DATABASE.md:248-249` describe
  per-job-language rendering and a colombia_perm parity report that do not
  exist. Either implement (§2.3, when needed) or annotate the docs as future.
- **F2 — The ES parity gate is silently defeated by approval coupling.**
  `cv_factory.ts:95` enforces `es_status='approved'` for real ES renders, but
  `/blocks` approve (single `app.tsx:1040` and bulk `app.tsx:1054`) sets
  `es_status='approved'` as a free side effect of EN approval whenever
  `text_es` exists — with 86/86 blocks carrying draft Spanish text, one
  "Approve the ENTIRE bank (EN + ES)" click approves all 86 Spanish texts
  sight-unseen (the light-review loop only shows EN samples unless the owner
  deliberately generates ES ones against the English skeleton). The gate then
  gates nothing. Decide: separate ES approval action, or accept coupling
  explicitly and document it.

### Minor

- **F3 — Spanish metadata in the bank**: 63/86 `evidence` + 34/86 `source`
  values in Spanish (live D1 + `seeds/seed_blocks.sql`); anchor `DLAB1` dates
  `'Jun 2025 – presente'`. Owner-facing only; never sent to Gemini or a CV.
- **F4 — Tracked-file leftovers**: `wrangler.jsonc:1` Spanish comment;
  `app.tsx:1266-1267` `/semana`,`/salud` redirects;
  `test/scoring.test.ts:113-115` `con`/`sin` variable names.
- **F5 — Local seed headers in Spanish**: `seeds/seed_companies.sql:1-2`,
  `seeds/seed_config.sql:1-2`.
- **F6 — Docs drift**: `docs/UI.md:64-66` still lists the Spanish routes.
- **F7 — Asymmetric demotion on edit**: `/blocks/update`
  (`app.tsx:1120`) resets `es_status` to `'draft'` on every edit (good for ES)
  but never demotes `status`, so an edited EN text keeps its approval — the EN
  side of the same governance question as F2.
- **F8 — No test coverage of the ES factory path**: `test/cv_factory.test.ts`
  never exercises `lang='es'` or the `es_status` gate at `cv_factory.ts:95`;
  the only ES tests cover form derivation (`test/blocks-form.test.ts:10-24`).

---

## 5. Recommended sequence (all pending owner approval — CLAUDE.md §1)

1. **Now, zero risk**: fix tracked leftovers (F4) and local seed headers (F5),
   update `docs/UI.md` routes (F6) — pure text, no behavior change.
2. **With the upcoming bank-tool rework**: translate `evidence`/`source`
   metadata + `presente` (F3) in the seed and D1; decide F2 (separate ES
   approval vs documented coupling) and F7 as part of the same governance
   pass; add an ES-gate unit test (F8).
3. **Defer**: the ES template + real-ES trigger (F1 / §2.3-2.4) until the
   first `colombia_perm` job that truly needs a Spanish CV, after the EN flow
   is unblocked and proven.
4. **Leave alone**: Spanish audit docs of 2026-07-17 (historical evidence),
   applied migration comments, all §1 content (text_es, market_colombia
   titles, Spanish scoring keywords, Spanish test data).

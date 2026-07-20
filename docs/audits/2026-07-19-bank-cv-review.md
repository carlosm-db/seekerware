# Audit — Blocks bank & CV subsystem: review + enrichment opportunities

Date: 2026-07-19 · Scope: everything that produces a tailored CV from the
blocks bank — data model (`migrations/0001_initial.sql`), AI selection
(`src/ia/agents.ts`, `src/ia/gemini.ts`), deterministic render + PDF + Drive
archive (`src/ia/cv_factory.ts`, `src/gdocs.ts`), the bank console
(`src/console/app.tsx` `/blocks`, `src/console/blocks-form.ts`,
`src/console/roles.ts`, `src/console/template-check.ts`), and the actual EN/ES
wording in `seeds/seed_blocks.sql` (gitignored; read locally for content).
Read-only audit; the ONLY file created is this report. No source, config, seed,
or DB was modified.

Builds on (does not repeat) three prior audits: `2026-07-18-cv-readiness.md`
(pipeline/plumbing correctness), `2026-07-18-spanish-state.md` (ES flow),
`2026-07-18-bank-schema-data.md` (dead columns). Note: since those, the schema
was **consolidated** into `migrations/0001_initial.sql` and the columns they
flagged as dead (`fact_key`, `evidence`, `source`, `suggested`, `angle`) are
**already gone** — the live `blocks` table is `id, section, anchor_id, text_en,
text_es, es_status, tags, status, updated_at, skcat` (0001:42-51). Where those
findings still bite, it is called out below.

---

## 1. How a CV is assembled end-to-end today

### 1.1 Data model (the bank)

- **`anchors`** (`0001:35-40`): `id` (the role/project CODE, e.g. `BNS1`), `kind`
  (`role`|`project`), `company`, `status` (`active`|`retired`), `title`,
  `date_from`, `date_to`. The `id` is triple-duty: PK, `blocks.anchor_id` FK
  target, AND the `{{<CODE>R<N>}}` template-token prefix — so its shape is
  guarded (`roles.ts:19-37` `validateRoleCode`: uppercase, letter-first, 2-8
  chars, may not end in `R<digits>`, no cross-role token shadowing).
- **`blocks`** (`0001:42-51`): `id`, `section`
  (`summary`|`skills`|`experience`|`projects`), `anchor_id`, `text_en`,
  `text_es`, `es_status` (`missing`|`draft`|`approved`), `tags`, `status`
  (`draft`|`review`|`approved`|`retired`), `skcat`
  (`technical`|`methodologies`|`academic`|`emerging`, skills only).
- **`cvs`** (`0001:110-118`): one row per generated CV — `doc_id`, `doc_url`,
  `lang`, `pdf_file_id`, `blocks_used` (JSON audit trail), `verifier_notes`,
  `rationale`, `sample`, `superseded_by`.
- Current data (`seed_blocks.sql`): **9 anchors** (5 roles BAC1/BNS1/BNS2/DLAB1/
  UPS1 + 4 `prj-*`) and **86 blocks** (summary 12, skills 30, experience 36,
  projects 8). Every block has both `text_en` and `text_es`; all seed rows land
  as `status='draft'`, `es_status='draft'`.
- **Load-bearing vs advisory metadata**: `skcat` is load-bearing (routes skills
  into `{{skills_<cat>}}` lines); `tags` is advisory (shown to Gemini as a
  relevance hint, `agents.ts:72`); `anchor_id` + `section` drive routing.
  `anchors.title`/`date_from`/`date_to` exist in the schema and are read by the
  console (`app.tsx:61`, rendered via `roles.ts:65` `fmtDates`) — **but the seed
  never populates them** (`seed_blocks.sql:6-14` set only id/kind/company/status),
  so today every role card shows no title and no dates.

### 1.2 AI selection (IDs only — never text)

Trigger: a `verdict='Apply'` survivor sets `cv_pending=1` at notification
(pipeline), and the next run's head-of-queue calls `generateCv(...)`
(`pipeline.ts:61-72`, hardcoded `lang='en'`, `sample=false`). The console offers
only a SAMPLE path (`/cvs/sample`).

1. **Catalog build** (`cv_factory.ts:97-116`): selects blocks with
   `status IN ('approved')` for real mode, or `('draft','review','approved')` in
   SAMPLE mode (`:97`). Per block it takes the language text; for real ES it
   additionally requires `es_status='approved'` (`:107`, the "mandatory ES
   parity" gate). Fails safe with `insufficient bank to render <lang>` below 8
   usable blocks (`:110-112`). The catalog passed to Gemini is `{id, section,
   anchor_id, skcat, tags, text}` (`:113-116`) — no owner-private data.
2. **`cvSelector`** (`agents.ts:66-98`): the `responseSchema` restricts each
   section's array `items` to an **enum of that section's catalog IDs**
   (`agents.ts:69-70` `enumOrNull`, `:85-96`) — hallucination is impossible by
   construction; the model can only return IDs that exist. Instruction
   (`:76-83`) tells it to pick ~7 summary bullets, the strongest
   responsibilities per role, skills across categories, **always empty
   `projects`** (projects are static, `maxItems:0` at `:93`), and a one-sentence
   `rationale`. Temp 0.3.
3. **Gemini wrapper** (`gemini.ts:39-100`): 2 models × 2 attempts with backoff
   (`gemini.ts:8` `gemini-3.1-flash-lite → gemini-2.5-flash-lite`), forced JSON
   (`responseMimeType` + `responseSchema`, `:58-63`), truncation/`blockReason`
   detection. Every job description is wrapped as untrusted third-party DATA
   (`gemini.ts:29-37` `wrapUntrusted`, domain rule 5).
4. **`cvVerifier`** (`agents.ts:106-123`, temp 0): reads the rendered body vs the
   job and returns 0-5 free-text `tweaks` — SUGGESTIONS only, never rewrites.

### 1.3 Deterministic render (zero AI)

`buildSlotMap` (`cv_factory.ts:217-287`) is a pure function mapping every
`{{...}}` token PRESENT in the template to selected block text:

- `{{phone}}`/`{{location}}` → per-track contact map (`:44-50`
  `contactPlaceholders`; `canada_coop`→CA values, else CO).
- `{{sum_N}}` → Nth selected summary block (`:258-263`).
- `{{skills_<cat>}}` → selected skills whose `skcat` matches, joined with `, `
  (`:233-240`, `:264-273`). **A selected skill with no `skcat` is silently
  dropped** (`:236` `if (!cat) continue;`).
- `{{<CODE>R<N>}}` → Nth selected responsibility for role `<CODE>`, grouped by
  `anchor_id` in selection order (`:226-232`, `:274-279`).
- Any unrecognized/unfilled token → `''` and reported in
  `filled/blanked/unrecognized/unplaced_blocks` (`:242-286`). **Projects are
  selected-then-never-routed** — `buildSlotMap` only routes summary/skills/
  experience (`:284`), so `projects` picks are dead weight (the selector is
  already told to return none).

Google plumbing (`gdocs.ts`): service-account RS256 JWT → access token
(`:31-60`) → Drive `files.copy` of `CV_TEMPLATE_DOC_ID` into `DRIVE_FOLDER_ID`
(`:74-85`) → `documents.get` reads the copy's `{{...}}` tokens keyed by RAW
literal (`:134-146` `readPlaceholders`) → `documents.batchUpdate` with one
`replaceAllText` per token, `matchCase:true` (`:93-104` `replacePlaceholders`).

### 1.4 PDF + Drive archive + persistence

`cv_factory.ts:138-163`: export the CLEAN doc to PDF **before** appending the
"SUGGESTED TWEAKS" block (`:156` export, `:157-163` append) so the PDF is clean;
`exportAndArchivePdf` (`gdocs.ts:161-182`) exports and uploads into an `archive/`
subfolder it finds-or-creates (`:186-202`). A `cvs` row records selected vs
placed IDs + the token fill report (`:171-183`); for real (non-sample) builds
the job row is stamped `cv_doc_url`/`cv_pdf_key` and `cv_pending=0` (`:186-189`).

### 1.5 The bank console (authoring + governance)

`/blocks` (`app.tsx:1221-1501`): one collapsible section per Summary / Skills
(×4 skcat) / Roles / Projects. A role or group is edited as ONE `<dialog>` form
— its fields plus ALL its bullets — parsed by `parseBulletEdits`
(`blocks-form.ts:30-60`, which **requires both EN and ES on every bullet**) and
saved in one transaction (`app.tsx:1503-1520`). **Saving IS the approval**: the
save routes write `status='approved', es_status='approved'` directly
(`app.tsx:1513`, `:1519`) — there is no separate review step, and EN and ES are
approved together in the same click. `template-check.ts:27-102` diffs the
template's tokens against the bank (both directions) and is the owner's only
pre-render safety net for token/bank mismatches.

---

## 2. Language / wording assessment (EN + ES)

Overall the content is **real, specific, and largely high quality** — no `TODO`/
`XXX`/lorem placeholders anywhere, native-level Spanish with correct diacritics
and Colombian number formatting (`1.000` vs EN `1,000`). The problems are
**consistency, duplication, register, and a few Spanglish leaks** — exactly the
things that hurt when the AI can pick two overlapping blocks into one CV.

### 2.1 Duplicate facts (highest-impact — a CV can state the same achievement twice)

The selector is constrained only by section (`agents.ts:85-96`); nothing dedups
by underlying fact (the old `fact_key` column is gone). Several block pairs are
two phrasings of ONE achievement anchored to the same role — Gemini can pick
both, and `buildSlotMap` renders both:

- **BNS1 "~93% cheque automation"** — `exp-st-03-data` (`seed:23`) "Contributed
  to 7 automation initiatives digitizing approximately 93% of cheque returns and
  chargebacks workflows…" vs `exp-st-04-compliance` (`seed:24`) "Contributed to
  7 automation initiatives that digitized ~93% of cheque returns/chargebacks…".
  Same fact, both BNS1.
- **UPS1 "52-person Colombia migration"** — `exp-ups-01-leadership` (`seed:42`)
  "Led consolidation of credit and collections operations from four North
  American locations … building a 52-person team from scratch…" vs
  `exp-ups-02-leadership` (`seed:43`) "Led the migration of the Collections team
  … building and training a new team of 52 collection specialists…".
- **BNS1 "600+ escalations"** — `exp-st-05-operations` (`seed:25`) vs
  `exp-st-06-operations` (`seed:26`, "over 600 technical issues and 1,000+
  customer support tickets").
- **UPS1 "risk matrix"** — `exp-ups-04-data` (`seed:45`, "risk segmentation
  matrix") vs `exp-ups-05-data` (`seed:46`, "risk assessment matrix … early
  intervention").

These alternates are *intentional* (different angle per job) but there is no
mechanism to ensure only one per CV — see enrichment E1.

### 2.2 Metric / tenure inconsistencies

- **Years of experience disagree across summary blocks**: `sum-profile-01-data`
  (`seed:96`) "5+ years", `sum-bi-01-compliance` (`seed:90`) "5+ years", but
  `sum-profile-03-operations` (`seed:98`) "Over 7+ years". If the selector picks
  two of these, one CV claims both 5+ and 7+ years. Also "Over 7+ years" is
  doubly redundant ("over" + "+").
- **GPA expressed as a percentage**: `sum-diploma-01` (`seed:93`) "Diploma in
  Data Engineering & Analytics (GPA: 89.91%)". A GPA labelled as a percentage is
  unusual to a North-American reviewer (GPA is a 0-4 scale) and the false
  precision (89.91) reads oddly on a CV. Needs an owner call on wording.

### 2.3 Spanglish / register leaks (ES side)

- `exp-st-10-leadership` (`seed:30`) ES leaves **"top performer"** untranslated:
  "Reconocido consistentemente como top performer en Scotiabank…".
- Anglicisms carried into ES that a formal Colombian CV may or may not want:
  **"insights"** (`exp-ups-07`/`08`, `seed:48-49` "insights estratégicos de
  recuperación", "insights de cartera"), **"dashboards"** throughout,
  **"ticketing, workflows"** (`skl-servicenow`, `seed:85`). These are common in
  LATAM tech Spanish and may be acceptable — but it is currently ad-hoc, not a
  decision. This is a termbase question (E4), not a one-off fix.

### 2.4 Structure / style inconsistencies (EN side)

- **Bullet length varies wildly.** Most bullets are one crisp line, but
  `exp-st-01-operations` (`seed:21`) and `exp-dvl-02-data` (`seed:38`) are
  ~55-word paragraphs (the first enumerates six payment systems inline). On a
  one-page CV these will wrap to 3-4 lines and break the visual rhythm of the
  role.
- **Projects mix verb tense.** `prj-corex-01` (`seed:55`) "Developing…"
  (present) vs `prj-biq-01` (`seed:51`) "Developed…" (past) vs `prj-rec-02`
  (`seed:58`) "Runs entirely in-browser…" (present, subjectless). Experience
  bullets are consistently past-tense; projects are not.
- **Bare, unexpanded acronyms as skills**: `skl-pmlc` "PMLC" (`seed:78`) and
  `skl-sdlc` "SDLC" (`seed:84`) appear with no expansion; "PMLC" in particular
  is ambiguous on a skills line.
- **Capitalization drift EN↔ES**: `skl-prompt` (`seed:81`) EN "Prompt
  Engineering" vs ES "Prompt engineering".
- **Minor EN grammar**: `exp-ba-01-operations` (`seed:15`) "implemented
  Excel-based double-verification system" (missing article "an"); the ES twin is
  correct.
- **Contractor framing that may read oddly to an employer**: `exp-dvl-01`
  (`seed:37`) "…Retained full IP for broader application." / "Propiedad
  intelectual retenida para aplicación más amplia." — fine for a portfolio,
  potentially confusing as an employment bullet.

### 2.5 A content/template collision

`sum-langs-01` (`seed:94`) "Languages: English (Professional), Spanish (Native),
French (Basic)." is a **summary** block, but per `TRD.md:166-168` the Languages
line is **static in the template**. If the selector picks `sum-langs-01` into a
`{{sum_N}}` slot, languages render twice. Either drop this block or make the
template's Languages line a token — a design decision, not a wording fix.

---

## 3. Enrichment opportunities — proper reusable capabilities

Each below is framed as a *general mechanism that runs on every CV / every
block*, not a one-time content patch. Every one respects the domain rules (AI
selects IDs; render is deterministic; new phrasing is an owner-approved edit).

### E1 — Fact-group dedup ("one claim, many phrasings, never twice per CV")

**Capability**: a lightweight `fact_group` key on blocks (or a join table) plus a
deterministic post-selection pass in `generateCv` that keeps at most one block
per fact group per section, preferring the highest-priority phrasing for the
job. **Why proper, not throwaway**: it fixes the *class* of bug in §2.1 for all
current and future alternates, is a pure testable function (mirrors the existing
`buildSlotMap` test style), and is the deterministic guarantee the AI-hint model
cannot give. It also gives the console a "these are the same fact" grouping view.
The earlier schema HAD `fact_key` for exactly this and it was dropped as "dead"
— but it was dead only because *nothing consumed it*; this makes it load-bearing.
Throwaway alternative to avoid: hand-deleting one of each duplicate pair (loses
the per-job angle flexibility and recurs on the next added block).

### E2 — Structured, machine-checkable metrics per block

**Capability**: an optional structured `metric` on quantified blocks
(`{value, unit, basis, verified_bool}`), surfaced in the console and used by the
verifier to (a) flag tenure/number contradictions across selected blocks (§2.2
"5+ vs 7+"), and (b) give the owner a single "claims ledger" to audit what every
CV can assert. **Why proper**: it is a reusable data capability that powers
consistency-checking on *every* render and doubles as interview-prep ground
truth; it is not the free-text `evidence` column that was (rightly) dropped —
this is structured and consumed by code.

### E3 — Deterministic CV linter / fill report (extend the verifier with code, not prompts)

**Capability**: a pure post-render check that reports, per build: blank slots,
raw `{{token}}` leaks (the padded-token risk in cv-readiness M2), duplicate
facts (E1), tenure contradictions (E2), skills dropped for missing `skcat`
(bank-schema F3), and per-role under-fill (e.g. DLAB1's exact 5/5 supply). It
returns structured findings into `FactoryResult` + a `/cvs` flash + a warn
event. **Why proper**: it is the deterministic complement to the AI
`cvVerifier`, runs on every CV, is fully unit-testable, and turns today's
"eyeball the Doc" into an enforced gate. (cv-readiness already recommended the
fill-report slice; this generalizes it into a reusable linter.)

### E4 — Bilingual termbase + ES parity workflow that actually gates

**Capability**: (a) a small controlled glossary of preferred EN↔ES renderings
(e.g. keep "dashboards"? translate "insights"→"perspectivas"? never leave "top
performer") checked when an ES draft is saved; (b) **decoupled ES approval** —
today saving sets `es_status='approved'` in the same click as EN
(`app.tsx:1513,1519`), so the `cv_factory.ts:107` ES-parity gate gates nothing
(spanish-state F2). A real ES-review status transition + an ES parity report
before an ES render restores the gate's meaning. **Why proper**: the termbase
enforces the CONVENTIONS "one term per concept" rule for CV content across the
whole bank; the decoupled workflow is the reusable governance every future
`colombia_perm` CV needs — versus one-off fixing "top performer".

### E5 — Richer, validated skills taxonomy

**Capability**: enforce `skcat` presence on every `section='skills'` block at
save time (today a missing `skcat` = a silently dropped skill, bank-schema F3),
and optionally add a `proficiency` / `last_used` dimension. **Why proper**: it
closes a silent data-loss path in the deterministic render AND the same
structured skills data can later feed the step-8 kit's question answers
(reused beyond the CV). Also resolves the bare-acronym issue (§2.4) by requiring
an expansion field.

### E6 — Role identity as data (titles + dates), and the projects decision

**Capability**: populate and render `anchors.title`/`date_from`/`date_to` (all
NULL today) so role headers/dates come from data via the existing `roles.ts`
`fmtDates`, instead of being frozen as static template text; and resolve the
projects story (either wire `{{<PRJCODE>L<N>}}` tokens + route
`selection.projects`, or stop selecting projects — they are dead weight today).
**Why proper**: it removes the hardest-to-change static content from the Doc into
the governed bank, enabling per-market titles (the ES market-title need in
spanish-state) without hand-editing the template — a reusable capability across
EN and a future ES template.

---

## 4. Context needed from the owner to enrich well

To do E1-E6 (and to correct §2) without guessing, the owner should provide:

- **Real role titles + month ranges** for each of the 5 roles (BAC1, BNS1, BNS2,
  DLAB1, UPS1) — currently absent from the data (`seed_blocks.sql:10-14` set no
  title/dates). Include the exact EN title and the intended Colombian-market ES
  title per role.
- **Ground-truth for every quantified claim**, marked verified/approximate and
  interview-defensible: the 92% error reduction, ~93% automation (×7
  initiatives), 20% recovery, 170% performance-review score, $200M portfolio, 52
  people, 600+ escalations / 1,000+ tickets, 89.91% GPA, and the years-of-
  experience number.
- **The canonical tenure figure** — is it 5+, 7+, or something else? (Resolves
  §2.2 so summary blocks agree.)
- **Which blocks are alternate phrasings of the same fact** — confirm/correct the
  groups in §2.1 so E1 can be seeded (the tool can propose groups; the owner
  ratifies).
- **Target seniority per track** (analyst vs senior vs lead, per canada_coop /
  contractor_usd / colombia_perm) — drives summary emphasis, title wording, and
  selection weighting.
- **Spanish-CV conventions for Colombia**: whether to keep anglicisms
  (dashboards/insights/ticketing) or translate them; degree/GPA presentation on
  the Spanish side; how "presente" and month names should read; and whether the
  Colombian market expects sections the current English skeleton omits.
- **Education block details** for the static template area: exact degree
  name(s), institution, dates, and how to express the grade (GPA scale vs
  percentage).
- **Languages line** canonical wording + levels (keep "Professional/Native/
  Basic" or move to CEFR B2/C1?), and whether Languages should stay static or
  become a token (resolves §2.5).
- **The projects decision** (E6): which projects to show, static vs
  per-job-tailored, and in what format.
- **GPA / metric that reads oddly** (89.91%): confirm the wording the owner
  wants on the actual CV.

---

## 5. Cross-references (do not re-solve here)

- Plumbing correctness, padded-token leak (M2), sample-cancels-real (M3),
  fill-report (M4), retry-budget/quota burn (C1/C2): `2026-07-18-cv-readiness.md`.
- ES flow, single English template → Spanglish ES render, approval coupling
  (F2), real-ES trigger missing: `2026-07-18-spanish-state.md`.
- Dead columns (now dropped in 0001), `skcat`-drop silent skill loss (F3),
  governance-not-enforced (F4): `2026-07-18-bank-schema-data.md`.

Nothing in this audit was implemented. Per CLAUDE.md §1, each enrichment is a
proposal requiring explicit owner approval before any edit.

---

## Follow-up 2026-07-19: CV/kit flow (Generate CV placement, Build kit, queued build)

Three owner questions about the real behavior of the CV / kit / applications
flow. All traced in code; read-only. Nothing implemented.

### F-1 — "Generate CV" placement (owner: "didn't see the point of where it is")

**Real behavior.** `POST /jobs/:hash/cv` (`app.tsx:1753-1765`) does NOT build a
CV. It checks the job is `new`/`notified` (`:1760`), sets
`UPDATE jobs SET cv_pending = 1` (`:1763`), and redirects with the flash
`CV queued — the next pipeline run builds it from your bank` (`:1764`). The
button is rendered in exactly two places: the Today row (`app.tsx:225`) and the
job detail card (`app.tsx:351-353`). The `/cvs` page has **no** generate control
— it only prints "To generate a CV, open the job … and tap Generate CV there"
(`app.tsx:1725`). The `/applications` page (the Apply queue) has **no** Generate
CV control either; when a kit has no CV it tells the owner "no CV yet — Generate
CV on the job page" (`app.tsx:1831`), sending them away from the queue they are
working in.

**Diagnosis: UX/placement gap, by-design, not a bug.** The action is a trivial
one-field POST, and every `/applications` row already carries the
`url_hash` it needs (`SELECT … j.url_hash` `app.tsx:1771`; already used for the
Build-kit hidden input `app.tsx:1814`). So the queue where the owner decides to
apply is precisely where the "queue a CV" action is missing. The current handler
even has a `back` param but it only maps `'today' → '/'`, else the job page
(`app.tsx:1756`) — it cannot currently return to `/applications`.

**Options (no implementation).** (a) Add a "Generate CV" form to each
`/applications` row reusing `POST /jobs/:hash/cv`, extending the `back` handling
(`app.tsx:1756`) to also accept `applications`; (b) move it there entirely and
drop it from the job page; (c) keep it on the job page and also add it to
`/applications` (least disruptive). All three reuse the same handler and the
same `cv_pending` mechanism — no new build path.

### F-2 — "Build kit does nothing — a button with no function"

**Real behavior.** `POST /applications/build` (`app.tsx:1898-1908`) →
`buildKit` (`kit/kit.ts:20-84`). `buildKit` almost always succeeds: it returns
`ok:false` ONLY when the job row is missing (`kit.ts:26`). Otherwise it (1)
loads the job + company token (`kit.ts:21-25`), (2) calls `detectQuestions`
inside a try/catch that **swallows any error into a non-fatal `detectError`**
(`kit.ts:32-41`), (3) reads the answers bank `WHERE status='approved'`
(`kit.ts:43-47`), (4) matches (`kit.ts:48`), (5) **upserts an
`application_kits` row and writes a `kit_built` job_event** (`kit.ts:52-74`), and
(6) returns matched/red/eeoc counts. The route always shows a flash:
`kit built: N matched · M red · K EEOC-flagged`, or the
`kit built (this ATS does not expose its form publicly …)` variant
(`app.tsx:1902-1906`).

So it is **functional-but-invisible, not broken.** Why the owner perceives
nothing, with evidence:

- **Empty approved answers bank ⇒ 0 matched (hypothesis c, confirmed likely).**
  No seed creates `profile_answers` (only `seed_blocks`/`seed_companies`/
  `seed_config` exist); the bank starts empty and answers must be added AND
  approved in `/applications` (`app.tsx:1863-1893`). `matchAnswers` marks every
  unmatched question `red` (`questions.ts:73`), so with 0 approved answers,
  `matched` is always 0.
- **Undetectable / failing ATS ⇒ 0 red, 0 EEOC too (hypotheses a + d).** Ashby
  returns `{questions:[], eeoc:[], detectable:false}` (`questions.ts:129`);
  Greenhouse/Lever throw on a fetch failure, which is caught and leaves
  `detectable=false` (`kit.ts:30,39-41`). Either way the kit has 0 questions ⇒
  0 red ⇒ the summary is `0 · 0 · 0`.
- **The button disappears and is replaced by a collapsed "0·0·0" line
  (hypothesis b — the visible cause).** After building, `hasKit = r.kit_at !=
  null` is true (`app.tsx:1803`), so the primary **Build kit button is removed**
  (`app.tsx:1812` `{!hasKit ? … }`) and replaced by a **collapsed** `<details>`
  whose summary reads `Kit — 0 matched · 0 red · 0 EEOC` (`app.tsx:1828-1829`),
  with "no CV yet — Generate CV on the job page" inside (`app.tsx:1831`). Net
  visual after the click: the button vanishes, a tiny collapsed line appears,
  the flash is easy to miss → reads as "did nothing."

**Concrete case — "Data Analyst (Intermediate/Senior), Credit" @ KOHO.** KOHO is
seeded as **Ashby** (`seed_companies.sql:22`: `('KOHO','ashby','koho',…)`).
`detectQuestions` has no Ashby path — it returns
`{ questions: [], eeoc: [], detectable: false }` with no fetch and no error
(`questions.ts:124-129`; Ashby "has no public form API", `questions.ts:2-4`). So
for this exact job `buildKit` runs the happy path with nothing to work on:
`questions=[]` ⇒ `matchAnswers([])=[]` ⇒ `matched=0, red=0, eeoc=0`; no
`detectError` is set (nothing threw), so the `kit_built` event records
`0 matched · 0 red · 0 EEOC` (`kit.ts:73`) and the flash takes the
non-detectable branch: `kit built (this ATS does not expose its form publicly —
open the form to see the questions)` with no error suffix (`app.tsx:1903-1905`,
`r.error` undefined). The row IS written (`kit.ts:52-74`), then `hasKit` flips
true, the Build kit button disappears (`app.tsx:1812`) and a **collapsed**
`Kit — 0 matched · 0 red · 0 EEOC` details appears containing "no CV yet"
(`app.tsx:1828-1831`). **Most likely real reason the owner saw nothing: KOHO is
Ashby (undetectable by design) AND the approved answers bank is empty, so the
kit is genuinely empty (0·0·0), the button vanished, and the only signal was a
collapsed details line plus an easy-to-miss flash. Working as coded, not
broken** — but for an Ashby job the feature can never show detected questions, so
the empty result is the permanent expected output here.

**Additional real gap found.** Once a kit exists there is **no rebuild control**
(the button is hidden whenever `hasKit`, `app.tsx:1812`). `buildKit` snapshots
`cv_doc_url`/`cv_pdf_key` from the job **at build time** (`kit.ts:22-23,67`), so
building the kit BEFORE the CV is generated permanently pins "no CV yet" with no
UI path to refresh it.

**Diagnosis: functional, but a UX-invisibility gap plus a missing rebuild.**
Options (no implementation): keep a "Rebuild kit" action visible when `hasKit`;
open the `<details>` (or show a summary chip) after a build; block/greying Build
kit until a CV exists (or auto-attach the CV on rebuild); seed/prompt the answers
bank so the first kit shows non-zero matches.

### F-2 addendum — the kit is CIRCULAR: Build kit depends on a CV built on another page via cron

**Owner's real observation (verified).** After clicking Build kit and opening the
kit, it showed **"no CV yet — Generate CV on the job page"**. That is the
`r.kit_cv ? … : <span class="warn">no CV yet — Generate CV on the job page</span>`
branch (`app.tsx:1831`), and the Telegram kit message has the identical dead-end:
`kit.cv_doc_url ? '📄 CV: …' : '📄 CV: not built yet — Generate CV from the job
page first'` (`tg.ts:68-75`). Owner's verdict: **Build kit is worthless as-is.**

**Why it is circular (file:line).** `buildKit` **does not build a CV** — it only
*reads* the job's already-built CV pointers: the SELECT pulls
`j.cv_doc_url, j.cv_pdf_key` (`kit.ts:22-23`) and the upsert stores exactly those
values into `application_kits.cv_doc_url / cv_pdf_id` (`kit.ts:54-67`). Those two
columns on `jobs` are written in **only one place** — `generateCv` on a
successful build (`cv_factory.ts:187`
`UPDATE jobs SET cv_doc_url=?, cv_pdf_key=?, cv_pending=0`). And `generateCv`
runs only from the pipeline's `cv_pending` queue (`pipeline.ts:42-73`), which is
set on a **different page** (`POST /jobs/:hash/cv`, `app.tsx:1763`) and executes
on the **next cron tick** (F-1/F-3 addendum). So the dependency chain is:
Build kit (on `/applications`) → needs `jobs.cv_doc_url` → set only by a queued
build → triggered on `/jobs/:hash` → runs up to ~1 h later. Build kit *before*
that completes (the normal case) snapshots `NULL` into the kit and, with no
rebuild control (`app.tsx:1812` hides the button once `hasKit`), the kit is
**permanently** stuck at "no CV yet" and bounces the owner to another page. For
KOHO specifically the whole kit is empty: Ashby ⇒ 0 detected questions
(`questions.ts:124-129`), empty approved answers bank ⇒ 0 matches
(`kit.ts:43-48`), and no CV ⇒ the warn line — i.e. nothing to show on any axis,
which is exactly why it reads as "nothing happened."

**Diagnosis: design flaw, not a UI miss.** Two actions split across two pages
with a cron wait wedged between them cannot produce a usable kit in one sitting.
The kit assembler consumes a CV it has no way to cause. The owner's intended end
state: from `/applications`, **one on-demand action that produces the CV AND the
kit together, immediately**, then shows the CV link + matched/red/EEOC in place.

**Options for a UNIFIED, on-demand "Prepare application" capability (no
implementation).** All keep the domain rules (AI selects IDs; deterministic
render; human submits) and reuse the existing pure entry points `generateCv`
(`cv_factory.ts:86`) and `buildKit` (`kit.ts:20`) in sequence.

- **(A) Synchronous "Prepare application".** One button on each `/applications`
  row: `await generateCv(job,'en',false)` then `await buildKit(hash)` (which now
  reads the freshly-written `jobs.cv_doc_url`), then re-render the row with the CV
  link and `matched · red · EEOC`. *Latency:* one request hangs ~6-25 s (2 Gemini
  calls + ~8 gdocs calls + 1 question-detect fetch). *Limit risk:* subrequests ≈
  9-17 (CV) + 1 (detect) ≈ **10-18 of the 50 budget** for this standalone
  console invocation (its own budget, `TRD.md:227`) — comfortable; CPU is one
  RS256 sign + one PDF blob (`gdocs.ts:45-49,166-173`) — low but **measure**
  against the 1102 cap that seeding hit (`pipeline.ts:28-30`). *Verdict:*
  cleanest match to owner intent; inline success/error at the point of action.
- **(B) Immediate return + `ctx.waitUntil` chain.** Button flips a "preparing"
  state and runs `generateCv`→`buildKit` in `ctx.waitUntil` (the pattern the
  scheduled handler already uses, `index.ts:265`); the row shows a
  "preparing…" badge and resolves to CV + counts on refresh. *Latency:* instant
  response. *Limit risk:* same work off the response path; errors surface in
  `/health` events, not inline. *Verdict:* best if (A)'s hang or CPU proves
  marginal; **requires** a persisted "preparing/ready/failed" state so the kit is
  never shown half-built (this also retires the circular NULL-snapshot bug).
- **(C) Keep two steps but make buildKit self-heal.** Leave Generate CV as-is but
  have `buildKit` build the CV on demand when `jobs.cv_doc_url` is NULL (call
  `generateCv` inside `buildKit` instead of only reading its output). *Latency:*
  same as (A) when a CV is missing. *Trade-off:* removes the circularity with a
  smaller surface, but two buttons/labels remain and the mental model stays
  "kit + CV are separate," which is what confused the owner. *Verdict:* partial
  fix; less aligned with "one action."
- **(D) Reuse `POST /api/run`.** Rejected for this use case (F-1/F-3 (iii)): runs
  the whole 25-company pipeline, `LIMIT 1` CV, and risks the 50-subrequest cap in
  one invocation. Blunt.

**Recommendation.** Ship **(A) a single "Prepare application" action on each
`/applications` row** that synchronously runs `generateCv` then `buildKit` and
re-renders the row with the CV link and `matched · red · EEOC` — collapsing two
pages + a cron wait into one immediate result. Add a persisted kit state
(`preparing`/`ready`/`failed`) and a **Rebuild** affordance so the NULL-snapshot
and no-rebuild bugs die with the split. If CPU measurement (RS256 + PDF on a
representative Doc) comes near the 1102 cap, downgrade to **(B) `ctx.waitUntil`
+ state badge**; both are proper reusable capabilities built from the existing
pure functions, not hacks. Note the honest floor: even a perfect unified action
yields an *empty* kit for an Ashby job with an empty answers bank — so pair it
with seeding/prompting the approved answers bank and setting owner expectations
that Ashby forms are not machine-readable (the kit's value there is the CV +
positioning + deep link, not detected questions).

### F-3 — "CV queued — the next pipeline run builds it from your bank" (async model)

**Real behavior — confirmed async, by-design.** Generate CV only sets
`cv_pending=1` (`app.tsx:1763`). The pipeline consumes it at **run start**:
`SELECT … WHERE j.cv_pending = 1 AND j.status IN ('new','notified') ORDER BY
j.notified_at, j.first_seen LIMIT 1` — **one build per run** (`pipeline.ts:42-47`),
gated on `env.GOOGLE_SA_KEY` (`:41`), calling `generateCv(…, 'en', false, …)`
(`:61-67`). A retry budget caps repeated failures at `cv_pending_max`
(`pipeline.ts:37,51-59`). On success `generateCv` sets
`cv_doc_url`, `cv_pdf_key`, `cv_pending=0` on the job and inserts a `cvs` row
(`cv_factory.ts:186-189`, `:171-183`). `cv_pending` is also set organically at
notification for `verdict='Apply'` jobs (`pipeline.ts:318`).

**Where the result surfaces.** (1) The `/cvs` "CV library" table, read straight
from the `cvs` table (`app.tsx:1703-1748`). (2) `jobs.cv_doc_url` — but note the
**job detail page never renders it** (the render at `app.tsx:322-407` shows the
Generate CV button and history, no CV link), so the owner does NOT see the built
CV where they queued it. (3) The kit's CV link, only if the kit is (re)built
**after** the CV exists (`kit.ts:23,67`; shown at `app.tsx:1831`).

**Timing.** Cron is `"0 * * * *"` = top of every hour (`wrangler.jsonc:11`),
further gated by the schedule config — default `every_hours:1`, window
09:00–19:00 `America/New_York` (`schedule.ts:16-17`, `shouldRunAt`
`:52-54`). So a queued CV builds within ~1 hour during the daytime window, or
waits until the next morning if queued after hours. The owner can force it
immediately with `POST /api/run` (`index.ts:20-29`, `trigger='manual'`, runs the
full pipeline including the one CV build).

**Diagnosis: correct and by-design; two UX gaps.** The "queued" message is
accurate. Gaps: (i) the job page where you queue never shows the finished
`cv_doc_url` (only `/cvs` does), so there is no feedback loop at the point of
action; (ii) a kit built before the CV exists won't reflect the new CV without a
rebuild (F-2). Options (no implementation): render `cv_doc_url` + a pending/ready
badge on the job detail and `/applications` rows; surface a "run now" affordance;
auto-refresh the kit's CV pointer.

### F-1/F-3 addendum — FIRM REQUIREMENT: "Generate CV" must be immediate / on-demand

The owner has ruled that queuing for the next cron run is unacceptable: when they
decide to apply to a specific job, the CV must build **now**, not in up to an
hour (or overnight). This reframes the options above from "where to place the
button" into "how to make the build synchronous."

**What happens today (the unacceptable wait).** `POST /jobs/:hash/cv` only sets
`cv_pending=1` (`app.tsx:1763`). The build happens at the *start* of a later
scheduled run, **one per run** (`pipeline.ts:42-73`, `LIMIT 1`). Cron fires at
the top of every hour (`wrangler.jsonc:11` `"0 * * * *"`), and each tick is
further gated by the `schedule` config — default `every_hours:1`, window
09:00–19:00 `America/New_York` (`schedule.ts:16-17`, `shouldRunAt` `:52-54`,
enforced in `index.ts:261-264`). **Real wait: up to ~1 hour inside the daytime
window; until ~09:00 ET next day if queued after 19:00; and because the queue is
`LIMIT 1`, multiple queued CVs serialize one-per-hour.**

**Why it was deferred to the pipeline.** The design comments state the intent:
"builds ONE pending item per run … 1 build/run, fixed budget"
(`pipeline.ts:39`, `:314-317`). The constraint is the Workers free tier. A single
`generateCv` (`cv_factory.ts:86-195`) makes ~2 Gemini calls (selector +
verifier, each up to 4 with retry/fallback, `gemini.ts:48-98`) plus a chain of
Google REST calls (token, `files.copy`, `documents.get`, `batchUpdate`,
`export`, ensure-archive, upload, append ≈ 8 subrequests, `gdocs.ts`) — the
cv-readiness audit measured **~9-17 outbound calls**. CPU-heavy bits are the
RS256 JWT signing (`gdocs.ts:45-49`) and PDF-byte handling (`gdocs.ts:166-173`);
the free tier gives ~10 ms CPU per invocation and 50 subrequests, and **error
1102 (CPU cap) was already hit during seeding** (`pipeline.ts:28-30`;
cv-readiness step 10).

**The key facts that make on-demand feasible.** (1) Nearly all of those ~9-17
calls are **network waits, which do NOT count against the 10 ms CPU limit**
(`TRD.md:24-25`, `:108-109`). (2) A console action gets **its own invocation with
its own 50-subrequest budget** — the TRD explicitly reserves this for a
"regenerate CV" action (`TRD.md:227`). (3) The 1102 seen was scoring **1,336
jobs** in a loop, not one CV; a single RS256 sign + one PDF blob is far less CPU
(still worth measuring on a large Doc).

**On-demand options and trade-offs (no implementation):**

- **(i) Synchronous build in the fetch handler.** `POST /jobs/:hash/cv` awaits
  `generateCv` and redirects to the finished Doc/`/cvs`. *Owner latency:* the
  request hangs ~5-20 s (Gemini + Google network waits) then shows the result or
  the exact error inline. *Limit risk:* fits the console's own 50-subrequest
  budget (`TRD.md:227`); CPU is one sign + one PDF blob — low, measure on a big
  Doc. *Verdict:* proper reusable capability (an on-demand generate action the
  TRD already anticipates); simplest model; inline success/error is good UX;
  only downside is a multi-second hang.
- **(ii) Return immediately, build via `ctx.waitUntil`.** Redirect instantly with
  "building now"; run `generateCv` in `ctx.waitUntil` exactly as the scheduled
  handler already does (`index.ts:265`). *Owner latency:* instant redirect,
  result on `/cvs` a few seconds later (needs a "building" badge to avoid the
  F-2/F-3 invisibility). *Limit risk:* same work, decoupled from the response;
  errors land in `/health` events, not inline. *Verdict:* proper reusable
  capability; best when the synchronous hang or CPU proves marginal; costs a
  status indicator.
- **(iii) "Run pipeline now" reusing `POST /api/run`.** Queue `cv_pending=1`,
  then trigger the existing manual run (`index.ts:20-29`), which already builds
  the one pending CV at run start. *Owner latency:* a full pipeline pass
  (25-company poll + 1 CV). *Limit risk:* highest — the ~39/50 poll plus the
  ~9-17 CV calls can approach/exceed 50 subrequests **in one invocation**, and
  it still builds only `LIMIT 1`. *Verdict:* reuses existing plumbing (zero new
  build path) but is a blunt instrument for "this job now" — closer to a hack for
  this use case.

**Recommendation.** Adopt **(i) synchronous on-demand build**, exposed as a
"Generate CV now" action on both the job page and each `/applications` row
(satisfying F-1), keeping `cv_pending` as the fallback for organic Apply
notifications (`pipeline.ts:318`) so nothing regresses. `generateCv` is already a
single pure entry point, so the only change is a call site that **awaits** it in
the fetch handler instead of flipping a flag — a proper reusable capability, not
a hack. Before committing to fully-synchronous, **measure** the real CPU of
RS256 + PDF assembly on a representative Doc; if it is marginal, fall back to
**(ii) `ctx.waitUntil` + a "building/ready" badge**. Avoid (iii) for the
single-job case.

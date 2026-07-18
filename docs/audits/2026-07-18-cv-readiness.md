# Audit — End-to-end CV readiness (everything between today and the first real tailored CV)

Date: 2026-07-18 · Scope: `src/console/app.tsx` (POST `/cvs/sample`), `src/ia/cv_factory.ts`,
`src/ia/agents.ts`, `src/ia/gemini.ts`, `src/gdocs.ts`, `src/pipeline.ts`, migrations 0001/0003/0006,
local D1 (read-only). Remote/live checks (Drive sharing, remote D1, deployed secrets) were NOT
possible from this session — they are tagged as owner verifications in the checklist.

Verified state (local D1, `npx wrangler d1 execute seekerware --local`):
- blocks: 86 total, ALL `status='draft'`, ALL `es_status='draft'`, 0 NULL `text_en`/`text_es`.
  By section: summary 12, skills 30, experience 36, projects 8.
- experience per anchor: BNS1 12, UPS1 9, BAC1 6, DLAB1 5, BNS2 4.
- skills per `skcat`: technical 11, methodologies 10, academic 5, emerging 4 (matches owner's claim).
- anchors: 5 roles (BAC1, BNS1, BNS2, DLAB1, UPS1) + 4 projects (`prj-*`).
- `contact_profile` set (local copy holds placeholder test data; the real one lives in remote D1).
- jobs: 0 with `verdict='Apply'` (ever), 0 with `cv_pending=1`, 0 rows in `cvs`.
  3 sample candidates, all `Stretch-worth-it` / `canada_coop` / status `new`, description_text 3.5–3.8 KB.
- config: scoring thresholds `apply:75, stretch:55`; `quota_limits.gemini_rpd=1000`;
  `observability.cv_pending_max=3`; `poll_page_size=25`; `FRESHNESS_MAX_DAYS=3`.

---

## 1. Full generation path — preconditions and failure modes, in execution order

### 1a. Console sample path — POST `/cvs/sample` (src/console/app.tsx:1193-1210)

| # | Step | Code | Preconditions | Failure mode / surfacing |
|---|------|------|---------------|--------------------------|
| 0 | Auth + form | app.tsx:18, 1193-1196 | cookie login; `hash` from the candidates dropdown (verdict Apply/Stretch, status new/notified, app.tsx:1147-1152) | unknown hash → flash `job not found` (app.tsx:1201) |
| 1 | Job load | app.tsx:1197-1200 | job row exists; `description_text` may be NULL → `''` passed to the AI (garbage selection, no error) | none — silent quality degradation |
| 2 | Catalog gate | cv_factory.ts:85-99 | sample allows `('draft','review','approved')`; needs >=8 usable blocks in the language | `insufficient bank to render <lang>` → flash. 86 drafts exist → sample passes today for EN and ES (ES parity gate at :95 is skipped when `sample=true`) |
| 3 | `cvSelector` (Gemini) | cv_factory.ts:107-109; agents.ts:65-95 | `GEMINI_API_KEY`; IDs enum-forced per section | fail after ≤4 calls (2 models × 2 attempts, gemini.ts:48-98) → `cv_selector: <err>` → flash |
| 4 | `roleCodes` | cv_factory.ts:114 | anchors table — includes `prj-*` project anchors too (harmless for the current tokens) | — |
| 5 | `cvVerifier` (Gemini) | cv_factory.ts:117-119 | none hard — failure is non-fatal, `tweaks=[]` | verifier error is silently swallowed (never surfaced) |
| 6 | `googleAccessToken` | cv_factory.ts:124; gdocs.ts:31-60 | `GOOGLE_SA_KEY` secret valid; JWT RS256 → token | `GOOGLE_SA_KEY not configured` / `google token: HTTP <s>` → flash |
| 7 | `copyTemplate` | cv_factory.ts:127; gdocs.ts:74-83 | **SA must have access to `CV_TEMPLATE_DOC_ID` (historic 404) and edit rights on `DRIVE_FOLDER_ID`**; both env vars set — NO explicit guard: unset var interpolates the string `undefined` into the URL → confusing Google 404 | `google api https://www.googleapis.com/drive/v3/files/…: HTTP 404` → flash |
| 8 | contact profile | cv_factory.ts:131-135 | `config['contact_profile']` — absence only sets `contact_missing` flag; invalid JSON silently → `{}` | `contact_missing` is returned but **ignored by both callers** (app.tsx:1209, pipeline.ts:53-55) |
| 9 | `readPlaceholders` | cv_factory.ts:137; gdocs.ts:123-133 | copy readable; regex `\{\{\s*([^{}]+?)\s*\}\}` over concatenated body text incl. table cells; token names are **trimmed** | see finding M2: padded tokens are read but can never be replaced |
| 10 | `buildSlotMap` | cv_factory.ts:138, 187-228 | recognizers: contact map, `^sum_(\d+)$`, `^skills_(.+)$`, `^(.+)R(\d+)$` with `roleCodes.includes` | unmatched/unrecognized tokens → `''` **silently** (no report of blank slots) |
| 11 | `replacePlaceholders` | cv_factory.ts:139; gdocs.ts:91-102 | one `batchUpdate` with `replaceAllText` per entry, `matchCase:true`, exact literal `{{name}}` | Google error → flash; whitespace-padded tokens in the Doc never match (M2) |
| 12 | `exportAndArchivePdf` | cv_factory.ts:141-142; gdocs.ts:148-169 | export **before** the appendix → clean PDF ✓; `archive/` subfolder found or created under `DRIVE_FOLDER_ID` | failure here → orphan filled Doc already exists in Drive (no cleanup) |
| 13 | Appendix | cv_factory.ts:143-149; gdocs.ts:136-145 | Doc-only (post-PDF) ✓ — rationale + verifier tweaks | failure → orphan Doc + archived PDF, no `cvs` row |
| 14 | Persistence | cv_factory.ts:152-162 | `cvs` INSERT (`sample=1`), then `UPDATE jobs SET cv_doc_url, cv_pdf_key, cv_pending=0` — **unconditional, also for samples** (M3) | flash: `sample generated: review it in Drive` or `FAILED: <error>` (app.tsx:1209) — error surfacing exists ✓ |

### 1b. Pipeline real path (src/pipeline.ts:36-57 + 293-301)

Differences from the sample path:
- **Trigger**: `cv_pending=1` is set ONLY when a job with `verdict==='Apply'` is successfully notified
  (pipeline.ts:299). There is no other producer and **no console button for a real CV** (only `/cvs/sample`).
- **Build slot**: one per run, the oldest `cv_pending=1 AND status='notified'` (pipeline.ts:39-43),
  gated only on `env.GOOGLE_SA_KEY` (pipeline.ts:38). Always `lang='en'`, `sample=false` (pipeline.ts:51)
  — **no real-ES path exists anywhere**.
- **Catalog**: approved-only (`cv_factory.ts:85`), and for ES it would additionally require
  `es_status='approved'` per block (cv_factory.ts:95). Today 0 approved → every real build fails at the
  catalog gate ("insufficient bank to render en (approved): 0 blocks") **before any Gemini call** (no quota burn).
- **Retry**: on failure `cv_pending` stays 1 → the SAME job is retried every run (cron `*/30`, 48/day),
  forever: no failure counter, no backoff, no `cv_pending_max` enforcement (the config key
  `observability.cv_pending_max:3`, migrations/0003_observability.sql:67, is **read nowhere** in src).
- **Failure surfacing**: `gdocs_fail` warn event (pipeline.ts:54) → visible in /health "Recent events"
  (app.tsx:1222-1259) and in the run's error count. No Telegram alert.
- **Job closes while pending**: auto-expire flips status to `closed` → the pending query stops matching;
  the CV is silently never built (acceptable, but invisible).

### Order-of-failure economics (the important one)

In `generateCv` the two Gemini calls (steps 3, 5) run **before** the first Google Docs call (step 6-7).
If the bank is approved but the template is still not shared (the historic Drive 404), each pipeline
retry burns ~2 Gemini calls (up to 8 with fallback/retries) and then fails at `copyTemplate`:
**~96–384 Gemini requests/day** against the free tier's ~1000 RPD, every 30 minutes, indefinitely —
plus the head of the CV queue is wedged (LIMIT 1, oldest first). `quota_limits.gemini_rpd` exists in
config but is never enforced in code (only per-run counting into `runs.gemini_calls`).

---

## 2. Cross-check: owner's template token list vs `buildSlotMap` recognizers vs seeded supply

| Template token(s) | Recognizer (cv_factory.ts) | Slots | Supply (local D1) | Verdict |
|---|---|---|---|---|
| `{{phone}}`, `{{location}}` | contact map :215 (per track, :44-50) | 2 | contact_profile set | OK (CA values for `canada_coop`, CO otherwise; `track=NULL` → CO values) |
| `{{sum_1..7}}` | `^sum_(\d+)$` :216 | 7 | 12 summary blocks | OK (selector maxItems 8 :87 — 8th silently dropped) |
| `{{skills_methodologies}}` | `^skills_(.+)$` :218 + `skcat:` tag :171-174 | 1 line | 10 blocks | OK — joined with ", " |
| `{{skills_technical}}` | idem | 1 line | 11 blocks | OK |
| `{{skills_academic}}` | idem | 1 line | 5 blocks | OK |
| `{{skills_emerging}}` | idem | 1 line | 4 blocks | OK |
| `{{DLAB1R1..5}}` | `^(.+)R(\d+)$` + roleCodes :220-224 | 5 | **exactly 5 blocks** | ⚠ zero headroom: the selector must pick ALL 5 or trailing slots render as blank bullet lines |
| `{{BNS2R1..3}}` | idem | 3 | 4 blocks | OK (1 spare) |
| `{{BNS1R1..5}}` | idem | 5 | 12 blocks | OK |
| `{{UPS1R1..5}}` | idem | 5 | 9 blocks | OK |
| `{{BAC1R1..3}}` | idem | 3 | 6 blocks | OK |
| *(none for projects)* | — | 0 | 8 project blocks | projects are selected (agents.ts:90, maxItems 2) and stored in `cvs.blocks_used` but **never rendered** — no template tokens and `buildSlotMap` only routes `selection.experience` (:197-202) |

Skcat category names in the seeds exactly match the four template suffixes — no mismatch.
Total experience slots = 21 ≤ selector `maxItems: 24` (agents.ts:89) ✓, but nothing enforces a
per-role minimum: if the model picks 3 DLAB1 bullets, `{{DLAB1R4..5}}` become `''` — the template's
bullet glyphs remain as empty list items and nobody is told (finding M4).

---

## 3. Findings, ranked

### Critical

- **C1 — The bank is 100% draft: every REAL CV build fails at the catalog gate.**
  `cv_factory.ts:85` (`('approved')` in real mode) + local D1: 0 approved of 86. Until the owner
  approves (per-block `/blocks/approve` app.tsx:1037-1043, or one-click `/blocks/approve-all`
  app.tsx:1052-1057, which also flips `es_status` to approved wherever `text_es` exists — all 86),
  a notified Apply job would fail its build every run with `gdocs_fail` events. This is the single
  biggest owner action between today and a real CV. (Fails BEFORE Gemini — no quota burn in this state.)

- **C2 — Template sharing (historic Drive 404) is unverified, and its failure mode burns Gemini quota
  on an infinite 30-minute retry.** `copyTemplate` gdocs.ts:74-83; Gemini calls precede it
  (cv_factory.ts:107, 117 vs 124-127); retry with no backoff/max pipeline.ts:38-57;
  `cv_pending_max` config dead (migrations/0003:67, never read). If the bank is approved while
  sharing is still broken: ~96–384 wasted Gemini calls/day and a wedged CV queue. **Order the go-live
  checklist so sharing is proven by a SAMPLE before approving the bank.**

### Major

- **M1 — There is no path to a real CV other than an organic Apply verdict, and Apply has never fired.**
  `cv_pending=1` only at notification time for `verdict==='Apply'` (pipeline.ts:299); apply threshold 75
  (config `scoring`); local D1: 0 Apply ever, all 31 survivors are Stretch-worth-it. Jobs notified before
  step 6 deployed never get `cv_pending` retroactively. Unless calibration produces Apply verdicts, the
  "first real CV" never happens without a code change (e.g. a console "generate real CV" action) or a
  manual D1 UPDATE. Needs an owner decision (CLAUDE.md §1) — flagged, not fixed.

- **M2 — Whitespace-padded tokens leak raw `{{ ... }}` into the CV, contradicting the stated invariant.**
  `readPlaceholders` trims names (gdocs.ts:131 `\{\{\s*([^{}]+?)\s*\}\}`), `buildSlotMap` rebuilds the
  key as exact `{{name}}` (cv_factory.ts:214), and `replaceAllText` matches the literal text
  (gdocs.ts:94-95, `matchCase:true`). A template token typed `{{ phone }}` is detected, "filled" in the
  map, but never replaced in the Doc — the raw token ships in the Doc AND the archived PDF. The comment
  at cv_factory.ts:184-185 ("a raw {{...}} never leaks") is false for this case. Tests
  (test/cv_factory.test.ts) cover `buildSlotMap` only, not this read/replace asymmetry. Since the owner
  just (re)typed all tokens into the template by hand, this is a live risk for the first sample.

- **M3 — SAMPLE generation silently cancels a queued REAL CV and stamps sample artifacts on the job.**
  cv_factory.ts:161-162 runs `UPDATE jobs SET cv_doc_url=?, cv_pdf_key=?, cv_pending=0` unconditionally
  — no `sample` guard. Generating a sample for a job that had `cv_pending=1` erases the pending real
  build with no trace, and the job row's `cv_doc_url` points at a SAMPLE doc. (Today `cv_doc_url` is not
  displayed anywhere — grep confirms cv_factory.ts:161 is its only writer — so the damage is the
  cancelled build + future confusion.)

- **M4 — No unfilled-token report: blank slots and typo'd tokens vanish silently.**
  Every unmatched or unrecognized token maps to `''` (cv_factory.ts:225, :217-223 when the Nth selection
  is missing). `FactoryResult` (cv_factory.ts:52-60) carries no filled/blank/unrecognized counts; the
  /cvs flash only says "sample generated: review it in Drive" (app.tsx:1209). Concrete risks: DLAB1's
  exact 5/5 supply (any under-selection = empty bullet lines whose list glyphs remain in the template);
  an owner typo like `{{sum1}}` is silently blanked instead of flagged. The owner's only detection tool
  is eyeballing the Doc.

### Minor

- **m1 — Missing `CV_TEMPLATE_DOC_ID`/`DRIVE_FOLDER_ID` produce a confusing 404 instead of a clear error.**
  gdocs.ts:78-79 interpolates `undefined` into the URL/body; only `GOOGLE_SA_KEY` has explicit guards
  (gdocs.ts:32, pipeline.ts:38).
- **m2 — `contact_missing` is computed but ignored by both callers** (cv_factory.ts:135/164 vs
  app.tsx:1209, pipeline.ts:53-55). Mitigated by the static banner on /cvs (app.tsx:1154-1161).
- **m3 — `cvVerifier` errors are swallowed** (cv_factory.ts:119 → `tweaks=[]`, no event, no flash note).
  Acceptable by design, but the owner can't distinguish "no tweaks" from "verifier failed".
- **m4 — Dead config:** `observability.cv_pending_max` and the whole `quota_limits` object
  (`gemini_rpd:1000`, etc.) are never read in src — quota discipline is counting-only
  (`runs.gemini_calls`, `runs.subrequests`, warn event at >40 subrequests pipeline.ts:96-98).
- **m5 — Empty-section catalog degrades the ID enum:** with 0 usable blocks in a section,
  `enumOrNull` (agents.ts:69) emits a plain STRING schema — the model may invent IDs. `text()` fails
  safe to `''` (cv_factory.ts:194), so nothing hallucinated ever renders, but the section goes blank
  silently. Only reachable with partial approval; the `usable.length < 8` gate is global, not per-section.
- **m6 — Job with NULL `description_text` generates against an empty description** (app.tsx:1205,
  pipeline.ts:48 coerce to `''`) — poor selection, no warning. The 3 current candidates all have text.
- **m7 — No real-ES path** (pipeline hardcodes `'en'`, pipeline.ts:51) and real ES would need per-block
  `es_status='approved'` (cv_factory.ts:95). Fine for now (EN market first) but undocumented.

---

## 4. THE ordered checklist to the first REAL CV

Order matters: prove Google plumbing with a SAMPLE **before** approving the bank (avoids C2's quota burn).

1. **[owner]** Confirm the three Worker secrets exist on the deployed worker: `GOOGLE_SA_KEY`,
   `CV_TEMPLATE_DOC_ID`, `DRIVE_FOLDER_ID` (`wrangler secret list`; they are not in wrangler.jsonc).
2. **[owner]** In Drive (data account): share the CV template Doc AND the Drive folder with the service
   account as **editor** — this is the historic 404. Verify the `archive/` subfolder is creatable (the
   worker will create it on first PDF, gdocs.ts:173-188).
3. **[owner]** Generate a **SAMPLE EN CV** from `/cvs` (drafts allowed — designed as the light review,
   app.tsx:998). If the flash says `FAILED: google api …/files/… HTTP 404` → sharing still broken (step 2).
   If `FAILED: insufficient bank…` → bank/language mismatch. Success = Google plumbing proven end-to-end.
4. **[owner]** Open the generated Doc and the archived PDF and inspect **manually** (the code will not
   warn you — M4/M2): (a) zero raw `{{` anywhere — if any remain, the template token has inner spaces
   or a typo: fix the token text in the template (exact `{{name}}`, no padding); (b) all 7 summary
   bullets filled; (c) 4 skills lines non-empty; (d) each role's bullets — especially all 5 DLAB1 slots
   (exact supply); (e) phone/location correct for the job's track; (f) appendix present in the Doc but
   absent from the PDF.
5. **[owner]** Optionally repeat with an **ES sample** (same flow, `lang=es`).
6. **[owner]** Fix bank text via `/blocks/edit` where the sample misrepresents you; regenerate the sample
   until it "represents you".
7. **[owner]** Approve the bank: one click `/blocks/approve-all` (sets `status='approved'` and
   `es_status='approved'` for all 86 — every block has ES text), or per-block for finer control.
   From this moment the real-mode catalog gate (C1) passes.
8. **[owner, decision]** The real-CV trigger: today only an organically notified **Apply**-verdict job
   (score ≥ 75) sets `cv_pending=1` — and none has ever occurred (M1). Either (a) wait/calibrate: use
   /calibration + Replay to check whether any realistic job reaches 75, adjust the draft thresholds and
   promote; or (b) approve a small code change adding a console "generate REAL CV for this job" action
   (CLAUDE.md §1: propose → OK → implement). Without one of these, step 9 may never fire.
9. **[auto]** When an Apply job is notified, the NEXT run (≤30 min) builds the real EN CV at run start
   (pipeline.ts:38-57, one per run). Do NOT generate a sample for that job in the meantime (M3 would
   cancel the pending build).
10. **[owner]** Watch `/health`: `gdocs_fail` events (build failures — remember they repeat every run
    until fixed, C2), `gemini_fail`/`gemini_fallback`, run `errors`, and quotas: peak subrequests /50
    (a CV build adds ~9-17 outbound calls on top of the 25-company poll; warn event fires >40),
    Gemini RPD (free tier ~1000/day; NOT enforced by code), D1 writes (100k/day), Workers CPU
    (RS256 signing + PDF bytes on the free tier — 1102 risk already seen during seeding).
11. **[owner]** Confirm the result: `/cvs` row typed **real** (not SAMPLE), Doc link opens, PDF in
    `archive/`, `jobs.cv_pending=0`. That is the first real tailored CV.

## Code-side gaps summary (for a future proposal — nothing edited in this audit)

1. Surface a fill report (`filled/blank/unrecognized` token lists) in `FactoryResult` and the /cvs flash + a `cv_slots_blank` warn event (fixes M4).
2. Normalize whitespace on the replace side (or replace using the ORIGINAL token text as read) so padded tokens can't leak (fixes M2). Add a test for the read/replace asymmetry.
3. Guard `cv_pending`/`cv_doc_url` updates with `if (!sample)` (fixes M3).
4. Retry budget for pipeline CV builds (use the already-seeded `cv_pending_max`) + skip-ahead so one broken job doesn't wedge the queue (fixes C2's burn).
5. Explicit guards for `CV_TEMPLATE_DOC_ID`/`DRIVE_FOLDER_ID` (m1); surface `contact_missing` (m2).
6. Decide the projects story: template tokens + routing `selection.projects`, or stop selecting projects (dead weight today).
7. Optional: console action to queue a REAL CV for a chosen job (unblocks M1 without waiting for calibration).

# Audit — Intelligence page & the real AI (IA) pipeline

Date: 2026-07-20 · Agent C · Scope: code AS-IS only (no fix proposed).
Goal: give the facts needed to re-split the current `/intelligence` page into
"ML (future card)" + "IA (real pipeline)".

Files audited: `src/console/app.tsx` (Intelligence section),
`src/console/layout.tsx` (nav), `src/ia/agents.ts`, `src/ia/gemini.ts`,
`src/ia/cv_factory.ts`, `src/ia/knowledge.ts`, `src/kit/kit.ts`, `src/pipeline.ts`,
`src/scoring.ts`, and migrations `0012_role_analysis.sql`,
`0013_jobs_enriched_by.sql`, `0013_answer_suggestions.sql`.

---

## 1. Current Intelligence page — everything it renders today

**Route:** single `GET /intelligence` (`src/console/app.tsx:1913`). **No POST
routes** back this page — it is read-only. Reached from nav group **"System"**
alongside Health (`src/console/layout.tsx:308`):
`['System', [['/intelligence', 'Intelligence'], ['/health', 'Health']]]`.

Section header comment (`app.tsx:1912`):
`// ---------- Intelligence (enrichment pipeline visibility + ML tooling over stored data) ----------`

Data loaded before render:
- `enabled = !!c.env.GEMINI_API_KEY` (`app.tsx:1914`)
- Gemini calls in 7d: `SELECT COALESCE(SUM(gemini_calls),0) n FROM runs WHERE started_at >= datetime('now','-7 days')` (`app.tsx:1915-1917`)
- Provenance: `SELECT COALESCE(enriched_by,'(legacy)') src, COUNT(*) n FROM jobs GROUP BY COALESCE(enriched_by,'(legacy)') ORDER BY n DESC` (`app.tsx:1918-1922`)
- AI events: `SELECT ts, type, severity, url_hash, detail FROM events WHERE type IN ('gemini_fail','gemini_fallback') ORDER BY id DESC LIMIT 20` (`app.tsx:1923-1927`)
- Scan of last 400 jobs for the aggregation cards: `SELECT j.url_hash, j.title, j.verdict, j.score, j.score_breakdown, c.name company FROM jobs j JOIN companies c ON c.id = j.company_id ORDER BY j.first_seen DESC LIMIT 400` (`app.tsx:1930-1936`). Comment on `app.tsx:1929`: `// ML tooling over the last 400 stored breakdowns (bounded CPU).`

Rendered top-to-bottom — **four `<div class="card">` blocks** (`app.tsx:1960-2009`):

1. **"Enrichment pipeline"** (`app.tsx:1962-1971`)
   - Enricher status: `enabled` (green) or `disabled (no GEMINI_API_KEY)` (warn) — `app.tsx:1965`.
   - `Gemini calls (7d):` value — `app.tsx:1966`.
   - Provenance chips: one `<span class="chip">{src}: {n}</span>` per `enriched_by` bucket — `app.tsx:1969`.
   - Static note: "The enricher only improves survivor wording — it never changes verdicts or gates." — `app.tsx:1970`.

2. **"Recent AI events"** (`app.tsx:1972-1987`)
   - Empty state "no Gemini failures or fallbacks recorded" or a table (columns: when / type / job / detail) of the ≤20 `gemini_fail`/`gemini_fallback` events; `warn` severity colored — `app.tsx:1974-1985`. Job link → `/jobs/{url_hash}`.

3. **"Keyword impact (last {rows.length} jobs)"** (`app.tsx:1988-1997`) — this is the "ML tooling".
   - Description: "How often each favor-keyword matches, and in how many survivors — the signal behind the scores. Tune these in Calibration." — `app.tsx:1990` (links to `/calibration`).
   - Table columns: keyword / category / matches / in survivors — `app.tsx:1991-1996`.
   - Computation (`app.tsx:1937-1956`): for each of the ≤400 jobs, `JSON.parse(score_breakdown)` as `ScoreResult`; `surv = r.verdict !== 'Skip'`; for every `breakdown[cat].matches` entry with `m.weight > 0`, increment `hits` and (if survivor) `surv` in a `Map<term, {hits, surv, cat}>`. `topImpact` = top 20 by `hits` (`app.tsx:1956`).

4. **"Near-miss mining ({topNear.length})"** (`app.tsx:1998-2007`)
   - Description: "Skipped jobs closest to the threshold — candidates for a calibration tweak." — `app.tsx:2000`.
   - Empty state or bullets: `{title}` (link `/jobs/{hash}`) `@ {company} · {score}` + `{reason}` — `app.tsx:2001-2006`.
   - Computation (`app.tsx:1952-1958`): from the same 400-job scan, jobs with `verdict === 'Skip'` **and** `b.near_miss_reason` present are collected, sorted by `score` desc, sliced to top 15.

**What "ML tooling" concretely is:** cards 3 and 4 only. Both are **deterministic
SQL + in-memory counting/filtering over the stored `score_breakdown` JSON** — no
learned model, no training, no inference. `near_miss_reason` and the
`breakdown[cat].matches[]` come from the rule-based scorer
(`src/scoring.ts:58-98`, `ScoreResult` / `CategoryBreakdown` / `KeywordMatch`),
not from any statistical model.

---

## 2. The real AI (IA) pipeline — every agent in code

Declarative-agent framework in `src/ia/agents.ts`:
- `Agent<S>` interface (`agents.ts:17-25`): `{ name, models: string[], temperature, instruction(), buildPrompt(state), schema(state) }`.
- `runAgent<T,S>` (`agents.ts:28-38`): calls `callGemini` with the agent's `models`, `temperature`, `instruction`, `buildPrompt(state)` as input, and `schema(state)` as `responseSchema`. **Every agent therefore uses forced JSON** (`responseSchema` set on every call).
- There is **NO monolithic runner** — agents fire at different lifecycle points (comment `agents.ts:1-8`).
- Domain knowledge injected via `src/ia/knowledge.ts`: `profile()`, `tracks()`, `domainVocab()`, `governance()` — positioning strings only, **no PII** (`knowledge.ts:4-5`).
- Every job description is wrapped by `wrapUntrusted()` (`gemini.ts:31-39`) — anti prompt-injection frame (domain rule §5).

**Five agents exist** (candidates `cv_selector`/`cv_verifier`/`answer_polisher`/`enricher`/`job_analyst` all present; there is no separately-named "role_analyst" — the role analysis is produced by `job_analyst`):

| Agent | Def (agents.ts) | Model chain (primary → fallback) | Temp | Output / purpose | responseSchema | Invoked at | Pipeline order |
|---|---|---|---|---|---|---|---|
| **job_analyst** | L57-86 (`models` L59) | `gemini-3.5-flash` → `gemini-3.1-flash-lite` | 0.2 | `RoleAnalysis` {must_haves, nice_to_haves, seniority, domain_signals, positioning_angle, screening_topics} (L44-51). Structured analysis of ONE role, produced once at notify, reused downstream. | Yes (L68-79) | `pipeline.ts:325` (at notify, `alive===true`) | **1st** (notify) |
| **enricher** | L112-140 (`models` L114) | `gemini-3.1-flash-lite` → `gemini-2.5-flash-lite` | 0.4 | `EnrichedTexts` {why_it_fits, gap_to_address, positioning_lead}. Improves wording of the 3 rule-based survivor texts; never touches verdict/gates. | Yes (L125-133) | `pipeline.ts:330` (at notify, right after job_analyst) | **2nd** (notify) |
| **cv_selector** | L196-244 (`models` L198) | `gemini-3.5-flash` → `gemini-3.1-flash-lite` | 0.3 | `Selection` {summary[], skills[], experience[], projects[], rationale}. Selects **IDs of approved blocks only** — schema `enum` restricts each ID to the catalog (L218-236); "hallucination impossible by construction" (L195). | Yes (L218-236, enum of block IDs) | `cv_factory.ts:153` (`generateCv`) | CV build (Prepare) |
| **cv_verifier** | L258-281 (`models` L260) | `gemini-3.5-flash` → `gemini-2.5-flash` | 0 | `VerifierNotes` {tweaks: string[]}. 0-5 short improvement suggestions; NEVER edits the CV. | Yes (L270-274) | `cv_factory.ts:160` (after selector) | CV build (Prepare) |
| **answer_polisher** | L300-337 (`models` L302) | `gemini-3.5-flash` → `gemini-3.1-flash-lite` | 0.3 | `PolishResult` {suggestions: [{question, suggestion}]}. Tailors already-approved Q&A answers to one job; suggestions only, never auto-submitted, EEOC never touched. | Yes (L315-329) | `kit/kit.ts:115` (`polishAnswers`), backed by `POST /jobs/:hash/polish` (`app.tsx:1874-1882`) | On-demand, after kit built |

**Gemini wrapper — retry / backoff / fallback** (`src/ia/gemini.ts:41-102`,
`callGemini`):
- No key → `{ ok:false, error:'GEMINI_API_KEY not configured', calls:0 }` (L46).
- Outer loop over `call.models ?? DEFAULT_MODELS` (L50); `DEFAULT_MODELS = ['gemini-3.1-flash-lite','gemini-2.5-flash-lite']` (L8) — but all 5 agents pass their own `models`, so DEFAULT is unused in practice.
- Inner loop `attempt = 1..2` per model (L51).
- HTTP 429 or ≥500 → set `lastError`, backoff `setTimeout(3000 * attempt)`, retry same model (L68-71).
- Other `!res.ok` → `break` to next fallback model (L73-76).
- `promptFeedback.blockReason` → break (L81-84); no candidates → break (L86); `finishReason === 'MAX_TOKENS'` (truncation) → break (L87).
- `JSON.parse` failure → retry same model (`continue`, L91-93).
- Network throw → backoff then retry (L95-98).
- Returns `{ ok, data, modelUsed, error, calls }` (`GeminiResult<T>`, L22-28); `calls` counts every HTTP attempt (drives `gemini_calls` instrumentation).
- Request config: `systemInstruction` + `contents` user part; `generationConfig` = `temperature ?? 0.3`, `responseMimeType:'application/json'`, `responseSchema`, `maxOutputTokens: 2048` (L57-65).

---

## 3. Provenance & events available to display in an "IA" section

**Columns (exact):**
- `jobs.enriched_by` — TEXT (migration `0013_jobs_enriched_by.sql:5`). Values seen in code (`pipeline.ts`):
  - `'rule'` — default (`pipeline.ts:297`); deterministic rule-based texts (no GEMINI key, or enricher failed → stays `'rule'`).
  - the Gemini **model name** that enriched, e.g. `'gemini-3.1-flash-lite'` / `'gemini-2.5-flash-lite'` (`enrichedBy = enriched.modelUsed ?? 'gemini'`, `pipeline.ts:339`).
  - `'gemini'` — literal fallback if `modelUsed` is absent (same line).
  - NULL for rows before the migration → rendered as `'(legacy)'` via `COALESCE` (`app.tsx:1920`; migration comment `0013_jobs_enriched_by.sql:1-4`).
- `jobs.role_analysis` — TEXT (migration `0012_role_analysis.sql:11`). JSON of `RoleAnalysis` (must_haves, nice_to_haves, seniority, domain_signals, positioning_angle, screening_topics). Written `pipeline.ts:327`; reused by CV factory (`cv_factory.ts:146-149`) and answer_polisher (`kit.ts:105-109`). **Not displayed anywhere in the console today** (only `enriched_by` is surfaced).
- `application_kits.answer_suggestions` — TEXT (migration `0013_answer_suggestions.sql:9`). JSON `[{question, suggestion}]` from answer_polisher (`kit.ts:118`).

**AI-related `events` types stored (exact strings):**
- `'gemini_fail'` severity `'warn'` — job_analyst failure (`pipeline.ts:328`, detail ``job_analyst: ${an.error}``) and enricher failure (`pipeline.ts:344`, detail `enriched.error`).
- `'gemini_fallback'` severity `'info'` — emitted by the **enricher only**, and only when `enriched.modelUsed !== 'gemini-3.1-flash-lite'` (its primary) (`pipeline.ts:340-341`); detail = `enriched.modelUsed`.
- `'gdocs_fail'` severity `'warn'` — CV factory build failed (`pipeline.ts:61`); also **counted** for the retry cap `cv_pending_max` (`pipeline.ts:39`).

**Gaps to note for a display:**
- The Intelligence "Recent AI events" card queries **only** `gemini_fail` and `gemini_fallback` (`app.tsx:1925`) — it does **not** show `gdocs_fail`.
- `cv_selector`, `cv_verifier`, and `answer_polisher` do **not** emit their own event types on failure. Their errors are returned to the caller as strings (`cv_factory.ts:155`; `kit.ts:116`); a failed overall CV build surfaces only as one `gdocs_fail` (`pipeline.ts:61`), and a failed polish surfaces only in the redirect message (`app.tsx:1880`). So per-agent AI failures during CV/kit build are largely **not** recorded as events.
- (Non-AI events, for contrast, not for an IA card: `fetch_fail`, `verify_fail`, `verify_dead`, `maintenance_alert`, `quota_warn`, `prune`, `digest_sent`, `run_crash`, `telegram_fail`.)

---

## 4. ML reality check

Grep across `src/` for `ML`, `machine learning`, `logistic`, `regression`,
`classifier`, `sklearn`, `tensorflow`, `onnx`, `training`, `neural`,
`model.predict`, `statistical model` (case-insensitive) returned **only**:
- `app.tsx:1912` — comment "…+ ML tooling over stored data".
- `app.tsx:1929` — comment "ML tooling over the last 400 stored breakdowns…".
- `tg.ts:143` — the word "regression" meaning a **code regression** (unrelated to statistics).

**Conclusion: NO statistical/ML model exists in code today.** There is no
training pipeline, no learned weights, no model artifact, no inference of any
learned model. What the page labels "ML tooling" is deterministic aggregation:
counting keyword-match frequencies (hits vs survivors) and filtering
near-threshold skipped jobs, both read out of the rule-based scorer's stored
`score_breakdown` JSON. Job scoring itself is 100% hand-tuned keyword weights +
gates from config (`src/scoring.ts`), tuned manually by the owner in
`/calibration` — nothing "learns" them. An "ML = roadmap / future" card is
therefore honest.

---

## 5. REAL and running (IA) vs NOT built (ML)

**REAL and running today (IA — Gemini generative agents):**
- `job_analyst` at notify → `jobs.role_analysis` (`pipeline.ts:325-327`).
- `enricher` at notify → survivor texts (why_it_fits / gap_to_address / positioning_lead) + `jobs.enriched_by` (`pipeline.ts:330-345`).
- `cv_selector` at CV build → approved-block-ID selection, enum-forced (`cv_factory.ts:153`).
- `cv_verifier` at CV build → tweak suggestions (`cv_factory.ts:160`).
- `answer_polisher` on-demand → tailored Q&A suggestions stored in `application_kits.answer_suggestions` (`kit.ts:115-119`, `POST /jobs/:hash/polish`).
- Gemini wrapper with retry + backoff + model fallback + forced JSON (`gemini.ts:41-102`).
- Provenance/events already stored and displayable: `enriched_by`, `role_analysis` (not yet shown), `answer_suggestions`; events `gemini_fail`, `gemini_fallback`, `gdocs_fail`; per-run `gemini_calls` counter.
- The two aggregation cards currently mislabeled "ML tooling" (Keyword impact, Near-miss mining) — real and working, but they are SQL/JS descriptive aggregation, **not** ML.

**NOT built (ML — pure roadmap / aspirational):**
- No learned/statistical model of any kind (no classifier, regression, embeddings-model, ranker).
- No training pipeline, no model artifacts, no learned-weight scoring.
- Nothing auto-adjusts scoring from data: "Keyword impact" is descriptive stats to inform **manual** calibration; it feeds a human, not a model.
- No feedback loop that learns from survivor/skip/applied outcomes.

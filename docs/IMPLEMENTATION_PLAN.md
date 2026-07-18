# Implementation Plan — Seekerware

Step-by-step execution plan, with acceptance criteria and required inputs. Live
status in `CLAUDE.md` §9 (and ultimately in the code — which is the source of
truth). Extended console/observability/kit design in
`docs/audits/2026-07-17-*.md`.

---

## 1. Phases and dependencies

```
0 docs ──> 1 scaffold+Greenhouse ──> 2 scoring+deltas ──> 3 pipeline+cron+instrumentation ──> 4 console v1 ──> 5 Lever+Ashby ──> 6 CV factory+PDF+R2 ──> 7 console v2 ──> 8 kit+two-way bot
                                        ^                                                                                            ^
                                        requires profile (received 2026-07-09)                                                       requires approved bank + service account (ready)
```

Steps 4 and 5 can be swapped; 6 requires 3; 7 requires 4 (and /blocks, /cvs of
7 require 6); 8 requires 6 and 7 partially. Until step 4, `companies` and
`config` are edited via seeds/`wrangler d1 execute`.

## 2. Step 0 — Documentation · DONE 2026-07-07 · rewritten 2026-07-09 · enriched 2026-07-17

## 3. Step 1 — Scaffold + Greenhouse + dry-run + CI · DONE 2026-07-17

Live worker (workers.dev), migrated D1 (0001), Greenhouse connector with the
canonical URL fixed (identity params), Bearer auth, CI deploy. Real bug found
and fixed: url_hash collapse on boards with their own page.

## 4. Step 2 — Scoring + urgent schema deltas

- **Goal**: reliable score and verdict over real jobs, with fully persistable
  transparency.
- **Deliverables**: migration `0002` (`jobs.description_text`,
  `jobs.score_breakdown`, `jobs.title_norm` — IMPOSSIBLE to reconstruct later;
  they must be born before data accumulates); `src/scoring.ts` (pure function,
  full `ScoreResult` with matches per category, gates per track, near-miss);
  `src/config-store.ts`; dry-run extended with scoring; LOCAL seeds
  (gitignored) of `config` and the ★ companies applied to local and remote D1;
  engine tests.
- **Acceptance**: over batches of real jobs from the ★, the verdicts match the
  owner's review (iterative calibration session by chat: he reacts to results,
  not to configs); the per-category breakdown is explainable in each case.
- **Inputs**: nothing new (profile received 2026-07-09; ★ verified).
- **Risks**: initial over/under-filtering -> replay (step 7) will make it
  systematic; in the meantime, short seed iterations.

## 5. Step 3 — Pipeline + cron + Telegram + instrumentation

- **Deliverables**: `src/pipeline.ts`, `src/freshness.ts`, `src/notify.ts`,
  writes in `src/store.ts`; `scheduled()` handler + a 30-min Cron Trigger with
  round-robin (~25 companies/run); migration `0003` (runs, events,
  notifications, ALTERs of companies); RunStats/trackedFetch instrumentation
  (TRD §7); MAINTENANCE alerts with anti-spam guards.
- **Acceptance**: the 5 original guarantees (seed without notifying, dedup,
  notify a new+fresh+live job, auto-expire, per-company isolation) + each run
  leaves its row in `runs` with the exact funnel and quotas + a crashed run is
  stamped by the next one.
- **Inputs**: none (Telegram configured 2026-07-17).

## 6. Step 4 — Console v1 (daily operation)

- **Deliverables**: Hono/jsx+htmx stack (TRD §8); signed-cookie login (secrets
  `LOGIN_PASSWORD_HASH`, `SESSION_SECRET`); migration `0004` (applications,
  job_events, config_history); pages: Today (status strip + triage with 5
  actions), /jobs (table+filters+saved views+why-NOT chip; detail with
  breakdown and gates), /companies (CRUD+health+ROI+test token), /config
  (structured editors, no replay), /health (runs); omnipresent footer.
- **Acceptance**: add a company, tune a threshold, triage a survivor through to
  "applied", and see the health of the last run — all from the browser, no SQL;
  no route without authentication (assets included).
- **Inputs**: the owner defines their login password (hash via guided command).
- **Risks**: visual scope creep — polish belongs to step 7.

## 7. Step 5 — Lever + Ashby connectors

- **Acceptance**: the same guarantees as step 3 with real companies of each
  ATS; ATS-specific verify-on-notify (Ashby: NEVER against HTML); own identity
  params in the canonical URL where they apply.

## 8. Step 6 — Bank integration + CV factory + PDF + R2

Bank content: built since 2026-07-09 (private master doc); review Phase C
parked by the owner's decision — on reaching here it resumes with a lightweight
mechanism (approve rendered sample CVs or bulk-approve from /blocks, not
row-by-row review).

- **Deliverables**: seed the approved bank into `anchors`+`blocks`;
  `src/ia/gemini.ts` + `src/ia/agents.ts` + `src/ia/cv_factory.ts` +
  `src/gdocs.ts`; PDF export (clean copy without the appendix); PDF archive in
  the Drive `archive/` subfolder (R2 dropped 2026-07-17: requires a card) +
  generated/submitted snapshots; migration `0005` (cvs table,
  jobs.cv_pdf_key).
- **Render model (revised 2026-07-18)**: fill-in-place, not append. The owner's
  template is the fixed skeleton; the factory reads its `{{...}}` tokens
  (`readPlaceholders`) and fills each with EXACT block text via `buildSlotMap`
  (`{{sum_N}}`, `{{skills_<cat>}}`, `{{<CODE>R<N>}}`, contact). Projects,
  education and Languages are static in the template (v1). See TRD §6.
- **Acceptance**: an Apply generates a Doc whose filled slots contain ONLY text
  from approved blocks (verifiable diff), no raw `{{...}}` leaks, a clean PDF
  archived in Drive `archive/`, verifier notes persisted in `cvs`; ES render
  blocked without approved parity.
- **Inputs**: owner builds the placeholder template + shares it with the SA;
  skills re-authored as individual `skcat:`-tagged items (owner-approved);
  lightweight bank review.

## 9. Step 7 — Console v2 (the complete instrument)

- **Deliverables**: kanban Tracker + follow-ups; full job detail (history, CV
  panel, similar jobs, rule-based interview prep); **Replay** in batches of 50
  + config_history with revert; complete /blocks (suggested queue, coverage,
  parity); /cvs; /week + Monday digest + momentum (`weekly_goal` initially 5);
  similar-jobs radar; global search; polish (theme, empty states, full
  keyboard).
- **Acceptance**: the full weekly operation (calibrate with replay, review the
  funnel, govern the bank) is comfortable from the console; the owner validates
  it in real use.

## 10. Step 8 — Application kit + two-way bot

- **Deliverables**: migration `0006` (answers table + kit); Telegram webhook
  (`TELEGRAM_WEBHOOK_TOKEN`) with buttons (View kit / Mark applied) and a
  conversational question flow (owner's replies -> kit -> optionally save to
  the `answers` bank); question detection (Greenhouse `?questions=true`; Lever
  public HTML — approved exception); /applications; weekly question census;
  the owner's contact details as a private `config` key.
- **Acceptance**: from the go-ahead in Telegram to the ready-to-submit form in
  < 5 minutes, with every answer coming from the approved bank or the owner's
  chat; ZERO submissions by the system (auditable).

## 11. Backlog (post step 8, with a data gate)

- **L2c userscript companion**: form auto-fill in the owner's browser (Simplify
  pattern; the click stays human). Gate: time-to-apply telemetry + question
  census after 2-3 months of operation.
- **Capture inbox**: a dedicated job-alert Gmail read via the official API as
  an additional connector (college co-op digest, newsletters).
- Bot: `/pending`, `/cv <id>`; materialized re-score.

## 12. Consolidated pending inputs

| Input | Blocks | Status |
|-------|--------|--------|
| Cloudflare + API token + Actions secrets | Step 1 | ✓ 2026-07-17 |
| Telegram bot + chat_id | Step 3 | ✓ 2026-07-17 |
| GEMINI_API_KEY, GOOGLE_SA_KEY, DRIVE_FOLDER_ID, CV_TEMPLATE_DOC_ID | Step 6 | ✓ 2026-07-17 |
| Login password (hash) | Step 4 | pending (guided command) |
| R2 bucket `CV_ARCHIVE` | Step 6 | dropped 2026-07-17 (needs a card) → Drive `archive/` |
| Lightweight blocks-bank review | Step 6 | parked by decision |
| Fill-in-place template + share with SA | Step 6 | pending (owner builds it with the named `{{...}}` placeholders and shares the Doc with the service account) |
| Skills re-authored as `skcat:`-tagged items | Step 6 | pending (owner approves the drafts) |

## 13. Decision log

- **2026-07-07** — All-GAS platform. **Reverted 2026-07-09.**
- **2026-07-07** — Two Google accounts: data vs execution. **Obsolete
  2026-07-09** (CLAUDE.md §6).
- **2026-07-07** — Select-only blocks bank; deterministic render +
  cv_verifier temp 0. **In force.**
- **2026-07-07** — Gemini free tier with fallback; responseSchema. **In force.**
- **2026-07-07** — GitHub via scoped MCP; git pinned per-repo. **In force.**
- **2026-07-09** — Reframe: Cloudflare Worker + D1 + console; strict free
  tiers; first-class dashboard; Gemini and Google Docs kept.
- **2026-07-09** — Blocks bank as a core subsystem (schema v2).
- **2026-07-17** — Dedup: the canonical URL preserves the ATS identity params
  (`gh_jid`); real bug found against Thinkific.
- **2026-07-17** — **10-page console** (Today/Tracker/Jobs/Companies/
  Calibration+Replay/Bank/CVs/Applications/Health/Week); Hono+jsx+htmx stack
  without a build; signed-cookie login (the owner has no domain → Access
  dropped).
- **2026-07-17** — **D1-first observability**: runs/events/notifications
  written by the pipeline itself (RunStats, one flush); Cloudflare-native only
  for debugging; retention 400/90/180; Monday digest ~06:00 Bogota;
  weekly_goal initially 5.
- **2026-07-17** — **Assisted application**: L1 kit with a go-ahead and answers
  via Telegram chat; the submit click is ALWAYS human. L2b (server-side
  submission) and L3 (unattended) REJECTED with evidence (company-key-only
  APIs; anti-bot; silent failure that burns companies; LazyApply 2.4/5;
  Greenhouse Real Talent). L2c (local userscript) parked behind a telemetry
  gate. Sources: docs/audits/2026-07-17-diseno-auto-apply.md.
- **2026-07-17** — Exception to no-scraping: public HTML of Lever's apply page,
  question detection only.
- **2026-07-17** — The owner's contact details as operational data in the
  private D1. **Revised the same day by the owner**: the contact details live
  ONLY in the Google Docs template (header); not in D1, not in the repo, not in
  the kit.
- **2026-07-17** — R2 as an immutable PDF archive (generated/submitted
  snapshots); Drive remains the editable master. **Reverted the same day**:
  enabling R2 requires registering a card (violates "strict free tiers without
  a card"); the PDF archive moves to the Drive `archive/` subfolder, immutable
  by convention (the system only creates, never edits/deletes).
- **2026-07-17** — `applications` table = the user's tracker (stages); the
  approved/submitted submission machinery is NOT built (consistent with the
  rejection of L2b/L3).
- **2026-07-18** — **Project language = English**: full retro-rewrite of docs,
  code comments, console UI, and Telegram labels; code/identifiers/SQL/enum
  values/blocks-bank EN+ES content preserved.
- **2026-07-18** — **Per-market CV contact**: ONE Docs template with
  `{{phone}}`/`{{location}}` placeholders filled per track from the private
  `config['contact_profile']` (canada_coop -> Vancouver + CA phone;
  colombia_perm & contractor_usd -> Medellín + CO phone, LATAM orientation);
  name/email/LinkedIn hardcoded in the template. Supersedes the earlier
  "contact only in the Docs template" and "contact in D1 for the kit" notes.
  Owner enters values via the console `/contact` page; address is
  application-forms-only (step 8), never in the CV.
- **2026-07-18** — **Fill-in-place CV factory**: the owner's template is the
  source of truth for structure; the factory reads its `{{...}}` tokens and
  fills each with EXACT approved-block text (contact, `{{sum_N}}`,
  `{{skills_<cat>}}`, `{{<CODE>R<N>}}`), replacing the old "append a generated
  body with its own headings" render. The AI still only SELECTS block IDs.
  **Role codes** `DLAB1/BNS2/BNS1/UPS1/BAC1` become the canonical `anchors.id`
  and `blocks.anchor_id` (one term per concept), used verbatim in the
  `{{<CODE>R<N>}}` responsibility placeholders. **Skills** re-authored as
  individual items tagged `skcat:<methodologies|technical|academic|emerging>`;
  the AI selects a job-relevant subset per category. **Languages, projects,
  education** are static in the template (Languages fixed; AI-selected projects
  are a Phase-2 fast-follow needing formatted title lines). Owner rebuilds the
  template with the named placeholders and shares it with the SA. Supersedes the
  body-append render in TRD §6.

# Conventions — Seekerware

Consistency rules between code and documentation. A complement to
[`../CLAUDE.md`](../CLAUDE.md): the code is the source of truth; these
conventions exist so that code, docs, commits and debugging speak the same
language.

## 1. Canonical terminology (glossary)

One concept = ONE term, identical in code, docs, commits and debugging
messages. The "avoid" column lists forbidden synonyms. The glossary is updated
in the same commit that introduces the new term.

| Term | Meaning | avoid |
|------|---------|-------|
| job | normalized job posting `{id, company, title, location, url, description, posted_at, ats, raw}` | posting, opening, listing, vacancy |
| connector | module that reads an ATS feed and returns normalized jobs | poller, fetcher, scraper |
| track | search path: `canada_coop`, `colombia_perm`, `contractor_usd` | variant, channel, lane |
| gate | per-track hard condition (require / reject); a fail eliminates the track — never subtracts points | hard filter, rule, restriction, penalty |
| score | 0-100 score from the rules engine | rating, points, grade |
| verdict | `Apply`, `Stretch-worth-it` or `Skip`; decided by the rules, never the AI | result, decision, classification |
| survivor | job with an Apply or Stretch-worth-it verdict that passed gates and freshness | finalist, candidate, selected |
| freshness | publication age <= `FRESHNESS_MAX_DAYS` (3 days); gates NOTIFICATION only | validity, age |
| store window | `STORE_MAX_DAYS` (45 days): a job is kept in the store while its age <= this, even past freshness; gates STORAGE, not notification | retention, catalog window |
| aged | a survivor first stored already older than `FRESHNESS_MAX_DAYS` but within `STORE_MAX_DAYS`: browsable in the console, never notified (`jobs.status = 'aged'`) | stale survivor, backlog, catalog |
| verify-on-notify | re-query of the job against the ATS API immediately before notifying | liveness check, liveness verification |
| store | the system's persistence in D1 (`jobs` table), accessed only via `src/store.ts` | database, DB, registry, history |
| block | owner-authored phrasing of a fact in the Blocks Bank (`blocks` table), anchored to an anchor, in EN+ES always; saving is the approval (2026-07-18) | phrase, snippet, bullet, sentence |
| fact | verifiable professional fact from the canonical record, with a single exact metric; blocks are its phrasings | achievement, claim, assertion, datum |
| anchor | real role or project a block is anchored to (`anchors` table); neutral — the displayed titles are per-market projections | role_anchor, position, title |
| angle | projection of a fact for a role type: `data`, `compliance`, `operations`, `leadership` | focus, variant, version |
| run | a full pipeline execution triggered by the cron | cycle, iteration, pass |
| dry-run | a run with no writes to the store and no notifications; via `GET /api/dry-run` or local `wrangler dev` | simulation, test run |
| pipeline | orchestration poll -> score -> gates -> dedup -> notify | flow, process |
| worker | the Cloudflare service that runs the pipeline (`scheduled` handler) and the dashboard (`fetch` handler) | function, lambda, script |
| dashboard | web console served by the worker (calibration, tracking, Blocks Bank), behind login | panel, admin, webapp, console |
| migration | versioned change to the D1 schema, file in `migrations/` | SQL script, schema patch |
| enricher | AI agent that improves a survivor's texts | analyst, improver |
| cv_selector | AI agent that selects block IDs per section (JSON with an enum of IDs) | phrase selector |
| cv_verifier | temperature-0 AI agent that verifies the rendered Doc and suggests tweaks | verifier, validator |
| console | the multipage webapp served by the worker (10 pages, UI.md §2) | dashboard (obsolete), panel, admin |
| triage | daily review of notified survivors until a decision (prepare/applied/dismiss/snooze) | inbox, review, tray |
| application | the application lifecycle of a job, owned by the user (`applications` table) | submission, candidacy, process |
| stage | stage of an application: `prepared\|applied\|interview\|offer\|rejected\|dismissed` | phase, state (reserved for jobs.status) |
| snooze | postpone a triage item until a date (`snoozed_until`) | reminder, defer |
| event | typed occurrence in the observability log (`events` table) | error log, occurrence, incident |
| notification | record of a push delivery attempt (`notifications` table) | alert, notice, message |
| meter | gauge of quota consumed vs the free-tier limit (derived from `runs`) | quota gauge, indicator |
| digest | weekly funnel summary (Week page + Monday Telegram message) | report, weekly summary |
| cluster | soft grouping of jobs by `title_norm` + tags (similar-jobs radar) | group, role family |
| answer | approved standard answer for application forms (`profile_answers` table, blocks-style governance); the console page is Q&A | canned answer, template |
| kit | per-job view with the CV as PDF, answers and links to apply in minutes; the human ALWAYS submits | package, bundle, auto-apply |
| matrix | the Calibration page (2026-07-18): 5 categories × in favor/against × EN/ES as collapsible rows; a projection over keywords + gates, never a softening of them; edits apply on save | word lists, chip walls |
| pair | the EN+ES twins of one calibration concept: a single `{en, es}` object (`Keyword`/`GateTerm`), both languages required; ✕ removes the concept | twins, duo, translation |
| path | the track a matrix word unlocks (require) or blocks (reject) via its gate membership; badge on the row | track tag, route, lane badge |

Shared-vocabulary rule: the Blocks Bank's `tags` and the `config` table's
keywords use the SAME canonical terms (domain / tool / signal families). A new
term is added on both sides in the same change — they are the job <-> content
matching surface.

## 2. Code (TypeScript / Cloudflare Workers)

- Strict TypeScript (`strict: true`), ES modules, explicit imports. No `any`:
  use `unknown` + narrowing and types per canonical concept (`Job`, `Company`,
  `Verdict`, `Block`).
- One module per glossary concept: `src/connectors/greenhouse.ts`,
  `src/scoring.ts`, `src/freshness.ts`, `src/store.ts`, `src/notify.ts`.
  Exported functions use the canonical term (`scoreJob()`, `isFresh()`);
  private = not exported (module scope replaces GAS's `_` prefix).
- Invocable public surface = the worker's `/api/*` routes (protected by the
  same dashboard login).
- Secrets ONLY as Worker secrets, read from the `env` binding. Never in code,
  comments, logs, commits or in `wrangler.jsonc` (only non-sensitive vars
  there).
- Outbound HTTP with `fetch` and explicit error handling: check `res.ok`, catch
  per company; an external failure never takes down the run (equivalent to
  GAS's `muteHttpExceptions`).
- D1 access ONLY from `src/store.ts`: prepared statements with bindings (never
  string interpolation in SQL); `db.batch()` for multiple writes per run.
- Tests with vitest in `test/`, with fixtures of real ATS responses
  (anonymized). Every connector and the scoring engine have tests; the pipeline
  is tested locally with `wrangler dev --test-scheduled`.

## 3. Documentation

- The .md files document intent; on any discrepancy the code wins (CLAUDE.md).
- Every design decision is dated (yyyy-mm-dd).
- No personal owner data in any repo file.
- Same glossary in docs, code, commits and debugging; if a document needs a new
  concept, the glossary row is added first.

## 4. Commits

- Messages in English, conventional, present tense ("add lever connector").
- Never secrets, tokens or private IDs (Drive folder, Doc template, Telegram
  chat, Cloudflare account id) in messages or in committed content.
- A terminology change = its own commit touching code + docs + glossary at once.

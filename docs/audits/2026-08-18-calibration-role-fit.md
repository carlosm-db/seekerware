# Calibration role-fit audit — `role_type` stopped discriminating

Audited 2026-08-18 against the LIVE config (`config['scoring']`, version 48), `src/scoring.ts`, and
the ~18.5k jobs then in prod D1. Trigger: the owner's read that results skew to tech / data-analysis
roles, against a positioning of **Business Operations × Technical Solutions | Banking Technology,
Data Engineering & AI-Powered Systems**.

Verdict: the perception is right, the presumed cause is not. The ops vocabulary is already present
(`operations analyst` +3, `business analyst` +3, `process analyst` +2, `operations supervisor` +3).
It never gets to matter, because the heaviest category is decided by generic corporate words.

## Engine shape (for reference)

| category | weight | saturation |
|---|---|---|
| role_type | 35 | 5 |
| domain | 30 | 8 |
| tool_overlap | 25 | 6 |
| level_fit | 10 | 3 |

`title_multiplier` 2 · thresholds `apply` 75 / `stretch` 60 · gates are eligibility + routing only
(Canada location; Colombia/LATAM + reject-US-only) and never shape the score.

## Finding 1 — `role_type` is a near-constant, not a discriminator

Terms that actually fired across the ~564 `Apply` verdicts in the store:

| role_type term | fired on | in title |
|---|---|---|
| business | 457 (81%) | 34 |
| support | 449 | 14 |
| gestion → matches "management" | 439 | 33 |
| process | 402 | 2 |
| data | 385 | 64 |
| technical | 314 | 12 |
| reporting / analysis | 284 / 279 | 13 / 2 |
| analytics | 197 | 34 |
| automation | 169 | 8 |
| **operations analyst** | *not in the top 18* | — |

Mechanism: each generic term is weight 2, occurrences capped at 3 → 6 raw. With saturation 5, TWO of
them (raw 12) give `1 − e^(−12/5)` = 0.91 → **32 of 35 points**. Every white-collar posting says
"business" and "management". So ranking is effectively delegated to `domain` — which IS well tuned to
the owner (operations 350, risk 317, compliance 287, banking 284, payments 103, aml 102,
reconciliation 80) — and anything banking-adjacent clears 75.

## Finding 2 — language terms are worth ~half the score

`english` is weight 3 in BOTH `role_type` and `domain` (same for `spanish`; `bilingual` +3 in
domain). Three mentions = 9 raw in each → 29.2/35 (role_type) + 20.3/30 (domain) ≈ **50 of the 100
points from the word "English" alone**, before any role or domain signal. It fired on 170 Applies.
Bilingualism is a real edge for the owner, but it is neither a role nor a domain.

## Finding 3 — negatives fire on boilerplate, costing RECALL

`recruiter` (−3) fired on 54 Apply postings and `devops` (−2) on 59 — from "our recruiter will reach
out" and "DevOps culture", not from the role. Because `raw = Math.max(0, raw)` (`src/scoring.ts:196`)
floors a category at zero, boilerplate can wipe out a legitimate ops match entirely. `Keyword` has no
`scope` field (only `Gate` does), so this cannot be fixed in config — it needs `scope?: 'title'` on
`Keyword`, honoured in `scoreCategory` (`src/scoring.ts:184-194`).

## Finding 4 — the seniority penalty is unreachable

`conditional_level_negatives` (`senior` −2) only applies if `role_type` matched one of
`["data engineer","software engineer","developer","platform engineer"]`. But `developer` and
`platform engineer` are not role_type keywords at all, and `roleMatchedTerms` keeps only matches with
`weight > 0` (`src/scoring.ts:252`) — so `software engineer` (−2) can never satisfy it either. Only
`data engineer` can. Hence *Senior* Java Developer / *Senior* Manager / *Senior* Assistant Manager
all pass ungated.

## Finding 5 — `{"en":"gestion","es":"management"}` has its languages swapped

Works by accident (accents are stripped in `normalizeText`), but it pollutes the EN/ES parity grid
fixed in `b2b44fb`.

## Consequence, measured

| title family | n | avg score | Apply |
|---|---|---|---|
| operations analyst | 60 | 76 | 14 |
| business operations | 13 | 57 | 1 |
| business analyst | 100 | 73 | 25 |
| operations (other) | 642 | 60 | 50 |
| data engineer | 161 | 64 | 20 |
| data analyst | 74 | 80 | 17 |
| process / transformation | 144 | 60 | 8 |
| program / project manager | 217 | 46 | 1 |
| **everything else** | **17,109** | **48** | **428** |

**428 of 564 Applies (76%) carry titles outside the ops/BA/data families**, and `business
operations` — the owner's literal positioning — is the worst-served family of all. Sample of alerts
actually delivered on 2026-08-07: *Senior Java Developer* (80), *AI Engineer Manager* (80), *Support
Engineer — Veterinary HealthTech* (78), *Manager, Proposal Writing* (79), *Accounting Supervisor*
(81), next to on-target hits like *Business Analyst, Data Integration* (92) and *Consultant, Business
Systems Analysis* (80).

## Gap vs the positioning

Absent from `role_type` entirely: business operations, operations manager/specialist, service
delivery, operational excellence, continuous improvement, business systems analyst, systems analyst,
solutions analyst/consultant, technical solutions, implementation, vendor management, program manager
(only `product manager` +2 exists — which is why 217 program/project-manager postings average 46).

## Constraint that shapes the fix

Replay/Preview and Re-score were removed on 2026-07-19 (`src/console/app.tsx:1300`): a calibration
edit applies to FUTURE scoring only, stored jobs keep their old verdicts, and there is no way to see
the effect before it goes live. With a ≤3-day notify window plus verify-on-notify, an over-tightened
config loses postings that cannot be recovered — and the feedback loop is 2 runs/day. Tuning ~150
terms, `saturation` and `thresholds` blind is therefore the wrong order of operations.

Interaction: the 2026-08-18 flush fix stores `description_text = NULL` for new `skipped` rows, so the
retro-scoring corpus decays as the ~10k older rows that still carry text age out of the 45-day store
window. If a preview is wanted, it should be built while that corpus exists.

## Recommendation (pending owner approval)

1. `scripts/score-preview.ts` — the `scripts/poll.ts` pattern (pure `src/` code + D1 over REST, no
   deploy, no Worker): re-score stored jobs with a candidate config, emit an old×new verdict matrix
   plus the titles that gain/lose `Apply`. `scoreJob` is pure and stored rows already carry
   title/location/description_text (same reconstruction as `src/kit/kit.ts:113`).
2. One informed config edit: demote the generic tokens, strip the language terms, add the missing
   ops/solutions vocabulary, and move `saturation`/`thresholds` in the same save.
3. Code, same deploy: `scope: 'title'` on `Keyword`; repair the dead `level_negatives_only_if_role`
   condition; fix the swapped `gestion` pair.

Target to calibrate against: from ~22 alerts/day at roughly 50% off-target, to **6-10/day with ≥70%
on-target titles**.

---

## Applied — config v49 (2026-08-18)

Owner adjudication during the session: **Apply** for AML/KYC/financial-crime, payments/settlements/
clearing, fraud/disputes/chargebacks, back-office/reconciliation/custody, risk/controls/governance;
**Stretch** for credit/collections, onboarding/client service, treasury/capital markets and Data
Engineer. Then a seniority band was stated that overrides the earlier Program/Project Manager call:
**analyst / senior analyst / specialist / lead / supervisor MAX** — manager, senior manager, director
and VP must not appear at all.

That last rule cannot be expressed with weights. A negative weight subtracts and can be outvoted:
"Manager, Operational Risk Program, Fraud Risk & Governance" collects +2 risk, +2 fraud, +2 governance
and absorbs a −3 `manager`. Measured, a weights-only variant still leaked 3 managerial titles into
Apply out of 34; the hard mechanism — a title-scoped `reject` gate — leaks 0. Gates are the engine's
only "must not appear" (domain rule 2: verdicts belong to the rules, not to arithmetic).

Measured on the same 700-job sample, base v48 → candidate v49:

| | v48 | v49 |
|---|---|---|
| Apply | 122 | **31** |
| on-target (roles + approved functions) | 26% | **81%** |
| on-target (strict role names) | 11% | **55%** |
| titles above the target band | 34 | **0** |
| mean `role_type` points | 33.4/35 | **7.0/50** |

Config v49 contents: 15 generic terms removed from `role_type` and the language terms from both
categories; 50 terms added (role grammar `analyst`/`operations`/`specialist`/`coordinator`/
`supervisor`/`lead`, the target role names, the approved banking functions, the Stretch tier at +1,
and title negatives `developer`/`architect`/`scientist`/`quantitative`); **all 81 `role_type` terms
title-scoped**; `role_type` 35→50 and `domain` 30→15 (the roster is already curated for banking, so
`domain` was itself near-constant at 22.4/30); `saturation` 5→8; thresholds 75/60 → **58/44**; and the
`reject_over_band` gate (`manager`, `director`, `vp`, `vice president`, `head of`, `chief`, `avp`,
`svp`, `principal`) on both tracks. `staff` was deliberately left out — in US grading "Staff
Accountant" is a junior role. Every weight stays within ±3 so each row remains editable from the
console. The patch is kept OUT of the repo at `seeds/calibration_2026-08-18_role-fit.patch.json` —
`seeds/` is gitignored and nothing in it is tracked, which matches TRD §3 ("the knowledge lives in the
`config` table, zero keywords in code"); this document is the versioned record of what changed. The
pre-change v48 JSON was exported for rollback (a single `config` row, no deploy needed to revert).

### Known residue

- **Co-op alerts fell 9 → 3** on a 60-posting co-op sample: co-op titles carry no ops role name
  ("Winter 2027 - GRM, CMM Analyst Intern"), and their postings are thin on domain and tools, so they
  cannot reach a bar tuned for experienced ops roles. They remain visible as `new`/`aged` survivors in
  the console and in the Monday digest — they just do not alert. The tempting shortcut (making
  `co-op`/`intern` role-identity terms) was measured and rejected: it recovers 11 co-op alerts at 27%
  on-target, i.e. it re-creates the disease this audit cured.
- **A per-track threshold would NOT fix that**, contrary to the first instinct in this session: the
  live `canada_coop` track has a single gate, `location_canada`, and routes 5,302 of 6,870 jobs — it
  is "any job in Canada", not a co-op route. Lowering its bar would lower it for the whole Canadian
  roster. The surgical fix is a NEW track: Canada location **+** a title gate on
  `co-op`/`intern`/`work term`, ordered first, with its own threshold (`TrackConfig.thresholds` exists
  in the type but the engine has ignored it since 2026-07-19). That is a separate change and does not
  violate the 2026-07-19 simplification — that decision stopped gates from shaping the SCORE; a
  per-track threshold moves the verdict bar, not the score.
- **Terminology drift:** `canada_coop` is named for a filter it does not have. Rename it, or give it
  the gate its name promises (CLAUDE.md §3).
- Two visible blemishes left in Apply: *"Apps Dev Tech Lead Analyst"* (enters via `analyst` + `lead`)
  and *"Senior Payments Engineer"* (via `payments`). Both would die by adding `engineer` as a title
  negative, at the cost of the Data Engineer roles the owner wants kept as Stretch.

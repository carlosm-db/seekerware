# PRD — Seekerware

Product requirements document. Functional design first; the technical side
lives in [`TRD.md`](TRD.md). Terminology in [`CONVENTIONS.md`](CONVENTIONS.md).

---

## 1. Problem

The system owner is job-hunting along three parallel paths. Job boards are
noise: old or closed jobs, results that do not fit, and a review cost that is
daily and high. When something good shows up, finding out late kills the
opportunity; and tailoring the CV by hand for each job is slow and error-prone.

## 2. Functional model: who sees what, who does what

| Actor | Sees | Does | Does NOT do |
|-------|------|------|-------------|
| **User** (owner) | Telegram messages (new fits, with buttons), the console (triage/tracker/calibration/Blocks Bank/Q&A/health), CV Docs in Drive | Configures companies and profile, approves blocks and answers, does triage, gives the go-ahead, **applies manually (the submit click is ALWAYS theirs)** | Nothing automatic toward companies |
| **System** | Public ATS feeds, the store, the Blocks Bank, the Q&A bank | Polls, normalizes, scores, dedups, verifies freshness and liveness, notifies, assembles the suggested CV, **prepares the application kit**, self-monitors | Never submits applications, never contacts companies, never writes CV content or form answers |
| **Companies / ATS** | Anonymous read traffic to their public APIs | Publish jobs | Receive no user data |

Functional flow: the system discovers -> scores -> filters -> notifies with
positioning and a suggested CV -> the user decides and applies.

## 3. The 3 tracks

| Track | Definition | Positive signals | Gates |
|-------|-----------|------------------|-------|
| `canada_coop` | Co-op / work term in Canada | "co-op", "work term", "internship" | Canada location; enrollment requirements |
| `colombia_perm` | Permanent role in Colombia for international companies | Permanent full-time, LATAM-friendly | Colombia / LATAM / Remote-Americas location; rejects "US only" / "no sponsorship" |
| `contractor_usd` | Remote contractor paid in USD | "contractor", "B2B", "freelance", remote | Remote worldwide / Americas |

A job is scored once (core score) and evaluated against each track's gates; it
is notified if it passes any of them, **naming the track** so the positioning
has the right frame.

## 4. Output contract (per notified job)

```
verdict            Apply | Stretch-worth-it        (Skip is never notified)
score              0-100 (rules, not AI)
track              canada_coop | colombia_perm | contractor_usd
why_it_fits        why it fits (2-3 lines)
gap_to_address     the gap to mitigate in the application
positioning_lead   what to open with / how to position
project_to_feature own project to highlight
cv_blocks          IDs of suggested blocks per section
cv_doc_url         (Apply verdict only) link to the Doc generated in Drive
freshness_ok       true | unknown (false is never notified)
```

## 5. Functional requirements

- **RF1 — Same-day discovery**: a job published today -> notified within the
  next cron run (30-60 min).
- **RF2 — Freshness**: nothing older than `FRESHNESS_MAX_DAYS` (3) days since
  publication. A company's first run seeds the history without notifying.
- **RF3 — Verify-on-notify**: before notifying, the job is re-queried against
  the ATS API; if it no longer exists, it is not notified and is marked
  `closed`.
- **RF4 — Dedup**: a job is notified at most once (key: hash of the canonical
  URL).
- **RF5 — Rule-based score**: 0-100 weighting domain > role type > tool overlap
  > level; `hard` gates (require/reject) per track; configurable verdict
  thresholds.
- **RF6 — AI enrichment (survivors)**: improves `why_it_fits` /
  `positioning_lead` and selects blocks. Never changes verdicts or gates.
- **RF7 — CV factory (Apply verdict)**: assembles the suggested CV ONLY from
  pre-approved blocks (EN or ES depending on the job), deterministic render over
  a Docs template, cv_verifier flags tweaks as suggestions.
- **RF8 — Tracking**: every job seen is kept in the store with score, verdict,
  status and dates; those that drop out of the feed are auto-marked `closed`.
- **RF9 — Configuration without deploy**: adding a company, tuning
  keywords/weights/thresholds and approving blocks are done from the dashboard
  (`companies`/`config`/`blocks` tables); no profile change requires a deploy.
- **RF10 — Console with login**: the console is private, always behind
  authentication; nothing of the system is exposed publicly.
- **RF11 — Application kit** (step 8): for each Apply with the owner's go-ahead
  (button in Telegram or console), the system prepares EVERYTHING — CV as PDF
  (clean copy), standard answers from Q&A (`profile_answers`; blocks-style
  governance: owner authorship, selection-only), detection of form questions
  (Greenhouse `?questions=true`; Lever public HTML), and any questions without
  an approved answer are asked to THE OWNER over the Telegram chat (their
  answers can be saved to Q&A). The final submit is human, always.
- **RF12 — Self-monitoring**: every run is recorded (funnel, quotas, errors);
  the console shows health, free-tier meters and ROI per company; MAINTENANCE
  alerts over Telegram and a weekly funnel digest (Mondays).

## 6. Non-goals (explicit)

- **No auto-apply**: the system NEVER submits an application — it prepares the
  kit and the human submits. Ratified 2026-07-17 with evidence
  (`docs/audits/2026-07-17-diseno-auto-apply.md`): the submit APIs of the 3
  ATS are company-key-only; form emulation is active anti-bot with silent
  failure (spam queue) that would permanently and invisibly burn curated
  companies.
- **No scraping** behind login or of portals without a public API. Explicit
  exception (2026-07-17): reading the PUBLIC HTML of Lever's apply page, only
  to detect form questions (Lever does not expose them in its API); never
  behind login, never to submit.
- **No free CV generation**: the AI does not write; it selects approved blocks.
- **No multi-user**: personal tool (the login exists for privacy, not for
  accounts).
- **No costing or timelining** in AI-generated text.

## 7. Success metrics

- 0 notifications for jobs older than 3 days or already closed.
- Learning about fits on the same day they are published.
- Low notification volume (real fits; if it gets noisy, raise the threshold).
- 0 claims in suggested CVs that do not come from approved blocks.
- The owner can maintain and extend the system on their own.
- Operating cost: $0/month (strict free tiers).

## 8. Future evolution (out of scope for steps 2-8)

- **Userscript companion (L2c)**: a local extension/userscript that auto-fills
  the form in the owner's browser from the kit (Simplify pattern: real browser,
  human present, human click). PARKED behind a data gate: reopened only if the
  time-to-apply telemetry + the question census (2-3 months) prove that manual
  submission with a kit is the real bottleneck.
- **Capture inbox**: a dedicated Gmail that receives job alerts (newsletters,
  the college co-op portal digest); the system READS its own inbox via the
  official API — never logs into portals — and normalizes those emails as
  pipeline jobs.
- Bot commands (`/pending`, `/cv <id>` on-demand).
- Manual re-score of existing jobs after config changes (future evolution;
  today edits apply only to new scores).

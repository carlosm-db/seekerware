# UI — Seekerware

Interface design. Two channels: **Telegram (push, with buttons)** to find out
and give the go-ahead, and the **console (pull)** to operate everything. The CV
Doc in Drive is the deliverable artifact. Terminology in
[`CONVENTIONS.md`](CONVENTIONS.md); extended design in
`docs/audits/2026-07-17-diseno-consola-ux.md`.

---

## 1. Telegram — push channel (and go-ahead)

One message per notified job (HTML parse mode). Only `Apply` and
`Stretch-worth-it` verdicts, with freshness OK and verify-on-notify passed.

```
🎯 <b>{title}</b> — {company}
📍 {location} · 🏷 {track} · ⏱ published {age} ago

Verdict: <b>{verdict}</b> · Score {score}/100

<b>Why it fits:</b> {why_it_fits}
<b>Gap to address:</b> {gap_to_address}
<b>Positioning:</b> {positioning_lead}
<b>Project to feature:</b> {project_to_feature}

📄 Suggested CV: {cv_doc_url}        <- Apply verdict only
🔗 {url}

[ View kit ]  [ Mark applied ]      <- inline buttons (step 8)
```

Rules:

- No personal user data in the message (only job data).
- If the AI was unavailable, the message goes out with the rule-based texts and
  the `(rule-based)` mark.
- Repeated failures of a company's feed generate a message to the same chat
  with a `⚠️ MAINTENANCE` prefix; on Mondays the weekly funnel **digest**
  arrives.
- **Kit conversational flow** (step 8, via webhook): on tapping "View kit", if
  the form has questions without an approved answer in the `answers` bank, the
  bot asks them ONE at a time in the chat; the owner's answers are included in
  the kit and (with their OK) saved to the bank. The bot transports; it NEVER
  writes.

## 2. The console — 10 pages

A multipage webapp served by the worker, ALWAYS behind the login (signed
cookie — TRD §8). It is the only operating surface: it replaces spreadsheets
100%. Wide layout mandatory; light/dark theme; UI in English; keyboard-first in
triage; every mutation works without JS (real forms, enhanced with htmx).

| Route | Page | Purpose | v |
|-------|------|---------|---|
| `/login` | Login | the only route without auth | 1 |
| `/` | **Today** | morning page: status strip (pending triage, applied-this-week count, health) + triage of survivors (Prepare / I applied ✓ / Dismiss / Snooze 3d / CV) two-up on desktop, paginated | 1 |
| `/jobs` · `/jobs/:hash` | **Jobs** | everything seen: filters (track/verdict/status/title text) + quick views; detail: score breakdown by category, gates table per track, description, history, similar-jobs radar, **Generate CV** button (SAMPLE while the bank is unapproved, REAL queue once approved) | 1 |
| `/tracker` | **Tracker** | applications kanban: Prepared → Applied → Interview → Offer/Rejected, notes, dates, overdue follow-ups (bounded at the 300 most recent) | 1 |
| `/companies` | **Companies** | CRUD + health (failure streak, last error) + 90d yield, token probe on create, paginated | 1 |
| `/config` | **Calibration** | matrix redesign (2026-07-18 v3.3): ONE grid — 5 categories (Location included) × In favor/Against × EN/ES — with the track as a **path** badge on the word (gates stay gates; the matrix is a projection, `src/console/matrix.ts`); live chip search + per-cell "show N more"; ONE add form after the table (EN+ES both required, weight vocabulary +3 strong/+2 medium/+1 light/−2 against/−3 strongly against, optional path); ✕ removes the full pair everywhere; edits accumulate in a DRAFT → **Preview impact** → **Activate** (its own button on the preview screen); history with human `diff_summary` and previewed revert; **Re-score** materializes the active config; raw JSON demoted to an Advanced fold | 1 |
| `/blocks` · `/blocks/edit` · `/blocks/template-check` | **Bank** | career-shaped (2026-07-18 v3.3 redesign): **My roles** newest-first with identity headers (title · company · dates from `anchors.title/date_from/date_to`, migration 0009; code demoted to a small chip); **Edit role** panel (title/company/dates/code-rename + retire) replaces "manage"; bullets show full EN/ES text with ONE fused language+status pill per line and **per-bullet Approve only** (mass approve-all and per-group approve removed by owner decision); contextual add-bullet with **EN+ES both required**; **My projects**, **My skills** (4 category groups), **My summary**; per-block edit page keeps Retire (soft) / Delete (confirm, permanent); **Check template** diffs the bank against the Doc's `{{…}}` tokens both ways | 2 |
| `/cvs` | **CVs** | pure library of generated CVs (Doc links, SAMPLE/real, selection rationale, verifier notes, fill report), paginated; generation happens on the job pages | 2 |
| `/applications` | **Applications** | kit queue: pending Apply → kit ready (PDF, matched answers, red questions, deep link) → applied; question census | 2 (step 8) |
| `/health` | **Health** | **Schedule panel** (run every N hours, window, timezone — no deploy needed) + runs history (paginated), event log, quota meters | 1 |
| `/week` | **Week** | weekly funnel (seen→survivors→notified→applied — plain counts, no goals/quotas by owner decision), median time-to-apply, stalled WIP | 2 |

Cross-cutting: top nav with badges (triage pending, suggested, health), an
omnipresent footer "last run X min ago · N companies OK · errors", global
search `Ctrl+K` (v2), `g`+key navigation.

Built-in creative features: **interview prep** (`/jobs/:hash/prep`, v2): a
100% rule-based dossier that projects the blocks of the submitted CV WITH their
`evidence` — every claim backed by its fact; **similar-jobs radar** (cluster by
`title_norm` + tags: positioning reuse across companies); **momentum** (honest
pace metrics for a high-conscientiousness profile); Monday **digest**.

Writers per page (extends the one-writer-per-column rule): `jobs` system only
(sole exception: `status -> skipped`); `applications`/`job_events` (actor user)
/ notes: user; `companies`/`config`/`blocks`/`answers`: user;
`runs`/`events`/`notifications`: system.

## 3. Suggested CV Doc (Drive) + PDF

Name: `CV — {company} — {title} — {yyyy-mm-dd}`, in the shared folder
(`DRIVE_FOLDER_ID`).

Structure (fill-in-place: the template `CV_TEMPLATE_DOC_ID` is the fixed
skeleton; the factory fills the `{{...}}` tokens it finds — see TRD §6):

1. Header — name/email/LinkedIn hardcoded in the template; `{{phone}}` and
   `{{location}}` filled per track from the private `config['contact_profile']`
   (owner-entered via the `/contact` console page). Never from the repo.
2. Summary — `{{sum_1}}…{{sum_N}}`, one selected block per bullet slot.
3. Skills — `{{skills_<methodologies|technical|academic|emerging>}}`, each line
   filled with the selected skills of that category (joined). Languages is
   static in the template.
4. Experience — role headers are static; responsibilities are `{{<CODE>R<N>}}`
   (role codes `DLAB1/BNS2/BNS1/UPS1/BAC1`), each filled with a selected block.
5. Projects & Education — static in the template (AI-selected projects: Phase 2).
6. **"Suggested tweaks" appendix** (to delete before submitting): cv_verifier
   suggestions — never applied automatically — and the selection rationale. Also
   persisted in D1 (`cvs` table), so they survive deleting the appendix.

Unfilled or unrecognized tokens resolve to '' — no raw `{{...}}` ever leaks.

Doc language = job language (`text_en` or `text_es` blocks; ES render requires
approved parity). The PDF exported for the kit and the R2 file use a CLEAN copy
without the appendix (TRD §6).

## 4. Console stack (summary; detail in TRD §8)

Hono + `hono/jsx` SSR + vendored htmx + vanilla islands + a single CSS file
with custom properties. Zero extra build. Login via signed cookie (no domain →
no Access). Assets behind `run_worker_first`. Pagination at 50 on every table;
replay in batches of 50 (free-tier CPU limit).

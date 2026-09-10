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
  the form has questions without an approved answer in **Q&A**
  (`profile_answers`), the bot asks them ONE at a time in the chat; the owner's
  answers are included in the kit and (with their OK) saved as draft Q&A
  answers. The bot transports; it NEVER writes.

## 2. The console — 10 pages

A multipage webapp served by the worker, ALWAYS behind the login (signed
cookie — TRD §8). It is the only operating surface: it replaces spreadsheets
100%. Wide layout mandatory; light/dark theme; UI in English; keyboard-first in
triage; every mutation works without JS (real forms, enhanced with htmx).

| Route | Page | Purpose | v |
|-------|------|---------|---|
| `/login` | Login | the only route without auth | 1 |
| `/overview` (`/` redirects here) | **Overview** | morning page: status strip (pending triage, applied-this-week count, health) + this week's funnel + triage of survivors (Prepare / I applied ✓ / Dismiss / Snooze 3d / CV) two-up on desktop, paginated | 1 |
| `/jobs` · `/jobs/:hash` | **Jobs** | everything seen: filters (track/verdict/status/title text + posted-date window, over posted_at falling back to first_seen) + quick views; detail: score breakdown by category, gates table per track, description, history, similar-jobs radar, **Generate CV** button (SAMPLE while the Blocks Bank is unapproved, REAL queue once approved) | 1 |
| `/tracker` | **Tracker** | applications kanban: Prepared → Applied → Interview → Offer/Rejected, notes, dates, overdue follow-ups (bounded at the 300 most recent) | 1 |
| `/contact` | **Contact** | per-track contact profile — `{{phone}}`/`{{location}}` for the CV header, owner-entered (`config['contact_profile']`), never from the repo | 1 |
| `/companies` | **Companies** | CRUD + health (failure streak, last error) + 90d yield, token probe on create, paginated | 1 |
| `/calibration` | **Calibration** | the matrix (`src/console/matrix.ts`): 5 categories (Location included) × In favor/Against × EN/ES as collapsible groups — Word EN (required) / Word ES (required) / Strength / Path; one add form per group (weight vocabulary +3 strong / +2 medium / +1 light / −2 against / −3 strongly against, optional path); inline ✏️ edit and ✕ remove per row; **edits apply on save** — no draft/Preview/Activate and no Re-score (removed 2026-07-19); each save bumps the config **version** stamped into new scores; gates stay gates, the matrix is a projection | 1 |
| `/blocks_bank` · `/blocks_bank/template-check` | **Blocks Bank** | v6, the owner's sketch (2026-07-18): roles/projects/skill-groups/summary are **collapsed cards, newest first** — tap = read mode (full-width EN+ES text, nothing else); the single ✏️ per card opens **the WHOLE card as ONE form** — role fields (Title, Company+Code, current-role checkbox + From/To months) plus ALL its bullets as token-labeled boxes (`BNS1R1`…) with per-box Delete and a ＋add-a-bullet that appends pairs client-side; **one Save = one transaction** (`/roles/save`, `/roles/create` with bullets, `/blocks_bank/group-save`); **saving IS the approval** (migration 0010); EN+ES always required; role delete is hard and takes its bullets (confirm); no Type dropdown — ＋Add role / ＋Add project imply the kind; **Check template** diffs the Blocks Bank against the Doc's `{{…}}` tokens both ways | 2 |
| `/qa` | **Q&A** | approved standard answers (`profile_answers`) for application forms + the kit queue (pending Apply → kit ready: PDF, matched answers, red questions, deep link → applied); blocks-style governance; the bot's draft answers are approved here | 2 |
| `/cvs` | **CVs** | pure library of generated CVs (Doc links, SAMPLE/real, selection rationale, verifier notes, fill report), paginated; generation happens on the job pages | 2 |
| `/intelligence` | **Intelligence** | AI surface: pipeline view (enricher → cv_selector → cv_verifier) + ML tooling | 2 |
| `/health` | **Health** | **Schedule panel** (run every N hours, window, timezone — no deploy needed) + runs history (paginated), event log, quota meters | 1 |

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
/ notes: user; `companies`/`config`/`blocks`/`profile_answers`: user;
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
no Access). Assets behind `run_worker_first`. Pagination at 50 on every table.

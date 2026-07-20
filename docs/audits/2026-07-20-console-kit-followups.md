# Audit + diagnosis — console/kit follow-ups #2–#7 (2026-07-20)

Audit of the real code for the owner's backlog. **Diagnosis only — nothing implemented.**
Each item: current code → diagnosis → proposed approach → decision needed.

---

## #2 — Answer the 🔴 (unanswered) questions from the job page

**Current code.** `buildKit` (`src/kit/kit.ts`) detects questions and matches them only
against **approved** Q&A (`profile_answers WHERE status='approved'`); unmatched → `red[]`.
The job page kit card (`src/console/app.tsx`) lists them under *"Unanswered: 🔴 … answer them
from the Telegram kit message, or add them in /qa"*. The **only** answer paths today:
- **Telegram** (`src/tg.ts` 182–201): a chat reply attaches the answer to THIS kit
  (`answers[].answer`, `red=false`) **and** saves a **draft** `profile_answers` row
  (`ON CONFLICT DO NOTHING`) for later approval/reuse.
- **/qa** (`app.tsx` `/qa/add` + `/qa/approve`): a **generic** bank, not tied to any job.

**Diagnosis.** There is NO per-job answer flow in the console — the card just points to
Telegram (which console Prepare never sends) or the generic /qa. So the owner "detects
questions but has nowhere to answer them here."

**Proposed.** On the job page, render each 🔴 with an inline `<form>` (a textarea + Save).
POST `/jobs/:hash/answer` mirrors the Telegram flow: attach the answer to this kit
(`application_kits.answers`, drop it from `red_questions`) **and** upsert a **draft**
`profile_answers` row (owner approves in /qa to reuse it elsewhere — keeps the "approve before
reuse" rule). Reuses `normalizeQuestion` + the existing upsert pattern.

**Decision:** save the per-job answer as **draft** (consistent — approve in /qa) or
**approved** (one step less, since the owner is deliberately answering in the console)?
*Recommend: draft + attach-to-kit* (matches the Telegram design).

---

## #3 — Doc vs PDF: which to surface

**Current code.** A build stores both: `cvs.doc_url` + `cvs.pdf_file_id`; the jobs row carries
`cv_doc_url` + `cv_pdf_key`. The kit card links **only the Doc** (`CV Doc ↗`). The **PDF is
archived in Drive but never linked** in the console.

**Diagnosis.** Not two rival CVs: the **Doc** is the editable master (render surface); the
**PDF** is exported from it and is the file you attach. Today you can't open the PDF from the
console at all.

**Proposed.** Link the PDF via its Drive id (`https://drive.google.com/file/d/{cv_pdf_key}/view`)
alongside/instead of the Doc.

**Decision (owner):** **solo PDF** (the deliverable), **solo Doc** (editable), or **ambos**?
*Recommend: ambos — `PDF ↗` primary (attach) + `Doc ↗` secondary (edit).*

---

## #4 — Console times show UTC; want COT (UTC−5)

**Current code.** One helper `fmt()` (`app.tsx:77`): `iso.slice(5,16).replace('T',' ')` — slices
the **raw ISO (UTC)** string. ~12 call sites (Jobs, job detail Posted/Seen, events, Companies
health, Tracker, Intelligence, footer). The Health panel even prints literal *"… UTC · … UTC"*.

**Diagnosis.** Single central cause → single central fix.

**Proposed.** Rewrite `fmt()` to format in **America/Bogota** via `Intl.DateTimeFormat`
(`month/day/hour/minute`, 24h); change the two "UTC" labels → "COT"; add a subtle
*"horas en COT (UTC−5)"* footer hint. Fixed to America/Bogota (owner's zone); **no** other
time/scheduler code touched.

**Decision:** COT primary (recommended) vs UTC with COT in parentheses.

---

## #5 — Telegram Prepare still uses `waitUntil` (latent PDF-cut risk)

**Current code.** `src/tg.ts:164` runs `prepareJob` in `waitUntil` (must, since a Telegram
webhook has to ack fast — it can't block ~30s). Same risk that broke the console: Cloudflare
can kill the background task before the PDF. **Mitigation exists:** on CV failure `prepareJob`
sets `cv_pending=1`, and each burst's CV factory (`pipeline.ts` 48–58) retries it (gives up
after `cv_pending_max=3`). So a cut Telegram CV **self-heals on the next burst** — but the
owner is NOT re-notified, and the burst retry does not push the CV to Telegram.

**Diagnosis.** Real but mitigated: the **kit/Q&A** (fast, reliable) always lands; the **CV**
(slow, risky) may need a burst retry, and the owner has to check the job page for it.

**Proposed options (owner picks):**
- **(a) Leave as-is** — accept the burst self-heal; lowest effort.
- **(b) Decouple** — Telegram Prepare builds only the kit (fast) + red-question chat inline,
  and the CV is built by the burst (`cv_pending`); when a `cv_pending` CV finishes, **push a
  Telegram message with the CV link**. Reliable + you get the CV, delayed to the next burst.
- **(c) Deep-link** — Telegram Prepare pushes the kit + a link to open the job in the console,
  where the CV builds **blocking with the progress popup** (reliable, immediate).

*Recommend (b) or (c).* Owner flagged this as "aparte" (lower priority).

---

## #6 — Move `Prepare` + `I applied` into the Application-kit section (next to Polish)

**Current code.** Job page header action row: `[Open job ↗] [Prepare] [I applied ✓] [Dismiss]`.
Kit card actions: `[✨ Polish answers] [CV Doc ↗]`.

**Diagnosis.** The "work on this application" actions (Prepare/Polish/CV/applied) are split
between the header and the kit card; triage/navigation is mixed with production.

**Proposed layout.**
- **Top row (navigate / triage / share):** `[Open Job ↗] [Dismiss] [Telegram]` (Telegram = #7).
- **Application-kit section (produce → refine → open → done):**
  `[Prepare] [✨ Polish answers] [PDF ↗ / Doc ↗] [I applied ✓]`
  — Polish only after a kit exists; CV link only after built; "I applied" is the terminal
  action (blue when `stage==='applied'`, Prepare blue when `stage==='prepared'`, as now).

**Decision:** confirm this order (or adjust).

---

## #7 — New `Telegram` action: send (or resend) the job to Telegram

**Current code.** Job notifications are pushed by the pipeline: `formatJobMessage()` +
`kitButtons(hash)` + `sendTelegram()` (all in `src/notify.ts` / `src/tg.ts`). There is **no
manual "send to Telegram"** action; a job is only pushed once, automatically, at notify time.

**Diagnosis.** The owner wants to push a job to Telegram on demand — to action it from the
phone when it wasn't notified, or to resend it.

**Proposed.** A `Telegram` button → POST `/jobs/:hash/telegram` that rebuilds the message from
the jobs row (`why_it_fits`, `positioning_lead`, `score`, `verdict`, `track`, `score_breakdown`
for the gap) and calls `sendTelegram(env, msg, fetch, kitButtons(hash))`. Always allowed
(send if never notified; resend otherwise). Reuses existing functions; the channel is the
owner's own private one (no new privacy surface).

**Decision:** none — straightforward if approved.

---

## Suggested order / grouping for implementation (all pending owner OK)
1. **#6 + #7 together** (one job-page action redesign: top row + kit-section row + Telegram send).
2. **#2** (answer 🔴 inline) — pairs naturally with the kit section.
3. **#4** (COT) — isolated, central, quick.
4. **#3** (Doc/PDF) — trivial once the visibility choice is made.
5. **#5** (Telegram CV reliability) — last, "aparte", pick option (a)/(b)/(c).

Verification per item: `tsc` + `vitest`; `wrangler dev` for the console/Telegram paths. No
commit/push without an explicit go.

---

## OWNER DECISIONS (2026-07-20) + re-audit

- **#3 — decided:** the single CV link redirects to the **PDF**
  (`https://drive.google.com/file/d/{cv_pdf_key}/view`). Send **everything to `archive/`
  INCLUDING the Google Doc** (today `copyTemplate` puts the Doc in `DRIVE_FOLDER_ID` root; the
  PDF already goes to `archive/`), and put the **time reference in the Doc name** (today the
  Doc name uses date-only `${today}`; the PDF uses `stamp` = YYYYMMDDHHMM). Changes:
  `src/gdocs.ts` `copyTemplate` → resolve `ensureArchiveFolder` and set that as the Doc's
  parent; `src/ia/cv_factory.ts` Doc name → include the timestamp; console CV link → PDF.
- **#4 — decided:** **UTC with COT in parentheses**, e.g. `07-20 19:35 UTC (14:35 COT)`.
  `fmt()` formats both (raw UTC slice + `Intl` America/Bogota); the two literal "UTC" labels stay.
- **#6 — accepted:** top row `[Open Job ↗] [Dismiss] [Telegram]`; kit-section row
  `[Prepare] [✨ Polish] [CV ↗ (PDF)] [I applied ✓]`.
- **#2 — deferred:** the per-job 🔴 answer flow is OUT for now.
- **#7 — the `Telegram` button (notify on demand, no new functions).** Re-audit confirms it
  can be reproduced from STORED data with no AI re-run: `formatJobMessage({job(from jobs row),
  verdict, track, score, ageDays(from posted_at), whyItFits(=why_it_fits),
  positioningLead(=positioning_lead), gapToAddress(recomputed via
  ruleBasedTexts(JSON.parse(score_breakdown)))})` + `sendTelegram(env, msg, kitButtons(hash))`
  — the same call the pipeline makes at `pipeline.ts:332–340`. The button re-fires it (send if
  never notified, resend otherwise). No CV-push-on-burst, no deep-links.

- **#5 — FIX the Telegram Prepare `waitUntil` (my earlier note "untouched" was WRONG).** The
  `p:` handler (`tg.ts:140-166`) runs `prepareJob` (kit **+ CV**) in `waitUntil`; Cloudflare
  can kill it before the PDF. A webhook can't block ~30s, so the console's blocking fix doesn't
  apply. **Fix = remove the heavy CV build from Telegram (a simplification, NOT a new
  function):** the handler calls `buildKit` (kit only — ~1-3s, no PDF → safe in `waitUntil`) +
  marks `stage=prepared` + pushes the Q&A + the red-question chat, exactly as today; the **CV
  is built in the console** (blocking, reliable, with the progress popup). Telegram still
  delivers the kit/Q&A instantly; the CV moves to where it completes reliably. The kit message's
  CV line points to the console. *(Alternative B: drop Prepare from Telegram entirely →
  Telegram = notify + [I applied]/[Dismiss]; loses the red-question chat. Recommend A.)*

### Consolidated scope to implement (pending go)
1. **Telegram button (#7)** — job-page `[Telegram]` button + `POST /jobs/:hash/telegram` that
   rebuilds the notify message from stored fields and calls `sendTelegram` + `kitButtons`.
2. **Telegram waitUntil fix (#5)** — `tg.ts` `p:` handler: `buildKit` + `stage=prepared` (drop
   the `generateCv`/CV build); kit message CV line → "build in the console". No new functions.
3. **Button reorg (#6)** — move `Prepare` + `I applied` into the kit section; top row becomes
   `[Open Job] [Dismiss] [Telegram]`; CV link → PDF.
4. **#3 archive/name** — `copyTemplate` → Doc into `archive/`; timestamped Doc name (COT).
5. **#4 COT** — `fmt()` shows `UTC (COT)`.

Small helper to avoid duplication: consider exporting `ensureArchiveFolder` from `gdocs.ts`
(used by both copy + export). No new AI, no scheduler, no migration.

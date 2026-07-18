# Audit — Bank tool UX vs its goal (2026-07-18)

**Scope**: the Bank console pages — `GET /blocks`, `GET /blocks/edit`, `POST /blocks/create|update|delete|approve|retire|approve-all` in `src/console/app.tsx` (lines 46–88 and 912–1132) and `src/console/blocks-form.ts` — measured against the Bank's goal: *let the owner manage his CV content the way he thinks about a CV (roles with bullets, skills by category, summary lines) and approve what is ready.*

**Owner verdicts under audit**: "the edit block is way nonsense, what is that puzzle?", "bank is a terrible awful tool, it does not work to its goal", "if I have a new role to add to the Bank, I cannot, there's no logic to it".

**Method**: full read of the Bank routes and form helper; grep of the whole `src/` tree for every consumer of each block/anchor column; read-only local D1 queries. All claims below are verified in code, with file:line references. Local DB state at audit time: **86 blocks, all `status='draft'`, all with ES text, all `es_status='draft'`; 9 anchors (5 roles: DLAB1, BNS2, BNS1, UPS1, BAC1; 4 projects)**.

**Verdict up front**: the owner is right on all three counts. The page is a raw admin grid over the `blocks` table. Its unit is the DB row, its vocabulary is the DB schema, and the one entity the owner actually thinks in — the **role** — has no page, no name in plain language, and no write path at all.

---

## 1. Element-by-element inventory and verdict

Classification: **VALUE** (serves the owner's goal) / **JARGON** (internal DB vocabulary leaked to the UI) / **DEAD** (no runtime consumer or no function for the user).

### 1.1 `GET /blocks` (list page) — app.tsx:913–1035

| # | Element | Where | Verdict | Evidence |
|---|---------|-------|---------|----------|
| 1 | Stat "approved blocks n/n" | app.tsx:964 | VALUE | Real progress signal toward a usable bank (real CVs require approved blocks, cv_factory.ts:85). |
| 2 | Stat "ES parity approved n/n" | app.tsx:965 | VALUE (weak) | The number is real, but there is no ES review workflow behind it (see §4.3) — it counts a side effect. |
| 3 | Section dropdown (auto-submit filter) | app.tsx:968–974 | VALUE | `summary/skills/experience/projects` is genuinely CV-shaped vocabulary. The only filter a normal user can operate. |
| 4 | "More filters" → `(anchor_id)` select | app.tsx:975–978, 947–952 | JARGON | Placeholder text is the literal column name `(anchor_id)`; options are raw codes (`BNS1`, `prj-corex`) with no company name (the `distinct()` helper at :927–929 returns codes only). |
| 5 | "More filters" → `(angle)` select | app.tsx:979 | JARGON | Unlabeled enum `data/compliance/operations/leadership`; meaning ("emphasis the AI prioritizes", agents.ts:77) explained nowhere. |
| 6 | "More filters" → `(status)` select | app.tsx:980 | VALUE (partly dead) | `draft/review/approved/retired` — but **nothing in the codebase ever sets `review`** (grep: `'review'` appears only in the CHECK constraint migrations/0001:65, this filter, and the approve-all WHERE at :1054). A dead vocabulary item offered to the user. |
| 7 | "More filters" → `(es_status)` select | app.tsx:981 | JARGON | Literal column name as label; `missing/draft/approved`. |
| 8 | "+ Add block" collapsed form | app.tsx:987–993 | VALUE (mis-shaped) | The only create path. It is section-first and role-last: 9 flat fields (see §1.3). Defaults to `summary` (first `<option>`, no `selected` when adding — app.tsx:62). **Not rendered at all when the bank is empty** — the route early-returns at :915–919 before the form, so block #1 can never be added from the console. |
| 9 | "Approve the ENTIRE bank (EN + ES)" button | app.tsx:994–999 | VALUE (dangerous) | One tap, **no confirm dialog** (contrast delete, which has one at :1089), approves all 86 draft blocks *and* their 86 unreviewed ES texts (:1052–1057). The single destructive-scale action on the page is the least guarded. |
| 10 | Section `<h2>` headers with counts | app.tsx:1000–1002 | VALUE (lying) | Count is `brows.length` = rows **on the current page**. With 86 blocks and `PAGE = 30` (app.tsx:26) there are 3 pages; page 1 shows "experience (30)" when there are 36. |
| 11 | Table column `id` | app.tsx:1004,1007 | JARGON | Opaque PK (`exp-a1b2c3d4`) that "is never shown in a CV" (blocks-form.ts:58) — yet it is the **first** column, while the actual text is last and truncated. |
| 12 | Table column `anchor` | app.tsx:1004,1008 | JARGON + hidden on mobile | Raw code (`BNS1`), no company name; class `hide-sm`. |
| 13 | Table column `angle` | app.tsx:1004,1009 | JARGON + hidden on mobile | class `hide-sm`. |
| 14 | Table columns `status` / `ES` | app.tsx:1010–1011 | VALUE | Color-coded, useful. |
| 15 | Table column `text (EN)` | app.tsx:1004,1012 | VALUE, crippled | The only human-readable content: truncated to 90 chars with an unconditional `…`, **and carries `hide-sm`, so on a phone it does not exist** (layout.tsx:44 `.hide-sm{display:none}`, restored only at ≥720px, layout.tsx:99). On mobile the Bank table is: opaque id, status, ES, buttons — zero content. This alone substantiates "terrible awful tool" given the mobile-first mandate. ES text is shown nowhere on the list at any width. |
| 16 | Row actions `edit` / `approve` / `retire` | app.tsx:1013–1026 | VALUE | Per-row approve is the core governance act. But every action redirects to bare `/blocks?m=…` (:1042, :1049), **discarding the active filters and page** — approving 10 experience blocks means re-filtering 10 times. |
| 17 | Pager | app.tsx:1032 | VALUE | Preserves filters (unlike the actions). Splits sections across pages, which fights the grouped-by-section presentation. |
| 18 | Empty-state card | app.tsx:915–919 | JARGON | "The bank is not yet seeded in the database (step 6 seeds)" — internal build-plan language, no action the console can take. |

### 1.2 `GET /blocks/edit` — app.tsx:1059–1096

| # | Element | Where | Verdict | Evidence |
|---|---------|-------|---------|----------|
| 19 | Header line `exp-xxxx · status draft · ES draft` | app.tsx:1068 | JARGON | Leads with the opaque id; no role/company/section in the page header. Page title is "Edit block". |
| 20 | The 9-field form (shared `blockFields`) | app.tsx:1069–1076, 57–88 | see §1.3 | This is the "puzzle". |
| 21 | Save / Cancel | app.tsx:1072–1075 | VALUE, trapped | Saving **silently destroys ES approval** (§4.2) and redirects to unfiltered `/blocks` (:1125). |
| 22 | approve / "retire (keep record)" | app.tsx:1077–1088 | VALUE | Mutually exclusive by status; a retired block's only way back is direct `approve` (the list shows `approve` for any non-approved status, :1015) — there is no return-to-draft. |
| 23 | "Delete permanently" + JS confirm | app.tsx:1089–1092 | VALUE (contradictory) | Sits next to retire, whose flash message says "retired (**never deleted**)" (:1049). The page simultaneously promises blocks are never deleted and offers permanent deletion. |

### 1.3 The form fields themselves (`blockFields`, app.tsx:57–88; `normalizeBlockInput`, blocks-form.ts:33–56)

This is the direct answer to *"the edit block is way nonsense, what is that puzzle?"* — 9 flat fields, of which 3 have **no runtime consumer at all** and 2 more are expert-only encodings:

| Field | Where | Runtime consumer | Verdict |
|-------|-------|------------------|---------|
| Section (select, required) | app.tsx:60–63 | Slot routing (cv_factory.ts:101–104, agents.ts:68) | VALUE — but should be implied by context (adding "a bullet under Scotiabank" *is* the section), not asked first. |
| Role / anchor (select) | app.tsx:64–68 | Groups experience bullets into `{{CODE}}R{N}` slots (cv_factory.ts:196–202, 220–223) | VALUE, badly presented: options read `BNS1 — Scotiabank Technology (Scotiatech) (role)` — code first, and two "Scotiabank" entries the owner must disambiguate by code. Label says "experience & projects only" but the field is offered and accepted for every section (no validation in blocks-form.ts). **No validation the other way either: an experience block with anchor "(none)" is accepted and then silently never rendered** — `buildSlotMap` keys experience by anchor code and `''` matches no `{{CODE}}R{N}` token (cv_factory.ts:196–202, 220–223). |
| Angle (select) | app.tsx:69–73 | AI selection emphasis only (agents.ts:71,77) + list filter | JARGON in presentation, real function. Optional; unexplained enum. |
| Text — English (required) | app.tsx:74–75 | The CV itself | VALUE — the actual content, buried as field 4 of 9. |
| Text — Spanish (parity) | app.tsx:76–77 | ES CV render (cv_factory.ts:93–95) | VALUE. |
| Tags (`skcat:` instructions in the label) | app.tsx:78–79 | `skcat:<cat>` routes skills into `{{skills_<cat>}}` (cv_factory.ts:171–174, 203–210); full string is pasted into the AI prompt (agents.ts:71) | JARGON: a raw machine encoding in a free-text input, with its own syntax documentation crammed into the label. **A skills block whose tags lack `skcat:` is accepted and silently never rendered** (cv_factory.ts:205–206 `if (!cat) continue`). Irrelevant to summary/experience/projects yet always shown. |
| fact_key ("groups phrasings of one fact") | app.tsx:80–81 | **None.** Grep of `src/` finds zero readers; it is only written (app.tsx:1104–1106, 1120–1121) and auto-filled with the block id when empty, which defeats its stated grouping purpose | DEAD / JARGON. |
| Evidence | app.tsx:82–83 | **None** at runtime (the `evidence` in scoring.ts is an unrelated gate field) | DEAD in the form. Legitimate as provenance metadata, but it is a curation note, not an every-edit input. |
| Source | app.tsx:84–85 | **None** at runtime | DEAD in the form (same as evidence). |

So the "puzzle": to type one bullet, the owner faces 9 fields; 5 of them (tags for non-skills, fact_key, evidence, source, and angle if unexplained) contribute nothing he can perceive, 2 can silently make his input never appear in any CV, and none of them says "Scotiabank" in a way he chose.

---

## 2. "If I have a new role to add to the Bank, I cannot" — CONFIRMED, three layers deep

1. **No console/API write path for anchors.** Grep of all of `src/` for `anchors`: the only statements are `SELECT id, company, kind FROM anchors` (app.tsx:54), `SELECT id FROM anchors` (cv_factory.ts:114), and a COUNT in store.ts:207. Zero `INSERT/UPDATE/DELETE ... anchors` anywhere in `src/`. The full route inventory (app.tsx:124–1267, index.ts:18–92) contains no `/anchors` or role route of any kind. Anchors exist solely because `seeds/seed_blocks.sql:6–14` inserts them via the wrangler CLI. This deferral is documented — docs/UI.md:62: "Anchors registry + `suggested` queue = future" — but the UI never says so; the anchor dropdown just presents a closed world.
2. **No console read path either.** There is no page that lists roles. The only place a role ever appears in the console is as a `<select>` option inside the block form. `anchors.dates` and `anchors.titles` (the per-market title JSON, migrations/0001:42–48) are shown nowhere — `fetchAnchors` selects only `id, company, kind`.
3. **Even a SQL-inserted role would not reach a CV.** The renderer fills only tokens **present in the template Doc** (cv_factory.ts:137–139, 176–186: `readPlaceholders` → `buildSlotMap` maps `{{CODE}}R{N}` only for codes in `roleCodes`, and unrecognized tokens resolve to `''`). Role headers (company, title, dates) are hardcoded in the Google Docs template — **`anchors.titles` and `anchors.dates` have zero runtime readers** (grep: no consumer in `src/`). Adding a role for real requires: (a) SQL insert into `anchors`, (b) hand-editing the private template Doc to add the role heading plus `{{CODE}}R1..RN` tokens, (c) adding blocks under the new code. The console covers only (c), partially. "There's no logic to it" is accurate: the logic exists but lives in three different places, two of them outside the product.

---

## 3. Information architecture: DB-shaped vs role-shaped

Today's IA is `section → rows ordered by anchor_id, id` (app.tsx:940–941, 954–959, 1000–1031): the grouping of a database, not of a CV. The owner thinks: *my roles, each with bullets; my skills by category; my summary lines*. Measured cost of that mismatch:

**(a) Add a bullet to Scotiabank — 9 steps, 2 requiring internal-code knowledge:**
1. Home → Bank (`/blocks`).
2. Expand the "+ Add block" `<details>`.
3. Change Section from its default `summary` to `experience`.
4. Open the anchor dropdown and decode which of `BNS2 — Scotiabank (role)` / `BNS1 — Scotiabank Technology (Scotiatech) (role)` is "my Scotiabank job".
5. Decide what to do with Angle (unexplained).
6. Type the bullet in "Text — English".
7. Skim past / skip tags, fact_key, evidence, source (and ideally write ES text).
8. Submit "Add as draft" → redirected to `/blocks?section=experience`; the new row lands wherever its random id sorts inside the anchor group, possibly on page 2.
9. Find it again and click **approve** (a draft never enters a real CV — cv_factory.ts:85).
   Zero validation protects step 3+4 consistency: skipping step 4 yields a bullet that renders in no CV, ever, silently (§1.3).

**(b) Fix a typo in a bullet — 4–6 steps plus two hidden traps:**
1. `/blocks`; 2. locate the bullet — on desktop by scanning 90-char fragments across up to 3 pages or via 2–3 extra filter clicks; **on a phone this is impossible: the text column is hidden**, so it becomes open-edit-pages-one-by-one-by-opaque-id; 3. `edit`; 4. fix the text among 9 fields; 5. Save.
   Trap 1: the save **silently resets `es_status` from `approved` to `draft`** even when only the EN text changed (§4.2). Trap 2: the redirect drops filter/page context (:1125).

**(c) See all bullets of one role together — 3 clicks to a degraded result:**
1. `/blocks` → "More filters"; 2. pick the raw code in `(anchor_id)`; 3. Apply filters.
   The result shows 90-char fragments (full text nowhere), no role header (title/dates are not in the DB view and not on the page), no ES text, and on mobile no text at all. "See my Scotiabank experience as it would read on a CV" is not achievable at any click depth.

A role-centric IA (**My roles** → each role card with its full bullets in render order → **My skills** by category → **My summary**) would make (a) a two-step act ("Add bullet" button under the Scotiabank card — section and anchor implied), (b) a direct tap on visible full text, and (c) the default view. The data model already supports it: it is a single `SELECT ... FROM blocks WHERE anchor_id = ?` plus the `anchors` row; nothing about the schema forces the current presentation.

---

## 4. Approve / retire / delete semantics and ES parity

### 4.1 Approve
- Per-block approve (app.tsx:1037–1043) and approve-all (:1052–1057) both set `status='approved'` **and, as a side effect, `es_status='approved'` whenever `text_es` exists** — the Spanish text is "approved" without ever being displayed to the approver (the list never shows `text_es`; the approve button lives on a row whose ES content is invisible).
- Approve-all has no confirmation and currently would mass-approve 86 EN + 86 ES texts in one tap (§1.1 #9). The code comments frame this as the intended "light review via sample CVs" (cv_factory.ts:83–84, app.tsx:998), which is a defensible workflow — but then the per-block governance the schema was built for (`draft → review → approved`) is vestigial: nothing ever sets `review`.

### 4.2 Update silently destroys ES approval (asymmetric with EN)
`POST /blocks/update` (app.tsx:1113–1126) writes `es_status` from `normalizeBlockInput`, which derives it purely from ES-text presence: `es_status: text_es ? 'draft' : 'missing'` (blocks-form.ts:51). Consequence: **any save of the edit form — including an EN-only typo fix — downgrades an `approved` ES status to `draft`**, with no message. Meanwhile `status` (EN approval) is *not* touched by update, so the same save leaves possibly heavily-edited EN text `approved`. The two approval systems react to edits in opposite ways, both silently. From the owner's chair this is unpredictable state churn — part of "does not work to its goal" (the goal being *approve what is ready* and have that approval hold).

### 4.3 ES parity visibility
There is no ES review surface: the list shows only the `es_status` badge, never the Spanish text; the edit page shows the two textareas stacked, with no indication of what approving will do to ES. ES approval can only be produced as a side effect of EN approval and only destroyed as a side effect of saving. A "parity" concept with no comparison view.

### 4.4 Retire vs delete
- Retire (app.tsx:1045–1050) is the documented soft path ("retired (never deleted)") and approve-all correctly excludes retired blocks (:1054). Good.
- But there is no un-retire/back-to-draft; the only exit from `retired` is straight to `approved` (:1015).
- "Delete permanently" (edit page only, :1089–1092, with confirm) directly contradicts the retire flash's "never deleted" promise on the same screen. For a bank whose value is accumulated curated content, hard delete of a possibly-approved block is a footgun the retire concept was designed to prevent.

---

## 5. Top UX failures, ranked

| Rank | Severity | Failure |
|------|----------|---------|
| 1 | **critical** | **Roles are not a manageable entity.** No create/edit/list surface for anchors anywhere in console or API (grep-verified, §2); roles enter only via `seeds/seed_blocks.sql` + CLI, and even then the template Doc must be hand-edited for them to render. The owner's #1 stated need ("add a new role") is structurally impossible in-product. |
| 2 | **critical** | **DB-shaped IA defeats the goal.** The unit shown is the table row (opaque id first, 90-char text last), grouped by `section`, filtered by raw column names and codes. No view shows a role's bullets in full, in render order, with its header. Steps measured in §3. |
| 3 | **critical** | **The bank is unusable on a phone.** `text (EN)`, `anchor`, `angle` all carry `hide-sm` (app.tsx:1004) and `.hide-sm` is `display:none` below 720px (layout.tsx:44,99): the mobile list is ids + statuses + buttons, zero content — against the owner's mobile-first console mandate. |
| 4 | **major** | **The edit form is 9 flat fields, 3 with no runtime consumer** (fact_key, evidence, source — grep-verified) **and 2 that can silently void the input** (experience without anchor; skills without `skcat:` tag — cv_factory.ts:196–210, 220–223). This is the "puzzle". |
| 5 | **major** | **Saving destroys ES approval silently; approving grants it blindly** (§4.1–4.3): `es_status` is recomputed to `draft` on every update (blocks-form.ts:51 + app.tsx:1120–1121), and set to `approved` by EN-approve without the ES text ever being on screen. |
| 6 | **major** | **"Approve the ENTIRE bank" is the least-guarded, most prominent action**: no confirm (delete has one), sits above the table, and today would approve 86 EN + 86 ES drafts in one tap. |
| 7 | **minor** | Action redirects drop filter/page context (app.tsx:1042,1049,1125) — bulk-reviewing a section means re-filtering after every approve. |
| 8 | **minor** | Section `<h2>` counts are per-page, not real totals (app.tsx:1002); sections split across pages. |
| 9 | **minor** | Dead vocabulary and contradictions: `review` status offered in filters but never set anywhere; "retired (never deleted)" next to "Delete permanently"; empty-state build-plan jargon with the add form unreachable at 0 blocks (app.tsx:915–919). |

---

## 6. What a role-centric rebuild requires from the backend (no code written; for owner discussion)

The schema is already adequate — this is mostly **routes + queries + one rendering decision**:

1. **Anchors CRUD routes** (the missing half of the Bank):
   - `GET /roles` (or fold into `/blocks` as the new home view): `SELECT id, kind, company, dates, titles FROM anchors` + per-anchor block counts (`LEFT JOIN blocks`). One query, already trivially supported.
   - `POST /roles/create`, `POST /roles/update`: plain INSERT/UPDATE on `anchors`. Form needs: kind, company, dates, and the four market titles as **named fields** (internal / market_canada / market_colombia / contractor) serialized to the existing `titles` JSON — never a raw JSON textarea. Role code (`id`) auto-suggested, immutable after creation (it is an FK from `blocks.anchor_id` and the template token prefix).
   - Role removal should be a soft `retire`-style flag (needs one nullable column or a convention), not DELETE — blocks reference it and history matters.
2. **Confront the template coupling honestly** (decision needed, either way is fine — hiding it is not):
   - (a) Keep role headers hardcoded in the template: then "Add role" must end with an explicit checklist step — "add a heading and `{{CODE}}R1..RN` lines to the CV template Doc" — and ideally a verification (copy template, `readPlaceholders()`, warn if no `{{CODE}}R…` token exists; `src/gdocs.ts:123` already provides the read). Also drop or clearly mark `anchors.dates/titles` as non-rendering metadata.
   - (b) Or make role headers data-driven: add `{{CODE_title}}` / `{{CODE_dates}}` (and heading) token support in `buildSlotMap` fed from `anchors.titles[market]`/`dates`, so a new role needs only generic token lines in the template. Larger change, cleaner product.
3. **Role-centric read queries** (all cheap, no schema change):
   - Role page: `SELECT * FROM blocks WHERE anchor_id = ? AND section='experience' ORDER BY id` (+ projects for project anchors), full text, EN and ES side by side.
   - Skills page grouped by parsed `skcat:` (or better: promote `skcat` to its own column and generate the tag — removes the raw-encoding input).
   - Summary page: `WHERE section='summary'`.
4. **Contextual create**: "Add bullet" under a role pre-fills `section=experience`, `anchor_id=<role>` (the existing `POST /blocks/create` already accepts both — only the UI entry point changes). Validation to add in `normalizeBlockInput`: experience/projects require an anchor; skills require a category; summary/skills reject an anchor.
5. **Approval semantics fixes**:
   - Update must preserve `es_status='approved'` unless `text_es` actually changed (compare before recompute), or decide explicitly that any edit re-drafts *both* languages — either rule is defensible; silence is not.
   - Separate, visible ES approve action (with the ES text on screen), or explicitly declare ES parity as bank-level (the approve-all + sample-CV flow) and remove the per-block ES badge theater.
   - Confirm dialog (at minimum) on approve-all; per-role "approve all bullets of this role" as the natural mid-size unit.
6. **Demote the internals**: fact_key (currently consumer-less), evidence, source behind a collapsed "curation notes" section or out of the form entirely; drop `review` from user-facing filters until something sets it; show `id` only inside edit, never as a leading column.

## 7. One-line answers to the owner's three verdicts

- *"What is that puzzle?"* — 9 flat fields where 3 are never read by any code, 2 are machine encodings that can silently void the block, and the actual bullet text is field 4.
- *"It does not work to its goal."* — It manages rows of a table; the goal is managing a CV. No role view, no full text (none at all on mobile), approvals that appear and vanish as side effects.
- *"I cannot add a role."* — Correct: no anchors write path exists in console or API (verified §2), and even outside the product a new role needs a hand-edited template Doc to ever render.

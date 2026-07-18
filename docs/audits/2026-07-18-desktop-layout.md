# Audit — Console desktop layout: distribute, don't shrink (2026-07-18)

Scope: `src/console/layout.tsx` (single CSS string) and `src/console/app.tsx`
(all page DOM). Goal: inventory what wastes horizontal space at >=1024px, page
by page, and spec a desktop distribution that RELOCATES controls instead of
capping widths. Owner constraint (verbatim intent): no `max-width` page caps
("garbage — a waste of space; I asked relocating/distributing"); phone layout
(mobile-first base rules) must remain untouched. Audit only — no code was
edited; this file is the only artifact created.

All line numbers below refer to the **working copy** as of this audit unless
marked HEAD. Everything was verified by reading the files and running
read-only git commands.

---

## 0. Pending-revert state (document before anything else)

Verified with `git status --short`, `git diff -- src/console/layout.tsx`,
`git branch -vv`, `git show HEAD:src/console/layout.tsx`:

- Branch `main` = `origin/main` = `4b9a77d` ("paginate all console lists at
  30/page + bound tracker + desktop polish"). That pushed commit — and
  therefore the **LIVE deployed site** — still contains the owner-rejected
  centering:
  - HEAD `src/console/layout.tsx:33` → `main { padding:16px; max-width:1040px; margin:0 auto }`
  - HEAD `src/console/layout.tsx:68` → `#secsel { max-width:460px }`
- The **working copy** has an UNCOMMITTED revert (`M src/console/layout.tsx`):
  - working `src/console/layout.tsx:33` → `main { padding:16px }` (cap + centering removed)
  - the `#secsel { max-width:460px }` line is deleted entirely.
- Consequences:
  1. The rejected layout is what is deployed right now; the revert exists only
     on this machine and is one `git checkout --`/fresh clone away from being
     lost.
  2. The revert **alone** makes things worse on one control: with
     `#secsel { max-width:460px }` gone and `.field select { width:100% }`
     (layout.tsx:67) still active, the /blocks section dropdown becomes a
     **viewport-wide select** (~1400px on a 1440px screen). The revert must
     ship together with the distribution below, which bounds that select by
     its layout slot instead of by an arbitrary cap.
  3. The stray `id="secsel"` remains in `app.tsx:970` (used by the `<label for>`)
     — harmless, keep it.

## 1. Baseline facts about the stylesheet (working copy)

- There is exactly **one** breakpoint: `@media (min-width:720px)`
  (layout.tsx:88-102). **No `@media (min-width:1024px)` exists anywhere in
  `src/`** (verified by grep). "Desktop" and "tablet" are currently the same
  layout: single column of full-width stacked `.card`s.
- `.field select, .field input, .field textarea { width:100% }`
  (layout.tsx:65-67) — any `.field` control stretches to the full card width,
  i.e. the full viewport once `main` is uncapped. This is the root generator
  of "one dropdown = one 1400px row".
- `.card { …; margin-bottom:14px }` (layout.tsx:46-47) — cards only ever
  stack vertically; there is no compositional primitive to place two cards
  side by side.
- `.statgrid` at >=720px: `repeat(auto-fit, minmax(150px,1fr))`
  (layout.tsx:97) — with 2-4 stats, `auto-fit`+`1fr` stretches each tile to
  fill the whole row (a 22px number in a ~470-700px tile).
- `.cardgrid` at >=720px: `minmax(240px,1fr)` (layout.tsx:98) — packs well;
  no issue.
- `.kanban`/`.kancol` at >=720px: 5 flex columns, `flex:1 min-width:230px`
  (layout.tsx:100-101) — already distributes; no issue.
- Remaining `max-width`s in the working copy: `max-width:100%` on inputs
  (layout.tsx:63 — correct, prevents overflow) and the inline
  `style="width:100%; max-width:520px"` on every /contact input
  (app.tsx:599 — see §2 Contact).

## 2. Per-page waste inventory at >=1024px (working copy = revert applied)

### Today `/` (app.tsx:205-256)
- `statgrid` (207-211): 3 stats stretch across the full row — oversized tiles,
  but they do fill the row; cosmetic only.
- `cardgrid` (212-220): 8 panel cards auto-fit — fine.
- **Triage cards (223-253): the real waste.** Each job is a full-width `.card`
  whose content is 3 short lines + a button row; on a 1440px screen each card
  is ~60% empty on the right, one job per row.

### Jobs `/jobs` (app.tsx:313-341)
- Filter form `card actions` (315-323): controls already flow in one row;
  the free-text search input has intrinsic width, leaving dead space at the
  right of the row. Minor.
- Table (324-338): full width, correct. Minor duplication: the title cell
  already renders `company · location` as muted subtext (328) AND a separate
  `company` column (`hide-sm`, 329) appears at >=720px — the same string twice
  per row, wasted column width on desktop.

### Job detail `/jobs/:hash` (app.tsx:366-423)
- Five full-width cards stacked. Header, breakdown and description are fine
  full-width. "Similar jobs radar" (405-415) and "History" (416-421) are
  narrow-content cards that each take a full row — pairable side by side.

### Tracker `/tracker` (app.tsx:685-723)
- Kanban already distributes 5 columns across the full width at >=720px.
  No desktop waste. (At 720-1023px it horizontal-scrolls inside `.kanban` —
  by design.)

### Companies `/companies` (app.tsx:442-473)
- Add-company form `card actions` (444-450): one row of intrinsic-width
  inputs; dead space to the right. Minor.
- Table (451-470): 8 columns, full width — fine on desktop. Note: this table
  uses **no** `hide-sm` at all, so on phones it relies entirely on
  `.table-wrap` horizontal scroll (mobile note, not a desktop issue).

### Calibration `/config` (app.tsx:519-557)
- Line 521: a **full-width card containing a single link** ("Contact profile →"
  + a muted span). One row burned for one link.
- Quick-thresholds form (522-528): 4 small numeric inputs + Save in a row
  inside another full-width card; right half empty.
- Scoring JSON card (529-537): `textarea rows=22` at full viewport width —
  JSON lines are ~80 chars; a 1400px-wide monospace box is mostly empty, but
  capping it would be "shrinking". The distribution answer is to give the
  freed width to the History card beside it.
- History card (538-555): a 4-column narrow table taking a full row.

### Contact `/contact` (app.tsx:590-617)
- Fields use ad-hoc inline styles, not `.field` (596-600):
  `style="width:100%; max-width:520px"` — 16 inputs in ONE sequential column
  (CO simple → CO address → CA simple → CA address), so the right ~60% of a
  desktop screen is empty for the whole page height. The two country groups
  are natural side-by-side columns. Also an inconsistency: the only form in
  the console not using the `.field` pattern.

### Week `/week` (app.tsx:787-803)
- 3 stretched stats + one full-width 6-column table. Table is fine; stat
  stretching same cosmetic note as Today. Nothing to relocate.

### Health `/health` (app.tsx:1231-1262)
- 4 stats + a 12-column runs table (full width, correct — `hide-sm` columns
  appear at desktop) + a narrow 3-column events table full-width below.
  Events table is pairable in principle but the runs table needs the width;
  leave stacked. Minor.

### Bank `/blocks` (app.tsx:961-1034) — the owner's pain page
Above the first data table the page stacks, in order:
1. `statgrid` (963-966): **two** stats → each stretches to ~half the viewport;
   two giant tiles for "x/86 approved" and "ES parity".
2. Filter card (967-986): a full-width `.card` whose visible content is ONE
   `.field` select (`#secsel`, width:100% → viewport-wide after the revert)
   plus a collapsed "More filters" `<details>`.
3. Add-block card (987-993): a full-width `<details class="card">` whose
   collapsed content is ONE summary line ("+ Add block").
4. Approve-all card (994-999): a full-width `card actions` with ONE button +
   one muted sentence.

That is ~380-420px of vertical space, ~4 near-empty rows, before any blocks
are visible — matching the owner's complaint exactly. The per-section tables
(1000-1031) themselves are correct at full width.

- Add-block form when opened (`blockFields`, app.tsx:57-88): **nine stacked
  `.field` rows, every control full viewport width** (3 selects, 2 textareas,
  4 text inputs) → a ~800px-tall single column. EN and ES texts — the pair the
  owner most needs to compare for parity — are stacked, not side by side.

### Bank `/blocks/edit` (app.tsx:1059-1096)
- Same `blockFields` single-column problem inside a full-width card.
- Below it, a full-width card (1077-1093) holding just approve/retire +
  delete buttons. Minor.

### CVs `/cvs` (app.tsx:1135-1191)
- Missing-contact warning card: fine (it is an alert).
- Generate-sample form `card actions` (1163-1170): one row, intrinsic widths,
  dead space right. Minor.
- Table: 8 columns full width — fine on desktop (no `hide-sm`; phone scrolls).

## 3. `.hide-sm` pattern — verified correct

- Base: `.hide-sm { display:none }` (layout.tsx:44). At >=720px:
  `.hide-sm { display:table-cell }` (layout.tsx:99).
- All 14 usages in `app.tsx` are on `<th>`/`<td>` only (Jobs 325/329-335,
  Blocks 1004/1008-1012, Health 1240/1246-1249), so `display:table-cell` is
  the right restored value and **desktop (>=720px, hence >=1024px) shows every
  column**. Correct; no change needed.
- Side note (phone, out of scope): Companies (8 cols) and CVs (8 cols) tables
  use no `hide-sm` at all and rely on horizontal scroll on phones.

---

## 4. Proposed desktop distribution (spec — NOT applied)

One new `@media (min-width:1024px)` block appended to the CSS string in
`layout.tsx`, plus four small mobile-inert primitives and minimal DOM wrapper
changes in `app.tsx`. **The existing base rules and the 720px block are not
modified**, so phone rendering is byte-identical except where noted (one 2px
gap delta, called out below). No `max-width` caps anywhere.

### 4.1 CSS additions to `layout.tsx`

Base additions (place near `.statgrid`; inert single-column on phone):

```css
/* controls row: stacks like today's cards on phone; distributes on desktop */
.controls { display:grid; grid-template-columns:1fr; gap:14px; margin-bottom:14px }
.controls > .card { margin-bottom:0 }
```

Desktop block (append at end of the CSS string):

```css
@media (min-width:1024px) {
  /* 1 — control rows: stats, filters, actions side by side; an opened
     panel (add-block form, more-filters) takes the full row */
  .controls { grid-template-columns:repeat(auto-fit, minmax(230px, 1fr)); align-items:stretch }
  .controls > .stat, .controls > .card { height:100% }
  .controls > details[open],
  .controls > .card:has(details[open]) { grid-column:1 / -1 }

  /* 2 — two-column form fields. grid-template-areas keeps the DOM order
     untouched, so phone order is unchanged. EN | ES side by side. */
  .formgrid { display:grid; grid-template-columns:1fr 1fr; column-gap:20px;
    grid-template-areas:
      "f-section f-anchor"
      "f-angle   f-tags"
      "f-en      f-es"
      "f-factkey f-evidence"
      "f-source  f-source" }
  .f-section{grid-area:f-section} .f-anchor{grid-area:f-anchor}
  .f-angle{grid-area:f-angle}     .f-tags{grid-area:f-tags}
  .f-en{grid-area:f-en}           .f-es{grid-area:f-es}
  .f-factkey{grid-area:f-factkey} .f-evidence{grid-area:f-evidence}
  .f-source{grid-area:f-source}

  /* 3 — two-up page sections (cards or plain groups) */
  .cols-2 { display:grid; grid-template-columns:1fr 1fr; gap:14px 24px;
    align-items:start; margin-bottom:14px }
  .cols-2 > .card { margin-bottom:0 }
  .cols-2.main-side { grid-template-columns:3fr 2fr }

  /* 4 — repeated content cards two per row (Today triage) */
  .twoup { display:grid; grid-template-columns:1fr 1fr; gap:14px; margin-bottom:14px }
  .twoup > .card { margin-bottom:0 }

  /* 5 — filter/action bars: free-text inputs absorb the leftover width */
  .filterbar input[type=text] { flex:1 1 240px }
  .grow { flex:1 1 auto }
}
```

Notes on the spec:
- `.cols-2` and `.twoup` have **no base rule**: on phone the wrappers are
  plain blocks and children keep their existing `margin-bottom:14px` — phone
  pixel-identical.
- `:has()` is used once (More-filters opening should widen its host card).
  Single-owner console on a current browser; if unsupported, graceful
  degradation is a squeezed-but-functional panel.
- Known phone delta: on /blocks the two stats move from `statgrid` (gap 12px)
  into `.controls` (gap 14px) → +2px between them on phone. If pixel-exact
  matters, set `.controls { gap:12px }` and accept 12px between cards instead.
  No other phone change.

### 4.2 DOM changes in `app.tsx`, page by page

**Bank `/blocks` (app.tsx:961-999)** — the priority:
- Replace the `statgrid` wrapper + the three consecutive cards with ONE
  `<div class="controls">` containing, in order: the 2 `.stat` divs, the
  section-filter `<form class="card">` (inner content unchanged), the
  `<details class="card">+ Add block`, and the approve-all
  `<div class="card actions">`.
- Result at >=1250px: one ~110px row of 5 slots — [approved stat] [ES stat]
  [Section select] [+ Add block] [Approve all] — instead of ~400px of stacked
  rows. At 1024px it wraps 4+1. The section select is bounded by its ~240px
  grid slot: **the slot replaces the deleted `#secsel` max-width** —
  distribution, not shrinking. Opening "+ Add block" or "More filters"
  expands that item to the full row.

**`blockFields` (app.tsx:57-88)** — fixes both add and edit forms at once:
- Wrap the nine `.field` divs in `<div class="formgrid">` and add one class
  per field div: `f-section f-anchor f-angle f-en f-es f-tags f-factkey
  f-evidence f-source` (e.g. `class="field f-en"`). DOM order untouched.
- Desktop result: 5 rows instead of 9; **Text EN and Text ES side by side**
  (direct parity review); source spans both columns. Phone: identical
  single column.

**Today `/` (app.tsx:223-253)**:
- Wrap the triage `rows.map(...)` output in `<div class="twoup">` (the
  "Triage up to date" card and the pager stay outside). Two job cards per row
  on desktop; phone unchanged. Stats/panel grids unchanged.

**Jobs `/jobs` (app.tsx:315)**:
- Add `filterbar` to the filter form: `class="card actions filterbar"` — the
  title-search input absorbs the row's leftover width.
- Optional (content, not layout): drop the `hide-sm` `company` column
  (app.tsx:325, 329) since the title cell already shows company · location;
  frees table width for the title.

**Job detail `/jobs/:hash` (app.tsx:405-421)**:
- When `similares.length > 0`, wrap the radar card and the History card in
  `<div class="cols-2">`; otherwise render History alone as today (the
  wrapper is conditional exactly like the radar card already is).

**Companies `/companies` (app.tsx:444)**:
- Add `filterbar` to the add-company form so name/token/notes share the
  leftover width. Table unchanged.

**Calibration `/config` (app.tsx:519-557)**:
- Merge the single-link card (521) into the quick-thresholds form card (append
  the link + muted span after the Save button) — removes one near-empty row on
  every viewport. Alternative if the owner prefers zero content moves: wrap
  cards 521+522 in `<div class="controls">`.
- Wrap the scoring-JSON form card and the History card in
  `<div class="cols-2 main-side">` → JSON editor left (3fr), history right
  (2fr). The 22-row textarea keeps full column width (no cap); History stops
  burning a private full row.

**Contact `/contact` (app.tsx:596-614)**:
- Change the local `field()` helper (596-600) to emit the standard pattern:
  `<div class="field"><label>…</label><input type="text" … /></div>`, deleting
  the inline `style="width:100%; max-width:520px"`. On phone the rendered
  width is identical (viewport < 520px); on desktop the input fills its
  column — sized by layout, not by a cap. Also removes the console's only
  non-`.field` form.
- Inside the form, wrap the Colombia group (h2 + its fields) and the Canada
  group in two plain `<div>`s inside `<div class="cols-2">`; the submit button
  stays after the wrapper. Desktop: CO left, CA right; phone: unchanged
  stacking.

**CVs `/cvs` (app.tsx:1163-1170)**:
- Add `filterbar` to the sample form and `class="grow"` to the job
  `<select name="hash">` so the long job titles get the row's spare width.

**Bank `/blocks/edit` (app.tsx:1066-1095)**:
- Inherits `formgrid` automatically. Optional: move the approve/retire/delete
  card above the form into a `.controls` row; not required.

**Tracker, Week, Health**: no DOM changes. Kanban already distributes; the
tables must stay full width; `hide-sm` already restores all columns at
desktop. The stretched `.statgrid` tiles on Today/Week/Health are left as-is
deliberately: capping tile width would leave dead space at the right — the
current stretch IS the distributed behavior, just visually generous.

### 4.3 Ship list

1. Commit the pending `layout.tsx` revert TOGETHER with the new CSS block
   (never the revert alone — see §0 consequence 2).
2. `app.tsx` wrapper/class edits per §4.2 (no logic changes, no route
   changes, no new endpoints).
3. Phone verification: only expected diff is the 2px gap note in §4.1.

---

## 5. Findings ranked

| # | Severity | Finding | Where |
|---|----------|---------|-------|
| 1 | major | Owner-rejected centering (`main max-width:1040px`, `#secsel max-width:460px`) is still LIVE: the revert exists only as an uncommitted local edit on `main`=`origin/main`=4b9a77d; one checkout/clone from being lost | HEAD layout.tsx:33,68; `git status` |
| 2 | major | The revert alone makes /blocks worse: with `#secsel` cap deleted, `.field select{width:100%}` renders a viewport-wide section dropdown; must ship with the controls-row distribution that bounds it by slot | layout.tsx:67; app.tsx:967-974 |
| 3 | major | No desktop breakpoint exists (only 720px); console has no primitive to place two things side by side, so every page is a single column of full-width cards at any width | layout.tsx:88-102 |
| 4 | major | /blocks header: 2 stretched stats + 3 consecutive full-width single-control cards ≈ 400px of near-empty rows before the first block | app.tsx:961-999 |
| 5 | major | `blockFields`: 9 stacked viewport-wide fields on /blocks add and /blocks/edit; EN/ES parity texts not comparable side by side | app.tsx:57-88 |
| 6 | minor | /contact: 16 inputs in one column with inline `max-width:520px` (right ~60% of desktop empty); only non-`.field` form in the console | app.tsx:596-614 |
| 7 | minor | /config: full-width card for a single link + quick form, JSON editor and history each burning a full row | app.tsx:519-557 |
| 8 | minor | Today triage: one short job card per full-width row | app.tsx:223-253 |
| 9 | minor | `statgrid` `auto-fit`+`1fr` stretches 2-4 tiles across the full row (giant tiles); cosmetic, capping would trade it for dead space | layout.tsx:97 |
| 10 | minor | /jobs table shows company twice at desktop (title subtext + `hide-sm` column) | app.tsx:328-329 |
| 11 | minor | Filter/action bars (/jobs, /companies, /cvs) leave dead space right of intrinsic-width inputs | app.tsx:315,444,1163 |
| 12 | info | `.hide-sm` verified correct: all 14 uses are th/td, restored via `display:table-cell` at >=720px — desktop shows every column | layout.tsx:44,99 |

# Audit — Role (anchor) lifecycle: the missing "add a new job" flow

Date: 2026-07-18 · Scope: anchors/blocks/CV-factory/template contract for adding, renaming, and retiring a role (e.g. the owner lands a new job with code `NEW1`). Read-only audit; no code changed. Local D1 state verified: **9 anchors, 86 blocks, all `status='draft'`** (`SELECT` via `wrangler d1 execute seekerware --local`).

Every claim below was verified against the code. Line numbers refer to the working tree at commit `3659c6e`.

---

## 1. The end-to-end contract today (verified)

### 1.1 Adding role `NEW1` requires ALL of the following, in this order

| # | Step | Where | Console path? |
|---|------|-------|---------------|
| A | Create the `anchors` row (`id='NEW1'`, kind, company, dates, titles JSON) | hand-edit gitignored `seeds/seed_blocks.sql` (`.gitignore:6` ignores `seeds/`), then full reseed | **NO** — zero write routes touch `anchors` |
| B | Author `blocks` rows with `anchor_id='NEW1'` | seeds, or console `/blocks/create` **after** step A (dropdown only lists existing anchors) | Yes, but only after A |
| C | Edit the private Google Doc template: paste a **static role header** (company, dates, per-market title — `anchors.titles` is NOT rendered, `docs/DATABASE.md:160`) plus the tokens `{{NEW1R1}}…{{NEW1RN}}`, choosing N by hand; possibly delete/displace an old role's static section to keep one page | Google Docs, manually | **NO** — and no check that C matches A/B |
| D | Approve the new blocks | console `/blocks` approve / approve-all (`src/console/app.tsx:1037`, `1052`) | Yes |

Evidence for "no console path to anchors":
- Full route table `src/console/app.tsx:124–1267`: `/blocks*`, `/cvs*`, `/companies*`, `/config*`, etc. — **no** `/anchors` or `/blocks/anchors` route of any method.
- The only two readers of `anchors` in `src/`: `fetchAnchors` (`src/console/app.tsx:53–54`, feeds the block form dropdown) and `SELECT id FROM anchors` (`src/ia/cv_factory.ts:114`, roleCodes). No `INSERT/UPDATE/DELETE INTO anchors` exists anywhere in `src/`.
- `docs/UI.md:62` explicitly: "Anchors registry + `suggested` queue = **future**".
- The planned page `/blocks/anchors` appears only in the UX design audit (`docs/audits/2026-07-17-diseno-consola-ux.md:53,293`), never built.

### 1.2 The reseed that step A forces is DESTRUCTIVE

`seeds/seed_blocks.sql:3–5`:

```sql
-- Full reseed: DELETE then re-INSERT so renamed anchors (role codes) replace cleanly.
DELETE FROM blocks;
DELETE FROM anchors;
```

Consequences (all verified against the seed file and console routes):
- Any block the owner authored via `/blocks/create` (`src/console/app.tsx:1098–1111`) that is not also copied into the seed file is **permanently destroyed** by a reseed.
- Every status transition made in the console — approve (`:1037`), retire (`:1045`), approve-all (`:1052`), text edits (`:1113`) — is reset to the seed's hardcoded `'draft'` values. Governance state lives only in D1; the seed cannot round-trip it.
- The `DELETE FROM blocks` before `DELETE FROM anchors` is required because `blocks.anchor_id REFERENCES anchors(id)` (`migrations/0001_initial.sql:54`) and D1 enforces foreign keys — i.e. the FK is satisfied only by nuking the whole bank.

So today, **the only supported way to add/rename/retire a role wipes the bank's console-side state.** This is the root cause behind the owner's "terrible awful tool" verdict: the Bank page can polish phrasings but cannot perform the single most common life event (a new job) without out-of-band surgery and data loss.

### 1.3 Renaming a role (e.g. `BNS1` → `SCOT1`)

Acknowledged workflow in the seed comment (`seeds/seed_blocks.sql:3`). Requires simultaneously:
1. seed: new `anchors.id` + every block's `anchor_id` rewritten;
2. full destructive reseed (§1.2);
3. owner manually rewrites every `{{BNS1Rn}}` token to `{{SCOT1Rn}}` in the template.

If (3) lags, every subsequent CV **silently loses all bullets for that role** (failure modes 2+1 in §3). Historical `cvs.blocks_used` JSON (`src/ia/cv_factory.ts:158`) still references the old block ids with no mapping.

### 1.4 Retiring a role

There is **no representation of a retired role**: `anchors` has no status column (`migrations/0001_initial.sql:42–48`). Options today:
- Leave the row: it stays forever in the block-form dropdown (`src/console/app.tsx:67`) and in `roleCodes` (`src/ia/cv_factory.ts:114`); retire its blocks one by one (`/blocks/retire`, `:1045`) — there is **no bulk retire-by-anchor** (approve-all exists, retire-all does not); manually delete the template section.
- Remove it from seeds + reseed: destroys bank state (§1.2).

### 1.5 The two-sided contract (bank ↔ template), stated precisely

The template is "the source of truth for structure" (`docs/TRD.md:142–143`); the bank is the source of truth for content. The render only intersects them:

- `readPlaceholders` (`src/gdocs.ts:123–133`) reads the **copy** of the template and extracts `{{...}}` names (regex `/\{\{\s*([^{}]+?)\s*\}\}/g`, `gdocs.ts:131`).
- `buildSlotMap` (`src/ia/cv_factory.ts:187–228`) iterates **only over tokens present in the template** (`:213`) and resolves them; anything on either side of the intersection is dropped or blanked **with no warning, no log, no return-value signal** (`FactoryResult`, `cv_factory.ts:52–60`, has no field for unplaced selections).
- Nothing anywhere compares `anchors` ids against template tokens. The check is technically trivial (see §4) but absent.

---

## 2. Verified behavior of each layer for a new role

### 2.1 `cv_selector` — new bullets are selectable immediately, template be damned

- Catalog = `blocks` filtered by status only (`src/ia/cv_factory.ts:85–91`); sample mode admits drafts.
- The response-schema enum is built per section from catalog block ids (`src/ia/agents.ts:68–69`, `87–90`). **No join with `anchors`, no knowledge of the template.**
- Therefore `NEW1` bullets enter the enum the moment the blocks exist (draft in sample mode, approved in real mode), even with **no anchors row and no template tokens**. They consume up to 24 experience picks (`agents.ts:89`) and are fed to the verifier (`verifierText`, `cv_factory.ts:231–238`) — yet may be 100 % unplaceable.
- The selector's instruction actively promises the opposite: "the render places them under the right role" (`agents.ts:79–80`).

### 2.2 `buildSlotMap` — the three probed scenarios

(a) **Template lacks `{{NEW1R*}}` tokens.** Selected `NEW1` bullets are grouped into `expByRole` (`cv_factory.ts:197–202`) but never consumed, because the loop iterates template tokens only (`:213`). Silently unplaced. The CV omits the role entirely (its static header doesn't exist either), while `cvs.blocks_used` (`:158`) records the bullets as if used — a **lying audit trail**.

(b) **Template has `{{NEW1R1}}` but no `anchors` row.** The regex matches (`:220`), `roleCodes.includes('NEW1')` is false (`:221`), control falls to `map[full] = ''` (`:225`). The token is silently blanked, leaving the static role header in the doc **with zero bullets under it** — a visibly broken CV with no error anywhere.

(c) **Regex probes** — `/^(.+)R(\d+)$/` (`cv_factory.ts:220`), verified by execution:

| Token | Match | Meaning |
|-------|-------|---------|
| `BAR1` | `['BA','1']` | a bare role code ending in R+digit parses as **another role's slot**: if role `BA` exists, `{{BAR1}}` is filled with BA's 1st bullet — the only failure mode producing WRONG text instead of blank |
| `BAR11` | `['BA','11']` | role code `BAR1` can never receive a token missing the `R` separator; if `BA` and `BAR1` coexist, `{{BAR11}}` always means BA slot 11 |
| `BAR1R1` | `['BAR1','1']` | greedy split is at the **last** `R` preceding the trailing digit run — deterministic and correct when the code exists |
| `R2D2` | no match | falls to unrecognized → `''` |
| `R2D2R1` | `['R2D2','1']` | codes with interior `R<digit>` work fine |
| `R1` | no match | `(.+)` needs ≥1 char before `R` — see NULL-anchor trap below |
| `BNSR2` | `['BNS','2']` | if codes `BNS` and `BNSR2` both existed, the bare code `BNSR2` as a token = BNS slot 2 (code-namespace collision) |
| `skills_techR1` | (shadowed) | `^skills_(.+)$` is tested **first** (`:218`), so any role code starting `skills_` (likewise `sum_<digits>`, `phone`, `location` — `:215–217`) is unplaceable |
| `BNS1 R1` (inner space) | `m[1]='BNS1 '` | trailing space ≠ role code → `''`; `readPlaceholders` trims only the outer edges (`gdocs.ts:131`) |
| `bns1R1` | `includes()` is case-sensitive | `''` silently; `replaceAllText` is also `matchCase: true` (`gdocs.ts:95`) |

Because the split point is unique (last `R` before the trailing digit run), the regex itself is deterministic; **ambiguity enters only through code naming**, so the guard is a naming rule, not a regex fix (§4).

- **NULL-anchor trap:** an experience block with `anchor_id NULL` groups under key `''` (`cv_factory.ts:198`), reachable only by a token `R<N>` — which can never match. The console form permits NULL anchor for experience (`src/console/blocks-form.ts:46`; the label at `app.tsx:64` says "experience & projects only" but nothing enforces non-null), and the selector can pick such blocks (§2.1). They are always silently dropped.

- **Projects are selected but never rendered:** `selection.projects` (up to 2, `agents.ts:90`) is consumed nowhere — `buildSlotMap` handles only summary/skills/experience (`cv_factory.ts:197–226`), `verifierText` also omits projects (`:231–238`). Documented as v1-static (`docs/TRD.md:167–168`), but the tokens are still spent and `blocks_used` records projects as "used". Project anchors (`prj-*`) also sit in `roleCodes` (`:114` has no `kind='role'` filter), harmless today but part of the code namespace for collisions.

- Test coverage confirms the silent-blank semantics as *intended* (`test/cv_factory.test.ts:48–57`: unknown tokens and unselected roles → `''`), but no test covers scenarios (a)/(b)/(c) above — the tests never probe a selected-but-unplaceable bullet or a tricky code.

### 2.3 Console exposure of the anchor link

- `GET /blocks`: anchor shown as a plain text column (`src/console/app.tsx:1008`, hidden on mobile via `hide-sm`); anchor filter options come from `SELECT DISTINCT anchor_id FROM blocks` (`:927–930`) — an anchor with **zero blocks is invisible** in filters (a freshly added `NEW1` looks nonexistent until its first block links).
- Add/edit forms: dropdown of all anchors labeled `id — company (kind)` (`:64–68`). `anchors.company/dates/titles` are otherwise displayed **nowhere**; `docs/DATABASE.md:157–160` claims they are "render metadata (console display)" — dead columns in practice.
- `normalizeBlockInput` (`src/console/blocks-form.ts:33–56`) does not validate `anchor_id` against `anchors`; a forged POST with an unknown code is caught only by the D1 FK, surfaced as a raw DB error in the flash message (`app.tsx:1107–1108`). The dropdown prevents this in normal use.

---

## 3. Findings ranked

### Critical

1. **No console path to create/rename/retire a role; the only path (seed reseed) destroys console-authored blocks and all approval state.** `seeds/seed_blocks.sql:4–5` (`DELETE FROM blocks; DELETE FROM anchors;`), `.gitignore:6`, route table `src/console/app.tsx:124–1267` (no anchors route), `docs/UI.md:62` ("future"). The bank's core life event — the owner gets a new job — cannot be performed by the tool that exists for the bank.

2. **Two-sided bank↔template contract is enforced nowhere; both breach directions fail silently in produced CVs.** (a) role in bank, tokens missing → bullets silently unplaced, `blocks_used` records them as used (`src/ia/cv_factory.ts:213–226`, `:158`); (b) tokens in template, role missing/renamed in `anchors` → tokens silently blanked leaving an empty role section under its static header (`:221`, `:225`). A rename that forgets the template erases a whole role from every future CV with zero signal.

### Major

3. **`cv_selector` selects bullets the render cannot place** — enum is blocks-only (`src/ia/agents.ts:87–90`), no anchors/template awareness; instruction promises placement (`:79–80`); up to 24 experience picks and 2 Gemini calls partially wasted; verifier reviews content the CV won't contain (`src/ia/cv_factory.ts:117`, `:231–238`).

4. **Role-code namespace has undetected collision classes**: codes ending in `R\d+` (bare `{{BAR1}}` fills role `BA` slot 1 — wrong-content, not blank), codes equal to `otherCode + 'R' + digits` (`BNSR2` ≡ BNS slot 2), codes starting `sum_`/`skills_` or equal to `phone`/`location` (shadowed by earlier checks, `src/ia/cv_factory.ts:215–219`). No format validation exists at any writer (seeds are freehand SQL; no console writer at all).

5. **Experience blocks with NULL `anchor_id` are selectable but permanently unplaceable** (token `R<N>` cannot match `^(.+)R(\d+)$`); the form does not require an anchor for the experience section (`src/console/blocks-form.ts:44–55`, `src/console/app.tsx:64`).

6. **Renaming a role breaks silently at three loosely coupled sites** (seed anchors id, every `blocks.anchor_id`, every template token) with no transactional or checking mechanism; historical `cvs.blocks_used` keeps orphaned ids (`src/ia/cv_factory.ts:158`).

### Minor

7. **No retire semantics for anchors** — no status column (`migrations/0001_initial.sql:42–48`); retired roles pollute the dropdown and `roleCodes` forever, or require the destructive reseed. No bulk retire-blocks-by-anchor either (`src/console/app.tsx:1045` is per-block; `:1052` is approve-only).
8. **Anchors with zero blocks are invisible in `/blocks` filters** (`src/console/app.tsx:927–930` derives options from `blocks`, not `anchors`).
9. **`selection.projects` is dead weight** (selected, persisted as "used", never rendered) — documented v1-static but still misleading (`src/ia/agents.ts:90`, `src/ia/cv_factory.ts:158`, `docs/TRD.md:167–168`).
10. **`anchors.company/dates/titles` render nowhere** except the dropdown label (`src/console/app.tsx:67`), contradicting `docs/DATABASE.md:157–160` ("console display"). Owner cannot even *view* a role's registered dates/titles in the console.
11. **Case/whitespace token fragility**: `roleCodes.includes()` and `replaceAllText` are case-sensitive (`src/ia/cv_factory.ts:221`, `src/gdocs.ts:95`); inner whitespace in a token defeats the role match (only outer trim, `src/gdocs.ts:131`). Typos in the Doc → silent blanks.
12. **Tests bless the silent behavior without probing the sharp edges** (`test/cv_factory.test.ts:48–57`): no test for an unplaceable selected bullet, an unknown role token, or a collision-prone code.

---

## 4. Guardrails a console "Add role" flow needs (design, no code)

1. **Code format validation at the single entry point** (the new form):
   - allowed shape e.g. `^[A-Z][A-Z0-9]{1,7}$` (uppercase, no spaces, no `_`);
   - reject codes matching `/R\d+$/` (kills the `BAR1` wrong-fill class);
   - reject codes where `existing + 'R' + digits === new` or `new + 'R' + digits === existing` (kills `BNS`/`BNSR2` class);
   - reject reserved prefixes/names: `sum_`, `skills_`, `phone`, `location` (shadowed by `src/ia/cv_factory.ts:215–219`);
   - uniqueness against `anchors.id` with a friendly message (PK already enforces it).

2. **Direct D1 writes, seeds demoted to bootstrap-only.** `INSERT INTO anchors` from the console ends the destructive-reseed era; the seed file stops being the role CRUD path (its `DELETE FROM blocks` at `seeds/seed_blocks.sql:4` should never again be the price of a new job).

3. **Template-check button** ("does my Doc match my bank?"): `googleAccessToken` + `readPlaceholders(env.CV_TEMPLATE_DOC_ID)` — a read-only `documents.get` directly on the template, **no copy needed** (today `readPlaceholders` runs only mid-generation on the copy, `src/ia/cv_factory.ts:137`). Diff report:
   - anchors with blocks but zero `{{CODE}}R*` tokens (breach (a));
   - tokens whose parsed code is in no `anchors` row (breach (b)) — including the greedy-parse view so `{{BAR1}}`-style traps are shown as "fills role BA";
   - per-role slot count in template vs approved-bullet count in bank;
   - `{{skills_<cat>}}` tokens vs distinct `skcat:` tags; `{{sum_N}}` max vs summary bank size;
   - malformed/unrecognized tokens (case, inner spaces, stray names).
   Run it as a gate inside Add/Rename/Retire flows and as a standalone Health check.

4. **Make the render's drops visible.** `generateCv` should return (and the console/flash surface) the ids selected but not consumed by any token, and the tokens blanked for want of a role/block — turning failure modes 1–3 of §3 from silent to observed. `blocks_used` should record only what was actually placed (or record placed/unplaced separately).

5. **Rename flow** = one transaction (`UPDATE anchors SET id` + `UPDATE blocks SET anchor_id`) + a blocking template-check that refuses to finish while `{{OLD*}}` tokens remain in the Doc.

6. **Retire flow** = new `anchors.status` (or `retired_at`) column so retired roles leave the form dropdown and `roleCodes` while preserving FK integrity and history; plus bulk "retire all blocks of this role".

7. **Require `anchor_id` for experience blocks** in `normalizeBlockInput` (closes the NULL-anchor unplaceable class), and validate the posted `anchor_id` against `anchors` before hitting the FK.

8. **Filter `roleCodes` to `kind='role'`** (`src/ia/cv_factory.ts:114`) once project rendering lands, so project ids stay out of the responsibility-token namespace.

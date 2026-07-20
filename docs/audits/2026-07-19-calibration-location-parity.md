# Audit — Calibration/scoring: location EN/ES parity + /config legend clarity

Date: 2026-07-19
Scope: read-only audit of the CALIBRATION/scoring subsystem.
Question set: (2a) why `location` has no EN/ES parity; (2b) legend wording on `/config`.
Files audited (unmodified): `src/scoring.ts`, `src/console/matrix.ts`, `src/config-store.ts`,
`src/console/app.tsx` (the `/config` GET render), `seeds/seed_config.sql`,
`test/matrix.test.ts`, `docs/CONVENTIONS.md`.

---

## Facts (file:line)

### Two different storage/matching mechanisms

**Keyword categories** (`domain`, `role_type`, `tool_overlap`, `level_fit`) — scored:
- The engine's `Category` type is EXACTLY those four; `location` is NOT a scoring
  category — `src/scoring.ts:6-7`.
- A keyword is `{ term, weight, lang?, pair? }` — `src/scoring.ts:9-17`. `lang`
  is display-only ("Matching ignores it." `src/scoring.ts:13`); `pair` links the
  EN/ES twins ("Matching ignores it." `src/scoring.ts:15`).
- Matching: `scoreCategory` iterates `cfg.keywords[cat]` and tests
  `matchesIn(kw.term, corpus.title/text)`; `kw.lang` is never referenced in
  matching — `src/scoring.ts:148-178` (loop 165-172).
- EN/ES parity is achieved by storing TWO entries per concept (an EN entry and a
  separate ES entry with `lang:'es'`, sharing a `pair` id). Example in the live
  seed: `payments`/`pagos` — `seeds/seed_config.sql:31-41`.

**Location** — NOT scored; it is the per-track GATE:
- `location` exists only at the matrix/display layer:
  `MatrixCategory = Category | 'location'` — `src/console/matrix.ts:9`; and it is
  rendered first — `src/console/matrix.ts:11`.
- A `Gate` is `{ id, type, points?, require?: string[], reject?: string[], scope? }`
  — `src/scoring.ts:19-30`. Gate lists are **plain `string[]`**: NO `lang`, NO
  `pair`, NO `weight`.
- Location terms live in `tracks[].gates[].require/reject` with `scope:'location'`:
  `location_canada` require — `seeds/seed_config.sql:1119-1136`; `location_latam`
  — `:1159-1176`; `remote_required` — `:1213-1226`; `reject_restricted_remote`
  reject — `:1228-1272`.
- Gate matching: `evaluateGate` tests `require`/`reject` strings against
  `corpus[scope]` and returns a hard fail / point penalty — it is absolute, not
  scored — `src/scoring.ts:180-206`. `corpus.location = normalizeText(job.location)`
  — `src/scoring.ts:136-146`.
- Matching is accent- and case-insensitive because `normalizeText` strips
  diacritics + lowercases before the regex — `src/scoring.ts:95-98`, `113-127`.
  So `bogotá` == `bogota` at match time regardless of the stored spelling.

### How the matrix projects location into the EN/ES grid

- Language/pairing for GATE terms is NOT stored on the gate; it lives in a
  separate console-only object `MatrixMeta { gate_langs, gate_pairs }` —
  `src/console/matrix.ts:18-25` ("Gate lists stay plain string[] … cosmetic"
  `:13-17`).
- `buildMatrix` gate-only branch: title-scope gates → Role-titles row; everything
  else (location/text scope) → Location row. A gate term's column-language comes
  from `meta.gate_langs[term]`, DEFAULTING to `'en'` — `src/console/matrix.ts:129-138`
  (`lang: meta.gate_langs[term] === 'es' ? 'es' : 'en'`, `:133`).
- Keyword chips instead take their language from the stored `k.lang` and mirror a
  single-entry pair into both columns — `src/console/matrix.ts:105-125`.
- **The seed never populates `matrix_meta`.** `seed_config.sql` inserts only
  `FRESHNESS_MAX_DAYS` and `scoring` — `seeds/seed_config.sql:4-5`. A repo-wide
  grep for `matrix_meta`/`gate_langs`/`gate_pairs` hits only `app.tsx`,
  `matrix.ts`, and `test/matrix.test.ts` — no seed, no migration writes it.
  → At runtime `gate_langs` is empty, so EVERY seeded location gate term renders
  as `lang:'en'`, and both "· Español" Location cells render "none".
- Confirmed by tests: with `emptyMeta()` the Location row's terms
  (`canada`, `colombia`, `remote`, `us only`, `emea`) all land in `favor_en` /
  `against_en` — `test/matrix.test.ts:84-90`; only an explicit
  `gate_langs:{colombia:'es'}` moves a term to the ES column — `:104-109`.
- The ADD path DOES support a Spanish twin for location: `applyWordAdd`'s
  `location` branch pushes both `en` and `es` into the same gate list and sets
  `gate_pairs[en]=en`, `gate_pairs[es]=en`, `gate_langs[es]='es'` —
  `src/console/matrix.ts:198-211`; test `:177-190`. So words added via the console
  WOULD appear in the ES column; the SEED words do not, because they were written
  as raw gate JSON with no meta.

### Language mismatches already present in the seeded gate lists

Because all gate terms default to the English column, genuinely-Spanish gate
terms currently render under "· English":
- `remoto` in `remote_required.require` — `seeds/seed_config.sql:1218`.
- `indefinido` and `tiempo completo` in `permanent_signal.require` —
  `seeds/seed_config.sql:1203,1205`.
The Location row is also a grab-bag: `permanent_signal` (`scope:text`, `:1195-1206`),
`reject_us_only` work-authorization phrases (`scope:text`, `:1178-1193`) and
`contractor_signal` (`scope:text`, `:1274-1285`) are NOT places at all, yet they
project into the Location row because they are non-title gates
(`src/console/matrix.ts:131`).

### The /config legends under audit

- 4 columns: "In favor · English", "In favor · Español", "Against · English",
  "Against · Español" — `src/console/app.tsx:611-615`. Same layout applied to the
  Location row — `:617-625`, label `['Location','where I can work']` `:494`.
- Weight legend (contains the sentence the owner flagged) —
  `src/console/app.tsx:629-633`:
  > "Weight: **+3** strong · **+2** medium · **+1** light · **−2** against ·
  > **−3** strongly against — ✕ removes a word in BOTH languages; adding happens
  > in ONE place, below."
- Path legend — `src/console/app.tsx:634-638`:
  > "**Path** — the track a word unlocks (or, on an against word, blocks): [badges]
  > · no badge = scores every track · path words are gates: absolute, not points
  > (−N = penalty)"
- Add-form helper — `src/console/app.tsx:672`:
  > "Location words REQUIRE a path (they are the track gates; weight does not
  > apply there)."
- Terminology is fixed by the glossary: `track` (`docs/CONVENTIONS.md:18`),
  `gate` (`:19`), `path` = "the track a matrix word unlocks (require) or blocks
  (reject) via its gate membership; badge on the chip" (`:54`). Any wording change
  must keep these three terms.

---

## Diagnosis

**The hypothesis is CONFIRMED.** `location` is not a scored keyword — it is the
per-track GATE. Location gate terms are plain strings matched against the job's
location (or full text) to hard-eliminate or penalize a track
(`src/scoring.ts:180-206`), never to add points. They carry no `weight`, no `lang`,
no `pair`. Matching is language- and accent-agnostic (`normalizeText`,
`src/scoring.ts:95-98`), and place names are largely language-neutral
(`canada`, `bogota`, `vancouver`, `remote`), so the "every word in both languages"
rule is essentially vacuous for them: the English and Spanish forms are the same
token, and diacritics are stripped anyway.

So the non-parity is **correct-by-design at the engine level, but a real UX gap at
the display level**:

1. **Correct by design:** location is a gate; parity via EN/ES twins is a
   *keyword-scoring* device and does not need to exist for place-name gates.
2. **UX gap #1 (misleading grid):** the 4-column "· English / · Español" header
   (`app.tsx:611-615`) is applied verbatim to the Location row, implying it should
   mirror EN/ES like the keyword rows. It cannot in practice — the seed never
   populates `matrix_meta` (`seed_config.sql:4-5`), so `gate_langs` is empty and
   every location term defaults to the English column
   (`matrix.ts:133`), leaving both Location "· Español" cells showing "none".
3. **UX gap #2 (genuine mislabels):** the few Spanish terms that ARE in gate lists
   (`remoto` `:1218`, `indefinido` `:1203`, `tiempo completo` `:1205`) render under
   "· English", which is simply wrong on the screen (harmless to scoring).
4. **UX gap #3 (row is a grab-bag):** non-place, text-scope gate terms
   (work-auth phrases, permanent/contractor signals) land in the Location row
   (`matrix.ts:131`), so "Location / where I can work" over-promises what the row
   contains.

**Bottom line:** the "every word in both languages" rule genuinely applies to the
four keyword categories, NOT to location. The UI wrongly implies location should
have EN/ES parity. This is a wording/labeling fix, not a scoring bug — the engine
is behaving correctly and must not change (domain rule 2: gates own verdicts).

---

## Proposed legend wording (for owner approval — NOT implemented)

### A. Weight legend — replace `app.tsx:629-633`

Current:
> Weight: +3 strong · +2 medium · +1 light · −2 against · −3 strongly against — ✕
> removes a word in BOTH languages; adding happens in ONE place, below.

Proposed (splits the three jammed-together ideas into plain sentences):
> **How much a word counts** — **+3** strong · **+2** medium · **+1** light (in
> favor); **−2** / **−3** (against).
> **✕** deletes a word in both its English and Spanish forms at once.
> To add a word, use the single **Add word** form below — you don't type into the
> cells.

### B. Path legend — replace `app.tsx:634-638`

Current:
> Path — the track a word unlocks (or, on an against word, blocks): [badges] · no
> badge = scores every track · path words are gates: absolute, not points (−N =
> penalty)

Proposed (keeps glossary terms track/gate/path; separates "counts as points" from
"is a pass/fail rule"):
> **Path badge** — which track a word belongs to: [badges].
> No badge = the word adds points in every track.
> A word WITH a badge is a track *gate*, not a points word: it decides pass/fail
> for that track (a **−N** badge means it subtracts N points instead of failing).

### C. Location EN/ES clarity — the fix for question (2a)

The confusion is that the grid implies location needs both languages. Add one line
(new small note under the matrix, or fold into the Location row's sub-label
`app.tsx:494`). Proposed note:
> **Location** words are place names and work-region rules (Canada, Bogotá,
> "remote", "US only"). They usually read the same in English and Spanish, so most
> sit in the English column — that's expected, not a missing translation. Add a
> Spanish form only when the place is actually written differently.

Optional row-sublabel tweak (`app.tsx:494`), from
`location: ['Location', 'where I can work']` to e.g.
`['Location', 'where I can work — place & region rules']` so the row's grab-bag
contents (work-auth / permanent / contractor signals) are less surprising.

---

## Options (NO implementation — owner decides)

- **Option 0 — Do nothing to code; document only.** Accept location non-parity as
  correct-by-design and rely on this audit. Lowest risk; the misleading grid
  remains.
- **Option 1 — Wording only (recommended, lowest-risk).** Apply A + B + C legend
  text. No engine, config, or data change; zero scoring risk. Directly answers the
  owner's "confusing / low-value" complaint and explains the empty Español
  location cells.
- **Option 2 — Wording + fix the mislabeled Spanish gate terms.** Option 1 plus
  seed a `matrix_meta.gate_langs` for the handful of Spanish gate terms already in
  the lists (`remoto`, `indefinido`, `tiempo completo`) so they render in the
  "· Español" column. Cosmetic only (meta is display-only, `matrix.ts:13-17`);
  requires writing the `matrix_meta` config key, which is currently never seeded.
- **Option 3 — Collapse the Location row to a single language pair of columns.**
  Render Location with one "In favor / Against" pair instead of four EN/ES cells
  (special-case the Location row in `app.tsx:617-625`). Best matches reality
  (place names are language-neutral) but is a larger view change and diverges from
  the uniform grid; more design/QA.
- **Option 4 — Split the Location row.** Separate true place gates (`scope:location`)
  from non-place text-scope gates (work-auth / permanent / contractor). Clearer
  semantics but the biggest change to `buildMatrix` projection and the labels;
  highest effort, deferrable.

Recommendation: **Option 1** now (pure wording), consider **Option 2** as a cheap
follow-up. Do NOT touch `src/scoring.ts` or gate matching — the engine is correct.

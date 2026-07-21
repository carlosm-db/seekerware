# Audit 2026-07-20 — Notification thresholds in scoring + the `canada_coop` threshold override

Agent A. READ-ONLY audit of code AS-IS. No fix proposed. All claims cite `file:line`
with verbatim excerpts. The code (and the D1 config it loads) is the source of truth.

## TL;DR

- Thresholds are a two-tier structure: ONE global `thresholds.{apply,stretch}` on
  `ScoringConfig`, PLUS an OPTIONAL per-track `TrackConfig.thresholds.{apply,stretch}`
  that, when present, overrides the global for that track only.
- The `canada_coop` override exists ONLY as bootstrap seed data in
  `seeds/seed_config.sql:756-759` (`apply:60, stretch:35`). It is NOT in any migration
  and is NOT hardcoded in a default object anywhere in `src/`. At runtime the value is
  whatever lives in the D1 `config` row `key='scoring'` (seeded from this file, then
  round-tripped by console saves).
- IMPORTANT — the task's premise is inverted vs. the code. In the repo seed the GLOBAL
  apply is **75** (`seed_config.sql:25-28`), and `canada_coop`'s override is **60**, i.e.
  a LOWER (more permissive) bar than the other two tracks, which have no override and use
  the global 75. There is no ">= 60 global". `60` IS the canada_coop override; removing it
  makes canada_coop STRICTER (75), not the reverse.
- Calibration gap CONFIRMED: the Calibration UI edits ONLY the global thresholds
  (`app.tsx:931-932` render, `app.tsx:1162` write). Per-track `track.thresholds` is never
  rendered or editable in the console, yet it silently overrides the global at scoring time
  (`scoring.ts:244`). So the owner cannot see or change `canada_coop`'s 60/35 from the UI.

---

## 1. ScoringConfig shape — how thresholds are represented

Two levels. Global on the config, optional per-track override.

Global (`src/scoring.ts:42-56`):

```ts
export interface ScoringConfig {
  weights: Record<Category, { weight: number; saturation: number }>;
  title_multiplier: number;
  thresholds: { apply: number; stretch: number };   // ← single GLOBAL threshold
  keywords: Record<Category, Keyword[]>;
  ...
  tracks: TrackConfig[];
  version?: number;
}
```

Per-track override (`src/scoring.ts:35-40`):

```ts
export interface TrackConfig {
  id: string;
  gates: Gate[];
  /** Track-specific thresholds (optional); if missing, the global ones apply. */
  thresholds?: { apply: number; stretch: number };   // ← OPTIONAL per-track OVERRIDE
}
```

Exact keys: global `thresholds.apply`, `thresholds.stretch`; per-track (optional)
`tracks[i].thresholds.apply`, `tracks[i].thresholds.stretch`. Both are plain numbers.
Validation only checks the GLOBAL pair (`config-store.ts:99-102`,
`apply > stretch` required); per-track `thresholds` is NOT validated at all — the
normalizer preserves it verbatim via the `...t` spread (`config-store.ts:53-63`), so any
per-track values pass through untouched.

## 2. Where EXACTLY the canada_coop threshold override is defined

Answer: **(b) bootstrap SEED file only** — `seeds/seed_config.sql`, inside the JSON blob
that is INSERTed into the D1 `config` row `key='scoring'`. It is NOT a migration and NOT a
hardcoded default object in `src/`.

Track id (`seeds/seed_config.sql:672-674`):

```
  "tracks": [
    {
      "id": "canada_coop",
```

Override value (`seeds/seed_config.sql:756-759`):

```
      "thresholds": {
        "apply": 60,
        "stretch": 35
      }
```

Global thresholds in the same blob (`seeds/seed_config.sql:25-28`):

```
  "thresholds": {
    "apply": 75,
    "stretch": 55
  },
```

The other two tracks carry NO `thresholds` key, so they fall back to the global 75/55:
- `colombia_perm` — track spans `seed_config.sql:761-883`; ends at line 882 (`}`) with no
  `thresholds`.
- `contractor_usd` — track spans `seed_config.sql:884-1110`; ends at line 1109 (`}`) with
  no `thresholds`.

Evidence it is seed-only, not migration or code default:
- The insert lives only in the seed. `seed_config.sql:1-3`: `-- Seed (bootstrap-only;
  NEVER hand-edit the live DB with this): scoring config …`, and
  `seed_config.sql:5`: `INSERT OR REPLACE INTO config (key, value) VALUES ('scoring', '{`.
- No migration seeds `scoring`. `migrations/0001_initial.sql:53` only creates the table
  (`CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL);`) and
  `migrations/0001_initial.sql:136-139` seeds only `quota_limits`, `observability`,
  `poll_page_size` (`INSERT OR IGNORE`). No `scoring`, no `thresholds`. (Grep for
  `scoring|thresholds|INSERT.*config` across `migrations/` returns only these lines.)
- No default `ScoringConfig` object exists in code. `loadScoringConfig`
  (`config-store.ts:9-23`) reads the row and THROWS if absent —
  `config-store.ts:14`: `throw new Error("config 'scoring' does not exist in D1 — apply
  the seed (seeds/seed_config.sql)")`. There is no in-code fallback config.

Runtime caveat (matters for "source of truth"): the LIVE value is the D1 row, not the
seed file. `seed_config.sql:1` explicitly warns it is bootstrap-only, and CLAUDE.md §9
step 2 notes calibration edits apply live in operation. So the live `canada_coop.apply`
could differ from 60 if it was edited — but it can ONLY have been edited by hand-writing
the D1 JSON, because (see §4) the console cannot touch per-track thresholds. Every console
save round-trips (preserves) whatever per-track `thresholds` are already in the row
(`config-store.ts:53-63` `...t` spread), so a console save never removes or changes them.

## 3. How scoreJob() applies thresholds per track → verdict → notify

Path: `scoreJob` computes one core `score` (0-100), then per track computes a verdict using
that track's own threshold (override if present, else global), picks the best track's
verdict, and the pipeline notifies iff the best verdict is not `Skip`.

Core score (`src/scoring.ts:234`):

```ts
const score = Math.round(CATEGORIES.reduce((acc, c) => acc + breakdown[c].points, 0));
```

Per-track verdict — the override-vs-global selection is HERE (`src/scoring.ts:237-246`):

```ts
for (const track of config.tracks) {
  const gates = track.gates.map((g) => evaluateGate(g, corpus));
  const hardFailed = gates.some((g) => !g.passed);
  tracks[track.id] = {
    gates,
    hard_failed: hardFailed,
    adjusted_score: score,
    verdict: hardFailed ? 'Skip' : verdictFor(score, track.thresholds ?? config.thresholds),
  };
}
```

Line 244 is the crux: `track.thresholds ?? config.thresholds`. For `canada_coop` this
resolves to the override `{apply:60, stretch:35}`; for `colombia_perm` / `contractor_usd`
it resolves to the global `{apply:75, stretch:55}`.

Threshold → verdict (`src/scoring.ts:209-213`):

```ts
function verdictFor(score: number, thresholds: ScoringConfig['thresholds']): Verdict {
  if (score >= thresholds.apply) return 'Apply';
  if (score >= thresholds.stretch) return 'Stretch-worth-it';
  return 'Skip';
}
```

So for `canada_coop`: `score >= 60 → Apply`, `>= 35 → Stretch-worth-it`, else `Skip`.
The literal `>= 60` you'd observe for a Canada job comes from
`verdictFor(score, track.thresholds)` where `track.thresholds.apply === 60`, i.e. the
seed override at `seed_config.sql:757`. It does NOT come from the global (which is 75).

Best track selection (`src/scoring.ts:248-258`): picks the highest-ranked verdict across
tracks (`VERDICT_RANK` Apply=2 > Stretch=1 > Skip=0, `scoring.ts:215`), tie-broken by score.
Result exposed as `result.best.verdict`.

Notify decision (`src/pipeline.ts:291`):

```ts
const isSurvivor = result.best.verdict !== 'Skip';
```

`isSurvivor` (best verdict is Apply OR Stretch-worth-it) is the gate for notification.
A survivor is notified only if additionally (a) not a seeding run (`pipeline.ts:301-303`),
(b) fresh (`pipeline.ts:305`), and (c) verify-on-notify returns alive===true
(`pipeline.ts:309-319`); on success `status='notified'` and Telegram is sent
(`pipeline.ts:347-363`). Verdict/threshold is what makes a job eligible; freshness +
live-verify are the extra gates.

Two gate caveats that affect whether `canada_coop` ever reaches a non-Skip verdict
(context, not thresholds themselves):
- Gates are HARD only. The normalizer strips `type`/`points` and keeps just
  `{id, scope, require, reject}` (`config-store.ts:56-62`, comment line 56: "Gates are
  always hard (pass/fail)"). So the seed's `coop_signal` gate — declared
  `"type":"penalty","points":15` (`seed_config.sql:728-730`) with a `require` list
  [co-op, coop, work term, intern, internship] — is loaded as a HARD `require` gate. A
  Canada job whose TITLE lacks one of those terms hard-fails `canada_coop` → `Skip`
  regardless of score/threshold (`scoring.ts:239,244`).
- `location_canada` (`seed_config.sql:676-726`) is a hard `require` on `scope:location`.

## 4. The "Calibration gap" — confirmed

The Calibration UI edits ONLY the single global `thresholds` pair. Per-track overrides are
invisible and uneditable there, while they silently override the global at scoring time.

Render (`src/console/app.tsx:931-932`):

```tsx
<label>Notify me at score ≥ <input type="number" name="apply" value={String(cfg.thresholds.apply)} class="w-sm" /></label>
<label>Show borderline from ≥ <input type="number" name="stretch" value={String(cfg.thresholds.stretch)} class="w-sm" /></label>
```

Write (`src/console/app.tsx:1159-1168`, route `/calibration/quick`):

```tsx
cfg.thresholds = { apply: Number(b.apply), stretch: Number(b.stretch) };
```

This assigns ONLY the global `cfg.thresholds`. It never reads or writes any
`cfg.tracks[i].thresholds`. Grep for `thresholds|.apply|.stretch` across `src/console/`
returns exactly three hits — the two inputs above (931, 932) and this write (1162) — and
nothing per-track. `buildMatrix`/the matrix editor map keywords and gates only, not
per-track thresholds.

Consequence: the console form shows the owner "Notify me at score ≥ 75" (global), while a
Canada job actually notifies at ≥ 60 because of `canada_coop.thresholds.apply=60`
(`seed_config.sql:757`) applied at `scoring.ts:244`. The owner cannot see the 60 or change
it from the console. And because `loadLive`→`normalizeScoringConfig` preserves the tracks
array verbatim (`config-store.ts:53-63`) and `saveLive` re-serializes the whole cfg
(`app.tsx:827-831`), every console save silently RE-persists the 60/35 override — there is
no console path that can drop it.

## 5. EXACTLY what would have to change to remove the canada_coop override

Goal restated precisely: make `canada_coop` use the GLOBAL thresholds like the other two
tracks (i.e. delete its `thresholds` block so `track.thresholds ?? config.thresholds` at
`scoring.ts:244` falls back to global). NOTE this makes canada_coop notify at the global
apply (75 in the seed), NOT 60 — 60 is the current override, not the global. The task's
phrase "notify from >=60 like the other tracks" does not match the code: the other tracks
notify from the global apply (75 per seed / whatever the live global is).

The override is DATA, not code. Two surfaces hold it:

A. The bootstrap seed (repo). `seeds/seed_config.sql:756-759` — delete the `thresholds`
   block from the `canada_coop` track (and fix the trailing comma on the preceding `}` at
   line 754/755 so the JSON stays valid). This ONLY affects fresh bootstraps; it does NOT
   change the already-seeded live D1 row.

B. The LIVE D1 `config` row `key='scoring'` (runtime source of truth). This is where the
   pipeline actually reads from (`config-store.ts:9-11` `SELECT value FROM config WHERE
   key='scoring'`). Editing the seed alone will NOT change a running system. The live JSON
   must have the `canada_coop.thresholds` key removed. There is NO console action that can
   do this today (see §4 — the UI only writes the global pair). So it must be done by
   directly rewriting the D1 row's JSON, e.g. via `wrangler d1 execute` with an
   `INSERT OR REPLACE INTO config (key, value) VALUES ('scoring', '<edited JSON>')`
   (owner-run; same statement shape the seed and `saveLive` use). After the write, new runs
   pick it up immediately (config is loaded per run; already-stored jobs keep their score —
   `app.tsx:939`).

There is no code line to flip: `scoring.ts:244`'s `track.thresholds ?? config.thresholds`
is already the correct fallback; it "sees" the override purely because the loaded config
object carries `canada_coop.thresholds`. Remove that key from the live D1 JSON (B) and, for
future bootstraps, from the seed (A), and canada_coop will fall through to the global
thresholds. (If instead the intent is a global 60 for ALL tracks, that is the Calibration
UI's "Notify me at score ≥" field, `app.tsx:931` → `/calibration/quick` `app.tsx:1162`,
setting global apply=60 — but that lowers ALL tracks, and canada_coop's 60 override would
still shadow it until removed per B.)

---

## File/line index

- `src/scoring.ts:35-40` — `TrackConfig.thresholds?` optional per-track override type.
- `src/scoring.ts:42-56` — `ScoringConfig` with global `thresholds`.
- `src/scoring.ts:209-213` — `verdictFor`: `>= apply → Apply`, `>= stretch → Stretch`.
- `src/scoring.ts:237-246` — per-track loop; L244 `track.thresholds ?? config.thresholds`.
- `src/scoring.ts:248-258` — best-track selection.
- `src/pipeline.ts:291` — `isSurvivor = result.best.verdict !== 'Skip'` (notify gate).
- `src/pipeline.ts:301-363` — seeding/freshness/verify-on-notify → Telegram send.
- `src/config-store.ts:9-23` — loads D1 row `key='scoring'`; throws if missing.
- `src/config-store.ts:53-63` — normalizer preserves tracks (`...t`), strips gate
  type/points (gates always hard).
- `src/config-store.ts:99-102` — validates ONLY global thresholds (per-track unvalidated).
- `seeds/seed_config.sql:25-28` — GLOBAL thresholds apply:75 stretch:55.
- `seeds/seed_config.sql:672-674` — `canada_coop` track id.
- `seeds/seed_config.sql:728-730` — `coop_signal` gate declared `type:penalty points:15`
  (loaded as HARD require).
- `seeds/seed_config.sql:756-759` — `canada_coop.thresholds` override apply:60 stretch:35.
- `seeds/seed_config.sql:761-883` — `colombia_perm` (no thresholds → global).
- `seeds/seed_config.sql:884-1110` — `contractor_usd` (no thresholds → global).
- `migrations/0001_initial.sql:53` — `CREATE TABLE config`.
- `migrations/0001_initial.sql:136-139` — seeds quota_limits/observability/poll_page_size
  only (NOT scoring).
- `src/console/app.tsx:821-831` — `loadLive`/`saveLive` (read/write the whole scoring cfg).
- `src/console/app.tsx:931-932` — Calibration form: global apply/stretch inputs only.
- `src/console/app.tsx:1159-1168` — `/calibration/quick`: writes global `cfg.thresholds`
  only + FRESHNESS_MAX_DAYS.

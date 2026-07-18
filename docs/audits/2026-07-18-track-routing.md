# Audit — Track routing & location gates (2026-07-18)

Owner-reported: (a) the tool recommends "remote" roles restricted to EMEA /
Brazil / San Francisco / etc.; (b) "Data Analyst (Intermediate/Senior), Credit"
@ KOHO — location "KOHO (CAN); Remote" — failed `ubicacion_canada` and was
routed to `contractor_usd` with Apply 82/100 and notified. Both verified
against the live remote D1 (read-only) and the config. Engine:
`src/scoring.ts` (generic, config-driven); knowledge: `config['scoring']`
(live copy matches `seeds/seed_config.sql`).

## Finding 1 (critical) — Canada gate misses abbreviations: "(CAN)"

`ubicacion_canada` (hard, scope `location`) requires one of: canada, vancouver,
toronto, montreal, calgary, ottawa, british columbia, ontario, alberta.
KOHO's ATS location is literally `KOHO (CAN); Remote` — none of those words —
so a Canadian remote job hard-fails the Canada track. The word-boundary
matcher (`termRegex`, scoring.ts:109) means adding the term `can` is safe in
the *location* scope ("vancouver" cannot false-match; boundaries block it),
but `ca` must NOT be added (California, "San Francisco, CA").
Also: gate scope is location-only; a job whose location field is bare but whose
description says "anywhere in Canada" also fails. Consider `title_location`
scope or a small abbreviation vocabulary: `can`, `cad`, per-province codes
(`bc`, `on` are risky as bare words — evaluate case by case).

## Finding 2 (critical) — contractor_usd reject list is a blacklist that can't win

`rechazo_remoto_restringido` (hard, scope location) rejects only exact
phrasings: "remote, canada", "remote - canada", "emea only", "europe only",
"us remote", "united states", "usa", "india", "hybrid", … Real ATS location
strings verified live that PASS the gate today:

- `KOHO (CAN); Remote` (Canada-restricted; notified as Apply)
- `Canada (Remote); remote` (bare "canada" is NOT in the reject list)
- `San Francisco; Remote`, `New York, NY (HQ); San Francisco, CA; Remote`
- `EMEA; Romania; Bulgaria; Portugal; …; Remote`, `Home based - EMEA`
- `Brazil; Remote`
- `New York, NY (HQ); …; Remote (US); Remote` — "Remote (US)" defeats the
  "remote us" pattern because `(` is not in the separator class `[\s/-]+`.

Structural diagnosis: enumerating the world's restricted phrasings is a losing
game. Options (owner decision, in the rebuild plan):
1. **Config-only broadening** (cheap, imperfect): add bare region/country/city
   tokens to reject (canada, can, brazil, brasil, emea, europe, uk, united
   kingdom, india, apac, san francisco, new york, seattle, miami, washington,
   plus "remote (us)"-style variants). No code change; still whack-a-mole.
2. **Eligibility semantics in code** (robust): a gate type that rejects when
   the location names ANY geography outside an allowlist (latam, americas,
   colombia, worldwide, anywhere, global). Schema/code change to `Gate`.
3. **Cross-track exclusivity**: if a job matches Canada tokens, exclude it from
   contractor_usd (a Canada job should be judged by the Canada track only).
   Today `best` just takes the highest verdict across independent tracks
   (scoring.ts:245-255), so contractor (penalty −15) usually outranks
   canada_coop (co-op penalty −25) for the same job — that is exactly the KOHO
   misroute.

## Finding 3 (major) — verdicts are frozen at ingestion; config fixes don't retro-apply

The LIVE config already rejects `hybrid`, yet ~15 jobs with "Hybrid - US…"
locations hold Stretch-worth-it on contractor_usd — they were scored under an
earlier calibration and never re-scored. `jobs.track/verdict/score_breakdown`
are written once when first seen. Replay (console /config) only SIMULATES a
draft config; **materialized re-score is an unbuilt backlog item**
(IMPLEMENTATION_PLAN §11). Consequence: any gate fix ships for future jobs
only; the ~30+ mis-tracked rows stay wrong until a re-score action exists
(or the rows expire). The rebuild plan should include a bounded "re-score all
open jobs with current config" action (D1 write budget: ~1350 rows, one-off).

## Finding 4 (minor) — Spanish gate ids/evidence persist in live data

Gate ids in config are Spanish (`ubicacion_canada`, `senal_coop`,
`rechazo_us_only`, `remoto`, …) and old persisted `score_breakdown` rows carry
pre-rewrite Spanish evidence ("sin match de: …"). Code now emits English
(scoring.ts:195). Per the 2026-07-18 English-everywhere decision, config gate
ids should be renamed in the same pass as any gate fix (a config edit +
optional breakdown refresh via the re-score in Finding 3).

## Finding 5 (context) — what SHOULD a non-co-op Canadian remote job do?

Even with "(CAN)" fixed, KOHO would be: canada_coop = hard-pass location,
co-op penalty −25 → 57 → Stretch (thresholds 60/35); contractor_usd = rejected
(Canada-restricted). Net: Stretch on canada_coop instead of Apply on
contractor_usd. Whether that's right is an owner calibration decision —
options: accept Stretch, soften the co-op penalty, or add a `canada_perm`
track.

**OWNER DECISION 2026-07-18:** soften the `senal_coop` penalty — a Canadian
non-co-op role must not score as high as a co-op one, but must not be punished
as hard as −25. Proposed value −15 (co-op keeps a 15-point edge; a strong-fit
non-co-op like KOHO 82 → 67 → Apply; core-score-<75 non-co-ops stay Stretch);
exact number to be confirmed at plan approval. Applies with the rest of the
fix package (needs the re-score action of Finding 3 to reach existing rows).

## Owner request logged in the same session — cron window

Owner asked: cron hourly, 9am–7pm Eastern. Cloudflare Cron Triggers are
UTC-only. `0 13-23 * * *` = 9:00–19:00 EDT (current, summer). In winter (EST)
the same expression means 8am–6pm ET (1h drift). Exact-ET behavior needs a
small code guard in `scheduled()` (compute ET hour, no-op outside 9–19) or
accepting the drift. Side effects to check in the plan: runs/day drop 48 → 11
(quota relief), freshness (`FRESHNESS_MAX_DAYS=3`) unaffected, Monday digest
claim logic (`src/pipeline.ts`) still fires within the window. Requires
`wrangler.jsonc` triggers change + possibly a pipeline guard; needs owner
approval like everything else.

## Recommended fix package (for the consolidated plan; NOT implemented)

1. Config: add Canada abbreviations to `ubicacion_canada`; broaden the
   contractor reject vocabulary (option 1) as an immediate stopgap.
2. Code: pick option 2 (eligibility allowlist gate) or 3 (cross-track
   exclusivity) as the durable fix — recommend 3 + 1 combined: cheap and
   addresses the misroute class directly.
3. Build the one-off "re-score open jobs" action (console button behind
   confirmation) so fixes apply to the existing 1350 rows.
4. Rename gate ids to English in the same config edit.
5. Cron: `0 13-23 * * *` + optional ET guard, owner to choose exact-ET vs
   drift-tolerant.

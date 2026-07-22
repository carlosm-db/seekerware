# Exploration — a LATAM/Colombia connector to widen the pool

Prompted by the discovery finding (2026-07-22-company-discovery.md): the `colombia_perm` pool is thin on
the 6 supported ATSes because most Colombian employers use platforms we don't connect to. This assesses
whether a new connector fixes that. **Research only — nothing built.**

## Candidates assessed (all probed live)

| Platform | Model | Public API? | Fit | Verdict |
|---|---|---|---|---|
| **SmartRecruiters** | per-company | ✅ `api.smartrecruiters.com/v1/companies/{id}/postings`, no auth, JSON with `location{city,region,country,remote}` + `releasedDate` + `ref` | Near-identical to Greenhouse/Ashby | **Viable — clean** |
| **Gupy** | per-company | ❌ documented API (`api.gupy.io`) needs **Bearer / Premium-plan tokens**; no public feed | We can't hold other companies' tokens | **Not viable** |
| **elempleo / Computrabajo / Magneto365** | **aggregator** (one source → many employers, search by criteria) | No clean per-company API; HTML/scrape | Breaks "1 company = 1 board" model; scraping violates the API-only domain rule | **Not recommended** |

## SmartRecruiters — technical fit (confirmed)

- `GET /v1/companies/{id}/postings` → `{ totalFound, content:[{ id, name, releasedDate, location{city,region,
  country,remote}, ref, … }] }`. Public, no auth. Detail (full description) via `/postings/{postingId}`.
- Effort ≈ one existing connector: a `src/connectors/smartrecruiters.ts` (fetchJobs/fetchDetail/isLive) +
  a `parseAtsUrl` host rule (`jobs.smartrecruiters.com/{id}` / `careers.smartrecruiters.com`) + the `Ats`
  union + the CHECK constraint on `companies.ats` (**migration** — recreate-table under FK, the
  2026-07-19 trap; do it via `wrangler d1 execute`, not `migrations apply`) + tests. ~half a day.

## The catch — coverage, not code

The blocker isn't feasibility, it's **who's actually on it**. A 30-ID probe hit only **Avianca** (1 posting,
Bogotá → on-target) and **Wise** (395, global). The Colombian employers the owner named — **Comfama,
ISAGEN** — are **not** on SmartRecruiters; they're on **elempleo/Computrabajo/Magneto365** (aggregators).
So SmartRecruiters would unlock *some* global/LATAM names (Avianca, Wise, others once exact IDs are found)
but is **not** the Colombian-mid-market fix the gap implied.

The real Colombian volume lives on aggregators, which are the wrong architecture for this system (search-
source, not company-board) and would require scraping (fragile + against the "verify against the API, never
HTML" rule). No clean connector reaches that market.

## Recommendation

1. **canada_coop** is the deep, reachable pool — grow it via **Workday/SF URL research** (no new connector;
   e.g. Bombardier already added). Highest ROI.
2. **SmartRecruiters connector** — build it **only if** the owner wants the modest global-SR unlock
   (Avianca, Wise, and SR-hosted companies found by exact ID). Clean and low-effort, but set expectations:
   it does **not** solve Colombian mid-market.
3. **Gupy / aggregators** — do not pursue as connectors (auth-gated / wrong-model / scraping).
4. If Colombian mid-market coverage is a hard requirement, the honest options are manual (owner browses
   elempleo/Magneto) or a future, separate "external saved-search" feature — not an ATS connector.

## Next step (owner's call)

- **Build SmartRecruiters** (I'll plan it: connector + parseAtsUrl + migration + tests) — or
- **Skip it**, keep growing canada_coop via Workday/SF research + owner-seeded verification.

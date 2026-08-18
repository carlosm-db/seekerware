# Scoping — a JOIN (join.com) connector (8th ATS)

Prompted 2026-07-24: JOIN carries genuine on-target roles (LATAM-remote, "Work from Anywhere"), so it's
worth scoping. **Research/scoping only — nothing built.** Verdict up front: **viable but a bigger, messier
build than SmartRecruiters, for uncertain LATAM density** — decide with the density check below first.

## What's confirmed (probed live)

- **Model fits us:** per-company boards at `join.com/companies/{slug}` → token = the slug (e.g.
  `synergybeamcom`). SMB, European-heavy.
- **Public API:** GraphQL at **`https://join.com/candidate-api/graphql`** — candidate-facing, **no WAF
  403** (unlike Dayforce/ADP). Next.js SPA; `__NEXT_DATA__` carries partial job data.
- **On-target coverage exists:** "Customer Support Tier 1 — LATAM" (REMOTE), FreshTalent "Work from
  Anywhere" (USD contract). JOIN distinguishes **"remote from anywhere" vs "remote within a country"** —
  that distinction is the key field for us.

## The hard part — location → gate mapping (the crux)

JOIN's structured fields are `workplaceType` (REMOTE/ONSITE/HYBRID) + `country` (iso3166) — but **`country`
is the company's HQ, not the role's eligibility**. The "Remote LATAM" job had `country=UA` (Ukraine); the
LATAM signal lived only in the **title/text**. So a naive `country`→location mapping would **miss the very
roles we want** and mis-route others.

**Needed:** find the field that encodes remote SCOPE — "from anywhere" vs "within {countries}". JOIN's UI
shows it, so it's in the GraphQL schema (likely a `remoteType` / `remoteCountries` / `locations[]`). The
connector must build `Job.location` from that (e.g. REMOTE+anywhere → "Remote - Worldwide"; REMOTE+[CO/…]
→ the country list; ONSITE → the city/country), so the existing gates route it correctly.

## Open questions (first implementation steps — reverse-engineer once)

1. **Exact GraphQL query** for a company's job list (capture from the SPA's network/Apollo cache). Confirm
   it's callable server-side with no auth token / just an origin header.
2. **The remote-scope field** (anywhere vs specific-countries) — this decides the location mapping.
3. **Description + posted date** fields (for scoring + freshness) — likely need a per-job detail query.

## Connector shape (once the above are known)

`src/connectors/join.ts` mirroring the others: `fetchJobs` (POST GraphQL by slug → normalize, building
`location` from workplaceType + remote-scope + country), `fetchDetail` (description), `isLive` (job still
in the board / a 404-equivalent). Wire-up = `Ats` union + registry + `parseAtsUrl` (`join.com/companies/{slug}`)
+ tests. **No DB migration** (companies.ats has no CHECK). Effort ≈ **~1 day** (vs half-day for SR — the
GraphQL + location mapping is the extra).

## Go / no-go — gauge density FIRST

Before committing a day: query JOIN's **global** job search (GraphQL) for `workplaceType=REMOTE` +
worldwide/LATAM scope and count how many exist. If it's a healthy cluster of globally-open/LATAM roles →
build it. If it's mostly remote-**EU** (not LATAM-eligible) → skip; the yield won't justify the build.
The verify-tally is the ultimate safety net regardless (every added board shows its real CA/CO count).

## Recommendation

- **Cheaper wins first:** the `everywhere` allowlist tune (helps all 7 current ATSes today) + owner-seeded
  employers via the new verify-then-add flow.
- **JOIN:** only if the density check shows real LATAM/global-remote volume. It's viable and clean-API
  (better than Dayforce), just more work + uncertain payoff — so gate it on the density check, don't build
  on spec.

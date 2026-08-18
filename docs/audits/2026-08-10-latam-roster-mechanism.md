# LATAM/Colombia roster — mechanism audit & improvement options

Prompted 2026-08-10: the owner won't resume the Canada sweep ("ese path está doloroso") and wants the
LATAM/Colombia roster — or the mechanism itself — improved. **Audit + options only; nothing built.**
Builds on 2026-07-22-company-discovery.md, 2026-07-22-latam-connector.md, 2026-07-24-join-connector.md.
Written for external review (Codex): claims below are either code-audited today or probed live today;
point-in-time facts are flagged.

## 1. As-is (code audited 2026-08-10 — code is the source of truth)

- **8 connectors** (`src/connectors/index.ts:27`): greenhouse, lever, ashby, successfactors, workday,
  workable, smartrecruiters, bamboohr. Interface = `fetchJobs` / `isLive` / optional `fetchDetail`.
- **`companies.ats` has NO CHECK constraint** since migration `0011_ats_open.sql` — adding a new source
  id needs **no DB migration** (jobs.status/verdict CHECKs from 0001/0015 are unrelated).
- **The poller no longer runs in the Worker.** `scheduled()` only dispatches: the Worker cron fires
  `poll.yml` via `workflow_dispatch` at 17:00 & 22:00 UTC = **noon & 17:00 Bogotá, 2×/day**
  (`src/dispatch.ts:9`). The poll itself runs in **GitHub Actions / Node 22** (`scripts/poll.ts` →
  `runPipeline`), talking to D1 over HTTP (`src/d1-http.ts`). Worker-era caps are explicitly relaxed
  (`src/pipeline.ts:82-89`): `max_new_jobs_per_run`/`max_detail_fetches_per_run` default 100000,
  concurrency 10, per-ATS timeouts. **Consequence: "the Worker can't afford heavier sources" — a July
  constraint — no longer applies to polling.** (CLAUDE.md §5 still describes the old shape; docs lag.)
- **Verify-then-add flow** (`src/console/app.tsx:679-762`): paste URLs → `parseAtsUrl`
  (`src/connectors/common.ts:71`) → live board fetch → CA/CO tally via `locationClears`
  (`src/scoring.ts:229`) → owner checks boxes → `INSERT OR IGNORE`. **Capped at 8 URLs/batch**
  (`VERIFY_CAP`, app.tsx:678) because the *console* still runs in the Worker (50-subrequest budget).
  Tally counts only `scope:'location'` gates over ≤250 jobs/board.
- **Gates live in D1** (`config` key `scoring`; `src/config-store.ts` — code holds zero keywords).
  Live values are console-editable and can't be read from the repo. Per the 2026-07-22 audit + memory
  (verify in `/calibration` before relying on it): `colombia_perm` requires location ∋ colombia/bogota/
  medellin/latam/latin america/south|central america/americas/worldwide/anywhere/global. **City-pinned
  LATAM labels (Mexico City, São Paulo, Buenos Aires…) do NOT clear it** — the Kavak drop case.
- **Roster**: ~204 active as of 2026-07-25 (memory; point-in-time — the console `/companies` is the
  live count). Target 320.

## 2. Diagnosis — why the current path hurts

1. **Discovery is manual and expensive.** The proven method (domain-restricted web search → extract
   token → verify ≤8/batch → owner INSERT) costs ~1 search + 1 probe per company and the deep pool it
   works on is **canada_coop** (Workday/SF URL research). That is exactly the path the owner is
   abandoning. The mechanism has no batch/offline discovery aid at all.
2. **Colombia is structurally absent from the 8 ATSes.** Empirically settled 2026-07-22/25: the strong
   Colombian/LATAM fintechs are already on the roster; a full Colombia sweep found nothing new worth
   adding; mid-market Colombia lives on aggregators (elempleo, Magneto365, Computrabajo) that were
   probed and ruled out (WAF 403 / auth-gated Server Actions / non-replayable minified-JS API). More
   sweeping cannot fix this — it's a coverage hole, not a search-effort hole.
3. **Two facts changed since July's "aggregators are out of clean reach" verdict:**
   - The poller moved to Node/Actions (no CPU/subrequest limits — §1).
   - Two LATAM aggregators with **clean public JSON APIs** were never probed: **GetOnBoard** and
     **Torre**. Probed live today (§3) — both answer without auth. The July ruling rejected
     *scraping*; these are APIs, so the "verify against the API, never HTML" domain rule (CLAUDE.md
     §7.3) is satisfiable.

## 3. New evidence — probed live 2026-08-10

### GetOnBoard (getonbrd.com) — LATAM tech job board, documented public API
- `GET https://www.getonbrd.com/api/v0/search/jobs?query=colombia&per_page=N` → JSON, **no auth**.
  166 results for "colombia" (paged).
- Per-job attributes seen: `remote`, `remote_modality` (e.g. `remote_local`), `remote_zone`,
  `countries`, `location_cities`, `published_at` (epoch), `seniority`, `min_salary`/`max_salary`,
  `modality`, `lang`, `company`, full HTML description sections. **This natively carries the
  remote-SCOPE distinction ("anywhere" vs "within-country") that the JOIN audit called the crux** —
  here it's structured, not buried in text.
- Freshness: `published_at` ✅. Verify-on-notify: per-job/company endpoints exist in the v0 API
  (exact isLive endpoint = first implementation step, not yet probed).
- Risk: LOW-ish — the API is publicly documented; volume is tech-niche (hundreds, not tens of
  thousands), Spanish-heavy, strong LATAM-remote density.

### Torre (torre.co / torre.ai) — Colombian company, LATAM-wide marketplace
- `POST https://search.torre.co/opportunities/_search?size=N` → JSON, **no auth**:
  **74,635 open opportunities**. Fields: `objective` (title), `organizations[]` (employer name/id),
  `remote`, `locations[]`, `timezones`, `compensation` (USD amounts + periodicity), `created`,
  `deadline`, `status:'open'`, `skills[]`, `slug`, `id`.
- Freshness: `created` ✅. Employer identity: `organizations[0].name` ✅. Status field suggests a
  clean isLive check ✅ (endpoint to confirm).
- **Caveat (honest result):** my filter attempt `{"and":[{"remote":{"term":true}},{"location":
  {"term":"Colombia"}}]}` did NOT narrow the total (still 74,635) — the exact filter grammar must be
  captured once from the torre.ai SPA (same "reverse-engineer once" shape as the JOIN scoping).
- Risk: MEDIUM — public but undocumented API (SPA-internal); could change without notice. Politeness
  + resilience required. Volume and Colombia-density are the highest of any source assessed to date.

## 4. Options (effort · yield · risk)

| # | Option | Effort | LATAM/CO yield | Risk / notes |
|---|--------|--------|----------------|--------------|
| A | **Gate tune**: widen `colombia_perm` (or a new `latam_regional` track) to accept LATAM country/city labels | Config-only, zero code | Low-medium — unlocks boards already reachable (Kavak-type drops) | Semantic: a job pinned to Mexico City may not serve a Colombia resident. Noise risk; owner's call on intent |
| B | **LATAM-wide sweep** on the 8 ATSes (MX/BR/AR/CL city terms + latam/latin-america labels; SR search proved the method — Fygaro, Blend360) | No code; owner+agent search sessions | Low-medium — Colombia-only sweep already exhausted; LATAM-remote angle partly untapped | Same painful manual path the owner is rejecting; only worth it opportunistically |
| C | **Search-source architecture** on GetOnBoard + Torre (the owner's "separate non-ATS tool") | ~1 day/source (JOIN-sized) | **High — the only option that reaches Colombia/LATAM volume** | See §5. Torre API undocumented (medium); GoB documented (low) |
| D | **JOIN connector** (as scoped 2026-07-24) | ~1 day | Uncertain — gated on its density check | Unchanged; do the density check before building |
| E | **Discovery de-pain**: a Node batch-verifier (workflow_dispatch or local script: file of URLs/tokens → fetch → CA/CO tally report), bypassing the Worker's 8-URL cap | ~half day | Indirect — makes ANY future sweep 10× less painful | Adds stay owner-run (INSERT step unchanged). Politeness caps on probing |

## 5. Option C design sketch (decisions needed before any build)

The current model is 1 company = 1 board. A search-source is 1 saved search = N employers. Least
invasive mapping, using what the code already allows:

- **Source row**: one `companies` row per saved search — e.g. `ats='getonboard'`,
  `token=<serialized query>` (no migration; 0011 removed the CHECK). `parseAtsUrl` untouched (sources
  are added via the single-add form, like custom-domain SF).
- **Connector shape**: `src/connectors/getonboard.ts` (+ `torre.ts`) implementing the SAME
  `fetchJobs/fetchDetail/isLive` interface — the pipeline, dedup (canonical-URL hash), freshness,
  scoring, and notify paths need **zero changes**.
- **Employer identity**: the real employer arrives per-job (`company`/`organizations[0].name`).
  Decision: prefix it into `Job.title` ("[Employer] Title") vs a new `jobs.employer` column
  (migration) vs notes. Affects dedup-by-URL not at all; affects display/kit.
- **Location mapping**: build `Job.location` from the structured remote-scope fields so the EXISTING
  gates route correctly (GoB: `remote_zone`/`countries`/`location_cities`; Torre: `remote` +
  `locations`/`timezones`) — the same rule the JOIN audit set.
- **Domain rules kept**: verify-on-notify against the source's API (§7.3 ✅ — this is what
  disqualified elempleo/Magneto/Computrabajo, NOT their being aggregators); first fetch seeds without
  notifying (§7.4 ✅); descriptions wrapped as third-party DATA (§7.5 ✅).
- **First implementation steps** (reverse-engineer once, before committing): GoB per-job isLive
  endpoint + pagination; Torre filter grammar (capture from SPA) + isLive endpoint; per-source
  politeness (result caps per poll — 74k unfiltered Torre results must never be ingested wholesale;
  a source poll ingests only its filtered page(s)).

## 6. Recommendation

1. **C is the answer to the actual question** (Colombia/LATAM without the Canada pain): start with
   **GetOnBoard** (documented API, native remote-scope fields, lowest risk) to prove the search-source
   pattern end-to-end, then **Torre** (highest Colombia volume; +grammar reverse-engineering).
2. **E alongside** (small): the Node batch-verifier removes the 8-URL bottleneck for whatever
   sweeping remains, and doubles as the density-checker for D (JOIN) and any future source.
3. **A** is a cheap owner decision to make explicit either way (widen vs keep strict); **B** only
   opportunistically; **D** stays gated on its density check.

**Open items:** live `colombia_perm` gate terms + whether the July "everywhere allowlist" tune was
applied (read in `/calibration` — not visible from the repo); GoB isLive endpoint; Torre filter
grammar; roster count today (console).

---

# UPDATE 2026-08-10 (same day) — owner redirect: GoB/Torre rejected; probe what Colombia actually uses

Owner's verdict on §3/§6: **GetOnBoard and Torre are awful for full-time jobs** — the market that
matters is **elempleo.com, Computrabajo, LinkedIn**, i.e. where employers like **EPM** post. EPM not
being reachable is the concrete failure case. §6's recommendation is **superseded** by this section.
New probe round below (all live, 2026-08-10, from the owner's residential IP).

## 7. New evidence — the JSON-LD JobPosting path

The structural insight the July audit missed: elempleo/Magneto/Computrabajo live off Google-for-Jobs
SEO, and Google **requires** schema.org `JobPosting` structured data — so their job pages embed
machine-readable JSON, by contract with Google, regardless of how locked their internal APIs are.
Probed and confirmed:

| Source | Per-company list page | Job detail page | Access |
|---|---|---|---|
| **elempleo** | ✅ SSR: `elempleo.com/co/ofertas-empleo/trabajo-epm` renders EPM's live vacancies as plain links with numeric IDs (`residente-civil-epm-1886733221`, `topografo-epm-1886724667`) | ✅ **JSON-LD `JobPosting`**: title, `datePosted`, `validThrough`, `hiringOrganization`, structured `jobLocation` (city/region/CO), `baseSalary` in COP | HTTP 200 (residential). The internal `/api/joboffers/findbyfilter` is **401** (re-confirmed; July verdict stands — skip the API, use the pages) |
| **Magneto365** | ✅ SSR: `magneto365.com/co/empresas/{slug}/empleos` (grupo-exito, bancolombia…) renders job links with numeric IDs (Next.js App Router flight payload + anchors) | ✅ **JSON-LD `JobPosting`** (`<script id="JobPosting" type="application/ld+json">`): title, dates, full description, org "Grupo Éxito" | HTTP 200 (residential). July's 401 applies to the *client search endpoints*, not these SSR pages |
| **Computrabajo** | ✅ SSR search pages with offer links + 1 JSON-LD block | (detail not probed; list confirms SSR + structured data) | HTTP **200 from residential IP** — July's blanket "WAF 403s all requests" was measured from a datacenter IP. Datacenter (GH Actions) will still 403 |
| **LinkedIn** | — | — | Not probed: auth-walled + aggressively anti-bot + ToS-hostile. The EPM case shows it's not needed — Colombian employers' postings land on the three boards above |

**EPM specifically:** its own portal (`epm.com.co/institucional/de-tu-interes/ofertas-de-empleo/`,
AEM + Azure APIM backend) is not worth reversing — its convocatorias (often run by contractors:
the "residente civil EPM" posting's real `hiringOrganization` is APPLUS NORCONTROL) are already
mirrored on elempleo's per-company page. **elempleo `trabajo-epm` IS the EPM board.**

## 8. What this changes architecturally

- **The 1-company = 1-board model survives.** No search-source needed for the named-company use
  case: token = the per-company slug (`elempleo/trabajo-epm`, `magneto/grupo-exito`). One connector
  per source with the existing `fetchJobs/fetchDetail/isLive` interface; pipeline/dedup/gates/kit
  untouched. `detail_per_company` (already in config) caps detail fetches for big boards like Éxito.
- **Extraction = JSON-LD parsing, not CSS scraping.** The list page yields job URLs (stable numeric
  IDs → canonical-URL dedup works); each detail page yields one `JobPosting` object (title, location,
  datePosted for freshness, validThrough, salary, employer). `isLive` = detail page still 200 +
  JobPosting present + `validThrough` in the future. This is the SEO contract these boards keep for
  Google — far more stable than DOM scraping, though still not a supported API.
- **It IS an HTML source** — the July "API, never HTML" ruling would bar it, but the owner already
  reversed that principle for Colombia (2026-07-25, recorded in memory + this thread). Domain rule
  §7.3's *letter* ("verify against the ATS API, never the HTML page") needs a conscious owner
  amendment for these sources: verify-on-notify = the JSON-LD check above.
- **The runner IP is the open risk.** All probes above were residential. Computrabajo 403s
  datacenter IPs (proven in July); elempleo/Magneto from GitHub-Actions IPs = **untested**. Two
  mitigations, in preference order: (a) test a probe step in Actions first — if elempleo/Magneto
  answer, done (skip Computrabajo, it's the most redundant of the three anyway); (b) run the
  Colombia-source poll from the owner's machine — `scripts/poll.ts` is plain Node + D1-over-HTTP and
  runs anywhere; a scheduled local run (Task Scheduler) or self-hosted runner covers WAF'd sources.
- **ToS/politeness:** low volume (a handful of per-company pages, 2×/day, bounded detail fetches)
  is polite in practice but remains ToS-gray scraping. Owner accepted this trade-off for Colombia.

## 9. Revised recommendation (supersedes §6)

1. **Build the elempleo per-company connector first** (`ats='elempleo'`, token=`trabajo-{slug}`) —
   it directly closes the stated gap (EPM day one), pages are simple SSR, and JSON-LD is confirmed
   end-to-end. Effort ≈ JOIN-sized (~1 day incl. tests).
2. **Magneto per-company connector second** (Bancolombia, Grupo Éxito, and Magneto hosts hundreds of
   Colombian employers' career sites) — same shape; list-page extraction is slightly messier
   (App Router flight payload; anchors suffice).
3. **Before building, run the datacenter-IP test** (one throwaway Actions run fetching both list
   pages) to decide runner placement; if blocked, decide (b) local poller vs self-hosted runner.
4. **Computrabajo: park** unless (1)+(2) leave gaps — residential-only access makes it the most
   operationally expensive, and its inventory overlaps elempleo's heavily.
5. **LinkedIn: out.** GoB/Torre (§3): drop per owner verdict. JOIN/§4-D: still gated on density.
6. Roster seeding for the new sources: owner names the companies (EPM, Bancolombia, Éxito,
   Sura/Comfama/ISAGEN…) via slug; a later `parseAtsUrl` rule can make the paste-verifier accept
   `elempleo.com/co/ofertas-empleo/trabajo-*` and `magneto365.com/co/empresas/*` URLs.

**Open items (this update):** ~~elempleo/Magneto reachability from GH Actions IPs~~ **RESOLVED
2026-08-10: PASS** — both sources serve full SSR + JobPosting to GitHub-hosted runners (see
2026-08-10-actions-ip-probe.md; probe ran on the `probe/actions-ip` branch). Owner approved
**elempleo connector first** the same day. Still open: elempleo list-page pagination for companies
with >1 page of vacancies; Magneto detail-page volume caps for giant boards; robots.txt/ToS review
per source (owner sign-off); whether §7.3's wording gets an owner-approved amendment ("or the
source's structured JobPosting data when no API exists").

*Still nothing edited or built. Implementation requires explicit owner approval (CLAUDE.md §1).*

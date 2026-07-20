# Audit — Companies subsystem: coverage, curation, and the "big employer" gap

Date: 2026-07-19 · Scope: the COMPANIES subsystem (ATS connectors, the
`companies` table, seed set, console add/poll flow). Read-only audit; no code
changed. Questions answered:

1. Why does the system track ~25 companies, and is the hand-curated set worth it?
2. Why are Scotiabank / RBC / TD / S&P Global / Nuvei / "Hire with Near" /
   super.com absent — ATS-support limitation or not-yet-added?

---

## Facts (with file:line evidence)

### Which ATS platforms are supported: exactly three

- The `Ats` type is a closed union of **three** values:
  `export type Ats = 'greenhouse' | 'lever' | 'ashby';` — `src/types.ts:3`.
- The DB enforces the same three at the schema level:
  `ats TEXT NOT NULL CHECK (ats IN ('greenhouse','lever','ashby'))` —
  `migrations/0001_initial.sql:8`.
- The connector registry maps exactly those three and nothing else:
  `export const connectors: Record<Ats, Connector> = { greenhouse, lever, ashby };`
  — `src/connectors/index.ts:15`.
- `src/connectors/` contains only `greenhouse.ts`, `lever.ts`, `ashby.ts`
  (+ `common.ts`, `index.ts`). No Workday / SmartRecruiters / iCIMS / Workable /
  Recruitee connector exists anywhere in the tree.
- The console add-company form offers only those three in its dropdown:
  `<select name="ats"><option>greenhouse</option><option>lever</option><option>ashby</option></select>`
  — `src/console/app.tsx:429`.

### How a company maps to an ATS: one public board token, one JSON feed

Each connector hits ONE public, no-login JSON endpoint keyed by `company.token`
(the board slug), returns normalized `Job[]`, and defines its own
verify-on-notify:

- Greenhouse — `boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true`;
  verify = GET `/boards/{token}/jobs/{id}`, 404 = closed —
  `src/connectors/greenhouse.ts:9,29,39-44`.
- Lever — `api.lever.co/v0/postings/{token}?mode=json`; verify = GET individual
  posting, 404 = dead — `src/connectors/lever.ts:9,26,34-37`.
- Ashby — `api.ashbyhq.com/posting-api/job-board/{token}?includeCompensation=true`;
  verify = re-fetch the board and look up the `id` (the HTML page is a SPA that
  returns 200 even when dead — NEVER verify against HTML) —
  `src/connectors/ashby.ts:11,34,41-46`.
- Same table in the docs: `docs/TRD.md:44-48`.
- `Company` is just `{ id, name, ats, token, active }` — `src/types.ts:8-14`;
  the `companies` row adds health columns (`last_ok_fetch`, `fail_count`,
  `last_error`, …) and `UNIQUE (ats, token)` — `migrations/0001_initial.sql:6-14`.

So "adding a company" = insert one row with `(name, ats∈{gh,lever,ashby}, token)`.
The token is the board slug (e.g. Greenhouse `stripe`, Lever `dlocal`, Ashby
`ramp`). No per-company code.

### The ~25 number is the seed set — and it is structurally load-bearing

- `seeds/seed_companies.sql:3-28` seeds exactly **25** companies:
  9 Greenhouse (Stripe, Marqeta, Global Relay, Alloy, Nubank, Thinkific, GitLab,
  Remote.com, Canonical — all `active=1`), 13 Ashby (Ramp, Modern Treasury,
  Socure, Sardine, Persona, Trulioo, Addi, Cohere, Neo Financial, KOHO, Supabase,
  Zapier, Oyster — seeded `active=0`, "activar en paso 5"), 3 Lever (Versapay,
  dLocal, Yuno — seeded `active=0`). CLAUDE.md §9 step 5 records all 25 activated
  in production ("25 active companies").
- The seed header says the console is the source of truth once seeded, and the
  set comes from a local, gitignored `Seekerware_Companies.md` verified 2026-07-09
  — `seeds/seed_companies.sql:1-2`. Each row's `notes` encodes WHY it was picked:
  domain fit (payments/KYC/AML/compliance), location (Vancouver / Bogotá /
  Toronto), or remote-LATAM-friendliness.
- The poll is a **round-robin page of `poll_page_size` (default 25)** active
  companies — `src/store.ts:27-50`; `poll_page_size` seeded to `25` —
  `migrations/0001_initial.sql:139`. With 25 active companies, one page = the
  whole set every run.
- That page size is sized to the free-tier per-invocation subrequest cap:
  "Typical subrequest budget with a round-robin page of 25 companies: ~39 of 50
  (22% margin)" — `docs/TRD.md:223-224`; `docs/IMPLEMENTATION_PLAN.md:52`
  ("round-robin (~25 companies/run)"). 25 feed fetches + occasional
  verify-on-notify + one capped CV build (~9-17 calls) fit under 50; the CV-build
  cost is noted at `docs/audits/2026-07-18-cv-readiness.md:206`.
- Per-company isolation: a feed failure is caught, logged, and does not abort the
  run; 3 consecutive failures raise a maintenance alert —
  `src/pipeline.ts:79-101`. Auto-expire only fires on a successful fetch —
  `src/pipeline.ts:341-348`.

### "Scotiabank" in this repo is the owner's own employer, not a target

- Every "Scotiabank"/`BNS` hit is a CV **role anchor** in the blocks bank, i.e.
  the owner's employment history, not a monitored company: role codes `BNS2`
  (Scotiabank, Customer Experience Associate) / `BNS1` (Scotiatech) —
  `docs/DATABASE.md:165`, `docs/TRD.md:163`, and the bank audits
  (`docs/audits/2026-07-18-bank-tool-ux.md:82-102`). It is absent from
  `seed_companies.sql` by design — a former employer, not a lead.

### Console add-company flow only probes/activates Greenhouse (stale behavior)

- POST `/companies` live-probes the token and sets `active=1` **only** when
  `ats === 'greenhouse'`; for Lever/Ashby it saves `active=0` with the message
  `'connector pending (step 5): saved inactive'` — `src/console/app.tsx:466-480`.
  Step 5 (Lever+Ashby) is DONE (CLAUDE.md §9), so this message is stale: a
  Lever/Ashby company added via the console lands inactive and needs a manual
  toggle (`POST /companies/toggle`, `src/console/app.tsx:483-487`) despite the
  connector existing. `/api/dry-run` DOES exercise all three connectors
  (`src/index.ts:176-195`), so a pre-add probe path exists — it just is not wired
  into the add form for Lever/Ashby.

### The submit side (why coverage ≠ auto-apply) is settled

- Non-goal ratified with evidence: the 3 ATS submit APIs are company-key-only and
  form emulation is anti-bot with silent failure that "would permanently and
  invisibly burn curated companies" — `docs/PRD.md:90-101`,
  `docs/audits/2026-07-17-diseno-auto-apply.md`. Coverage growth is about
  DISCOVERY only; the human always submits.
- Future-evolution list (`docs/PRD.md:116-129`) contains userscript, capture
  inbox, bot commands, re-score — **no new-ATS-connector item**. Expanding ATS
  coverage is currently unplanned, not merely queued.

---

## Diagnosis

**Q1 — why ~25, and is curation worth it?**

The number is not arbitrary: it is the intersection of three forces.

1. **Product thesis = precision, not recall.** README frames the tool as a
   "reverse-ATS" that watches "selected companies" and notifies **only** on a
   genuine fit (`README.md:3-7`); PRD success metrics are low volume / same-day /
   zero stale (`docs/PRD.md:107-114`). A curated whitelist is the mechanism that
   delivers precision — noise is excluded at the source.
2. **Fit is encoded in the curation.** The seed `notes` show every pick maps to
   the owner's domain (payments / card issuing / KYC-AML / compliance) and
   geography (Vancouver co-op, Bogotá, Toronto, remote-LATAM-friendly). This is
   knowledge a keyword filter cannot reconstruct.
3. **25 = the free-tier sweet spot.** `poll_page_size=25` × one feed each ≈ 39/50
   subrequests (`docs/TRD.md:223-224`). At ≤25 active companies every company is
   polled every run, so same-day discovery (PRD RF1) holds. Above 25, round-robin
   spill (`src/store.ts:35-49`) polls each company less often — freshness degrades
   — or raising the page size pushes toward the 50-subrequest cap.

Maintenance cost is genuinely low: adding a company is one row / one form submit
with a board slug; health columns + the 3-strike maintenance alert
(`src/pipeline.ts:89-100`) surface churn automatically. **Verdict: yes, the
curated approach is worth it** — it is the core of the precision guarantee and it
is cheap to maintain. Its inherent cost is bounded recall (anything off the
whitelist is invisible), which is an accepted trade, not a defect. The one real
friction is the stale Lever/Ashby add-form behavior (`app.tsx:466-480`), which
makes adding the already-supported non-Greenhouse ATS feel broken.

**Q2 — why are the named big employers absent?** Two distinct causes:

- **Structurally unsupported (needs a NEW connector) — Scotiabank, RBC, TD,
  S&P Global.** These are large enterprises that run **Workday**. Workday is not
  in the `Ats` union (`src/types.ts:3`), not in the DB CHECK
  (`0001_initial.sql:8`), and has no connector. It is *not* "not yet added to the
  list" — the platform cannot ingest them at all today. (And Scotiabank is
  additionally the owner's former employer, present only as a CV anchor, not a
  lead.) Workday IS technically reachable via its public CxS JSON API
  (`{tenant}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs`), but that is a
  genuinely different connector: per-tenant host + site discovery, POST-based
  pagination, and its own verify semantics — not a single-slug token like
  GH/Lever/Ashby.
- **Unknown ATS — must be probed (possibly addable today) — Nuvei, super.com,
  "Hire with Near".** These are not in the seed set and their ATS is not
  determinable from the code. Whether they are addable today hinges solely on
  whether their public board runs Greenhouse/Lever/Ashby:
  - **super.com** (Toronto tech) and **Hire with Near** (LATAM staffing/EOR) are
    startup/tech-scale employers, the population that overwhelmingly uses
    Greenhouse/Lever/Ashby → **plausibly addable today**, pending a token probe.
  - **Nuvei** (large public payments co.) is enterprise-scale and more likely on
    Workday or SmartRecruiters → **likely needs a new connector**, pending probe.

  The definitive test already exists and costs nothing: hit
  `GET /api/dry-run?ats=<gh|lever|ashby>&company=<slug>` (`src/index.ts:176-195`)
  — a non-empty job list confirms the ATS + token and the company is one row away
  from being tracked.

**Bottom line:** supported ATS = Greenhouse, Lever, Ashby only. The absence
splits cleanly: the banks + S&P are a **Workday connector gap** (platform
limitation); Nuvei/super.com/Hire-with-Near are **not-yet-added and must be
probed**, addable immediately if and only if they sit on a supported ATS.

---

## Options (analysis only — NOT an implementation plan; no code changed)

**A. Leave coverage as-is (curated GH/Lever/Ashby, ~25).**
Keeps precision and the $0 budget intact; recall stays bounded to the whitelist.
Big-bank/Workday roles remain out of reach — acceptable if the owner's targets
are fintech/startup/remote-LATAM (which the seed set reflects). Zero effort.

**B. Fill the coverage that is already supported (fast, no new connector).**
Probe Nuvei / super.com / Hire-with-Near (and any other leads) via `/api/dry-run`
against each ATS; add the ones that resolve to GH/Lever/Ashby as ordinary rows.
Also worth flagging: the stale Lever/Ashby add-form path
(`app.tsx:466-480`) means these currently save inactive — a candidate cleanup so
"add a supported-ATS company" works uniformly. Effort: minutes per company; no
architecture change. Watch the 25-company / 50-subrequest ceiling as active
count grows.

**C. Add a Workday connector (unlocks the banks + S&P Global).**
Scope of a new ATS in this codebase: a `fetchJobs`/`isLive`/`normalize` module
+ register in `connectors` (`index.ts:15`) + extend the `Ats` union
(`types.ts:3`) + the DB CHECK (`0001_initial.sql:8`, via a migration) + the
add-form dropdown (`app.tsx:429`). Workday-specific friction beyond that:
per-tenant host + site discovery (no clean single slug), POST/paginated feed,
and a verify-on-notify path that never trusts an HTML SPA (the Ashby rule).
Higher-effort and higher-maintenance than the existing three; justified only if
Workday employers are genuinely on the owner's target list.

**D. Raise breadth beyond the free-tier sweet spot.**
More active companies than `poll_page_size` either (i) accept round-robin spill —
each company polled less often, degrading same-day discovery (PRD RF1), or
(ii) raise `poll_page_size` toward the 50-subrequest cap, or (iii) re-architect
polling across multiple invocations/queue. This is a budget/architecture
decision independent of which ATS are supported, and trades directly against the
freshness guarantee — call it out before growing the set materially.

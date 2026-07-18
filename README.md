# Seekerware

Personal job-discovery engine ("reverse-ATS"): watches the public job feeds of
selected companies, scores every new job against a configured profile, discards
the noise, and notifies via Telegram **only** when something is a genuine fit —
with a positioning note and a suggested CV. The human is always the one who
applies.

> **Status**: design v2 locked 2026-07-09 (reframe to Cloudflare; the v1
> all-GAS design from 2026-07-07 lives on in git history) · under construction —
> step 1 (scaffold + Greenhouse + dry-run + CI) completed 2026-07-17;
> next: step 2 (scoring). The .md files document intent; **the code is the
> source of truth** (see [`CLAUDE.md`](CLAUDE.md)).

---

## How it works (3 layers + human step)

```
[cron 30-60 min]
      |
      v
1. DISCOVERY   — poll public ATS APIs (Greenhouse / Lever / Ashby, no login)
      |            -> normalized job {id, company, title, location, url, ...}
      v
2. FILTER &    — score 0-100 by rules (domain > role type > tools > level)
   SCORE          + 3 tracks with their own gates -> verdict Apply | Stretch-worth-it | Skip
      |            (the AI never decides verdicts; it only enriches survivors)
      v
3. NOTIFY &    — dedup (URL hash), freshness (<= 3 days), verify-on-notify,
   TRACK          push to Telegram, tracking in D1, CV factory -> Doc in Drive
      |
      v
   HUMAN       — reviews and applies manually
```

## The 3 tracks

| Track | What it looks for |
|-------|-------------------|
| `canada_coop` | Co-op / work terms in Canada |
| `colombia_perm` | Permanent roles in Colombia for international companies |
| `contractor_usd` | Remote contractor paid in USD |

## Platform

**Cloudflare Worker** in TypeScript, managed with wrangler from this repo and
deployed via GitHub Actions. Everything on free tiers ($0/month):

- **Runtime**: one worker with `scheduled()` (pipeline, Cron Trigger 30-60 min)
  and `fetch()` (console + API, always behind login).
- **Store / config / tracking**: D1 (SQLite) with tables `companies`, `jobs`,
  `blocks`, `config` and versioned migrations.
- **Console**: web console served by the same worker (login via Cloudflare
  Access) — job tracking, companies, profile tuning, and the blocks bank.
- **AI**: Gemini API free tier, only over survivors; JSON output forced by
  `responseSchema`. For the CV, the AI **selects pre-approved phrases, never
  writes them**.
- **CV**: Docs generated in Drive via a service account (deterministic render
  over a template; the only Google dependency).
- **Notification**: Telegram Bot API.

## Setup

1. **ATS tokens** — no account needed: the token is the slug of the board's
   public URL (`boards.greenhouse.io/{token}`, `jobs.lever.co/{token}`,
   `jobs.ashbyhq.com/{token}`). They are registered in the `companies` table.
2. **Cloudflare** — account with Workers + D1; API token for the deploy (GitHub
   Actions secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`).
3. **Telegram bot** — create it with @BotFather, copy the token; obtain the
   `chat_id` via `https://api.telegram.org/bot<token>/getUpdates` after sending
   the bot a message.
4. **Gemini API key** — free tier (AI Studio).
5. **Google Docs (CV factory)** — GCP service account; the data account shares
   the Drive folder and the CV template as editor with the service account.
6. **Worker secrets** (via `wrangler secret put`, never in the repo):
   `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `GEMINI_API_KEY`,
   `GOOGLE_SA_KEY`, `DRIVE_FOLDER_ID`, `CV_TEMPLATE_DOC_ID`. Tuning
   (including `FRESHNESS_MAX_DAYS`) lives in the `config` table.

## Repo structure

```
seekerware/
├── README.md / CLAUDE.md / .mcp.json
├── docs/                      # documentation (see index below)
├── wrangler.jsonc             # (step 1) worker config + bindings
├── package.json / tsconfig.json
├── migrations/                # (step 1) versioned D1 schema
├── src/
│   ├── index.ts               # (step 1) entrypoint: scheduled() + fetch()
│   ├── connectors/            # (steps 1 and 5) greenhouse.ts -> lever.ts + ashby.ts
│   ├── scoring.ts             # (step 2) rules engine + tracks
│   ├── pipeline.ts            # (step 3) run orchestration
│   ├── freshness.ts           # (step 3) freshness + verify-on-notify + auto-expire
│   ├── store.ts               # (steps 1-3) D1 access
│   ├── notify.ts              # (step 3) Telegram
│   ├── dashboard/             # (steps 4 and 7) web console
│   ├── ia/                    # (step 6) gemini.ts + agents.ts + cv_factory.ts
│   └── gdocs.ts               # (step 6) service account + Docs/Drive REST
└── test/                      # vitest + feed fixtures
```

## Documentation

| Document | Contents |
|----------|----------|
| [`CLAUDE.md`](CLAUDE.md) | Working rules for agents; code = source of truth |
| [`docs/CONVENTIONS.md`](docs/CONVENTIONS.md) | Canonical glossary and code/docs/commit conventions |
| [`docs/PRD.md`](docs/PRD.md) | Product: functional model, tracks, requirements, non-goals |
| [`docs/TRD.md`](docs/TRD.md) | Technical: connectors, scoring, AI, store, dashboard, errors |
| [`docs/DATABASE.md`](docs/DATABASE.md) | D1 as the database: tables, columns, states |
| [`docs/UI.md`](docs/UI.md) | Telegram, dashboard, CV Doc |
| [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) | Steps, acceptance criteria, inputs, decisions |

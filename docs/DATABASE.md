# DATABASE — Seekerware

The system store is **a single D1 database (Cloudflare's serverless SQLite)**,
the worker's `DB` binding, with the schema versioned in `migrations/`.
Terminology in [`CONVENTIONS.md`](CONVENTIONS.md).

---

## 1. Principles

- One single database. Core tables: `companies`, `jobs`, `anchors`, `blocks`,
  `config`. Observability (§9): `runs`, `events`, `notifications`.
  Applications (§10): `applications`, `job_events`. Console: `config_history`
  (§11). Future: `cvs` (step 6), `answers` (step 8) — §12.
- Every schema change is a versioned migration (`wrangler d1 migrations`);
  never manual DDL against production.
- Access ONLY via `src/store.ts`: prepared statements with bindings;
  `db.batch()` for the run's writes.
- Each column has ONE writer: either the user (via the dashboard) or the system
  (marked below).
- No personal data of the owner beyond the operational (the blocks are CV
  content he has approved; the database and the dashboard are private).

## 2. `companies` table — companies to watch

| Column | Type | Writer | Description |
|--------|------|--------|-------------|
| id | INTEGER PK | system | Autoincrement |
| name | TEXT | user | Human-readable company name |
| ats | TEXT enum `greenhouse\|lever\|ashby` | user | Connector to use |
| token | TEXT | user | Slug of the ATS public board |
| active | INTEGER 0/1 | user | 0 = not polled |
| notes | TEXT | user | Free text |
| last_ok_fetch | TEXT (ISO) | system | Last successful feed fetch; governs auto-expire (§6) |
| fail_count | INTEGER | system | Consecutive failures; triggers the MAINTENANCE message when the threshold is exceeded |
| fetch_ok_total / fetch_fail_total | INTEGER | system | Accumulators for the success rate (health in the console) |
| last_fail / last_error | TEXT | system | Last failure and its message (visible in `/companies` without going to the log) |

```sql
CREATE TABLE companies (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  ats           TEXT NOT NULL CHECK (ats IN ('greenhouse','lever','ashby')),
  token         TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  notes         TEXT,
  last_ok_fetch TEXT,
  fail_count    INTEGER NOT NULL DEFAULT 0,
  UNIQUE (ats, token)
);
-- 0003 (step 3): company observability
ALTER TABLE companies ADD COLUMN fetch_ok_total   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE companies ADD COLUMN fetch_fail_total INTEGER NOT NULL DEFAULT 0;
ALTER TABLE companies ADD COLUMN last_fail        TEXT;
ALTER TABLE companies ADD COLUMN last_error       TEXT;
```

## 3. `jobs` table — the store

Key: `url_hash` (SHA-256 of the canonical URL, without query params). All
columns are written by the system; the only user edit (via the dashboard):
`status` to `skipped`.

| Column | Type | Description |
|--------|------|-------------|
| url_hash | TEXT PK | Job identity for dedup |
| url | TEXT | Canonical URL |
| company_id | INTEGER FK -> companies | Source company |
| ats / ext_id | TEXT | ATS and the job's external ID in the ATS |
| title / location | TEXT | From the feed |
| posted_at | TEXT (ISO) | From the correct field per ATS (TRD §2); NULL if not reliable |
| freshness_ok | TEXT `true\|unknown` | `unknown` = no reliable date; first_seen was used |
| track | TEXT | Best track that passed the gates |
| score | INTEGER 0-100 | From the rules engine |
| verdict | TEXT enum | Apply / Stretch-worth-it / Skip |
| status | TEXT enum | See the state machine (§4) |
| first_seen / last_seen | TEXT (ISO) | Lifecycle in the feed. `last_seen` is stamped ON CLOSE (last confirmed presence, max error of one interval); for open jobs presence is guaranteed by auto-expire — writing it every run would cost >100k rows/day (decision 2026-07-17, D1 quota) |
| notified_at | TEXT (ISO) | When it was sent to Telegram |
| cv_doc_url | TEXT | Generated Doc (Apply only); cache of the latest — history in `cvs` (step 6) |
| cv_pending | INTEGER 0/1 | 1 = the CV was left pending (Gemini down); retried on the next run |
| why_it_fits / positioning_lead | TEXT | Final version sent (rule-based or enriched) |
| description_text | TEXT | Plain text of the description (post stripHtml) — enables replay, why-not, prep, radar. Written ONCE on ingest |
| score_breakdown | TEXT JSON | Full ScoreResult from the engine (matches per category, gates per track, verdicts) — transparency and replay |
| title_norm | TEXT | Normalized title (lowercase, without parentheses or seniority tokens) — similar-jobs radar |
| cv_pdf_key | TEXT | Latest `generated` snapshot in R2 (step 6) |

```sql
CREATE TABLE jobs (
  url_hash         TEXT PRIMARY KEY,
  url              TEXT NOT NULL,
  company_id       INTEGER NOT NULL REFERENCES companies(id),
  ats              TEXT NOT NULL,
  ext_id           TEXT,
  title            TEXT NOT NULL,
  location         TEXT,
  posted_at        TEXT,
  freshness_ok     TEXT NOT NULL DEFAULT 'unknown'
                     CHECK (freshness_ok IN ('true','unknown')),
  track            TEXT,
  score            INTEGER,
  verdict          TEXT CHECK (verdict IN ('Apply','Stretch-worth-it','Skip')),
  status           TEXT NOT NULL
                     CHECK (status IN ('new','notified','closed','skipped')),
  first_seen       TEXT NOT NULL,
  last_seen        TEXT NOT NULL,
  notified_at      TEXT,
  cv_doc_url       TEXT,
  cv_pending       INTEGER NOT NULL DEFAULT 0,
  why_it_fits      TEXT,
  positioning_lead TEXT
);
CREATE INDEX idx_jobs_status  ON jobs (status);
CREATE INDEX idx_jobs_company ON jobs (company_id, last_seen);
-- 0002 (step 2): scoring/console fields — impossible to reconstruct later
ALTER TABLE jobs ADD COLUMN description_text TEXT;
ALTER TABLE jobs ADD COLUMN score_breakdown  TEXT;
ALTER TABLE jobs ADD COLUMN title_norm       TEXT;
-- 0005 (step 6): R2 archive
ALTER TABLE jobs ADD COLUMN cv_pdf_key TEXT;
```

## 4. `jobs.status` state machine

```
                    (verdict Skip, or first-run seeding, or manual)
        new job ─────────────────────────────────────────> skipped
            │
            │ (verdict Apply|Stretch + freshness + verify-on-notify OK
            │  + successful Telegram push)
            v
           new ──────────────────────────────────────────> notified
            │                                                  │
            │ (absent from feed with fetch OK,                 │ (idem)
            │  or verify-on-notify failed)                     │
            v                                                  v
          closed <─────────────────────────────────────────────
```

- `closed` is terminal: if the job reappears in the feed, `last_seen` is
  updated but it is NOT re-notified (anti-spam).
- Verdicts are computed when the job is discovered; config changes apply to
  future jobs (manual re-score: future evolution).

## 5. `anchors` and `blocks` tables — the blocks bank

The bank is the core asset of the CV layer: the canonical, governed record,
with evidence, of the owner's professional claims. Model: one **fact**
(verifiable fact, with a single exact metric) can have several **blocks**
(approved phrasings), differentiated by **angle** (the projection they serve)
and language. The select-only guarantee is only as good as the completeness and
accuracy of this bank.

### `anchors` — registry of real roles and projects

| Column | Type | Writer | Description |
|--------|------|--------|-------------|
| id | TEXT PK | user | e.g. `scotiatech-2021`, `prj-chequeguardai` |
| kind | TEXT enum `role\|project` | user | Anchor type |
| company / dates | TEXT | user | Render metadata |
| titles | TEXT JSON | user | Titles shown per market: `{internal, market_canada, market_colombia, contractor}` — the anchor is neutral; the title is a projection |

```sql
CREATE TABLE anchors (
  id      TEXT PRIMARY KEY,
  kind    TEXT NOT NULL CHECK (kind IN ('role','project')),
  company TEXT,
  dates   TEXT,
  titles  TEXT  -- JSON {internal, market_canada, market_colombia, contractor}
);
```

### `blocks` — approved phrasings of facts

| Column | Type | Writer | Description |
|--------|------|--------|-------------|
| id | TEXT PK | user | `{sec}-{anchor\|topic}-{nn}[-{angle}]`, e.g. `exp-scotiatech-01-data` |
| section | TEXT enum `summary\|skills\|experience\|projects` | user | CV section |
| anchor_id | TEXT FK -> anchors | user | Null in summary/skills |
| fact_key | TEXT | user | Groups all phrasings/languages of the same fact |
| angle | TEXT enum `data\|compliance\|operations\|leadership` or NULL | user | The projection this phrasing serves |
| text_en / text_es | TEXT | user | Phrasings of the SAME fact in each language (parity required) |
| es_status | TEXT enum `missing\|draft\|approved` | user | ES parity status |
| tags | TEXT csv | user | Controlled vocabulary SHARED with `config` (domain/tool/signal families + track-fit) |
| evidence | TEXT | user | Real verifiable fact backing the claim |
| source | TEXT | user | Provenance (CV variant, portfolio case, project) |
| status | TEXT enum `draft\|review\|approved\|retired` | user | Lifecycle; only `approved` enters the cv_selector enum; `retired` is never deleted (audit trail) |
| suggested | TEXT | system | AI proposal (tweak or new block) pending review; NEVER used in render |
| updated_at | TEXT ISO | system | Last modification |

```sql
CREATE TABLE blocks (
  id         TEXT PRIMARY KEY,
  section    TEXT NOT NULL
               CHECK (section IN ('summary','skills','experience','projects')),
  anchor_id  TEXT REFERENCES anchors(id),
  fact_key   TEXT NOT NULL,
  angle      TEXT CHECK (angle IN ('data','compliance','operations','leadership')),
  text_en    TEXT,
  text_es    TEXT,
  es_status  TEXT NOT NULL DEFAULT 'missing'
               CHECK (es_status IN ('missing','draft','approved')),
  tags       TEXT,
  evidence   TEXT,
  source     TEXT,
  status     TEXT NOT NULL DEFAULT 'draft'
               CHECK (status IN ('draft','review','approved','retired')),
  suggested  TEXT,
  updated_at TEXT
);
```

The fact registry (fact_key -> fact + exact metric + evidence + source) lives
in the bank's master document (the owner's private resource, outside the repo);
`fact_key` references it from D1.

## 6. `config` table — rules-engine tuning and operation

Key/value with JSON in `value`; editable from the dashboard without a deploy
and parseable in a single read per run.

```sql
CREATE TABLE config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL   -- JSON
);
```

Contents: category weights, keywords per category with weight, track and gate
definitions, verdict thresholds (`apply=75`, `stretch=55` initial),
`title_multiplier` (2.0), `FRESHNESS_MAX_DAYS` (=3, operation). The detail of
the keys and JSON sub-formats **is decided in build 2** with real jobs.

## 7. Integrity rules

- `url_hash` is the PK: existing -> only update `last_seen` (dedup by
  construction).
- Auto-expire ONLY over companies with a successful fetch in the run.
- A company's first run: seeding with `status = 'skipped'`, without notifying.
- `closed` is not reopened nor re-notified.
- The cv_selector only sees blocks with `status = 'approved'`.
- An `approved` block MUST have `evidence`, `fact_key`, and >= 1 tag.
- Rendering in ES requires `es_status = 'approved'` on all selected blocks
  (parity report before rendering colombia_perm).
- `retired` is never deleted (bank audit trail).
- The run's writes in `db.batch()` (per-batch atomicity).

## 8. Limits and scale

D1 free tier: 5 GB of storage, 5M row reads/day, 100k row writes/day — orders
of magnitude above the use case (dozens of companies, hundreds of jobs/day). If
`jobs` grows too large over the years, annual archiving to a `jobs_archive`
table (future evolution). Full observability (§9) consumes ~1-5k writes/day ≈
1-5% of the budget.

## 9. Observability — `runs`, `events`, `notifications` (migration 0003, step 3)

Principle: **the console can only show what is in D1** (the worker cannot read
its own Cloudflare metrics). Instrumentation pattern: in-memory counters during
the run (`RunStats` + `trackedFetch` + `meta.rows_read/rows_written` from each
D1 result — exact accounting, free) and ONE single flush inside the final
`db.batch()`. The `runs` row is inserted at the START of the run; if the
isolate dies, the next run marks it `crashed` (the crash is data, not silence).
Detail: TRD §Instrumentation and
`docs/audits/2026-07-17-diseno-monitoreo-datos.md`.

```sql
CREATE TABLE runs (
  id              INTEGER PRIMARY KEY,
  started_at      TEXT NOT NULL,
  finished_at     TEXT,
  status          TEXT NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running','ok','partial','fail','crashed')),
  trigger         TEXT NOT NULL DEFAULT 'cron'
                    CHECK (trigger IN ('cron','manual')),
  duration_ms     INTEGER,
  companies_total INTEGER NOT NULL DEFAULT 0,
  companies_ok    INTEGER NOT NULL DEFAULT 0,
  companies_fail  INTEGER NOT NULL DEFAULT 0,
  jobs_seen       INTEGER NOT NULL DEFAULT 0,
  jobs_new        INTEGER NOT NULL DEFAULT 0,
  jobs_scored     INTEGER NOT NULL DEFAULT 0,
  survivors       INTEGER NOT NULL DEFAULT 0,
  notified        INTEGER NOT NULL DEFAULT 0,
  closed          INTEGER NOT NULL DEFAULT 0,
  subrequests     INTEGER NOT NULL DEFAULT 0,
  d1_reads        INTEGER NOT NULL DEFAULT 0,
  d1_writes       INTEGER NOT NULL DEFAULT 0,
  gemini_calls    INTEGER NOT NULL DEFAULT 0,
  errors          INTEGER NOT NULL DEFAULT 0,
  error_summary   TEXT
);
CREATE INDEX idx_runs_started ON runs (started_at);

CREATE TABLE events (
  id         INTEGER PRIMARY KEY,
  run_id     INTEGER REFERENCES runs(id),
  ts         TEXT NOT NULL,
  type       TEXT NOT NULL CHECK (type IN (
               'fetch_fail','parse_fail','verify_dead','verify_fail',
               'gemini_fallback','gemini_fail','gdocs_fail','r2_fail',
               'telegram_fail','maintenance_alert','quota_warn','run_crash',
               'config_change','digest_sent','prune')),
  severity   TEXT NOT NULL CHECK (severity IN ('info','warn','error')),
  company_id INTEGER REFERENCES companies(id),
  url_hash   TEXT,
  detail     TEXT
);
CREATE INDEX idx_events_ts      ON events (ts);
CREATE INDEX idx_events_company ON events (company_id, ts);

CREATE TABLE notifications (
  id            INTEGER PRIMARY KEY,
  run_id        INTEGER REFERENCES runs(id),
  url_hash      TEXT,
  kind          TEXT NOT NULL CHECK (kind IN ('job','maintenance','digest')),
  ts            TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('sent','fail')),
  tg_message_id INTEGER,
  error         TEXT
);
CREATE INDEX idx_notifications_ts ON notifications (ts);
```

Rules: `events.detail` short and readable — NEVER full payloads, secrets, or
personal data. If Telegram fails, the job stays `new` (retries on the next
run); the log makes the retry visible. Per-company health and ROI are DERIVED
at read time (aggregates over `jobs`, 90-day window) — not duplicated.

## 10. Applications — `applications` + `job_events` (migration 0004, step 4)

The USER's lifecycle, parallel to `jobs.status` (which remains 100% the
system's — the one-writer-per-column rule is preserved by splitting tables).
The human ALWAYS submits the application (CLAUDE.md §7.8); these tables record
their process, not submissions by the system.

```sql
CREATE TABLE applications (
  url_hash      TEXT PRIMARY KEY REFERENCES jobs(url_hash),
  stage         TEXT NOT NULL DEFAULT 'prepared'
                  CHECK (stage IN ('prepared','applied','interview',
                                   'offer','rejected','dismissed')),
  applied_at    TEXT,
  interview_at  TEXT,
  outcome_at    TEXT,
  follow_up_at  TEXT,
  snoozed_until TEXT,
  cv_pdf_key    TEXT,   -- R2 'submitted' snapshot: the EXACT CV sent (step 6)
  notes         TEXT,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_applications_stage ON applications (stage);

-- Append-only history of jobs AND applications: NEVER deleted or updated.
CREATE TABLE job_events (
  id       INTEGER PRIMARY KEY,
  url_hash TEXT NOT NULL,
  ts       TEXT NOT NULL,
  actor    TEXT NOT NULL CHECK (actor IN ('user','system')),
  event    TEXT NOT NULL,   -- e.g. notified, stage:applied, snoozed, note
  detail   TEXT
);
CREATE INDEX idx_job_events_hash ON job_events (url_hash, ts);
```

Writers: `applications` is written by the user (via console/Telegram);
`job_events` by both, each row declaring its `actor`.

## 11. Configuration history — `config_history` (migration 0004)

```sql
CREATE TABLE config_history (
  id             INTEGER PRIMARY KEY,
  ts             TEXT NOT NULL,
  key            TEXT NOT NULL,
  old_value      TEXT,
  new_value      TEXT NOT NULL,
  replay_summary TEXT   -- JSON of the replay summary at save time (if any)
);
```

Written on every save from the console; enables "revert to this version".

## 12. Future tables and retention

- **`cvs`** (step 6): one generated CV per row — `url_hash`, `doc_url`, `lang`,
  `pdf_key`, `blocks_used` JSON, `verifier_notes`, `rationale`, `created_at`,
  `superseded_by`, `pending`. Replaces `jobs.cv_doc_url` as history (which
  remains the cache of the latest).
- **`answers`** (step 8): answer bank for forms — governance identical to
  `blocks` (owner authorship, draft/approved, EN/ES with parity); the system
  selects, NEVER writes.
- **Retention** (executed by the day's first run, `prune` event):
  `runs` 400 days · `events` 90 days · `notifications` 180 days ·
  `applications`/`job_events` NEVER (audit trail) · `jobs` unchanged.
- **Operational `config` keys**: `quota_limits` (editable free-tier limits),
  `observability` (alert thresholds, Monday digest ~06:00 America/Bogota,
  retention), `weekly_goal` (weekly application target, initially 5).

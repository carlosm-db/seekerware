-- Migration number: 0001   Consolidated schema (repo cleanup): the current
-- published reality of the D1, not the incremental history. Prod already has
-- 0001..0010 recorded, so `wrangler d1 migrations apply` treats this as applied
-- (no-op); a fresh DB builds the whole schema from this single file.

CREATE TABLE companies (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL,
  ats TEXT NOT NULL CHECK (ats IN ('greenhouse','lever','ashby')),
  token TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, notes TEXT,
  last_ok_fetch TEXT, fail_count INTEGER NOT NULL DEFAULT 0,
  fetch_ok_total INTEGER NOT NULL DEFAULT 0, fetch_fail_total INTEGER NOT NULL DEFAULT 0,
  last_fail TEXT, last_error TEXT,
  UNIQUE (ats, token)
);

CREATE TABLE jobs (
  url_hash TEXT PRIMARY KEY, url TEXT NOT NULL,
  company_id INTEGER NOT NULL REFERENCES companies(id), ats TEXT NOT NULL,
  ext_id TEXT, title TEXT NOT NULL, location TEXT, posted_at TEXT,
  freshness_ok TEXT NOT NULL DEFAULT 'unknown' CHECK (freshness_ok IN ('true','unknown')),
  track TEXT, score INTEGER,
  verdict TEXT CHECK (verdict IN ('Apply','Stretch-worth-it','Skip')),
  status TEXT NOT NULL CHECK (status IN ('new','notified','closed','skipped')),
  first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, notified_at TEXT,
  cv_doc_url TEXT, cv_pending INTEGER NOT NULL DEFAULT 0,
  why_it_fits TEXT, positioning_lead TEXT,
  description_text TEXT, score_breakdown TEXT, title_norm TEXT, cv_pdf_key TEXT
);
CREATE INDEX idx_jobs_status      ON jobs (status);
CREATE INDEX idx_jobs_company     ON jobs (company_id, last_seen);
CREATE INDEX idx_jobs_first_seen  ON jobs (first_seen);
CREATE INDEX idx_jobs_notified_at ON jobs (notified_at);
CREATE INDEX idx_jobs_title_norm  ON jobs (title_norm);

CREATE TABLE anchors (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('role','project')),
  company TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  retired_at TEXT, title TEXT, date_from TEXT, date_to TEXT
);

CREATE TABLE blocks (
  id TEXT PRIMARY KEY,
  section TEXT NOT NULL CHECK (section IN ('summary','skills','experience','projects')),
  anchor_id TEXT REFERENCES anchors(id), text_en TEXT, text_es TEXT,
  es_status TEXT NOT NULL DEFAULT 'missing' CHECK (es_status IN ('missing','draft','approved')),
  tags TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','review','approved','retired')),
  updated_at TEXT,
  skcat TEXT CHECK (skcat IN ('technical','methodologies','academic','emerging'))
);

CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE runs (
  id INTEGER PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','ok','partial','fail','crashed')),
  trigger TEXT NOT NULL DEFAULT 'cron' CHECK (trigger IN ('cron','manual')),
  duration_ms INTEGER, companies_total INTEGER NOT NULL DEFAULT 0,
  companies_ok INTEGER NOT NULL DEFAULT 0, companies_fail INTEGER NOT NULL DEFAULT 0,
  jobs_seen INTEGER NOT NULL DEFAULT 0, jobs_new INTEGER NOT NULL DEFAULT 0,
  jobs_scored INTEGER NOT NULL DEFAULT 0, survivors INTEGER NOT NULL DEFAULT 0,
  notified INTEGER NOT NULL DEFAULT 0, closed INTEGER NOT NULL DEFAULT 0,
  subrequests INTEGER NOT NULL DEFAULT 0, d1_reads INTEGER NOT NULL DEFAULT 0,
  d1_writes INTEGER NOT NULL DEFAULT 0, gemini_calls INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0, error_summary TEXT
);
CREATE INDEX idx_runs_started ON runs (started_at);

CREATE TABLE events (
  id INTEGER PRIMARY KEY, run_id INTEGER REFERENCES runs(id), ts TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN (
    'fetch_fail','parse_fail','verify_dead','verify_fail','gemini_fallback',
    'gemini_fail','gdocs_fail','r2_fail','telegram_fail','maintenance_alert',
    'quota_warn','run_crash','config_change','digest_sent','prune')),
  severity TEXT NOT NULL CHECK (severity IN ('info','warn','error')),
  company_id INTEGER REFERENCES companies(id), url_hash TEXT, detail TEXT
);
CREATE INDEX idx_events_ts      ON events (ts);
CREATE INDEX idx_events_company ON events (company_id, ts);

CREATE TABLE notifications (
  id INTEGER PRIMARY KEY, run_id INTEGER REFERENCES runs(id), url_hash TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('job','maintenance','digest')),
  ts TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('sent','fail')),
  tg_message_id INTEGER, error TEXT
);
CREATE INDEX idx_notifications_ts ON notifications (ts);

CREATE TABLE applications (
  url_hash TEXT PRIMARY KEY REFERENCES jobs(url_hash),
  stage TEXT NOT NULL DEFAULT 'prepared'
    CHECK (stage IN ('prepared','applied','interview','offer','rejected','dismissed')),
  applied_at TEXT, interview_at TEXT, outcome_at TEXT, follow_up_at TEXT,
  snoozed_until TEXT, cv_pdf_key TEXT, notes TEXT, updated_at TEXT NOT NULL
);
CREATE INDEX idx_applications_stage ON applications (stage);

CREATE TABLE job_events (
  id INTEGER PRIMARY KEY, url_hash TEXT NOT NULL, ts TEXT NOT NULL,
  actor TEXT NOT NULL CHECK (actor IN ('user','system')), event TEXT NOT NULL, detail TEXT
);
CREATE INDEX idx_job_events_hash ON job_events (url_hash, ts);

CREATE TABLE config_history (
  id INTEGER PRIMARY KEY, ts TEXT NOT NULL, key TEXT NOT NULL,
  old_value TEXT, new_value TEXT NOT NULL, replay_summary TEXT, diff_summary TEXT
);

CREATE TABLE cvs (
  id INTEGER PRIMARY KEY, url_hash TEXT NOT NULL REFERENCES jobs(url_hash),
  doc_id TEXT NOT NULL, doc_url TEXT NOT NULL,
  lang TEXT NOT NULL CHECK (lang IN ('en','es')),
  pdf_file_id TEXT, blocks_used TEXT, verifier_notes TEXT, rationale TEXT,
  sample INTEGER NOT NULL DEFAULT 0, pending INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, superseded_by INTEGER REFERENCES cvs(id)
);
CREATE INDEX idx_cvs_hash ON cvs (url_hash, created_at);

CREATE TABLE profile_answers (
  id INTEGER PRIMARY KEY, question_norm TEXT NOT NULL UNIQUE, question_label TEXT NOT NULL,
  answer_en TEXT, answer_es TEXT, tags TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved')),
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_profile_answers_status ON profile_answers (status);

CREATE TABLE application_kits (
  url_hash TEXT PRIMARY KEY REFERENCES jobs(url_hash),
  positioning TEXT, answers TEXT, red_questions TEXT, eeoc_questions TEXT,
  cv_doc_url TEXT, cv_pdf_id TEXT, deep_link TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

-- Neutral operational defaults (from old 0003; editable in the console).
INSERT OR IGNORE INTO config (key, value) VALUES
  ('quota_limits', '{"subrequests_per_invocation":50,"d1_reads_day":5000000,"d1_writes_day":100000,"gemini_rpd":1000,"workers_invocations_day":100000}'),
  ('observability', '{"maintenance_fail_streak":3,"subrequests_warn":40,"quota_warn_pct":80,"cv_pending_max":3,"digest":{"dow":1,"hour_utc":11},"retention_days":{"runs":400,"events":90,"notifications":180}}'),
  ('poll_page_size', '25');

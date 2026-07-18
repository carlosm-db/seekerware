-- Migration number: 0003 	 Observability (DATABASE.md §9) + company health

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

ALTER TABLE companies ADD COLUMN fetch_ok_total   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE companies ADD COLUMN fetch_fail_total INTEGER NOT NULL DEFAULT 0;
ALTER TABLE companies ADD COLUMN last_fail        TEXT;
ALTER TABLE companies ADD COLUMN last_error       TEXT;

-- Neutral operational defaults (editable without deploy)
INSERT OR IGNORE INTO config (key, value) VALUES
  ('quota_limits', '{"subrequests_per_invocation":50,"d1_reads_day":5000000,"d1_writes_day":100000,"gemini_rpd":1000,"workers_invocations_day":100000}'),
  ('observability', '{"maintenance_fail_streak":3,"subrequests_warn":40,"quota_warn_pct":80,"cv_pending_max":3,"digest":{"dow":1,"hour_utc":11},"retention_days":{"runs":400,"events":90,"notifications":180}}'),
  ('poll_page_size', '25');

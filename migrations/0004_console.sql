-- Migration number: 0004 	 Consola v1 (DATABASE.md §10-§11)

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
  cv_pdf_key    TEXT,
  notes         TEXT,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_applications_stage ON applications (stage);

CREATE TABLE job_events (
  id       INTEGER PRIMARY KEY,
  url_hash TEXT NOT NULL,
  ts       TEXT NOT NULL,
  actor    TEXT NOT NULL CHECK (actor IN ('user','system')),
  event    TEXT NOT NULL,
  detail   TEXT
);
CREATE INDEX idx_job_events_hash ON job_events (url_hash, ts);

CREATE TABLE config_history (
  id             INTEGER PRIMARY KEY,
  ts             TEXT NOT NULL,
  key            TEXT NOT NULL,
  old_value      TEXT,
  new_value      TEXT NOT NULL,
  replay_summary TEXT
);

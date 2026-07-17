-- Migration number: 0001 	 Schema inicial: 5 tablas segun docs/DATABASE.md

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

CREATE TABLE anchors (
  id      TEXT PRIMARY KEY,
  kind    TEXT NOT NULL CHECK (kind IN ('role','project')),
  company TEXT,
  dates   TEXT,
  titles  TEXT
);

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

CREATE TABLE config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

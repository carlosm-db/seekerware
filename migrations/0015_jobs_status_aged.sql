-- 0015: allow jobs.status = 'aged' — a survivor first stored already older than the notify
-- window (FRESHNESS_MAX_DAYS) but within the store window (STORE_MAX_DAYS): browsable in the
-- console, never notified. SQLite cannot ALTER a CHECK, so recreate `jobs` with the status
-- CHECK widened to include 'aged'. All other columns, CHECKs, data and indexes are preserved.
--
-- HOW TO APPLY (see docs/CLAUDE-ERRORS.md, 2026-07-19): D1 enforces foreign keys and
-- jobs.url_hash is referenced by applications, cvs and application_kits. `PRAGMA
-- foreign_keys=OFF` is a NO-OP inside a migration transaction, and `defer_foreign_keys` has a
-- DROP+RENAME counter bug — so on the PROD (populated) DB this recreate must be run MANUALLY in
-- autocommit, where the leading `foreign_keys=OFF` takes effect:
--     wrangler d1 execute seekerware --remote --file=migrations/0015_jobs_status_aged.sql
-- then mark it applied so CI's `migrations apply` skips it:
--     wrangler d1 execute seekerware --remote --command "INSERT INTO d1_migrations (name) VALUES ('0015_jobs_status_aged.sql')"
-- (On a fresh/empty DB it is ALSO safe via `migrations apply`: no rows -> the DROP orphans nothing.)

PRAGMA foreign_keys=OFF;

CREATE TABLE jobs_new (
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
                     CHECK (status IN ('new','notified','aged','closed','skipped')),
  first_seen       TEXT NOT NULL,
  last_seen        TEXT NOT NULL,
  notified_at      TEXT,
  cv_doc_url       TEXT,
  cv_pending       INTEGER NOT NULL DEFAULT 0,
  why_it_fits      TEXT,
  positioning_lead TEXT,
  description_text TEXT,
  score_breakdown  TEXT,
  title_norm       TEXT,
  cv_pdf_key       TEXT,
  enriched_by      TEXT,
  role_analysis    TEXT
);

INSERT INTO jobs_new
  (url_hash, url, company_id, ats, ext_id, title, location, posted_at, freshness_ok,
   track, score, verdict, status, first_seen, last_seen, notified_at, cv_doc_url,
   cv_pending, why_it_fits, positioning_lead, description_text, score_breakdown,
   title_norm, cv_pdf_key, enriched_by, role_analysis)
SELECT
   url_hash, url, company_id, ats, ext_id, title, location, posted_at, freshness_ok,
   track, score, verdict, status, first_seen, last_seen, notified_at, cv_doc_url,
   cv_pending, why_it_fits, positioning_lead, description_text, score_breakdown,
   title_norm, cv_pdf_key, enriched_by, role_analysis
FROM jobs;

DROP TABLE jobs;
ALTER TABLE jobs_new RENAME TO jobs;

CREATE INDEX idx_jobs_status      ON jobs (status);
CREATE INDEX idx_jobs_company     ON jobs (company_id, last_seen);
CREATE INDEX idx_jobs_first_seen  ON jobs (first_seen);
CREATE INDEX idx_jobs_notified_at ON jobs (notified_at);
CREATE INDEX idx_jobs_title_norm  ON jobs (title_norm);

PRAGMA foreign_keys=ON;

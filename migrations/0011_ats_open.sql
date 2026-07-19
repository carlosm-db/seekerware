-- 0011: allow any connector-backed ATS value (adds 'successfactors', 'workday', and
-- future connectors, with no further migration). SQLite cannot ALTER a CHECK, so
-- recreate `companies` WITHOUT the ats CHECK — the connector registry
-- (src/connectors/index.ts) is now the single source of truth for valid ATS.
-- Data and UNIQUE(ats, token) are preserved.
--
-- Numbered 0011 (not 0002): prod's d1_migrations already recorded 0001..0010 before
-- the repo squashed the incremental migrations into a single 0001_initial.sql, so a
-- NEW migration must sort AFTER 0010 or `wrangler d1 migrations apply` fails
-- out-of-order. No PRAGMA statements — D1 rejects them over its HTTP API and does not
-- enforce foreign keys by default, so the drop/rename is safe as-is.

CREATE TABLE companies_new (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  ats           TEXT NOT NULL,
  token         TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  notes         TEXT,
  last_ok_fetch TEXT,
  fail_count    INTEGER NOT NULL DEFAULT 0,
  fetch_ok_total   INTEGER NOT NULL DEFAULT 0,
  fetch_fail_total INTEGER NOT NULL DEFAULT 0,
  last_fail        TEXT,
  last_error       TEXT,
  UNIQUE (ats, token)
);

INSERT INTO companies_new
  (id, name, ats, token, active, notes, last_ok_fetch, fail_count,
   fetch_ok_total, fetch_fail_total, last_fail, last_error)
SELECT
  id, name, ats, token, active, notes, last_ok_fetch, fail_count,
  fetch_ok_total, fetch_fail_total, last_fail, last_error
FROM companies;

DROP TABLE companies;
ALTER TABLE companies_new RENAME TO companies;

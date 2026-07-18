-- 0009: role identity (2026-07-18 Bank redesign, mockups v3.3).
-- 0007 dropped the original anchors.titles/dates because nothing read them.
-- The Bank now SHOWS role identity — title · company · dates, newest first —
-- so identity returns as first-class nullable columns the console reads and
-- writes ('/roles/create', '/roles/update').
-- Format: 'YYYY-MM' (month inputs); date_to NULL = current role (sorts first).
ALTER TABLE anchors ADD COLUMN title TEXT;
ALTER TABLE anchors ADD COLUMN date_from TEXT;
ALTER TABLE anchors ADD COLUMN date_to TEXT;

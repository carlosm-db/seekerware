-- Drop config_history: the calibration change-history + revert UI was removed
-- (owner decision — unwanted clutter). No table references config_history (no
-- inbound foreign key), so a plain DROP is safe for `wrangler d1 migrations apply`.
--
-- Numbered 0012 to sort AFTER prod's highest recorded migration (0011); the
-- consolidated 0001 still CREATEs the table, so a fresh DB creates then drops it.
DROP TABLE IF EXISTS config_history;

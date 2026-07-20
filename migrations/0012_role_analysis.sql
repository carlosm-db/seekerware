-- 0012: job_analyst stores a structured role analysis per notified survivor
-- (JSON: must_haves, nice_to_haves, seniority, domain_signals, positioning_angle,
-- screening_topics), reused by cv_selector and cv_verifier. Nullable — older jobs
-- stay NULL and the CV agents fall back to the raw job (backward-compatible).
-- A plain ADD COLUMN is safe in D1: no table rebuild, no foreign-key touch.
--
-- Numbered after 0011 (see that file): prod's d1_migrations recorded 0001..0010
-- before the incremental migrations were squashed into 0001, so any NEW migration
-- must sort past the highest applied one.

ALTER TABLE jobs ADD COLUMN role_analysis TEXT;

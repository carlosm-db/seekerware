-- 0016: `canada_coop` was a misnomer — its only gate was `location_canada`, so it routed EVERY job in
-- Canada (5,302 of 6,870 stored jobs), not co-op roles. Config v50 splits Canada into two routes:
-- `canada_coop` (location + a co-op/intern/work-term TITLE gate, own lower verdict bar) and
-- `canada_perm` (location only). Relabel the already-stored Canadian rows to the permanent route so a
-- historic row is not read as a co-op hit; from here on `canada_coop` means the co-op route.
--
-- Label-only: `jobs.track` carries no index or FK, and stored verdicts are untouched (calibration
-- changes never re-score history). Reverses with the mirror UPDATE.
UPDATE jobs SET track = 'canada_perm' WHERE track = 'canada_coop';

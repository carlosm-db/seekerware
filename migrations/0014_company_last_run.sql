-- Track which run last read each company, for the /companies health column (status · run # · hour).
-- Nullable: existing rows are backfilled on their next poll.
ALTER TABLE companies ADD COLUMN last_run_id INTEGER;

-- Cumulative companies covered in the current rotation at the time of each run, for the /health
-- coverage denominator (section + cumulative, e.g. "25/25 (50/116)"). Nullable for old rows.
ALTER TABLE runs ADD COLUMN rotation_covered INTEGER;

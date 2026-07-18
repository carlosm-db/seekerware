-- Migration number: 0002 	 Scoring/console fields (DATABASE.md §3)
-- Urgent: written on ingest/scoring and impossible to reconstruct later.

ALTER TABLE jobs ADD COLUMN description_text TEXT;
ALTER TABLE jobs ADD COLUMN score_breakdown  TEXT;
ALTER TABLE jobs ADD COLUMN title_norm       TEXT;

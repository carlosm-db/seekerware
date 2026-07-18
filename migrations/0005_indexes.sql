-- Migration number: 0005 	 Indexes for console v2 (finding from the quota review:
-- /semana, digest, replay, and the similar-jobs radar scanned the full jobs table without an index).

CREATE INDEX idx_jobs_first_seen  ON jobs (first_seen);
CREATE INDEX idx_jobs_notified_at ON jobs (notified_at);
CREATE INDEX idx_jobs_title_norm  ON jobs (title_norm);

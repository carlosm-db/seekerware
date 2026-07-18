-- 0007 — bank cleanup (2026-07-18 audits + owner decisions):
-- drop dead columns (fact_key/evidence/source/suggested/angle on blocks;
-- titles/dates on anchors — nothing reads them), promote the load-bearing
-- skill category from a tags convention to a real column, add the role
-- lifecycle (anchors.status), readable calibration history, and retire the
-- weekly_goal quota (owner: plain counts, never KPIs).

-- Skills category: real column, backfilled from the old skcat: tag convention.
ALTER TABLE blocks ADD COLUMN skcat TEXT
  CHECK (skcat IN ('technical','methodologies','academic','emerging'));
UPDATE blocks SET skcat = CASE
  WHEN tags LIKE '%skcat:technical%' THEN 'technical'
  WHEN tags LIKE '%skcat:methodologies%' THEN 'methodologies'
  WHEN tags LIKE '%skcat:academic%' THEN 'academic'
  WHEN tags LIKE '%skcat:emerging%' THEN 'emerging'
END WHERE section = 'skills';

ALTER TABLE blocks DROP COLUMN fact_key;
ALTER TABLE blocks DROP COLUMN evidence;
ALTER TABLE blocks DROP COLUMN source;
ALTER TABLE blocks DROP COLUMN suggested;
ALTER TABLE blocks DROP COLUMN angle;

-- Role lifecycle: retire instead of delete; headers live in the CV template.
ALTER TABLE anchors ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active','retired'));
ALTER TABLE anchors ADD COLUMN retired_at TEXT;
ALTER TABLE anchors DROP COLUMN titles;
ALTER TABLE anchors DROP COLUMN dates;

-- Calibration history becomes readable ("what changed", in words).
ALTER TABLE config_history ADD COLUMN diff_summary TEXT;

-- No quotas: application metrics are plain personal counts.
DELETE FROM config WHERE key = 'weekly_goal';

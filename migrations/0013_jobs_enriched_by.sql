-- Per-job AI provenance for the AI pipeline view: 'rule' (deterministic rule-based
-- texts) or the Gemini model name that enriched the notification. NULL on rows
-- written before this migration (shown as '(legacy)' in the console). ADD COLUMN is
-- safe for `wrangler d1 migrations apply` (no rebuild, no FK). Numbered past 0012.
ALTER TABLE jobs ADD COLUMN enriched_by TEXT;

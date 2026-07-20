-- 0013: answer_polisher stores per-JOB tailored versions of the matched Q&A
-- answers on the kit (JSON: [{question, suggestion}]). These are SUGGESTIONS the
-- owner reviews and uses when filling THIS application's form — they never enter
-- the generic Q&A bank (that would pollute reuse) and never auto-submit (§7.1/§7.8).
-- Nullable; a plain ADD COLUMN is safe in D1 (no rebuild, no FK touch).
--
-- Numbered after 0012 (see 0011 for the numbering rationale after the squash).

ALTER TABLE application_kits ADD COLUMN answer_suggestions TEXT;

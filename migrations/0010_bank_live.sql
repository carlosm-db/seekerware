-- 0010: the bank goes live (owner decision 2026-07-18, mockups v4).
-- Owner-authored content is approved by existing: the draft->approve cycle is
-- removed from the Bank — SAVING is the approval. Existing drafts flip to
-- approved so the whole bank is immediately eligible for CV builds
-- (cv_factory selects status='approved' + es_status='approved' for ES parity).
UPDATE blocks SET status = 'approved' WHERE status IN ('draft', 'review');
UPDATE blocks SET es_status = 'approved' WHERE text_es IS NOT NULL;

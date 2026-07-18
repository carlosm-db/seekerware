-- 0008 — step 8: application kit + answers bank (ratified L1 design,
-- docs/audits/2026-07-17-diseno-auto-apply.md). The system prepares the kit;
-- the submit click is ALWAYS human; EEOC questions are never auto-answered.

-- The owner's approved answers to recurring application-form questions.
-- Selection-only: the bot/kit may pick from here, never write prose itself
-- (owner replies in chat become DRAFT rows the owner approves in the console).
CREATE TABLE profile_answers (
  id             INTEGER PRIMARY KEY,
  question_norm  TEXT NOT NULL UNIQUE,
  question_label TEXT NOT NULL,
  answer_en      TEXT,
  answer_es      TEXT,
  tags           TEXT,
  status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved')),
  updated_at     TEXT NOT NULL
);
CREATE INDEX idx_profile_answers_status ON profile_answers (status);

-- One kit per Apply job: CV artifacts + rule-based positioning inputs +
-- matched answers + unanswered ("red") questions + deep link.
CREATE TABLE application_kits (
  url_hash       TEXT PRIMARY KEY REFERENCES jobs(url_hash),
  positioning    TEXT,  -- JSON {why_it_fits, positioning_lead}
  answers        TEXT,  -- JSON [{question, answer, source:'bank'|'chat', red}]
  red_questions  TEXT,  -- JSON [string] (unanswered, non-EEOC)
  eeoc_questions TEXT,  -- JSON [string] (flagged, NEVER auto-answered)
  cv_doc_url     TEXT,
  cv_pdf_id      TEXT,
  deep_link      TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

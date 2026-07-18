-- Migration number: 0006 	 Biblioteca de CVs (DATABASE.md §12) + archivo PDF

CREATE TABLE cvs (
  id             INTEGER PRIMARY KEY,
  url_hash       TEXT NOT NULL REFERENCES jobs(url_hash),
  doc_id         TEXT NOT NULL,
  doc_url        TEXT NOT NULL,
  lang           TEXT NOT NULL CHECK (lang IN ('en','es')),
  pdf_file_id    TEXT,
  blocks_used    TEXT,   -- JSON: ids por seccion
  verifier_notes TEXT,
  rationale      TEXT,
  sample         INTEGER NOT NULL DEFAULT 0,  -- 1 = CV de MUESTRA (blocks draft, solo revision)
  pending        INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  superseded_by  INTEGER REFERENCES cvs(id)
);
CREATE INDEX idx_cvs_hash ON cvs (url_hash, created_at);

ALTER TABLE jobs ADD COLUMN cv_pdf_key TEXT;

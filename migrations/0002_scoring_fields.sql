-- Migration number: 0002 	 Campos de scoring/consola (DATABASE.md §3)
-- Urgentes: se escriben al ingerir/puntuar y son imposibles de reconstruir despues.

ALTER TABLE jobs ADD COLUMN description_text TEXT;
ALTER TABLE jobs ADD COLUMN score_breakdown  TEXT;
ALTER TABLE jobs ADD COLUMN title_norm       TEXT;

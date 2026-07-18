-- Migration number: 0005 	 Indices para consola v2 (hallazgo de la revision de cuotas:
-- /semana, digest, replay y radar de similares escaneaban jobs completo sin indice).

CREATE INDEX idx_jobs_first_seen  ON jobs (first_seen);
CREATE INDEX idx_jobs_notified_at ON jobs (notified_at);
CREATE INDEX idx_jobs_title_norm  ON jobs (title_norm);

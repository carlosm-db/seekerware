# DATABASE — Seekerware

El store del sistema es **una base D1 (SQLite serverless de Cloudflare)**,
binding `DB` del worker, con schema versionado en `migrations/`. Terminologia
en [`CONVENTIONS.md`](CONVENTIONS.md).

---

## 1. Principios

- Una sola base. Tablas nucleo: `companies`, `jobs`, `anchors`, `blocks`,
  `config`. Observabilidad (§9): `runs`, `events`, `notifications`.
  Candidaturas (§10): `applications`, `job_events`. Consola: `config_history`
  (§11). Futuras: `cvs` (paso 6), `answers` (paso 8) — §12.
- Todo cambio de schema es una migration versionada (`wrangler d1 migrations`);
  nunca DDL manual contra produccion.
- Acceso SOLO via `src/store.ts`: statements preparados con bindings;
  `db.batch()` para las escrituras del run.
- Cada columna tiene UN escritor: o el usuario (via dashboard) o el sistema
  (marcado abajo).
- Sin datos personales del propietario mas alla de lo operativo (los blocks son
  contenido de CV aprobado por el; la base y el dashboard son privados).

## 2. Tabla `companies` — empresas a vigilar

| Columna | Tipo | Escribe | Descripcion |
|---------|------|---------|-------------|
| id | INTEGER PK | sistema | Autoincremental |
| name | TEXT | usuario | Nombre legible de la empresa |
| ats | TEXT enum `greenhouse\|lever\|ashby` | usuario | Connector a usar |
| token | TEXT | usuario | Slug del board publico del ATS |
| active | INTEGER 0/1 | usuario | 0 = no se pollea |
| notes | TEXT | usuario | Libre |
| last_ok_fetch | TEXT (ISO) | sistema | Ultimo fetch exitoso del feed; condiciona el auto-expire (§6) |
| fail_count | INTEGER | sistema | Fallos consecutivos; dispara mensaje MANTENIMIENTO al superar umbral |
| fetch_ok_total / fetch_fail_total | INTEGER | sistema | Acumulados para tasa de exito (salud en la consola) |
| last_fail / last_error | TEXT | sistema | Ultimo fallo y su mensaje (visibles en `/companies` sin ir al log) |

```sql
CREATE TABLE companies (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  ats           TEXT NOT NULL CHECK (ats IN ('greenhouse','lever','ashby')),
  token         TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  notes         TEXT,
  last_ok_fetch TEXT,
  fail_count    INTEGER NOT NULL DEFAULT 0,
  UNIQUE (ats, token)
);
-- 0003 (paso 3): observabilidad de empresa
ALTER TABLE companies ADD COLUMN fetch_ok_total   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE companies ADD COLUMN fetch_fail_total INTEGER NOT NULL DEFAULT 0;
ALTER TABLE companies ADD COLUMN last_fail        TEXT;
ALTER TABLE companies ADD COLUMN last_error       TEXT;
```

## 3. Tabla `jobs` — el store

Clave: `url_hash` (SHA-256 de la URL canonica, sin query params). Todas las
columnas las escribe el sistema; unica edicion del usuario (via dashboard):
`status` a `skipped`.

| Columna | Tipo | Descripcion |
|---------|------|-------------|
| url_hash | TEXT PK | Identidad del job para dedup |
| url | TEXT | URL canonica |
| company_id | INTEGER FK -> companies | Empresa de origen |
| ats / ext_id | TEXT | ATS y ID externo del job en el ATS |
| title / location | TEXT | Del feed |
| posted_at | TEXT (ISO) | Segun campo correcto por ATS (TRD §2); NULL si no confiable |
| freshness_ok | TEXT `true\|unknown` | `unknown` = sin fecha confiable; se uso first_seen |
| track | TEXT | Mejor track que paso gates |
| score | INTEGER 0-100 | Del motor de reglas |
| verdict | TEXT enum | Apply / Stretch-worth-it / Skip |
| status | TEXT enum | Ver maquina de estados (§4) |
| first_seen / last_seen | TEXT (ISO) | Ciclo de vida en el feed. `last_seen` se estampa AL CERRAR (ultima presencia confirmada, error max. de un intervalo); para jobs abiertos la presencia la garantiza el auto-expire — escribirla en cada run costaria >100k filas/dia (decision 2026-07-17, cuota D1) |
| notified_at | TEXT (ISO) | Cuando se envio a Telegram |
| cv_doc_url | TEXT | Doc generado (solo Apply); cache del ultimo — historial en `cvs` (paso 6) |
| cv_pending | INTEGER 0/1 | 1 = CV quedo pendiente (Gemini caido); se reintenta el run siguiente |
| why_it_fits / positioning_lead | TEXT | Version final enviada (rule-based o enriquecida) |
| description_text | TEXT | Texto plano de la descripcion (post stripHtml) — habilita replay, por-que-no, prep, radar. Se escribe UNA vez al ingerir |
| score_breakdown | TEXT JSON | ScoreResult completo del motor (matches por categoria, gates por track, verdicts) — transparencia y replay |
| title_norm | TEXT | Titulo normalizado (lowercase, sin parentesis ni tokens de seniority) — radar de similares |
| cv_pdf_key | TEXT | Ultimo snapshot `generated` en R2 (paso 6) |

```sql
CREATE TABLE jobs (
  url_hash         TEXT PRIMARY KEY,
  url              TEXT NOT NULL,
  company_id       INTEGER NOT NULL REFERENCES companies(id),
  ats              TEXT NOT NULL,
  ext_id           TEXT,
  title            TEXT NOT NULL,
  location         TEXT,
  posted_at        TEXT,
  freshness_ok     TEXT NOT NULL DEFAULT 'unknown'
                     CHECK (freshness_ok IN ('true','unknown')),
  track            TEXT,
  score            INTEGER,
  verdict          TEXT CHECK (verdict IN ('Apply','Stretch-worth-it','Skip')),
  status           TEXT NOT NULL
                     CHECK (status IN ('new','notified','closed','skipped')),
  first_seen       TEXT NOT NULL,
  last_seen        TEXT NOT NULL,
  notified_at      TEXT,
  cv_doc_url       TEXT,
  cv_pending       INTEGER NOT NULL DEFAULT 0,
  why_it_fits      TEXT,
  positioning_lead TEXT
);
CREATE INDEX idx_jobs_status  ON jobs (status);
CREATE INDEX idx_jobs_company ON jobs (company_id, last_seen);
-- 0002 (paso 2): campos de scoring/consola — imposibles de reconstruir despues
ALTER TABLE jobs ADD COLUMN description_text TEXT;
ALTER TABLE jobs ADD COLUMN score_breakdown  TEXT;
ALTER TABLE jobs ADD COLUMN title_norm       TEXT;
-- 0005 (paso 6): archivo R2
ALTER TABLE jobs ADD COLUMN cv_pdf_key TEXT;
```

## 4. Maquina de estados de `jobs.status`

```
                    (verdict Skip, o seeding de primer run, o manual)
        nuevo job ────────────────────────────────────────> skipped
            │
            │ (verdict Apply|Stretch + freshness + verify-on-notify OK
            │  + push Telegram exitoso)
            v
           new ──────────────────────────────────────────> notified
            │                                                  │
            │ (ausente del feed con fetch OK,                  │ (idem)
            │  o verify-on-notify fallido)                     │
            v                                                  v
          closed <─────────────────────────────────────────────
```

- `closed` es terminal: si el job reaparece en el feed, se actualiza
  `last_seen` pero NO se re-notifica (anti-spam).
- Los verdicts se calculan al descubrir el job; cambios de config aplican a
  jobs futuros (re-score manual: evolucion futura).

## 5. Tablas `anchors` y `blocks` — el banco de blocks

El banco es el activo nucleo de la capa de CV: el registro canonico,
gobernado y con evidencia de las afirmaciones profesionales del propietario.
Modelo: un **fact** (hecho verificable, con metrica exacta unica) puede tener
varios **blocks** (fraseos aprobados), diferenciados por **angle** (la
proyeccion que sirven) e idioma. La garantia select-only vale lo que valga la
completitud y exactitud de este banco.

### `anchors` — registro de roles y proyectos reales

| Columna | Tipo | Escribe | Descripcion |
|---------|------|---------|-------------|
| id | TEXT PK | usuario | p. ej. `scotiatech-2021`, `prj-chequeguardai` |
| kind | TEXT enum `role\|project` | usuario | Tipo de anchor |
| company / dates | TEXT | usuario | Metadata de render |
| titles | TEXT JSON | usuario | Titulos mostrados por mercado: `{internal, market_canada, market_colombia, contractor}` — el anchor es neutro; el titulo es proyeccion |

```sql
CREATE TABLE anchors (
  id      TEXT PRIMARY KEY,
  kind    TEXT NOT NULL CHECK (kind IN ('role','project')),
  company TEXT,
  dates   TEXT,
  titles  TEXT  -- JSON {internal, market_canada, market_colombia, contractor}
);
```

### `blocks` — fraseos aprobados de facts

| Columna | Tipo | Escribe | Descripcion |
|---------|------|---------|-------------|
| id | TEXT PK | usuario | `{sec}-{anchor\|topic}-{nn}[-{angle}]`, p. ej. `exp-scotiatech-01-data` |
| section | TEXT enum `summary\|skills\|experience\|projects` | usuario | Seccion del CV |
| anchor_id | TEXT FK -> anchors | usuario | Null en summary/skills |
| fact_key | TEXT | usuario | Agrupa todos los fraseos/idiomas de un mismo fact |
| angle | TEXT enum `data\|compliance\|operations\|leadership` o NULL | usuario | Proyeccion que sirve este fraseo |
| text_en / text_es | TEXT | usuario | Fraseos del MISMO fact en cada idioma (paridad obligatoria) |
| es_status | TEXT enum `missing\|draft\|approved` | usuario | Estado de paridad ES |
| tags | TEXT csv | usuario | Vocabulario controlado COMPARTIDO con `config` (familias domain/tool/signal + track-fit) |
| evidence | TEXT | usuario | Hecho real verificable que respalda la afirmacion |
| source | TEXT | usuario | Procedencia (CV variante, caso del portfolio, proyecto) |
| status | TEXT enum `draft\|review\|approved\|retired` | usuario | Ciclo de vida; solo `approved` entra al enum del cv_selector; `retired` nunca se borra (audit trail) |
| suggested | TEXT | sistema | Propuesta de la IA (tweak o block nuevo) pendiente de revision; NUNCA se usa en render |
| updated_at | TEXT ISO | sistema | Ultima modificacion |

```sql
CREATE TABLE blocks (
  id         TEXT PRIMARY KEY,
  section    TEXT NOT NULL
               CHECK (section IN ('summary','skills','experience','projects')),
  anchor_id  TEXT REFERENCES anchors(id),
  fact_key   TEXT NOT NULL,
  angle      TEXT CHECK (angle IN ('data','compliance','operations','leadership')),
  text_en    TEXT,
  text_es    TEXT,
  es_status  TEXT NOT NULL DEFAULT 'missing'
               CHECK (es_status IN ('missing','draft','approved')),
  tags       TEXT,
  evidence   TEXT,
  source     TEXT,
  status     TEXT NOT NULL DEFAULT 'draft'
               CHECK (status IN ('draft','review','approved','retired')),
  suggested  TEXT,
  updated_at TEXT
);
```

El registro de facts (fact_key -> hecho + metrica exacta + evidencia +
fuente) vive en el documento maestro del banco (recurso privado del
propietario, fuera del repo); `fact_key` lo referencia desde D1.

## 6. Tabla `config` — tuning del motor de reglas y operacion

Key/value con JSON en `value`; editable desde el dashboard sin deploy y
parseable en una sola lectura por run.

```sql
CREATE TABLE config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL   -- JSON
);
```

Contenido: pesos de categorias, keywords por categoria con peso, definicion de
tracks y gates, umbrales de verdict (`apply=75`, `stretch=55` iniciales),
`title_multiplier` (2.0), `FRESHNESS_MAX_DAYS` (=3, operacion). El detalle de
las claves y sub-formatos JSON **se decide en build 2** con jobs reales.

## 7. Reglas de integridad

- `url_hash` es PK: existente -> solo actualizar `last_seen` (dedup por
  construccion).
- Auto-expire SOLO sobre empresas con fetch exitoso en el run.
- Primer run de una empresa: seeding con `status = 'skipped'`, sin notificar.
- `closed` no se reabre ni re-notifica.
- El cv_selector solo ve blocks con `status = 'approved'`.
- Un block `approved` DEBE tener `evidence`, `fact_key` y >= 1 tag.
- Render en ES exige `es_status = 'approved'` en todos los blocks
  seleccionados (reporte de paridad antes de renderizar colombia_perm).
- `retired` nunca se borra (audit trail del banco).
- Escrituras del run en `db.batch()` (atomicidad por lote).

## 8. Limites y escala

D1 free tier: 5 GB de storage, 5M lecturas de fila/dia, 100k escrituras de
fila/dia — ordenes de magnitud por encima del caso de uso (decenas de empresas,
cientos de jobs/dia). Si `jobs` crece demasiado en años, archivado anual a
tabla `jobs_archive` (evolucion futura). La observabilidad completa (§9)
consume ~1-5k escrituras/dia ≈ 1-5% del presupuesto.

## 9. Observabilidad — `runs`, `events`, `notifications` (migration 0003, paso 3)

Principio: **la consola solo puede mostrar lo que esta en D1** (el worker no
puede leer sus propias metricas de Cloudflare). Patron de instrumentacion:
contadores en memoria durante el run (`RunStats` + `trackedFetch` +
`meta.rows_read/rows_written` de cada resultado D1 — contabilidad exacta,
gratis) y UN solo flush dentro del `db.batch()` final. La fila de `runs` se
inserta al INICIO del run; si el isolate muere, el run siguiente la marca
`crashed` (el crash es dato, no silencio). Detalle: TRD §Instrumentacion y
`docs/audits/2026-07-17-diseno-monitoreo-datos.md`.

```sql
CREATE TABLE runs (
  id              INTEGER PRIMARY KEY,
  started_at      TEXT NOT NULL,
  finished_at     TEXT,
  status          TEXT NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running','ok','partial','fail','crashed')),
  trigger         TEXT NOT NULL DEFAULT 'cron'
                    CHECK (trigger IN ('cron','manual')),
  duration_ms     INTEGER,
  companies_total INTEGER NOT NULL DEFAULT 0,
  companies_ok    INTEGER NOT NULL DEFAULT 0,
  companies_fail  INTEGER NOT NULL DEFAULT 0,
  jobs_seen       INTEGER NOT NULL DEFAULT 0,
  jobs_new        INTEGER NOT NULL DEFAULT 0,
  jobs_scored     INTEGER NOT NULL DEFAULT 0,
  survivors       INTEGER NOT NULL DEFAULT 0,
  notified        INTEGER NOT NULL DEFAULT 0,
  closed          INTEGER NOT NULL DEFAULT 0,
  subrequests     INTEGER NOT NULL DEFAULT 0,
  d1_reads        INTEGER NOT NULL DEFAULT 0,
  d1_writes       INTEGER NOT NULL DEFAULT 0,
  gemini_calls    INTEGER NOT NULL DEFAULT 0,
  errors          INTEGER NOT NULL DEFAULT 0,
  error_summary   TEXT
);
CREATE INDEX idx_runs_started ON runs (started_at);

CREATE TABLE events (
  id         INTEGER PRIMARY KEY,
  run_id     INTEGER REFERENCES runs(id),
  ts         TEXT NOT NULL,
  type       TEXT NOT NULL CHECK (type IN (
               'fetch_fail','parse_fail','verify_dead','verify_fail',
               'gemini_fallback','gemini_fail','gdocs_fail','r2_fail',
               'telegram_fail','maintenance_alert','quota_warn','run_crash',
               'config_change','digest_sent','prune')),
  severity   TEXT NOT NULL CHECK (severity IN ('info','warn','error')),
  company_id INTEGER REFERENCES companies(id),
  url_hash   TEXT,
  detail     TEXT
);
CREATE INDEX idx_events_ts      ON events (ts);
CREATE INDEX idx_events_company ON events (company_id, ts);

CREATE TABLE notifications (
  id            INTEGER PRIMARY KEY,
  run_id        INTEGER REFERENCES runs(id),
  url_hash      TEXT,
  kind          TEXT NOT NULL CHECK (kind IN ('job','maintenance','digest')),
  ts            TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('sent','fail')),
  tg_message_id INTEGER,
  error         TEXT
);
CREATE INDEX idx_notifications_ts ON notifications (ts);
```

Reglas: `events.detail` corto y legible — NUNCA payloads completos, secretos
ni datos personales. Si Telegram falla, el job queda `new` (reintenta el run
siguiente); el log hace visible el reintento. Salud y ROI por empresa se
DERIVAN al leer (aggregates sobre `jobs`, ventana 90 dias) — no se duplican.

## 10. Candidaturas — `applications` + `job_events` (migration 0004, paso 4)

Ciclo de vida DEL USUARIO, paralelo a `jobs.status` (que sigue siendo 100%
del sistema — la regla un-escritor-por-columna se preserva separando tablas).
El humano SIEMPRE envia la aplicacion (CLAUDE.md §7.8); estas tablas registran
su proceso, no envios del sistema.

```sql
CREATE TABLE applications (
  url_hash      TEXT PRIMARY KEY REFERENCES jobs(url_hash),
  stage         TEXT NOT NULL DEFAULT 'prepared'
                  CHECK (stage IN ('prepared','applied','interview',
                                   'offer','rejected','dismissed')),
  applied_at    TEXT,
  interview_at  TEXT,
  outcome_at    TEXT,
  follow_up_at  TEXT,
  snoozed_until TEXT,
  cv_pdf_key    TEXT,   -- snapshot R2 'submitted': el CV EXACTO enviado (paso 6)
  notes         TEXT,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_applications_stage ON applications (stage);

-- Historial append-only de jobs Y applications: JAMAS se borra ni actualiza.
CREATE TABLE job_events (
  id       INTEGER PRIMARY KEY,
  url_hash TEXT NOT NULL,
  ts       TEXT NOT NULL,
  actor    TEXT NOT NULL CHECK (actor IN ('user','system')),
  event    TEXT NOT NULL,   -- p. ej. notified, stage:applied, snoozed, note
  detail   TEXT
);
CREATE INDEX idx_job_events_hash ON job_events (url_hash, ts);
```

Escritores: `applications` la escribe el usuario (via consola/Telegram);
`job_events` ambos, cada fila declara su `actor`.

## 11. Historial de configuracion — `config_history` (migration 0004)

```sql
CREATE TABLE config_history (
  id             INTEGER PRIMARY KEY,
  ts             TEXT NOT NULL,
  key            TEXT NOT NULL,
  old_value      TEXT,
  new_value      TEXT NOT NULL,
  replay_summary TEXT   -- JSON del resumen de replay al guardar (si hubo)
);
```

Escrito en cada guardado desde la consola; habilita "revertir a esta version".

## 12. Tablas futuras y retenciones

- **`cvs`** (paso 6): un CV generado por fila — `url_hash`, `doc_url`, `lang`,
  `pdf_key`, `blocks_used` JSON, `verifier_notes`, `rationale`, `created_at`,
  `superseded_by`, `pending`. Reemplaza como historial a `jobs.cv_doc_url`
  (que queda como cache del ultimo).
- **`answers`** (paso 8): banco de respuestas para formularios — gobernanza
  identica a `blocks` (autoria del propietario, draft/approved, EN/ES con
  paridad); el sistema selecciona, JAMAS redacta.
- **Retenciones** (ejecutadas por el primer run del dia, evento `prune`):
  `runs` 400 dias · `events` 90 dias · `notifications` 180 dias ·
  `applications`/`job_events` NUNCA (audit trail) · `jobs` sin cambio.
- **Claves de `config` operativas**: `quota_limits` (limites free tier
  editables), `observability` (umbrales de alerta, digest lunes ~06:00
  America/Bogota, retenciones), `weekly_goal` (objetivo semanal de
  aplicaciones, inicial 5).

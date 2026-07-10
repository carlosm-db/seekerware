# DATABASE — Seekerware

El store del sistema es **una base D1 (SQLite serverless de Cloudflare)**,
binding `DB` del worker, con schema versionado en `migrations/`. Terminologia
en [`CONVENTIONS.md`](CONVENTIONS.md).

---

## 1. Principios

- Una sola base con 5 tablas: `companies`, `jobs`, `anchors`, `blocks`,
  `config`.
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
| first_seen / last_seen | TEXT (ISO) | Ciclo de vida en el feed |
| notified_at | TEXT (ISO) | Cuando se envio a Telegram |
| cv_doc_url | TEXT | Doc generado (solo Apply) |
| cv_pending | INTEGER 0/1 | 1 = CV quedo pendiente (Gemini caido); se reintenta el run siguiente |
| why_it_fits / positioning_lead | TEXT | Version final enviada (rule-based o enriquecida) |

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
tabla `jobs_archive` (evolucion futura).

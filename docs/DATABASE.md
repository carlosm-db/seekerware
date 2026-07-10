# DATABASE — Seekerware

El store del sistema es **una base D1 (SQLite serverless de Cloudflare)**,
binding `DB` del worker, con schema versionado en `migrations/`. Terminologia
en [`CONVENTIONS.md`](CONVENTIONS.md).

---

## 1. Principios

- Una sola base con 4 tablas: `companies`, `jobs`, `blocks`, `config`.
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

## 5. Tabla `blocks` — banco de frases del CV

| Columna | Tipo | Escribe | Descripcion |
|---------|------|---------|-------------|
| id | TEXT PK | usuario | p. ej. `sum-payments-01` |
| section | TEXT enum `summary\|skills\|experience` | usuario | Seccion del CV |
| role_anchor | TEXT | usuario | Rol real al que pertenece el block (vacio en summary/skills) |
| text_en / text_es | TEXT | usuario | El mismo hecho en cada idioma |
| tags | TEXT csv | usuario | Para matching con el job |
| evidence | TEXT | usuario | A que hecho real corresponde la afirmacion |
| approved | INTEGER 0/1 | usuario | Solo blocks con 1 entran al enum del cv_selector |
| suggested | TEXT | sistema | Propuesta de la IA (tweak o block nuevo) pendiente de revision; NUNCA se usa en render |

```sql
CREATE TABLE blocks (
  id          TEXT PRIMARY KEY,
  section     TEXT NOT NULL CHECK (section IN ('summary','skills','experience')),
  role_anchor TEXT,
  text_en     TEXT,
  text_es     TEXT,
  tags        TEXT,
  evidence    TEXT,
  approved    INTEGER NOT NULL DEFAULT 0,
  suggested   TEXT
);
```

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
- El cv_selector solo ve blocks con `approved = 1`.
- Escrituras del run en `db.batch()` (atomicidad por lote).

## 8. Limites y escala

D1 free tier: 5 GB de storage, 5M lecturas de fila/dia, 100k escrituras de
fila/dia — ordenes de magnitud por encima del caso de uso (decenas de empresas,
cientos de jobs/dia). Si `jobs` crece demasiado en años, archivado anual a
tabla `jobs_archive` (evolucion futura).

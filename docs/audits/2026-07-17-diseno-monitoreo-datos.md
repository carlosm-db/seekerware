# Observabilidad y modelo de datos — diseño para la consola multipagina

Fecha: 2026-07-17 · Rol: diseño de auto-instrumentación + modelo de datos.
Propuesta (no implementación): nada de esto se edita sin OK del propietario
(CLAUDE.md §1). Estilo y convenciones de [`DATABASE.md`](../docs/DATABASE.md);
terminología de [`CONVENTIONS.md`](../docs/CONVENTIONS.md).

Estado real del código auditado (2026-07-17): paso 1 desplegado — worker vivo
con `fetch()` (auth Bearer `API_TOKEN`), `scheduled()` stub, D1 migrada con las
5 tablas de `0001_initial.sql`, `wrangler.jsonc` ya tiene
`"observability": { "enabled": true }`. Todo lo de abajo son ADICIONES; ninguna
tabla existente cambia salvo `companies` (columnas nuevas, todas de escritor
sistema).

---

## 0. Principio rector

**La consola solo puede mostrar lo que está en D1.** El worker no puede leer
sus propias métricas de Cloudflare sin llamar a la API de management (otro
token, otro subrequest, otra dependencia). Por eso: todo lo que el dashboard
visualiza — runs, errores, salud por empresa, entregas, cuotas, candidaturas —
se persiste en D1, escrito por el propio pipeline dentro del `db.batch()` que
ya existe por diseño. Cloudflare-nativo queda para debugging en vivo y métricas
de plataforma (§1); D1 es el registro consultable e histórico.

## 1. Qué da Cloudflare gratis vs qué debemos almacenar

### Gratis y ya activo (NO duplicar)

| Capacidad nativa | Qué da | Límite free (verificar vigencia) |
|---|---|---|
| Workers Logs (`observability.enabled`, ya en `wrangler.jsonc`) | `console.log` estructurado persistido, buscable en dashboard; incluye CPU time y outcome por invocación | ~200k eventos/día, retención ~3 días |
| `wrangler tail` | Tail en vivo para debugging | Gratis |
| Workers Metrics (dashboard CF) | Invocaciones, errores, percentiles de CPU, subrequests agregados | Gratis, solo agregados |
| Cron Triggers → Past Events | Historial reciente de disparos del cron con éxito/fallo | Gratis, ventana corta |
| D1 Metrics (dashboard CF) | Queries/día, filas leídas/escritas, storage | Gratis |
| GitHub Actions | Alertas por email de deploy roto | Gratis |

### Lo que NO da (y por eso va a D1)

1. **Historia > 3 días** — la consola necesita semanas/meses.
2. **Semántica de negocio** — jobs vistos/nuevos/notificados, survivors por
   track, yield por empresa: Cloudflare no sabe qué es un job.
3. **Consultable desde el worker** — los meters y el digest los arma el propio
   worker leyendo D1; las métricas CF no son alcanzables sin API externa.
4. **Joins** — "errores de la empresa X junto a sus jobs" exige SQL contra las
   tablas de dominio.
5. **Alerting** — el free tier no alerta por errores de Workers; la alerta
   MANTENIMIENTO por Telegram es nuestra (§7).

Descartado: Workers Analytics Engine (disponibilidad en free ambigua, no hace
joins con D1, otra pieza móvil). D1 sobra: el volumen de observabilidad es de
decenas de filas por run contra un presupuesto de 100k escrituras/día.

## 2. Patrón de instrumentación más barato (~10 ms CPU)

Regla: **cero escrituras intermedias, contadores en memoria, un solo flush**.
La instrumentación viaja dentro del `db.batch()` final que el pipeline ya hace
por diseño (TRD §7); el costo marginal de CPU es despreciable (incrementos de
enteros y push a arrays; los ms de CPU se van en stripHtml/scoring, no aquí).

```
scheduled() -> runPipeline(env)
  1. INSERT runs (status='running', started_at)          ← 1 escritura
     + barrido de huérfanos: UPDATE runs SET status='crashed'
       WHERE status='running' AND started_at < now-10min ← detecta al antecesor muerto
  2. stats = { companiesOk:0, companiesFail:0, jobsSeen:0, jobsNew:0, ...,
               subrequests:0, d1Reads:0, d1Writes:0, geminiCalls:0,
               events: [], notifications: [] }            ← objeto plano en memoria
  3. Durante el run:
     - trackedFetch(stats, ...) envuelve TODO fetch saliente: stats.subrequests++
     - store.ts acumula meta.rows_read / meta.rows_written de CADA resultado D1
       (D1 lo regresa gratis en `meta`; contabilidad EXACTA, no estimada)
     - errores y sucesos -> stats.events.push({type, severity, ...}) (memoria)
     - envíos Telegram -> stats.notifications.push(...)
  4. finally:
     db.batch([ ...escrituras de jobs/companies del run,
                INSERT events...,
                INSERT notifications...,
                UPDATE runs SET status, finished_at, duration_ms, contadores...,
                (1×/día) DELETEs de retención (§9) ])
```

Notas de plataforma:

- `duration_ms` es reloj de pared (`Date.now()` avanza tras cada await de I/O;
  el pipeline es I/O-dominado, la medida es útil). El CPU time real por
  invocación NO es observable desde dentro del worker: eso lo dan Workers
  Logs/Metrics — no lo almacenamos, no lo inventamos.
- Si el isolate muere (límite de CPU, excepción no capturada antes del
  finally), el `UPDATE` final nunca llega: la fila queda `running` y **el run
  siguiente la marca `crashed`** (paso 1). Costo: 1 statement condicional.
  Sin heartbeats, sin timers, sin Durable Objects.
- El run row se inserta al inicio (no solo al final) precisamente para que un
  crash sea visible como dato y no como silencio.
- Cada invocación (cron o request del dashboard) tiene SU PROPIO presupuesto de
  50 subrequests: las acciones de la consola (regenerar CV, dry-run) no
  compiten con el pipeline.

Costo total añadido por run: 2 escrituras fijas (INSERT+UPDATE de `runs`) +
0–10 events + 0–5 notifications; las columnas nuevas de `companies` van en
UPDATEs que el run ya hace (misma fila ⇒ sin costo extra). Peor caso ~1k
filas/día ≈ 1 % del presupuesto D1.

## 3. Tabla `runs` — un run, una fila

Todas las columnas las escribe el **sistema**. Fuente de: página "Runs" de la
consola, banner "último run hace X min", meters de cuota (§6) y digest (§7).

| Columna | Tipo | Descripción |
|---------|------|-------------|
| id | INTEGER PK | Autoincremental |
| started_at / finished_at | TEXT (ISO) | `finished_at` NULL si crashed |
| status | TEXT enum | `running` → `ok` (todo bien) / `partial` (≥1 empresa falló, run completo) / `fail` (excepción de run) / `crashed` (estampado por el run siguiente) |
| trigger | TEXT enum `cron\|manual` | `manual` = disparado desde la consola |
| duration_ms | INTEGER | Reloj de pared |
| companies_total / companies_ok / companies_fail | INTEGER | Empresas de la página round-robin de este run |
| jobs_seen / jobs_new / jobs_scored / survivors / notified / closed | INTEGER | Embudo del run |
| subrequests | INTEGER | Contados por `trackedFetch` (vs límite 50/invocación) |
| d1_reads / d1_writes | INTEGER | Suma de `meta.rows_read` / `meta.rows_written` (exacto) |
| gemini_calls | INTEGER | Llamadas Gemini del run (vs RPD del free tier) |
| errors | INTEGER | Eventos severity `error` del run |
| error_summary | TEXT | Primer error, legible; detalle en `events` |

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
```

## 4. Tabla `events` — log tipado de sucesos y errores

Todas las columnas las escribe el **sistema**. Vocabulario cerrado con CHECK
(coherente con "un término por concepto"; agregar un tipo = migration, que ya
es el flujo normal del repo). Sin FK a `jobs` (un evento puede referir un job
que nunca se insertó, p. ej. `parse_fail`). `detail` corto y legible: **nunca**
payloads completos, secretos ni datos personales.

| Columna | Tipo | Descripción |
|---------|------|-------------|
| id | INTEGER PK | Autoincremental |
| run_id | INTEGER FK -> runs | NULL si ocurre fuera de un run (acción de dashboard) |
| ts | TEXT (ISO) | Momento del evento |
| type | TEXT enum | Ver vocabulario abajo |
| severity | TEXT enum `info\|warn\|error` | Colorea la consola y cuenta en `runs.errors` |
| company_id | INTEGER FK -> companies | NULL si no aplica |
| url_hash | TEXT | Referencia débil al job (sin FK) |
| detail | TEXT | Mensaje corto (p. ej. `HTTP 404 boards-api...`) |

Vocabulario de `type` (severidad por defecto):

| type | sev | Cuándo |
|------|-----|--------|
| `fetch_fail` | error | Feed de empresa no-OK (status, red, timeout) |
| `parse_fail` | error | Feed OK pero payload inesperado |
| `verify_dead` | info | verify-on-notify: el job ya no existe → `closed` (funcionamiento normal, vale la pena verlo) |
| `verify_fail` | warn | verify-on-notify no se pudo ejecutar (red/API); el job NO se notifica |
| `gemini_fallback` | info | Modelo primario cayó, respondió el fallback (`modelUsed`) |
| `gemini_fail` | warn | Ambos modelos fallaron → textos rule-based, `cv_pending=1` |
| `gdocs_fail` | warn | Docs/Drive caído → `cv_pending=1` |
| `r2_fail` | warn | Falló el archivado del PDF en R2 (§8); no bloquea nada |
| `telegram_fail` | error | `sendMessage` falló; el job queda `new` y reintenta |
| `maintenance_alert` | warn | Se emitió (o intentó) una alerta MANTENIMIENTO |
| `quota_warn` | warn | Un meter cruzó el umbral (§6) |
| `run_crash` | error | El barrido marcó `crashed` a un run antecesor |
| `config_change` | info | Edición de `companies`/`config`/`blocks` desde la consola (auditoría ligera del dashboard) |
| `digest_sent` | info | Digest semanal emitido |
| `prune` | info | Retención ejecutada (conteo de filas borradas en `detail`) |

```sql
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
```

(Dos índices a propósito: cada índice extra cuesta escrituras por INSERT. El
filtro por `type` en la consola escanea la ventana de retención — decenas de
miles de filas máximo, trivial contra 5M lecturas/día.)

## 5. Salud por empresa y ROI — derivado, no duplicado

Insight de costo: el run YA actualiza la fila de `companies` (por
`last_ok_fetch`/`fail_count`); columnas extra en ese mismo UPDATE son gratis en
la contabilidad de filas de D1. Se agregan solo contadores no-derivables; todo
lo demás se calcula al leer con aggregates sobre `jobs` (cientos/miles de
filas: barato).

Columnas nuevas en `companies` (escritor: **sistema**):

| Columna | Tipo | Descripción |
|---------|------|-------------|
| fetch_ok_total | INTEGER | Fetches exitosos acumulados (denominador de tasa de éxito) |
| fetch_fail_total | INTEGER | Fallos acumulados |
| last_fail | TEXT (ISO) | Último fallo |
| last_error | TEXT | Mensaje del último fallo (visible en `/companies` sin ir al log) |

```sql
ALTER TABLE companies ADD COLUMN fetch_ok_total   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE companies ADD COLUMN fetch_fail_total INTEGER NOT NULL DEFAULT 0;
ALTER TABLE companies ADD COLUMN last_fail        TEXT;
ALTER TABLE companies ADD COLUMN last_error       TEXT;
```

Salud (todo derivable): racha de fallos = `fail_count` (existe); tasa de éxito
= `fetch_ok_total / (fetch_ok_total + fetch_fail_total)`; último éxito =
`last_ok_fetch`.

**ROI por empresa** — costo fijo (1 subrequest por poll, cupo escaso de 50) vs
valor (survivors). Query de la consola (ventana 90 días):

```sql
SELECT c.id, c.name, c.ats, c.active, c.fail_count, c.last_ok_fetch, c.last_error,
       COUNT(j.url_hash)                                   AS jobs_seen,
       SUM(j.verdict IN ('Apply','Stretch-worth-it'))      AS survivors,
       SUM(j.verdict = 'Apply')                            AS applies,
       SUM(j.notified_at IS NOT NULL)                      AS notified,
       MAX(j.first_seen)                                   AS last_job,
       ROUND(100.0 * SUM(j.verdict IN ('Apply','Stretch-worth-it'))
             / NULLIF(COUNT(j.url_hash), 0), 1)            AS yield_pct
FROM companies c
LEFT JOIN jobs j ON j.company_id = c.id
                AND j.first_seen >= datetime('now', '-90 days')
GROUP BY c.id
ORDER BY survivors DESC, yield_pct DESC;
```

La consola presenta esto como el ranking de ROI y deriva dos listas
accionables: **rotas** (`fail_count >= umbral`) y **candidatas a desactivar**
(activas, ≥60 días polleadas, 0 survivors) — cada empresa muerta desactivada
devuelve un subrequest por run al presupuesto.

## 6. Tabla `notifications` — log de entregas

Registra cada intento de push (job, mantenimiento, digest). Complementa a
`jobs.notified_at` (que solo guarda el éxito final): aquí quedan los fallos y
reintentos. Todas las columnas: **sistema**.

| Columna | Tipo | Descripción |
|---------|------|-------------|
| id | INTEGER PK | Autoincremental |
| run_id | INTEGER FK -> runs | Run que envió |
| url_hash | TEXT | Job notificado; NULL en mantenimiento/digest |
| kind | TEXT enum | `job` / `maintenance` / `digest` |
| ts | TEXT (ISO) | Momento del intento |
| status | TEXT enum `sent\|fail` | Resultado del `sendMessage` |
| tg_message_id | INTEGER | ID devuelto por Telegram (trazabilidad; futuros edits/botones del bot) |
| error | TEXT | Descripción si `fail` |

```sql
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

Semántica de reintento (sin cambiar la máquina de estados): si Telegram falla,
el job queda `new` (solo pasa a `notified` con push exitoso), se registra
`notifications.status='fail'` + evento `telegram_fail`, y el run siguiente
reintenta. El log hace visibles los reintentos sin columna nueva en `jobs`.

## 7. Cuotas: auto-conciencia y meters

Mecánica de captura (§2): `trackedFetch` cuenta subrequests;
`meta.rows_read/rows_written` de D1 da lecturas/escrituras exactas; el wrapper
Gemini cuenta llamadas. Todo aterriza en `runs`; los meters son SUMs del día.

Límites en `config` (editables sin deploy si Cloudflare/Google cambian tiers):

```json
config['quota_limits'] = {
  "subrequests_per_invocation": 50,
  "d1_reads_day": 5000000,
  "d1_writes_day": 100000,
  "gemini_rpd": 1000,               // RPD del modelo free tier vigente — verificar
  "workers_invocations_day": 100000
}
```

Meters de la consola (query única):

```sql
SELECT MAX(subrequests)  AS peak_subreq,      -- vs 50 (límite POR invocación: el meter es el pico, no la suma)
       SUM(d1_reads)     AS d1_reads_today,   -- vs 5M
       SUM(d1_writes)    AS d1_writes_today,  -- vs 100k
       SUM(gemini_calls) AS gemini_today,     -- vs RPD
       COUNT(*)          AS runs_today
FROM runs WHERE date(started_at) = date('now');
```

Presupuesto de subrequests por run (para dimensionar la página round-robin,
con las ~84 empresas vivas de la lista):

```
página de 25 empresas (fetch feed)        25
verify-on-notify (survivors del run)     ~ 3
Gemini (enricher + cv_selector/verifier) ~ 4
Google (token + copy + batchUpdate)      ~ 3
Telegram                                 ~ 3
R2 PUT del PDF (si se adopta §8)         ~ 1   (asumir que cuenta como subrequest)
                                         ────
                                         ~39 de 50  → margen 22 %
```

Con cron de 30 min: 84 empresas se cubren en 4 páginas ≈ latencia máxima de
2 h por empresa — dentro de RF1 (same-day). `subrequests_warn` (default 40)
dispara `quota_warn`; el meter con datos reales valida o corrige la página.

D1: el diseño completo (pipeline + observabilidad) consume ~1–5k
escrituras/día de 100k. Gemini: survivors de un dígito × 1–2 llamadas ≈ <20 de
~1000 RPD. Los meters existen para detectar la anomalía (bug en bucle, board
gigante), no porque el diseño esté apretado.

## 8. Alertas: MANTENIMIENTO y digest semanal

Toda alerta = mensaje Telegram (prefijo `⚠️ MANTENIMIENTO`, ya definido en
UI.md §1) + fila en `notifications` (kind `maintenance`) + evento
`maintenance_alert`. Umbrales en `config['observability']`:

```json
config['observability'] = {
  "maintenance_fail_streak": 3,
  "subrequests_warn": 40,
  "quota_warn_pct": 80,
  "cv_pending_max": 3,
  "digest": { "dow": 1, "hour_utc": 11 },   // lunes ~06:00 America/Bogota
  "retention_days": { "runs": 400, "events": 90, "notifications": 180 }
}
```

Disparadores de MANTENIMIENTO (con guarda anti-spam):

| # | Condición | Guarda anti-repetición |
|---|-----------|------------------------|
| 1 | `companies.fail_count` cruza el umbral (token cambiado, board muerto) | Dispara solo en la igualdad exacta (`== 3`), no en `>=`; las rotas persistentes van al digest |
| 2 | Run antecesor `crashed` o run actual `fail` | El run que lo detecta alerta una vez |
| 3 | Meter ≥ `quota_warn_pct` % de su límite (o `subrequests > subrequests_warn`) | 1×/día por cuota (clave `config['quota_alerted']` = fecha+cuota) |
| 4 | `cv_pending` acumulados > `cv_pending_max` (Gemini/Docs caído sostenido) | 1×/día |
| 5 | `telegram_fail` | Inalerable por Telegram (está caído): queda en `events` + banner rojo en la consola; si persiste, aparece en el digest cuando vuelva |

Silencio total (cron nunca corre): indetectable desde dentro — cobertura
nativa: historial de Cron en el dashboard CF + banner de la consola
("último run hace X min", derivado de `runs`) + la ausencia del digest semanal
como heartbeat humano.

**Digest semanal** (primer run tras `dow`+`hour_utc`; guarda
`config['digest_last_sent']`): runs de la semana (total/ok/partial/fail, p95
duración), embudo (vistos → nuevos → survivors → notificados, por track), top
5 empresas por yield, lista de rotas (racha ≥ umbral) y de 0-jobs-30-días,
picos de cuota, CVs generados y `cv_pending` vivos, candidaturas por estado
(§10 si se adopta). Todo sale de `runs` + `events` + queries de §5 — cero
almacenamiento adicional.

## 9. Retención (mecánica y política)

Ejecutada por el primer run de cada día (guarda `config['prune_last']`),
DELETEs dentro del batch, evento `prune` con conteos:

| Tabla | Retención | Racional |
|-------|-----------|----------|
| `runs` | 400 días | ~48 filas/día compactas; un año de tendencia + margen |
| `events` | 90 días | Diagnóstico operativo; lo estructural sobrevive en `runs` y `companies` |
| `notifications` | 180 días | El éxito queda para siempre en `jobs.notified_at`; el log es forense |
| `applications` / `application_events` | NUNCA | Audit trail (mismo principio que `blocks.retired`) |
| `jobs` | Sin cambio | Ya previsto `jobs_archive` anual (DATABASE.md §8) |

## 10. Almacenamiento de CV: Drive master + archivo R2 — recomendación

**Recomendación: adoptar R2 como archivo de auditoría; Drive sigue siendo el
master editable.** No es redundancia: son artefactos distintos.

| | Drive (hoy) | R2 (propuesto) |
|---|---|---|
| Naturaleza | Doc vivo: el propietario edita, borra el apéndice, ajusta | PDF inmutable: "exactamente qué existía en el momento X" |
| Riesgo | Un Doc editado/borrado pierde la evidencia de qué se envió | Inmutable por convención de key |
| Dependencia | Google (service account) | Cloudflare (binding, sin egreso ni credencial externa) |
| Consola | Link externo a Drive | Servible inline tras el login (`GET /api/cv/...` vía binding) |
| Free tier | 15 GB de la cuenta de datos | 10 GB-mes, 1M ops clase A/mes — a ~150 KB/PDF caben ~65k CVs: décadas |

Costo por CV: 1 subrequest (`files.export?mimeType=application/pdf` del Doc) +
1 PUT R2 (asumido como subrequest, presupuestado en §7). Volumen: verdicts
Apply son un dígito/día — irrelevante para las cuotas.

Diseño de snapshots (dos momentos, dos propósitos):

```
render del Doc (CV factory) ──> snapshot 'generated'   (qué sugirió el sistema)
marcar aplicado (consola)   ──> snapshot 'submitted'   (qué se envió realmente,
                                                        post-edición del propietario)
key R2: cv/{url_hash}/{yyyymmdd-hhmm}-{generated|submitted}.pdf
```

El `submitted` es el que importa para el audit trail de candidaturas (§10);
el `generated` es gratis de tomar y permite el diff "qué cambió el humano" —
señal valiosa para mejorar el banco de blocks.

Columna nueva en `jobs` (escritor: **sistema**):

```sql
ALTER TABLE jobs ADD COLUMN cv_pdf_key TEXT;  -- último snapshot 'generated' en R2
```

(El snapshot `submitted` vive en `applications.cv_pdf_key`, §11.)

Requisitos: bucket creado por el propietario en el dashboard CF (infra no-code,
CLAUDE.md §5), binding `CV_ARCHIVE` en `wrangler.jsonc`, bucket JAMÁS público
— solo lectura a través del worker tras el login. Fallo de R2 = evento
`r2_fail`, nunca bloquea notificación ni CV (es archivo, no ruta crítica).

## 11. Candidaturas: `applications` + `application_events`

### Marco de decisión (para el propietario — no se asume nada)

El PRD §6 dice hoy **"No auto-apply"** y el modelo funcional dice "el usuario
aplica manualmente". El propietario está cuestionando esa regla. Tres niveles,
con implicaciones distintas:

| Nivel | Qué hace el sistema | ¿Cambia reglas? |
|-------|--------------------|-----------------|
| **T0 — Tracker manual** | Nada hacia afuera; el propietario registra estados en la consola | NO — el PRD §8 ya lo prevé como evolución ("aplicado/entrevista/oferta") |
| **T1 — Assisted apply** | Prepara el paquete completo (PDF `submitted`-ready, respuestas de screening en borrador, link directo); el humano revisa, aprueba y ENVÍA | Retoque menor de redacción ("el sistema prepara, nunca envía") |
| **T2 — Auto apply** | Envía tras aprobación (o solo) | SÍ — revierte un no-goal explícito |

Realidad técnica de T2: Greenhouse/Lever/Ashby **no exponen submit público
utilizable por terceros** (los endpoints de application exigen API keys que
emite la empresa dueña del board). Auto-submit real = automatizar formularios
HTML: contra el espíritu no-scraping del PRD, frágil (CAPTCHAs, campos
custom) y con riesgo de ToS/spam-flagging que quemaría candidaturas reales.

**Recomendación: adoptar T0 ya (la consola lo necesita de todos modos) y
apuntar a T1 como objetivo; dejar T2 en el schema pero desactivado por
`config`, para que el modelo de datos no cambie si la decisión evoluciona.**
T1 captura ~90 % del valor (de notificación a candidatura enviada en un tap de
revisión) con ~0 % del riesgo.

### Máquina de estados y actores

```
            (usuario aprueba)      (envío: usuario en T0/T1;
 prepared ────────────────> approved ────────────────> submitted ──> confirmed
    │                          │        sistema solo en T2             │
    │ (usuario descarta)       │        y con approved previo          └──> failed
    └────────> withdrawn <─────┘                                        (reintento
                                                                         = nueva fila de evento)
```

Invariante de seguridad (espejo de la gobernanza del banco de blocks):
**`prepared -> approved` SOLO lo ejecuta el usuario; el sistema no puede
auto-aprobar jamás.** Aunque `apply_mode = 'auto'` exista algún día, el humano
sigue siendo la compuerta. Extensión del principio "una columna, un escritor"
para columnas de workflow: **una TRANSICIÓN, un actor**, registrado en el
audit trail:

| Transición | Actor permitido |
|------------|-----------------|
| (creación) -> `prepared` | sistema (al marcar interés / desde un Apply) o usuario |
| `prepared` -> `approved` | usuario ÚNICAMENTE |
| `approved` -> `submitted` | usuario (T0/T1); sistema solo si `config apply_mode='auto'` (T2) |
| `submitted` -> `confirmed` / `failed` | usuario (email de confirmación recibido) o sistema (si T2 con verificación) |
| cualquiera -> `withdrawn` | usuario ÚNICAMENTE |

### DDL

| Columna | Tipo | Escribe | Descripción |
|---------|------|---------|-------------|
| id | INTEGER PK | sistema | Autoincremental |
| url_hash | TEXT UNIQUE FK -> jobs | sistema | Un job = máx. una candidatura |
| status | TEXT enum | según matriz | `prepared\|approved\|submitted\|confirmed\|failed\|withdrawn` |
| mode | TEXT enum | sistema | `manual\|assisted\|auto` — cómo se ejecutó/ejecutará el envío |
| prepared_at / approved_at / submitted_at / confirmed_at | TEXT (ISO) | actor de la transición | Timestamps del ciclo |
| cv_pdf_key | TEXT | sistema | Snapshot R2 `submitted` — el CV EXACTO enviado (§10) |
| answers | TEXT JSON | usuario (borrador: sistema en T1) | Respuestas de screening preparadas/aprobadas |
| confirmation | TEXT | usuario o sistema | Referencia externa (ID de confirmación del ATS, nota) |
| error | TEXT | sistema | Motivo si `failed` |
| updated_at | TEXT (ISO) | sistema | Última transición |

```sql
CREATE TABLE applications (
  id           INTEGER PRIMARY KEY,
  url_hash     TEXT NOT NULL UNIQUE REFERENCES jobs(url_hash),
  status       TEXT NOT NULL DEFAULT 'prepared'
                 CHECK (status IN ('prepared','approved','submitted',
                                   'confirmed','failed','withdrawn')),
  mode         TEXT NOT NULL DEFAULT 'manual'
                 CHECK (mode IN ('manual','assisted','auto')),
  prepared_at  TEXT NOT NULL,
  approved_at  TEXT,
  submitted_at TEXT,
  confirmed_at TEXT,
  cv_pdf_key   TEXT,
  answers      TEXT,
  confirmation TEXT,
  error        TEXT,
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_applications_status ON applications (status);

-- Audit trail inmutable: append-only, JAMÁS se borra ni se actualiza.
CREATE TABLE application_events (
  id             INTEGER PRIMARY KEY,
  application_id INTEGER NOT NULL REFERENCES applications(id),
  ts             TEXT NOT NULL,
  actor          TEXT NOT NULL CHECK (actor IN ('user','system')),
  from_status    TEXT,
  to_status      TEXT NOT NULL,
  detail         TEXT
);
CREATE INDEX idx_application_events_app ON application_events (application_id);
```

Guardas de operación en `config` (si T1/T2 se aprueban): `apply_mode`
(`'off'|'assisted'|'auto'`, default `'off'` — kill switch), `apply_daily_max`
(tope de envíos/día). `jobs.status` NO se toca: la máquina de estados existente
queda intacta; la candidatura es un ciclo de vida aparte unido por `url_hash`.

## 12. Migrations propuestas

- **`0002_observability.sql`** (con paso 3, el pipeline la necesita al nacer):
  `runs`, `events`, `notifications`, ALTERs de `companies` (§5), ALTER
  `jobs.cv_pdf_key` (§10; inofensivo aunque R2 llegue después), seeds de
  `config['observability']` y `config['quota_limits']`.
- **`0003_applications.sql`** (cuando el propietario decida §11 — T0 basta
  para crearla): `applications`, `application_events`, seed de
  `config['apply_mode']='off'`.

Glosario (CONVENTIONS §1) — filas nuevas requeridas en el mismo commit:
`event` (suceso tipado del log de observabilidad), `notification` (registro de
un intento de entrega push), `meter` (medidor de cuota consumida vs límite
free tier), `application` (candidatura: ciclo de vida de aplicar a un job),
`digest` (resumen semanal push). Evitar: alerta/aviso para notification,
postulación para application, etc.

## 13. Qué alimenta esto en la consola (mapa rápido)

| Página | Tablas fuente |
|--------|--------------|
| Salud / home de monitoreo | `runs` (último run, racha, embudo), `events` (últimos errores), meters (§7) |
| Runs (historial + detalle) | `runs` + `events` por `run_id` |
| Empresas (con ROI) | `companies` + aggregate de `jobs` (§5) |
| Log de eventos | `events` con filtros type/severity/empresa |
| Entregas | `notifications` (+ join a `jobs`) |
| Biblioteca de CVs | `jobs.cv_doc_url` + `cv_pdf_key`, `applications.cv_pdf_key`, listado R2 |
| Candidaturas (kanban por status) | `applications` + `application_events` |
| Cuotas | `runs` del día vs `config['quota_limits']` |

## 14. Decisiones abiertas (solo el propietario)

1. **Auto-apply**: ¿se revierte el no-goal? Recomendación: T0 ya + T1 como
   objetivo; T2 solo en schema, desactivado (§11).
2. **R2**: ¿crear el bucket (infra del propietario) y adoptar el archivo de
   PDFs? Recomendación: sí, snapshots `generated` + `submitted` (§10).
3. **Retenciones**: aprobar 400/90/180 días (§9).
4. **Umbrales y digest**: racha=3, warn=80 %, subrequests_warn=40, digest lunes
   ~06:00 Bogotá (§8) — todo editable en `config` después.
5. **`events.type` con CHECK** (migration por tipo nuevo, coherente con el
   glosario) vs TEXT abierto. Recomendación: CHECK.

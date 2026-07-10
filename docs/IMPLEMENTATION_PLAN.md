# Implementation Plan — Seekerware

Plan de ejecucion por pasos, con criterios de aceptacion e inputs requeridos.
Estado vivo en `CLAUDE.md` §9 (y en ultima instancia, en el codigo — que es la
fuente de verdad).

---

## 1. Fases y dependencias

```
0 docs ──> 1 scaffold + Greenhouse ──> 2 scoring ──> 3 pipeline + notify + cron ──> 4 dashboard v1 ──> 5 Lever + Ashby ──> 6 blocks + CV factory ──> 7 dashboard v2
                                          ^                                                                                     ^
                                          requiere perfil                                                                       requiere CVs EN/ES + service account
```

Los pasos 4 y 5 pueden intercambiarse; el 6 requiere el 3 operando; el 7
requiere el 4. Hasta el paso 4, `companies` y `config` se editan via
migrations/`wrangler d1 execute` (sin dashboard).

## 2. Paso 0 — Documentacion · HECHO 2026-07-07 · REESCRITO 2026-07-09

Entregables: `README.md`, `CLAUDE.md`, `docs/` (PRD, TRD, UI, DATABASE,
IMPLEMENTATION_PLAN, CONVENTIONS). Reescritos 2026-07-09 tras el reframe de
plataforma (§10).

## 3. Paso 1 — Scaffold + connector Greenhouse + dry-run

- **Objetivo**: ver jobs reales normalizados, sin efectos, con CI/CD operando.
- **Entregables**: repo TypeScript (wrangler config, `package.json`,
  `tsconfig.json`, vitest); D1 creada + migration inicial con las 4 tablas;
  `src/index.ts`, `src/connectors/greenhouse.ts`, `src/store.ts` (lectura);
  ruta `GET /api/dry-run?company=<token>`; workflow de GitHub Actions
  (typecheck + tests + migrations + deploy).
- **Aceptacion**: `wrangler dev` local y el worker desplegado responden al
  dry-run con jobs normalizados de un board real, `posted_at` correcto y URL
  canonica; tests de connector en verde; deploy automatico en push a `main`.
- **Inputs requeridos**: cuenta Cloudflare + API token; secrets de Actions
  (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`); 1 empresa Greenhouse de
  prueba.
- **Riesgos**: boards sin `first_published` (usar fallback y marcar
  `freshness_ok = 'unknown'`).

## 4. Paso 2 — Scoring + tracks

- **Objetivo**: score y verdict confiables sobre jobs reales.
- **Entregables**: `src/scoring.ts` (funcion pura + tests); tabla `config`
  poblada (formato de claves decidido aqui); dry-run extendido con score,
  gates y verdict por track.
- **Aceptacion**: sobre un batch de jobs reales, los verdicts coinciden con la
  revision manual del propietario; el desglose por categoria es explicable.
- **Inputs requeridos**: material de perfil del propietario (crudo, cualquier
  formato) para derivar config. Se recibe por canal privado; al repo solo llega
  configuracion neutral en D1 (nada personal en el repo).
- **Riesgos**: sobre/sub-filtrado inicial -> se tunean umbrales en iteraciones
  cortas; keywords bilingues EN/ES.

## 5. Paso 3 — Pipeline + freshness + Telegram + cron

- **Objetivo**: operacion real de punta a punta.
- **Entregables**: `src/pipeline.ts`, `src/freshness.ts`, `src/notify.ts`,
  escrituras en `src/store.ts`; handler `scheduled()` + Cron Trigger 30-60 min.
- **Aceptacion**: un run real (1) siembra el primer feed sin notificar,
  (2) deduplica en runs siguientes, (3) notifica a Telegram un job nuevo,
  fresco y verificado vivo, (4) auto-marca `closed` los que salen del feed,
  (5) sobrevive el fallo de una empresa sin afectar las demas.
- **Inputs requeridos**: bot de Telegram (token + chat_id); Worker secrets
  poblados.
- **Riesgos**: limite de 50 subrequests/invocacion (mitigacion: round-robin de
  empresas por run con cursor en `config`).

## 6. Paso 4 — Dashboard v1 (consola minima)

- **Objetivo**: operar el sistema sin tocar SQL: la consola reemplaza al Sheet
  del diseno v1.
- **Entregables**: handler `fetch()` con rutas `/`, `/companies`, `/config`
  (UI.md §2 consola minima); login operando (Access o fallback, TRD §8).
- **Aceptacion**: agregar una empresa, tunear un umbral y marcar un job
  `skipped` desde el navegador, sin deploy ni SQL; ninguna ruta responde sin
  autenticacion.
- **Inputs requeridos**: decision de hostname (zona propia en Cloudflare para
  Access, o fallback con cookie firmada).
- **Riesgos**: scope creep visual — el pulido va en el paso 7, no aqui.

## 7. Paso 5 — Connectors Lever + Ashby

- **Aceptacion**: mismas garantias del paso 3 con empresas reales de cada ATS,
  incluyendo verify-on-notify especifico (Ashby: nunca contra HTML).

## 8. Paso 6 — Banco de blocks + CV factory

- **Entregables**: tabla `blocks` poblada y aprobada; `src/ia/gemini.ts`
  (wrapper), `src/ia/agents.ts` (enricher + cv_selector + cv_verifier),
  `src/ia/cv_factory.ts`, `src/gdocs.ts` (JWT de service account + Docs/Drive
  REST); plantilla de Doc y carpeta en Drive compartidas al service account.
- **Aceptacion**: un job con verdict Apply genera un Doc cuyo cuerpo contiene
  SOLO texto de blocks aprobados (verificable por diff), con apendice
  "Suggested tweaks"; el enricher mejora textos sin cambiar verdicts.
- **Inputs requeridos**: todas las versiones de CV del propietario (EN/ES) por
  canal privado -> se decomponen en blocks que el aprueba en el dashboard;
  plantilla de Doc; carpeta Drive; service account GCP (JSON en Worker secret);
  `GEMINI_API_KEY`.
- **Riesgos**: cobertura inicial del banco insuficiente (el flujo `suggested`
  la alimenta con el tiempo); free tier de Gemini entrena con datos (solo
  material aprobado para terceros sale hacia la API).

## 9. Paso 7 — Dashboard v2 (consola completa)

- **Entregables**: UI.md §2 consola completa — desglose de score por job,
  flujo de aprobacion de blocks/suggested, acciones (aplicado/descartado,
  regenerar CV, dry-run desde la UI), layout ancho, tema claro/oscuro.
- **Aceptacion**: la operacion diaria completa (revisar fits, aprobar blocks,
  tunear config) se hace comoda desde el dashboard; el propietario lo valida
  en uso real.

## 10. Inputs pendientes consolidados

| Input | Bloquea |
|-------|---------|
| Cuenta Cloudflare + API token + secrets de Actions | Paso 1 |
| Lista inicial de empresas (con investigacion asistida) | Paso 1-2 |
| Material de perfil (privado) | Paso 2 |
| Bot de Telegram + chat_id | Paso 3 |
| Hostname para Access (o decision de fallback) | Paso 4 |
| CVs EN/ES + plantilla Doc + carpeta Drive | Paso 6 |
| Service account GCP (JSON) con carpeta/plantilla compartidas | Paso 6 |
| GEMINI_API_KEY | Paso 6 |

## 11. Registro de decisiones

- **2026-07-07** — Plataforma: all-GAS estilo DiversoLAB (descartados
  Python+GitHub Actions+Cloudflare, Termux en telefono dedicado, app nativa).
  **Revertida 2026-07-09.**
- **2026-07-07** — Dos cuentas Google: datos vs ejecucion. **Obsoleta
  2026-07-09** (ver CLAUDE.md §6: identidades y accesos).
- **2026-07-07** — Banco de blocks con seleccion-only (la IA nunca redacta CV);
  render determinista + cv_verifier temp 0. **Vigente.**
- **2026-07-07** — Gemini free tier `gemini-3.1-flash-lite` con fallback
  `gemini-2.5-flash-lite`; `responseSchema` JSON forzado. **Vigente.**
- **2026-07-07** — GitHub via MCP scoped con PAT fine-grained en env var;
  identidad git pinneada por-repo. **Vigente.**
- **2026-07-09** — **Reframe de plataforma**: Cloudflare Worker (TypeScript) +
  D1 + dashboard con login, deploy via GitHub Actions + wrangler. Razones:
  testabilidad real (vitest + wrangler dev), store SQL, consola web propia con
  login, DX moderna. Revierte la decision all-GAS del 2026-07-07.
- **2026-07-09** — Se mantienen del diseno v1: Gemini free tier (mismo patron
  de agentes) y Google Docs como salida del CV (unica dependencia Google
  restante, via service account).
- **2026-07-09** — Presupuesto: free tiers estrictos ($0/mes); upgrade solo si
  un limite real lo exige.
- **2026-07-09** — El dashboard pasa de opcional a first-class (v1 minima paso
  4, v2 completa paso 7): al desaparecer el Sheet, es la unica consola.

# Implementation Plan — Seekerware

Plan de ejecucion por pasos, con criterios de aceptacion e inputs requeridos.
Estado vivo en `CLAUDE.md` §9 (y en ultima instancia, en el codigo — que es la
fuente de verdad).

---

## 1. Fases y dependencias

```
0 docs ──> 1 scaffold + Greenhouse ──> 2 scoring ──> 3 store+notify+trigger ──> 4 Lever+Ashby ──> 5 blocks + CV factory ──> 6 dashboard (opcional)
                                          ^                                                            ^
                                          requiere perfil                                              requiere CVs EN/ES
```

Los pasos 2 y 4 pueden intercambiarse; el 5 requiere el 3 operando.

## 2. Paso 0 — Documentacion · HECHO 2026-07-07

Entregables: `README.md`, `CLAUDE.md`, `docs/` (PRD, TRD, UI, DATABASE,
IMPLEMENTATION_PLAN, CONVENTIONS).

## 3. Paso 1 — Scaffold + connector Greenhouse + dry-run

- **Objetivo**: ver jobs reales normalizados en el log, sin efectos.
- **Entregables**: proyecto GAS (cuenta de ejecucion) + `.clasp.json` +
  `appsscript.json`; Sheet con los 4 tabs creados; `codigo.js`,
  `connectors.js` (solo Greenhouse), `api_dryRun(companyToken)`.
- **Aceptacion**: `api_dryRun('<token>')` desde el editor imprime jobs
  normalizados con `posted_at` correcto y URL canonica.
- **Inputs requeridos**: cuenta de ejecucion creada + `clasp login`; Sheet
  creado por la cuenta de datos y compartido; 1 empresa Greenhouse de prueba.
- **Riesgos**: boards sin `first_published` (usar fallback y marcar
  `freshness_ok = unknown`).

## 4. Paso 2 — Scoring + tracks

- **Objetivo**: score y verdict confiables sobre jobs reales.
- **Entregables**: `scoring.js`; tab `Config` poblado (formato decidido aqui);
  `api_scoreDryRun(companyToken)`.
- **Aceptacion**: sobre un batch de jobs reales, los verdicts coinciden con la
  revision manual del propietario; el desglose por categoria es explicable.
- **Inputs requeridos**: material de perfil del propietario (crudo, cualquier
  formato) para derivar Config. Se recibe por canal privado; al repo solo llega
  configuracion neutral en el Sheet (nada personal en el repo).
- **Riesgos**: sobre/sub-filtrado inicial -> se tunean umbrales en iteraciones
  cortas; keywords bilingues EN/ES.

## 5. Paso 3 — Store + freshness + Telegram + trigger

- **Objetivo**: operacion real de punta a punta.
- **Entregables**: `store.js`, `freshness.js`, `notify.js`, `pipeline.js`;
  trigger de tiempo 30-60 min.
- **Aceptacion**: un run real (1) siembra el primer feed sin notificar,
  (2) deduplica en runs siguientes, (3) notifica a Telegram un job nuevo,
  fresco y verificado vivo, (4) auto-marca `closed` los que salen del feed,
  (5) sobrevive el fallo de una empresa sin afectar las demas.
- **Inputs requeridos**: bot de Telegram (token + chat_id); Script Properties
  pobladas.
- **Riesgos**: cuotas de trigger (mitigacion: paginacion por run).

## 6. Paso 4 — Connectors Lever + Ashby

- **Aceptacion**: mismas garantias del paso 3 con empresas reales de cada ATS,
  incluyendo verify-on-notify especifico (Ashby: nunca contra HTML).

## 7. Paso 5 — Banco de blocks + CV factory

- **Entregables**: tab `Blocks` poblado y aprobado; `ia_agents.js` (wrapper +
  enricher + cv_selector + cv_verifier), `ia_pipeline.js`; plantilla de Doc y
  carpeta en Drive compartidas.
- **Aceptacion**: un job con verdict Apply genera un Doc cuyo cuerpo contiene
  SOLO texto de blocks aprobados (verificable por diff), con apendice
  "Suggested tweaks"; el enricher mejora textos sin cambiar verdicts.
- **Inputs requeridos**: todas las versiones de CV del propietario (EN/ES) por
  canal privado -> se decomponen en blocks que el aprueba en el Sheet;
  plantilla de Doc; `GEMINI_API_KEY` de la cuenta de ejecucion.
- **Riesgos**: cobertura inicial del banco insuficiente (el flujo `suggested`
  la alimenta con el tiempo); free tier entrena con datos (solo material
  aprobado para terceros sale hacia la API).

## 8. Paso 6 — Dashboard HtmlService · OPCIONAL

Segun [`UI.md`](UI.md) §4. Solo si el Sheet se queda corto como consola.

## 9. Inputs pendientes consolidados

| Input | Bloquea |
|-------|---------|
| Cuenta de ejecucion (Google) + clasp login | Paso 1 |
| Sheet creado y compartido entre cuentas | Paso 1 |
| Lista inicial de empresas (con investigacion asistida) | Paso 1-2 |
| Material de perfil (privado) | Paso 2 |
| Bot de Telegram + chat_id | Paso 3 |
| CVs EN/ES + plantilla Doc + carpeta Drive | Paso 5 |
| GEMINI_API_KEY (cuenta de ejecucion) | Paso 5 |

## 10. Registro de decisiones

- **2026-07-07** — Plataforma: all-GAS estilo DiversoLAB (descartados
  Python+GitHub Actions+Cloudflare, Termux en telefono dedicado, app nativa).
- **2026-07-07** — Dos cuentas Google: datos vs ejecucion.
- **2026-07-07** — Banco de blocks con seleccion-only (la IA nunca redacta CV);
  render determinista + cv_verifier temp 0.
- **2026-07-07** — Gemini free tier `gemini-3.1-flash-lite` con fallback
  `gemini-2.5-flash-lite`; `responseSchema` JSON forzado.
- **2026-07-07** — GitHub via MCP scoped con PAT fine-grained en env var;
  identidad git pinneada por-repo.
- **2026-07-07** — Documentacion: 8 archivos (README, CLAUDE, PRD, TRD, UI,
  DATABASE, IMPLEMENTATION_PLAN, CONVENTIONS); sin datos personales del
  propietario en el repo.

# Implementation Plan — Seekerware

Plan de ejecucion por pasos, con criterios de aceptacion e inputs requeridos.
Estado vivo en `CLAUDE.md` §9 (y en ultima instancia, en el codigo — que es la
fuente de verdad). Diseno extendido de consola/observabilidad/kit en
`docs/audits/2026-07-17-*.md`.

---

## 1. Fases y dependencias

```
0 docs ──> 1 scaffold+Greenhouse ──> 2 scoring+deltas ──> 3 pipeline+cron+instrumentacion ──> 4 consola v1 ──> 5 Lever+Ashby ──> 6 CV factory+PDF+R2 ──> 7 consola v2 ──> 8 kit+bot bidireccional
                                        ^                                                                                            ^
                                        requiere perfil (recibido 2026-07-09)                                                        requiere banco aprobado + service account (listo)
```

Los pasos 4 y 5 pueden intercambiarse; el 6 requiere el 3; el 7 requiere el 4
(y /blocks, /cvs del 7 requieren el 6); el 8 requiere 6 y 7 parciales. Hasta el
paso 4, `companies` y `config` se editan via seeds/`wrangler d1 execute`.

## 2. Paso 0 — Documentacion · HECHO 2026-07-07 · reescrito 2026-07-09 · enriquecido 2026-07-17

## 3. Paso 1 — Scaffold + Greenhouse + dry-run + CI · HECHO 2026-07-17

Worker vivo (workers.dev), D1 migrada (0001), connector Greenhouse con
canonical URL corregida (identity params), auth Bearer, CI deploy. Bug real
encontrado y corregido: colapso de url_hash en boards con pagina propia.

## 4. Paso 2 — Scoring + deltas de schema urgentes

- **Objetivo**: score y verdict confiables sobre jobs reales, con
  transparencia total persistible.
- **Entregables**: migration `0002` (`jobs.description_text`,
  `jobs.score_breakdown`, `jobs.title_norm` — IMPOSIBLES de reconstruir
  despues; deben nacer antes de acumular datos); `src/scoring.ts` (funcion
  pura, `ScoreResult` completo con matches por categoria, gates por track,
  near-miss); `src/config-store.ts`; dry-run extendido con scoring; seeds
  LOCALES (gitignored) de `config` y empresas ★ aplicados a D1 local y
  remota; tests del motor.
- **Aceptacion**: sobre lotes de jobs reales de las ★, los verdicts coinciden
  con la revision del propietario (sesion de calibracion iterativa por chat:
  el reacciona a resultados, no revisa configs); el desglose por categoria es
  explicable en cada caso.
- **Inputs**: ninguno nuevo (perfil recibido 2026-07-09; ★ verificadas).
- **Riesgos**: sobre/sub-filtrado inicial -> replay (paso 7) lo hara sistematico;
  mientras tanto iteraciones cortas de seeds.

## 5. Paso 3 — Pipeline + cron + Telegram + instrumentacion

- **Entregables**: `src/pipeline.ts`, `src/freshness.ts`, `src/notify.ts`,
  escrituras en `src/store.ts`; handler `scheduled()` + Cron Trigger 30 min
  con round-robin (~25 empresas/run); migration `0003` (runs, events,
  notifications, ALTERs de companies); instrumentacion RunStats/trackedFetch
  (TRD §7); alertas MANTENIMIENTO con guardas anti-spam.
- **Aceptacion**: las 5 garantias originales (siembra sin notificar, dedup,
  notificacion de job nuevo+fresco+vivo, auto-expire, aislamiento por
  empresa) + cada run deja su fila en `runs` con embudo y cuotas exactas +
  un run crashed queda estampado por el siguiente.
- **Inputs**: ninguno (Telegram configurado 2026-07-17).

## 6. Paso 4 — Consola v1 (operacion diaria)

- **Entregables**: stack Hono/jsx+htmx (TRD §8); login cookie firmada
  (secrets `LOGIN_PASSWORD_HASH`, `SESSION_SECRET`); migration `0004`
  (applications, job_events, config_history); paginas: Hoy (tira de estado +
  triage con 5 acciones), /jobs (tabla+filtros+vistas guardadas+chip
  por-que-NO; detalle con desglose y gates), /companies (CRUD+salud+ROI+
  probar token), /config (editores estructurados, sin replay), /salud
  (runs); footer omnipresente.
- **Aceptacion**: agregar empresa, tunear umbral, hacer triage de un survivor
  hasta "aplicado" y ver la salud del ultimo run — todo desde el navegador,
  sin SQL; ninguna ruta sin autenticacion (assets incluidos).
- **Inputs**: el propietario define su password de login (hash via comando
  guiado).
- **Riesgos**: scope creep visual — el pulido es del paso 7.

## 7. Paso 5 — Connectors Lever + Ashby

- **Aceptacion**: mismas garantias del paso 3 con empresas reales de cada
  ATS; verify-on-notify especifico (Ashby: NUNCA contra HTML); identity
  params propios en canonical URL si aplican.

## 8. Paso 6 — Integracion del banco + CV factory + PDF + R2

Contenido del banco: construido desde 2026-07-09 (doc maestro privado);
Fase C de revision aparcada por decision del propietario — al llegar aqui se
retoma con mecanismo ligero (aprobar CVs de muestra renderizados o
bulk-approve desde /blocks, no revision fila-a-fila).

- **Entregables**: seed del banco aprobado a `anchors`+`blocks`;
  `src/ia/gemini.ts` + `src/ia/agents.ts` + `src/ia/cv_factory.ts` +
  `src/gdocs.ts`; export PDF (copia limpia sin apendice); archivo de PDFs
  en subcarpeta `archive/` de Drive (R2 descartado 2026-07-17: exige
  tarjeta) + snapshots generated/submitted; migration `0005` (tabla cvs,
  jobs.cv_pdf_key).
- **Aceptacion**: un Apply genera Doc cuyo cuerpo contiene SOLO texto de
  blocks approved (diff verificable), PDF limpio archivado en R2, notas del
  verifier persistidas en `cvs`; render ES bloqueado sin paridad aprobada.
- **Inputs**: bucket R2 (propietario); revision ligera del banco.

## 9. Paso 7 — Consola v2 (el instrumento completo)

- **Entregables**: Tracker kanban + seguimientos; detalle de job completo
  (historial, panel CV, similares, prep de entrevista rule-based); **Replay**
  por lotes de 50 + config_history con revert; /blocks completo (cola
  suggested, cobertura, paridad); /cvs; /semana + digest de lunes + momentum
  (`weekly_goal` inicial 5); radar de similares; busqueda global; pulido
  (tema, estados vacios, teclado completo).
- **Aceptacion**: la operacion semanal completa (calibrar con replay, revisar
  funnel, gobernar el banco) se hace comoda desde la consola; el propietario
  la valida en uso real.

## 10. Paso 8 — Kit de aplicacion + bot bidireccional

- **Entregables**: migration `0006` (tabla answers + kit); webhook Telegram
  (`TELEGRAM_WEBHOOK_TOKEN`) con botones (Ver kit / Marcar aplicado) y flujo
  conversacional de preguntas (respuestas del propietario -> kit -> opcional
  guardar al banco `answers`); deteccion de preguntas (Greenhouse
  `?questions=true`; Lever HTML publico — excepcion aprobada); /aplicaciones;
  censo semanal de preguntas; datos de contacto del propietario como clave
  privada de `config`.
- **Aceptacion**: del visto bueno en Telegram al formulario listo-para-enviar
  en < 5 minutos, con toda respuesta proveniente del banco aprobado o del
  chat del propietario; CERO envios del sistema (auditable).

## 11. Backlog (post paso 8, con gate de datos)

- **L2c userscript companion**: auto-llenado del form en el navegador del
  propietario (patron Simplify; el clic sigue humano). Gate: telemetria
  time-to-apply + censo de preguntas tras 2-3 meses de operacion.
- **Buzon de captura**: Gmail dedicado de alertas de empleo leido via API
  oficial como connector adicional (college co-op digest, newsletters).
- Bot: `/pending`, `/cv <id>`; re-score materializado.

## 12. Inputs pendientes consolidados

| Input | Bloquea | Estado |
|-------|---------|--------|
| Cloudflare + API token + secrets Actions | Paso 1 | ✓ 2026-07-17 |
| Telegram bot + chat_id | Paso 3 | ✓ 2026-07-17 |
| GEMINI_API_KEY, GOOGLE_SA_KEY, DRIVE_FOLDER_ID, CV_TEMPLATE_DOC_ID | Paso 6 | ✓ 2026-07-17 |
| Password de login (hash) | Paso 4 | pendiente (comando guiado) |
| Bucket R2 `CV_ARCHIVE` | Paso 6 | pendiente (1 clic) |
| Revision ligera del banco de blocks | Paso 6 | aparcada por decision |
| Encabezado de contacto en la plantilla de Docs | Paso 6 | pendiente (lo agrega el propietario a mano en el Doc) |

## 13. Registro de decisiones

- **2026-07-07** — Plataforma all-GAS. **Revertida 2026-07-09.**
- **2026-07-07** — Dos cuentas Google: datos vs ejecucion. **Obsoleta
  2026-07-09** (CLAUDE.md §6).
- **2026-07-07** — Banco de blocks seleccion-only; render determinista +
  cv_verifier temp 0. **Vigente.**
- **2026-07-07** — Gemini free tier con fallback; responseSchema. **Vigente.**
- **2026-07-07** — GitHub via MCP scoped; git pinneado por-repo. **Vigente.**
- **2026-07-09** — Reframe: Cloudflare Worker + D1 + consola; free tiers
  estrictos; dashboard first-class; Gemini y Google Docs se mantienen.
- **2026-07-09** — Banco de blocks como subsistema nucleo (schema v2).
- **2026-07-17** — Dedup: URL canonica preserva identity params del ATS
  (`gh_jid`); bug real encontrado contra Thinkific.
- **2026-07-17** — **Consola de 10 paginas** (Hoy/Tracker/Jobs/Empresas/
  Calibracion+Replay/Banco/CVs/Aplicaciones/Salud/Semana); stack Hono+jsx+
  htmx sin build; login por cookie firmada (el propietario no tiene dominio
  → Access descartado).
- **2026-07-17** — **Observabilidad D1-first**: runs/events/notifications
  escritas por el propio pipeline (RunStats, un flush); Cloudflare-nativo
  solo para debugging; retenciones 400/90/180; digest lunes ~06:00 Bogota;
  weekly_goal inicial 5.
- **2026-07-17** — **Aplicacion asistida**: kit L1 con visto bueno y
  respuestas por chat de Telegram; el clic de enviar es SIEMPRE humano.
  L2b (envio server-side) y L3 (desatendido) RECHAZADOS con evidencia (APIs
  company-key-only; anti-bot; fallo silencioso que quema empresas; LazyApply
  2.4/5; Greenhouse Real Talent). L2c (userscript local) aparcado con gate
  de telemetria. Fuentes: docs/audits/2026-07-17-diseno-auto-apply.md.
- **2026-07-17** — Excepcion al no-scraping: HTML publico de la pagina de
  apply de Lever, solo deteccion de preguntas.
- **2026-07-17** — Datos de contacto del propietario como dato operativo en
  D1 privada. **Revisada el mismo dia por el propietario**: los datos de
  contacto viven UNICAMENTE en la plantilla de Google Docs (encabezado);
  ni en D1, ni en el repo, ni en el kit.
- **2026-07-17** — R2 como archivo inmutable de PDFs (snapshots generated/
  submitted); Drive sigue siendo master editable. **Revertida el mismo dia**:
  activar R2 exige registrar tarjeta (viola "free tiers estrictos sin
  tarjeta"); el archivo de PDFs pasa a subcarpeta `archive/` de Drive,
  inmutable por convencion (el sistema solo crea, jamas edita/borra).
- **2026-07-17** — Tabla `applications` = tracker del usuario (stages);
  maquinaria de envio approved/submitted NO se construye (coherente con el
  rechazo de L2b/L3).

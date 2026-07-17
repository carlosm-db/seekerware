# PRD — Seekerware

Documento de requerimientos de producto. Diseno funcional primero; lo tecnico
vive en [`TRD.md`](TRD.md). Terminologia en [`CONVENTIONS.md`](CONVENTIONS.md).

---

## 1. Problema

El propietario del sistema busca empleo por tres vias en paralelo. Los portales
de empleo son ruido: jobs viejos o cerrados, resultados que no encajan, y el
costo de revisarlos es diario y alto. Cuando aparece algo bueno, enterarse tarde
mata la oportunidad; y adaptar el CV a mano para cada job es lento y propenso a
imprecisiones.

## 2. Modelo funcional: quien ve que, quien hace que

| Actor | Ve | Hace | NO hace |
|-------|----|------|---------|
| **Usuario** (propietario) | Mensajes de Telegram (fits nuevos, con botones), la consola (triage/tracker/calibracion/banco/salud), Docs de CV en Drive | Configura empresas y perfil, aprueba blocks y answers, hace triage, da el visto bueno, **aplica manualmente (el clic de enviar es SIEMPRE suyo)** | Nada automatico hacia empresas |
| **Sistema** | Feeds publicos de ATS, el store, el banco de blocks, el banco de answers | Poll, normaliza, puntua, deduplica, verifica freshness y vida, notifica, ensambla CV sugerido, **prepara el kit de aplicacion**, se auto-monitorea | Nunca envia aplicaciones, nunca contacta empresas, nunca redacta contenido de CV ni respuestas de formularios |
| **Empresas / ATS** | Trafico de lectura anonimo a sus APIs publicas | Publican jobs | No reciben datos del usuario |

Flujo funcional: el sistema descubre -> puntua -> filtra -> notifica con
posicionamiento y CV sugerido -> el usuario decide y aplica.

## 3. Los 3 tracks

| Track | Definicion | Senales positivas | Gates |
|-------|-----------|-------------------|-------|
| `canada_coop` | Co-op / work term en Canada | "co-op", "work term", "internship" | Ubicacion Canada; requisitos de enrolamiento |
| `colombia_perm` | Termino indefinido en Colombia para empresas internacionales | Full-time permanente, LATAM-friendly | Ubicacion Colombia / LATAM / Remote-Americas; rechaza "US only" / "no sponsorship" |
| `contractor_usd` | Contractor remoto pagado en USD | "contractor", "B2B", "freelance", remoto | Remote worldwide / Americas |

Un job se puntua una sola vez (score core) y se evalua contra los gates de cada
track; se notifica si pasa alguno, **nombrando el track** para que el
posicionamiento tenga el marco correcto.

## 4. Contrato de salida (por job notificado)

```
verdict            Apply | Stretch-worth-it        (Skip nunca se notifica)
score              0-100 (reglas, no IA)
track              canada_coop | colombia_perm | contractor_usd
why_it_fits        por que encaja (2-3 lineas)
gap_to_address     la brecha a mitigar en la aplicacion
positioning_lead   con que abrir / como posicionarse
project_to_feature proyecto propio a destacar
cv_blocks          IDs de blocks sugeridos por seccion
cv_doc_url         (solo verdict Apply) link al Doc generado en Drive
freshness_ok       true | unknown (false nunca se notifica)
```

## 5. Requerimientos funcionales

- **RF1 — Descubrimiento same-day**: job publicado hoy -> notificado dentro del
  siguiente run del cron (30-60 min).
- **RF2 — Freshness**: nada con mas de `FRESHNESS_MAX_DAYS` (3) dias de
  publicado. El primer run de una empresa siembra el historico sin notificar.
- **RF3 — Verify-on-notify**: antes de notificar se re-consulta el job en la API
  del ATS; si ya no existe, no se notifica y se marca `closed`.
- **RF4 — Dedup**: un job se notifica maximo una vez (clave: hash de URL
  canonica).
- **RF5 — Score por reglas**: 0-100 ponderando dominio > tipo de rol > overlap
  de herramientas > nivel; gates `hard` o `penalty` por track; umbrales de
  verdict configurables.
- **RF6 — Enriquecimiento IA (survivors)**: mejora `why_it_fits` /
  `positioning_lead` y selecciona blocks. Nunca cambia verdicts ni gates.
- **RF7 — CV factory (verdict Apply)**: ensambla el CV sugerido SOLO con blocks
  pre-aprobados (EN o ES segun el job), render determinista sobre plantilla de
  Docs, cv_verifier senala tweaks como sugerencias.
- **RF8 — Tracking**: todo job visto queda en el store con score, verdict,
  estado y fechas; los que salen del feed se auto-marcan `closed`.
- **RF9 — Configuracion sin deploy**: agregar empresa, tunear
  keywords/pesos/umbrales y aprobar blocks se hace desde el dashboard (tablas
  `companies`/`config`/`blocks`); ningun cambio de perfil requiere deploy.
- **RF10 — Consola con login**: la consola es privada, siempre detras de
  autenticacion; nada del sistema queda expuesto publicamente.
- **RF11 — Kit de aplicacion** (paso 8): para cada Apply con visto bueno del
  propietario (boton en Telegram o consola), el sistema prepara TODO — CV en
  PDF (copia limpia), respuestas estandar desde el banco `answers`
  (gobernanza tipo blocks: autoria del propietario, seleccion-only),
  deteccion de preguntas del formulario (Greenhouse `?questions=true`; Lever
  HTML publico), y las preguntas sin respuesta aprobada se le preguntan AL
  PROPIETARIO por el chat de Telegram (sus respuestas pueden guardarse al
  banco). El envio final es humano, siempre.
- **RF12 — Auto-monitoreo**: cada run se registra (embudo, cuotas, errores);
  la consola muestra salud, meters de free tier y ROI por empresa; alertas
  MANTENIMIENTO por Telegram y digest semanal del funnel (lunes).

## 6. No-goals (explicitos)

- **No auto-apply**: el sistema JAMAS envia una aplicacion — prepara el kit y
  el humano envia. Ratificado 2026-07-17 con evidencia
  (`docs/audits/2026-07-17-diseno-auto-apply.md`): las APIs de envio de los 3
  ATS son company-key-only; la emulacion de formularios es anti-bot activo
  con fallo silencioso (spam queue) que quemaria empresas curadas de forma
  permanente e invisible.
- **No scraping** detras de login ni de portales sin API publica. Excepcion
  explicita (2026-07-17): lectura del HTML PUBLICO de la pagina de apply de
  Lever, solo para detectar preguntas del formulario (Lever no las expone en
  su API); nunca tras login, nunca para enviar.
- **No generacion libre de CV**: la IA no redacta; selecciona blocks aprobados.
- **No multi-usuario**: herramienta personal (el login existe para privacidad,
  no para cuentas).
- **No costear ni temporalizar** en textos generados por IA.

## 7. Metricas de exito

- 0 notificaciones de jobs con mas de 3 dias o ya cerrados.
- Enterarse de los fits el mismo dia de publicacion.
- Volumen de notificaciones bajo (fits reales; si molesta, se sube el umbral).
- 0 afirmaciones en CVs sugeridos que no provengan de blocks aprobados.
- El propietario puede mantener y extender el sistema por su cuenta.
- Costo de operacion: $0/mes (free tiers estrictos).

## 8. Evolucion futura (fuera del alcance de los pasos 2-8)

- **Userscript companion (L2c)**: extension/userscript local que auto-llena
  el formulario en el navegador del propietario desde el kit (patron
  Simplify: navegador real, humano presente, clic humano). APARCADO con gate
  de datos: se reabre solo si la telemetria time-to-apply + el censo de
  preguntas (2-3 meses) demuestran que el envio manual con kit es el cuello
  de botella real.
- **Buzon de captura**: Gmail dedicado que recibe alertas de empleo
  (newsletters, digest del portal co-op del college); el sistema LEE ese
  buzon propio via API oficial — nunca inicia sesion en portales — y
  normaliza esos correos como jobs del pipeline.
- Comandos del bot (`/pending`, `/cv <id>` on-demand).
- Re-score manual de jobs existentes tras cambios de config (el replay ya da
  el preview; esto seria materializarlo).

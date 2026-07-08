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
| **Usuario** (propietario) | Mensajes de Telegram (fits nuevos), el Sheet (tracker/config/banco de blocks), Docs de CV en Drive | Configura empresas y perfil, aprueba blocks, revisa fits, **aplica manualmente** | Nada automatico hacia empresas |
| **Sistema** | Feeds publicos de ATS, el Sheet, el banco de blocks | Poll, normaliza, puntua, deduplica, verifica freshness y vida, notifica, ensambla CV sugerido | Nunca aplica, nunca contacta empresas, nunca redacta contenido de CV |
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
  siguiente run del trigger (30-60 min).
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
- **RF9 — Configuracion sin deploy**: agregar empresa = fila en el Sheet; tunear
  keywords/pesos/umbrales = editar Config; aprobar un block = marcar su fila.

## 6. No-goals (explicitos)

- **No auto-apply** ni contacto automatico con empresas o reclutadores.
- **No scraping** detras de login ni de portales sin API publica.
- **No generacion libre de CV**: la IA no redacta; selecciona blocks aprobados.
- **No multi-usuario**: herramienta personal.
- **No costear ni temporalizar** en textos generados por IA.

## 7. Metricas de exito

- 0 notificaciones de jobs con mas de 3 dias o ya cerrados.
- Enterarse de los fits el mismo dia de publicacion.
- Volumen de notificaciones bajo (fits reales; si molesta, se sube el umbral).
- 0 afirmaciones en CVs sugeridos que no provengan de blocks aprobados.
- El propietario puede mantener y extender el sistema por su cuenta.

## 8. Evolucion futura (fuera del alcance inicial)

- Comandos del bot (`/pending`, `/applied <id>`, `/cv <id>` on-demand).
- Dashboard HtmlService (layout ancho).
- Tracking de estado de aplicaciones (aplicado / entrevista / oferta).

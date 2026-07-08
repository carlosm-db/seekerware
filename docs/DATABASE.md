# DATABASE — Seekerware

El store del sistema es **un unico Google Sheet** (ID en la Script Property
`SHEET_ID`), propiedad de la cuenta de datos y compartido como editor a la
cuenta de ejecucion. Terminologia en [`CONVENTIONS.md`](CONVENTIONS.md).

---

## 1. Principios

- Un solo Sheet con 4 tabs: `Companies`, `Jobs`, `Blocks`, `Config`.
- Acceso batch: `getValues`/`setValues` una vez por run; nunca celda a celda.
- Cada columna tiene UN escritor: o el usuario o el sistema (marcado abajo).
- Sin datos personales del propietario en el Sheet mas alla de lo operativo
  (los blocks son contenido de CV aprobado por el; el Sheet es privado).

## 2. Tab `Companies` — configuracion de empresas a vigilar

| Columna | Tipo | Escribe | Descripcion |
|---------|------|---------|-------------|
| name | texto | usuario | Nombre legible de la empresa |
| ats | enum `greenhouse\|lever\|ashby` | usuario | Connector a usar |
| token | texto | usuario | Slug del board publico del ATS |
| active | bool | usuario | FALSE = no se pollea |
| notes | texto | usuario | Libre |
| last_ok_fetch | fecha-hora | sistema | Ultimo fetch exitoso del feed; condiciona el auto-expire (§6) |
| fail_count | numero | sistema | Fallos consecutivos; dispara mensaje MANTENIMIENTO al superar umbral |

## 3. Tab `Jobs` — el store

Clave: `url_hash` (SHA-256 de la URL canonica, sin query params). Todas las
columnas las escribe el sistema; unica edicion manual permitida: `status` a
`skipped`.

| Columna | Tipo | Descripcion |
|---------|------|-------------|
| url_hash | texto (clave) | Identidad del job para dedup |
| url | texto | URL canonica |
| company / ats / ext_id | texto | Origen y ID externo en el ATS |
| title / location | texto | Del feed |
| posted_at | fecha | Segun campo correcto por ATS (TRD §2) |
| freshness_ok | `true\|unknown` | `unknown` = sin fecha confiable; se uso first_seen |
| track | enum | Mejor track que paso gates |
| score | 0-100 | Del motor de reglas |
| verdict | enum | Apply / Stretch-worth-it / Skip |
| status | enum | Ver maquina de estados (§4) |
| first_seen / last_seen | fecha-hora | Ciclo de vida en el feed |
| notified_at | fecha-hora | Cuando se envio a Telegram |
| cv_doc_url | texto | Doc generado (solo Apply); vacio + flag si quedo pendiente |
| why_it_fits / positioning_lead | texto | Version final enviada (rule-based o enriquecida) |

## 4. Maquina de estados de `Jobs.status`

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
- Los verdicts se calculan al descubrir el job; cambios de Config aplican a
  jobs futuros (re-score manual: evolucion futura).

## 5. Tab `Blocks` — banco de frases del CV

| Columna | Tipo | Escribe | Descripcion |
|---------|------|---------|-------------|
| id | texto (clave) | usuario | p. ej. `sum-payments-01` |
| section | enum `summary\|skills\|experience` | usuario | Seccion del CV |
| role_anchor | texto | usuario | Rol real al que pertenece el block (vacio en summary/skills) |
| text_en / text_es | texto | usuario | El mismo hecho en cada idioma |
| tags | csv | usuario | Para matching con el job |
| evidence | texto | usuario | A que hecho real corresponde la afirmacion |
| approved | bool | usuario | Solo blocks TRUE entran al enum del cv_selector |
| suggested | texto | sistema | Propuesta de la IA (tweak o block nuevo) pendiente de revision; NUNCA se usa en render |

## 6. Tab `Config` — tuning del motor de reglas

Contenido: pesos de categorias, keywords por categoria con peso, definicion de
tracks y gates, umbrales de verdict (`apply=75`, `stretch=55` iniciales),
`title_multiplier` (2.0). `FRESHNESS_MAX_DAYS` queda en Script Properties (es
operacion, no tuning de perfil).

Formato exacto: **se decide en build 2**. Candidatos: (a) filas key/value con
JSON por seccion; (b) tabs `Config_*` separados por categoria. Requisitos:
editable sin deploy y parseable en una sola lectura batch.

## 7. Reglas de integridad

- `url_hash` unico; existente -> solo actualizar `last_seen`.
- Auto-expire SOLO sobre empresas con fetch exitoso en el run.
- Primer run de una empresa: seeding con `status = skipped`, sin notificar.
- `closed` no se reabre ni re-notifica.
- El cv_selector solo ve blocks con `approved = TRUE`.

## 8. Limites y escala

Google Sheets soporta 10M de celdas; `Jobs` con ~20 columnas permite cientos de
miles de filas — ordenes de magnitud por encima del caso de uso. Si `Jobs`
crece demasiado, archivado anual a tab `Jobs_YYYY` (evolucion futura).

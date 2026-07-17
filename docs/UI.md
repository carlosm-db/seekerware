# UI — Seekerware

Diseno de interfaz. Dos canales: **Telegram (push, con botones)** para
enterarse y dar el visto bueno, y la **consola (pull)** para operar todo. El
Doc de CV en Drive es el artefacto entregable. Terminologia en
[`CONVENTIONS.md`](CONVENTIONS.md); diseno extendido en
`docs/audits/2026-07-17-diseno-consola-ux.md`.

---

## 1. Telegram — canal push (y visto bueno)

Un mensaje por job notificado (parse mode HTML). Solo verdicts `Apply` y
`Stretch-worth-it`, con freshness OK y verify-on-notify aprobado.

```
🎯 <b>{title}</b> — {company}
📍 {location} · 🏷 {track} · ⏱ publicado hace {edad}

Verdict: <b>{verdict}</b> · Score {score}/100

<b>Por que encaja:</b> {why_it_fits}
<b>Brecha a mitigar:</b> {gap_to_address}
<b>Posicionamiento:</b> {positioning_lead}
<b>Proyecto a destacar:</b> {project_to_feature}

📄 CV sugerido: {cv_doc_url}        <- solo verdict Apply
🔗 {url}

[ Ver kit ]  [ Marcar aplicado ]    <- botones inline (paso 8)
```

Reglas:

- Sin datos personales del usuario en el mensaje (solo datos del job).
- Si la IA no estuvo disponible, el mensaje sale con los textos rule-based y la
  marca `(rule-based)`.
- Fallos repetidos del feed de una empresa generan un mensaje al mismo chat con
  prefijo `⚠️ MANTENIMIENTO`; los lunes llega el **digest** semanal del funnel.
- **Flujo conversacional del kit** (paso 8, via webhook): al tocar "Ver kit",
  si el formulario tiene preguntas sin respuesta aprobada en el banco
  `answers`, el bot las pregunta UNA a una en el chat; las respuestas del
  propietario se incluyen en el kit y (con su OK) se guardan al banco. El bot
  transporta; JAMAS redacta.

## 2. La consola — 10 paginas

Webapp multipagina servida por el worker, SIEMPRE detras del login (cookie
firmada — TRD §8). Es la unica superficie de operacion: reemplaza hojas de
calculo al 100%. Layout ancho obligatorio; tema claro/oscuro; UI en espanol;
teclado-first en el triage; toda mutacion funciona sin JS (forms reales,
mejorados con htmx).

| Ruta | Pagina | Proposito | v |
|------|--------|-----------|---|
| `/login` | Login | unica ruta sin auth | 1 |
| `/` | **Hoy** | pagina matutina: tira de estado (pendientes, ritmo vs objetivo, salud, proximos seguimientos) + triage de survivors (preparar `p` / aplicado `a` / descartar `x` / posponer `s` / nota `n`; deshacer 30 s) | 1 |
| `/jobs` · `/jobs/:hash` | **Vacantes** | todo lo visto: filtros combinables (track/verdict/status/stage/empresa/texto), vistas guardadas, chip "por que NO" en near-misses, export CSV; detalle: desglose del score por categoria, tabla de gates por track, descripcion, historial, panel CV | 1 (tabla+detalle minimo) |
| `/tracker` | **Tracker** | kanban de applications: Notificado → Preparado → Aplicado → Entrevista → Oferta/Rechazado, con notas, fechas, seguimientos vencidos; drag-and-drop | 2 |
| `/companies` | **Empresas** | CRUD + salud (racha de fallos, ultimo error) + **ROI 90d** (jobs vistos, survivors, yield %) + sugerencias de poda + boton "probar token" (dry-run preview al crear) | 1 |
| `/config` | **Calibracion** | editores estructurados (pesos, keywords por familia, gates, umbrales sobre histograma) + **Replay**: simular config borrador contra los ultimos N jobs (default 200, max 1000) con diff de verdicts y proyeccion de volumen ANTES de guardar; historial con revert | 1 (editor) / 2 (replay) |
| `/blocks` · `/blocks/anchors` | **Banco** | browser agrupado por fact_key, editor con checklist de aprobacion forzado (evidence+fact_key+tag), cola de `suggested` (convertir en borrador / descartar), reporte de cobertura de tags, reporte de paridad EN/ES, registro de anchors | 2 (con paso 6) |
| `/cvs` | **CVs** | biblioteca de CVs generados: Doc + PDF, blocks usados, notas del verifier persistidas, regenerar, diff entre generaciones | 2 (con paso 6) |
| `/aplicaciones` | **Aplicaciones** | cola del kit: Apply pendientes → kit listo (PDF, answers matcheadas, preguntas rojas, deep link) → aplicado; censo de preguntas | 2 (paso 8) |
| `/salud` | **Salud** | ultimo run + historial (`runs`), log de eventos, meters de cuota (pico subrequests vs 50, D1 vs limites, Gemini vs RPD), empresas con problemas, chequeos de integridad | 1 (runs) / 2 (completo) |
| `/semana` | **Semana** | funnel semanal por track (vistos→survivors→aplicadas→entrevistas→ofertas), conversiones con deltas, momentum (racha de triage, ritmo vs `weekly_goal`, time-to-apply mediano), aging WIP | 2 |

Transversales: nav superior con badges (pendientes de triage, suggested,
salud), footer omnipresente "ultimo run hace X min · N empresas OK · errores",
busqueda global `Ctrl+K` (v2), navegacion `g`+tecla.

Features creativas incorporadas: **prep de entrevista** (`/jobs/:hash/prep`,
v2): dossier 100% rule-based que proyecta los blocks del CV enviado CON su
`evidence` — cada afirmacion respaldada por su hecho; **radar de similares**
(cluster por `title_norm` + tags: reuso de posicionamiento entre empresas);
**momentum** (metricas de ritmo honestas para un perfil de alta
conciencia); **digest** de lunes.

Escritores por pagina (extiende la regla un-escritor-por-columna): `jobs` solo
sistema (unica excepcion: `status -> skipped`); `applications`/`job_events`
(actor user) / notas: usuario; `companies`/`config`/`blocks`/`answers`:
usuario; `runs`/`events`/`notifications`: sistema.

## 3. Doc de CV sugerido (Drive) + PDF

Nombre: `CV — {company} — {title} — {yyyy-mm-dd}`, en la carpeta compartida
(`DRIVE_FOLDER_ID`).

Estructura (desde plantilla `CV_TEMPLATE_DOC_ID`, placeholders `{{...}}`):

1. Encabezado con datos de contacto — vienen de la plantilla (recurso privado),
   nunca del repo ni del sistema.
2. Resumen profesional — 1 block seleccionado.
3. Skills — N blocks seleccionados.
4. Experiencia — por anchor real, con los blocks seleccionados para este job.
5. Educacion / certificaciones — desde plantilla.
6. **Apendice "Suggested tweaks"** (fondo gris, para borrar antes de enviar):
   sugerencias del cv_verifier — nunca aplicadas automaticamente — y la
   justificacion de la seleccion. Las notas se persisten ADEMAS en D1 (tabla
   `cvs`), asi sobreviven cuando el propietario borra el apendice.

Idioma del Doc = idioma del job (blocks `text_en` o `text_es`; render ES exige
paridad aprobada). El PDF exportado para el kit y el archivo R2 usa una copia
LIMPIA sin apendice (TRD §6).

## 4. Stack de la consola (resumen; detalle TRD §8)

Hono + `hono/jsx` SSR + htmx vendorizado + islas vanilla + CSS unico con
custom properties. Cero build adicional. Login por cookie firmada (sin
dominio → sin Access). Assets tras `run_worker_first`. Paginacion a 50 en
toda tabla; replay en lotes de 50 (limite de CPU del free tier).

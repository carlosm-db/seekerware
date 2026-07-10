# UI — Seekerware

Diseno de interfaz. Dos canales: **Telegram (push)** para enterarse y el
**dashboard (pull)** para configurar y hacer tracking. El Doc de CV en Drive es
el artefacto entregable. Terminologia en [`CONVENTIONS.md`](CONVENTIONS.md).

---

## 1. Telegram — canal push

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
```

Reglas:

- Sin datos personales del usuario en el mensaje (solo datos del job).
- Si la IA no estuvo disponible, el mensaje sale con los textos rule-based y la
  marca `(rule-based)`.
- Fallos repetidos del feed de una empresa generan un mensaje al mismo chat con
  prefijo `⚠️ MANTENIMIENTO`.

## 2. Dashboard — consola de configuracion y tracking

Webapp servida por el worker, SIEMPRE detras de login (TRD §8). Es la unica
consola del sistema: reemplaza al Sheet del diseno v1.

Rutas y proposito (que edita el usuario vs que escribe el sistema; detalle de
columnas en [`DATABASE.md`](DATABASE.md)):

| Ruta | Entidad | Edita el usuario | Escribe el sistema |
|------|---------|------------------|--------------------|
| `/companies` | `companies` | name, ats, token, active, notes | last_ok_fetch, fail_count |
| `/` (jobs) | `jobs` | solo status -> `skipped` (opcional) | todo lo demas |
| `/blocks` | `blocks` | todas las columnas del banco + approved | suggested (propuestas IA) |
| `/config` | `config` | pesos, keywords, tracks, umbrales, FRESHNESS_MAX_DAYS | — |

### Consola minima (build 4)

- Tabla de jobs con filtros por track/verdict/status y busqueda; badges de
  color por status: `new` = azul · `notified` = verde · `closed` = gris ·
  `skipped` = neutro.
- CRUD de `companies` y editor de `config` (formularios simples).
- Vistas filtradas: "Notificados esta semana", "Apply pendientes", "Cerrados
  sin aplicar".

### Consola completa (build 7)

- Detalle por job: desglose del score por categoria (transparencia del motor de
  reglas), historial de estados.
- Flujo de aprobacion del banco: revisar `suggested`, editar y aprobar blocks
  en la misma vista.
- Acciones: marcar aplicado/descartado, regenerar CV, dry-run por empresa desde
  la UI.
- Pulido visual: **layout ancho obligatorio** (aprovechar todo el ancho
  disponible), tema claro/oscuro, estados vacios y de error cuidados.

Principios: HTML server-rendered por el worker, sin build pesado; interaccion
progresiva (formularios que funcionan sin JS; JS solo donde suma). El dashboard
es una herramienta diaria del propietario: se disena para lectura rapida.

## 3. Doc de CV sugerido (Drive)

Nombre: `CV — {company} — {title} — {yyyy-mm-dd}`, en la carpeta compartida
(`DRIVE_FOLDER_ID`).

Estructura (desde plantilla `CV_TEMPLATE_DOC_ID`, placeholders `{{...}}`):

1. Encabezado con datos de contacto — vienen de la plantilla (recurso privado),
   nunca del repo ni del sistema.
2. Resumen profesional — 1 block seleccionado.
3. Skills — N blocks seleccionados.
4. Experiencia — por rol real (`role_anchor`), con los blocks seleccionados
   para este job.
5. Educacion / certificaciones — desde plantilla.
6. **Apendice "Suggested tweaks"** (fondo gris, para borrar antes de enviar):
   sugerencias del cv_verifier — nunca aplicadas automaticamente — y la
   justificacion de la seleccion ("el job enfatiza X; se destacaron los blocks
   Y/Z").

Idioma del Doc = idioma del job (blocks `text_en` o `text_es`).

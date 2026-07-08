# UI — Seekerware

Diseno de interfaz. La UI primaria NO es una app: es **Telegram (push)** para
enterarse y **el Sheet (pull)** para configurar y hacer tracking. El Doc de CV
en Drive es el artefacto entregable. Dashboard HtmlService: fase opcional 6.
Terminologia en [`CONVENTIONS.md`](CONVENTIONS.md).

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

## 2. El Sheet — consola de configuracion y tracking

Que edita el usuario vs que escribe el sistema, por tab (detalle de columnas en
[`DATABASE.md`](DATABASE.md)):

| Tab | Edita el usuario | Escribe el sistema |
|-----|------------------|--------------------|
| `Companies` | name, ats, token, active, notes | last_ok_fetch, fail_count |
| `Jobs` | solo status -> `skipped` (opcional) | todo lo demas |
| `Blocks` | todas las columnas del banco + approved | suggested (propuestas IA) |
| `Config` | pesos, keywords, tracks, umbrales | — |

Formato condicional en `Jobs.status` para lectura rapida:

- `new` = azul · `notified` = verde · `closed` = gris · `skipped` = sin color.

Vistas filtradas recomendadas: "Notificados esta semana", "Apply pendientes",
"Cerrados sin aplicar".

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

## 4. Dashboard HtmlService (fase opcional 6)

Webapp GAS al estilo de los modulos DiversoLAB (`index.html` + parciales +
`google.script.run`):

- Tabla de jobs con filtros por track/verdict/status y busqueda.
- Detalle por job: desglose del score por categoria (transparencia del motor de
  reglas).
- Acciones: marcar aplicado/descartado, regenerar CV.
- **Layout ancho obligatorio**: aprovechar todo el ancho disponible; auditar el
  patron de layout de los modulos DiversoLAB antes de construir.
- Si alguna accion es lenta, progreso via polling de `PropertiesService`
  (patron DiversoLAB).

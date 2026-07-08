# Seekerware

Motor personal de descubrimiento de empleo ("reverse-ATS"): vigila los feeds
publicos de vacantes de empresas seleccionadas, puntua cada job nuevo contra un
perfil configurado, descarta el ruido y notifica por Telegram **solo** cuando
algo encaja de verdad — con nota de posicionamiento y CV sugerido. El humano
siempre es quien aplica.

> **Estado**: diseno cerrado 2026-07-07 · en construccion (paso 0: documentacion).
> Los .md documentan intencion; **el codigo es la fuente de verdad**
> (ver [`CLAUDE.md`](CLAUDE.md)).

---

## Como funciona (3 capas + paso humano)

```
[trigger 30-60 min]
      |
      v
1. DISCOVERY   — poll de APIs publicas ATS (Greenhouse / Lever / Ashby, sin login)
      |            -> job normalizado {id, company, title, location, url, ...}
      v
2. FILTER &    — score 0-100 por reglas (dominio > tipo de rol > herramientas > nivel)
   SCORE          + 3 tracks con gates propios -> verdict Apply | Stretch-worth-it | Skip
      |            (la IA nunca decide verdicts; solo enriquece survivors)
      v
3. NOTIFY &    — dedup (hash de URL), freshness (<= 3 dias), verify-on-notify,
   TRACK          push a Telegram, tracking en el Sheet, CV factory -> Doc en Drive
      |
      v
   HUMANO      — revisa y aplica manualmente
```

## Los 3 tracks

| Track | Que busca |
|-------|-----------|
| `canada_coop` | Co-op / work terms en Canada |
| `colombia_perm` | Termino indefinido en Colombia para empresas internacionales |
| `contractor_usd` | Contractor remoto con pago en USD |

## Plataforma

**Google Apps Script** (patron del ecosistema DiversoLAB-GAS), gestionado con
clasp desde este repo:

- **Store / config / tracking**: un Google Sheet (tabs `Companies`, `Jobs`,
  `Blocks`, `Config`).
- **IA**: Gemini API free tier, solo sobre survivors; salida JSON forzada por
  `responseSchema`. En CV, la IA **selecciona frases pre-aprobadas, nunca
  redacta**.
- **Notificacion**: Telegram Bot API.
- **Dos cuentas Google**: una de datos (Sheet + Drive) y una de ejecucion
  (proyecto GAS, trigger, API keys, llamadas salientes).

## Setup

1. **Tokens ATS** — sin cuenta: el token es el slug de la URL publica del board
   (`boards.greenhouse.io/{token}`, `jobs.lever.co/{token}`,
   `jobs.ashbyhq.com/{token}`). Se registran como filas del tab `Companies`.
2. **Bot de Telegram** — crear con @BotFather, copiar el token; obtener el
   `chat_id` via `https://api.telegram.org/bot<token>/getUpdates` tras enviarle
   un mensaje al bot.
3. **Gemini API key** — de la cuenta de ejecucion (free tier).
4. **Script Properties** (nunca secretos en codigo): `TELEGRAM_BOT_TOKEN`,
   `TELEGRAM_CHAT_ID`, `GEMINI_API_KEY`, `FRESHNESS_MAX_DAYS`, `SHEET_ID`,
   `DRIVE_FOLDER_ID`, `CV_TEMPLATE_DOC_ID`.

## Estructura del repo

```
seekerware/
├── README.md / CLAUDE.md / .mcp.json
├── docs/                      # documentacion (ver indice abajo)
├── .clasp.json                # (paso 1) proyecto GAS
├── appsscript.json            # (paso 1)
├── codigo.js                  # (paso 1) entrypoint, api_*, helpers
├── connectors.js              # (pasos 1 y 4) Greenhouse -> Lever + Ashby
├── scoring.js                 # (paso 2) motor de reglas + tracks
├── freshness.js               # (paso 3) freshness + verify-on-notify + auto-expire
├── store.js                   # (paso 3) Sheet
├── notify.js                  # (paso 3) Telegram
├── pipeline.js                # (paso 3) orquestacion del trigger
├── ia_agents.js               # (paso 5) wrapper Gemini + agentes
└── ia_pipeline.js             # (paso 5) CV factory
```

## Documentacion

| Documento | Contenido |
|-----------|-----------|
| [`CLAUDE.md`](CLAUDE.md) | Reglas de trabajo para agentes; codigo = fuente de verdad |
| [`docs/CONVENTIONS.md`](docs/CONVENTIONS.md) | Glosario canonico y convenciones de codigo/docs/commits |
| [`docs/PRD.md`](docs/PRD.md) | Producto: modelo funcional, tracks, requerimientos, no-goals |
| [`docs/TRD.md`](docs/TRD.md) | Tecnico: connectors, scoring, IA, store, errores |
| [`docs/DATABASE.md`](docs/DATABASE.md) | El Sheet como base de datos: tabs, columnas, estados |
| [`docs/UI.md`](docs/UI.md) | Telegram, el Sheet como consola, Doc de CV, dashboard futuro |
| [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) | Pasos, criterios de aceptacion, inputs, decisiones |

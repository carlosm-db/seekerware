# Seekerware

Motor personal de descubrimiento de empleo ("reverse-ATS"): vigila los feeds
publicos de vacantes de empresas seleccionadas, puntua cada job nuevo contra un
perfil configurado, descarta el ruido y notifica por Telegram **solo** cuando
algo encaja de verdad — con nota de posicionamiento y CV sugerido. El humano
siempre es quien aplica.

> **Estado**: diseno v2 cerrado 2026-07-09 (reframe a Cloudflare; el diseno v1
> all-GAS del 2026-07-07 quedo en el historial de git) · en construccion —
> paso 1 (scaffold + Greenhouse + dry-run + CI) completado 2026-07-17;
> siguiente: paso 2 (scoring). Los .md documentan intencion; **el codigo es
> la fuente de verdad** (ver [`CLAUDE.md`](CLAUDE.md)).

---

## Como funciona (3 capas + paso humano)

```
[cron 30-60 min]
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
   TRACK          push a Telegram, tracking en D1, CV factory -> Doc en Drive
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

**Cloudflare Worker** en TypeScript, gestionado con wrangler desde este repo y
desplegado via GitHub Actions. Todo en free tiers ($0/mes):

- **Runtime**: un worker con `scheduled()` (pipeline, Cron Trigger 30-60 min) y
  `fetch()` (dashboard + API, siempre detras de login).
- **Store / config / tracking**: D1 (SQLite) con tablas `companies`, `jobs`,
  `blocks`, `config` y migrations versionadas.
- **Consola**: dashboard web servido por el mismo worker (login via Cloudflare
  Access) — tracking de jobs, empresas, tuning del perfil y banco de blocks.
- **IA**: Gemini API free tier, solo sobre survivors; salida JSON forzada por
  `responseSchema`. En CV, la IA **selecciona frases pre-aprobadas, nunca
  redacta**.
- **CV**: Docs generados en Drive via service account (render determinista
  sobre plantilla; unica dependencia Google).
- **Notificacion**: Telegram Bot API.

## Setup

1. **Tokens ATS** — sin cuenta: el token es el slug de la URL publica del board
   (`boards.greenhouse.io/{token}`, `jobs.lever.co/{token}`,
   `jobs.ashbyhq.com/{token}`). Se registran en la tabla `companies`.
2. **Cloudflare** — cuenta con Workers + D1; API token para el deploy (secrets
   de GitHub Actions: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`).
3. **Bot de Telegram** — crear con @BotFather, copiar el token; obtener el
   `chat_id` via `https://api.telegram.org/bot<token>/getUpdates` tras enviarle
   un mensaje al bot.
4. **Gemini API key** — free tier (AI Studio).
5. **Google Docs (CV factory)** — service account GCP; la cuenta de datos
   comparte carpeta Drive y plantilla de CV como editor al service account.
6. **Worker secrets** (via `wrangler secret put`, nunca en el repo):
   `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `GEMINI_API_KEY`,
   `GOOGLE_SA_KEY`, `DRIVE_FOLDER_ID`, `CV_TEMPLATE_DOC_ID`. El tuning
   (incluido `FRESHNESS_MAX_DAYS`) vive en la tabla `config`.

## Estructura del repo

```
seekerware/
├── README.md / CLAUDE.md / .mcp.json
├── docs/                      # documentacion (ver indice abajo)
├── wrangler.jsonc             # (paso 1) config del worker + bindings
├── package.json / tsconfig.json
├── migrations/                # (paso 1) schema D1 versionado
├── src/
│   ├── index.ts               # (paso 1) entrypoint: scheduled() + fetch()
│   ├── connectors/            # (pasos 1 y 5) greenhouse.ts -> lever.ts + ashby.ts
│   ├── scoring.ts             # (paso 2) motor de reglas + tracks
│   ├── pipeline.ts            # (paso 3) orquestacion del run
│   ├── freshness.ts           # (paso 3) freshness + verify-on-notify + auto-expire
│   ├── store.ts               # (pasos 1-3) acceso a D1
│   ├── notify.ts              # (paso 3) Telegram
│   ├── dashboard/             # (pasos 4 y 7) consola web
│   ├── ia/                    # (paso 6) gemini.ts + agents.ts + cv_factory.ts
│   └── gdocs.ts               # (paso 6) service account + Docs/Drive REST
└── test/                      # vitest + fixtures de feeds
```

## Documentacion

| Documento | Contenido |
|-----------|-----------|
| [`CLAUDE.md`](CLAUDE.md) | Reglas de trabajo para agentes; codigo = fuente de verdad |
| [`docs/CONVENTIONS.md`](docs/CONVENTIONS.md) | Glosario canonico y convenciones de codigo/docs/commits |
| [`docs/PRD.md`](docs/PRD.md) | Producto: modelo funcional, tracks, requerimientos, no-goals |
| [`docs/TRD.md`](docs/TRD.md) | Tecnico: connectors, scoring, IA, store, dashboard, errores |
| [`docs/DATABASE.md`](docs/DATABASE.md) | D1 como base de datos: tablas, columnas, estados |
| [`docs/UI.md`](docs/UI.md) | Telegram, dashboard, Doc de CV |
| [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) | Pasos, criterios de aceptacion, inputs, decisiones |

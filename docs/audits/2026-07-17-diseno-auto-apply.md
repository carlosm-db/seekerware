# Auto-aplicacion en Seekerware — factibilidad, riesgos y escalera L0-L3

Investigacion de factibilidad y diseno de riesgo para avanzar de "notify-only"
hacia aplicacion automatica. Evidencia web recolectada 2026-07-17 (fuentes en
§8). Terminologia segun `docs/CONVENTIONS.md`; los cambios de reglas se citan
contra el texto exacto de `docs/PRD.md` y `CLAUDE.md` vigentes.

---

## 0. Resumen ejecutivo

1. **Los tres ATS tienen API oficial de envio de aplicaciones — pero ninguna
   es utilizable por un aplicante.** Greenhouse, Lever y Ashby exponen
   endpoints POST para crear candidatos, y en los tres casos la API key la
   emite la EMPRESA contratante (admin del ATS) para sus propias career pages
   e integraciones. No existe via oficial para que un buscador de empleo
   envie aplicaciones programaticamente.
2. **La alternativa (emular el form hosted) es territorio anti-bot.**
   Greenhouse corre invisible reCAPTCHA + verificacion de email + deteccion
   de fraude por IP/user-agent + blocklists por organizacion; Lever y Ashby
   tienen mitigaciones equivalentes y limites por candidato. Un POST desde la
   IP datacenter de un Cloudflare Worker es la firma de bot mas obvia posible.
3. **El modo de fallo dominante no es el error visible sino el silencioso**:
   la aplicacion "se envia", cae en la cola de spam/fraude del empleador, y el
   job queda quemado (dedup + `closed` terminal = no hay segunda oportunidad).
   Para una lista curada de ~84 empresas objetivo, quemar una empresa es una
   perdida permanente.
4. **El mercado confirma el patron**: las herramientas tipo autofill con
   humano presente (Simplify) tienen buena reputacion; las de envio masivo
   desatendido (LazyApply, AIHawk) acumulan bans, formularios mal llenados y
   respuesta activa de la industria (Greenhouse Real Talent, deteccion
   conductual).
5. **Recomendacion: L1 completo ("kit de aplicacion") ahora — cero cambios a
   las reglas del proyecto — y L2 SOLO en la variante "companion local con
   click humano" (L1.5) como evolucion. Rechazar el envio server-side (L2b) y
   el modo desatendido (L3)** por razones tecnicas, no solo eticas: el ROI es
   negativo para un pipeline de precision con survivors de un solo digito
   por dia.

---

## 1. Evidencia por pregunta de investigacion

### 1.1 Greenhouse Job Board API — ¿soporta POST de aplicaciones?

**Si, pero es company-side.** Endpoint:
`POST https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs/{id}`.

- **Autenticacion**: HTTP Basic Auth donde "the Basic Auth username is your
  API key (found on the API Credentials page)". Esa pagina es el **Dev Center
  de la cuenta Greenhouse de la empresa** (Configure -> Dev Center -> API
  Credential Management). La key se crea para "integrations you enable on
  Greenhouse Recruiting". El board token publico solo da LECTURA; el POST
  exige la key privada de la empresa. Un aplicante externo no puede
  obtenerla. [1][2][3]
- **Campos**: requeridos `first_name`, `last_name`, `email`. Resume en 4
  modos: multipart (`resume`), base64 (`resume_content` +
  `resume_content_filename`), URL externa (`resume_url`), o texto plano
  (`resume_text`). Mismos modos para cover letter y adjuntos de custom
  questions. [1][2]
- **Custom questions**: "Application forms are job-specific and will be
  constructed via the 'questions' array available via the Job method" — es
  decir, `GET /boards/{token}/jobs/{id}?questions=true`, que es **publico
  (solo board token)**. Esto es oro para el diseno del kit (§3.2): permite
  detectar y enumerar las preguntas del form de cada job sin credenciales.
  [1][2]
- **EEOC/demograficos**: array `demographic_answers` con `question_id` +
  `answer_option_id`, solo cuando la empresa tiene Greenhouse Inclusion
  activo. [2]
- Greenhouse explicitamente desincentiva implementaciones custom del form y
  recomienda su "Embedded Job Application" con "built-in spam protection
  measures". [2]

### 1.2 Lever — ¿apply programatico sobre jobs.lever.co?

**API oficial: si, pero company-side.** Endpoint:
`POST https://api.lever.co/v0/postings/{SITE}/{POSTING-ID}?key=APIKEY`.

- **La key la genera "a Super Admin of your account ... from your
  integrations settings page"** — cuenta de la empresa en Lever. [4]
- Requeridos: `name` y `email` (mas los campos que la empresa haya marcado
  requeridos). Resume SOLO en multipart form-data. Flag `silent` para no
  enviar email al candidato. Rate limit: **429 por encima de 2 POST/s**. [4]
- La documentacion recomienda a las empresas implementar "spam mitigations
  such as captchas and session or IP based rate limits" en forms custom;
  el form hosted de jobs.lever.co ya trae esas mitigaciones. [4]
- **El JSON publico de postings NO expone las preguntas del form**: las
  custom questions solo son visibles en la pagina de apply (HTML). Detectar
  custom questions en Lever requiere fetch de esa pagina publica (decision de
  alcance en §6.1).

### 1.3 Ashby — ¿posting-api soporta envio?

**Si, `applicationForm.submit`, pero company-side.** [5][6]

- Es parte de la API principal (`api.ashbyhq.com`), no del posting-api
  publico. Requiere API key con permiso de escritura del modulo Candidates;
  las keys se administran por "an Ashby Admin ... in the Ashby web app"
  (app.ashbyhq.com/admin/api/keys). [7]
- El schema del form (tipos String/Email/File/Boolean/ValueSelect/etc.,
  `isRequired`) se obtiene via `jobPosting.info` — **tambien detras de API
  key**. El feed publico del posting-api NO incluye el schema del form.
- Files: multipart o handles via `file.createFileUploadHandle`.
- Anti-abuso server-side: la respuesta puede traer `blocked: true` "due to
  configured application limits (eg too many applications submitted for a
  single candidate)"; ademas hay que chequear `success: false` — si no,
  "applications not being recorded without any notification". Modo de fallo
  silencioso documentado por el propio vendor. [5][6]

### 1.4 Realidad anti-bot en los forms hosted

- **Greenhouse**: invisible reCAPTCHA que "analyzes activity on a job post,
  like mouse movements and typing patterns"; segun configuracion, puede
  exigir **verificacion por codigo de email**; sensibilidad configurable por
  la empresa. [8] Encima: **Fraud Detection** (senales de IP, user agent,
  email/telefono -> "fraud risk" sobre la aplicacion) y **Spam and IP
  blocklist** administrado por la organizacion que **auto-rechaza en el
  intake** por dominio de email, email o IP. [9] En 2025 lanzaron **Real
  Talent** especificamente para "identify and flag spam, bot submissions, and
  applications with patterns indicative of fraud". [10]
- **Lever**: el form hosted trae mitigaciones anti-spam administradas por
  Lever (captcha / rate limits por sesion o IP). [4]
- **Ashby**: limites de aplicacion por candidato server-side (`blocked`). [5]
- **Deteccion conductual** (vendors tipo CrossClassify venden esto a
  reclutadores): timing demasiado rapido/regular, reuso de fingerprint de
  device, muchas aplicaciones en rafaga, "browser environment that looks
  manipulated". [11]
- **Frecuencia de custom questions**: no hay cifra publica confiable; lo
  correcto es medirla empiricamente — el array `questions` de Greenhouse es
  publico, asi que el propio pipeline puede censarla sobre las 84 empresas
  (propuesta: "censo de preguntas" en §3.2). Las preguntas de work
  authorization son casi universales (y para este proyecto ya son gates);
  EEOC aparece sobre todo en postings US.

### 1.5 Herramientas comerciales de auto-apply — como operan y reputacion

| Herramienta | Mecanica | Reputacion / modo de fallo |
|---|---|---|
| **Simplify Copilot** | Extension de navegador: autofill del form desde un perfil; el humano revisa y hace click en submit. Cubre 100+ portales (Workday, Greenhouse, Lever, iCIMS...). | Aceptada en general; "no major platform is built to detect autofill authorship". El humano presente elimina el patron de bot. [12][13] |
| **LazyApply** | Extension que auto-completa Y auto-envia en masa. | ~2.4/5 en Trustpilot (mayoria 1 estrella); falla llenando campos basicos (hasta nombre/apellido); caso reportado de 14,000+ aplicaciones incluyendo roles sin fit; figura en listas de plugins blacklisteados de LinkedIn; cuentas restringidas/baneadas; soporte inalcanzable. [14][15] |
| **AIHawk / Jobs_Applier_AI_Agent** | Open source: Selenium con `undetected-chromedriver` + PyAutoGUI + aleatorizacion "human-like" **disenada explicitamente para evadir deteccion**; apunta sobre todo a LinkedIn Easy Apply. | Cobertura de prensa + criticas fuertes (HN: "clogs job inboxes"); el propio README delega el cumplimiento de ToS al usuario. Es la carrera armamentista que provoco Real Talent. [16][17] |
| Ecosistema | — | Encuesta Robert Half (nov 2025, publicada mar 2026, 2,000+ hiring managers US): 67% dice que revisar aplicaciones generadas por AI **enlentecio su hiring**; 65% dice que es mas dificil verificar skills reales. La reaccion es mas filtros, no mas tolerancia. [18] |

Lectura clave para Seekerware: **la propuesta de valor del auto-apply
comercial es VOLUMEN**. Seekerware es lo contrario: un pipeline de PRECISION
que produce survivors de un digito por dia ya enriquecidos. El costo marginal
que elimina el auto-submit (~5-10 min por aplicacion) es minusculo comparado
con el riesgo que introduce.

### 1.6 ToS / politica y consecuencias observadas

- Los ToS de Greenhouse/Lever/Ashby son contratos con **sus clientes (los
  empleadores)**, no con los aplicantes; no se encontro un "applicant
  agreement" que prohiba explicitamente el envio automatizado. [19]
- La consecuencia real contra aplicantes no es legal sino **tecnica y por
  empleador**: auto-reject en intake (blocklist por email/IP de Greenhouse),
  flag de "fraud risk" adherido al perfil del candidato dentro del ATS de esa
  empresa, y **rechazo silencioso** (nunca se notifica al candidato). [9][11]
- Traducido al proyecto: el peor resultado no es "Greenhouse demanda al
  propietario" sino **"el email del propietario queda en la blocklist de una
  de sus 84 empresas objetivo, para siempre, sin que nadie se lo diga"**.

---

## 2. Matriz de factibilidad por ATS

| Capacidad | Greenhouse | Lever | Ashby |
|---|---|---|---|
| Leer jobs (hoy, L0) | Publico (board token) | Publico | Publico (posting-api) |
| **Descubrir preguntas del form** | **PUBLICO**: `GET jobs/{id}?questions=true` | No publico (solo HTML de la pagina de apply) | No publico (`jobPosting.info` exige API key) |
| Deep link al form | Si (`url` del feed) | Si (`applyUrl` / `{url}/apply`) | Si (URL del posting) |
| API oficial de envio | Si — **key emitida por la empresa** (Dev Center) | Si — **key emitida por Super Admin de la empresa** | Si — **key de Ashby Admin de la empresa** |
| ¿Key obtenible por un aplicante? | **No** | **No** | **No** |
| Emular form hosted (sin key) | reCAPTCHA invisible + email verification + fraud detection + blocklists | captcha/rate limit por sesion e IP | SPA + limites por candidato + fallo silencioso (`success:false`) |
| Headless browser desde Cloudflare | Browser Rendering existe en free plan (10 min/dia) [20], pero egress = IP datacenter -> senal de fraude inmediata | idem | idem |
| Riesgo de fallo silencioso al emular | Alto (cola de spam) | Alto | Alto y documentado |

**Conclusion tecnica**: para un sistema del lado del aplicante, el envio
mecanico "limpio" via API **no esta soportado en ninguno de los tres ATS**.
Todo L2/L3 server-side es, por construccion, emulacion de forms contra
defensas anti-bot activas, desde una IP que las delata.

---

## 3. La escalera L0 -> L3

### L0 — Notify-only (hoy)

Lo ya disenado: descubre -> puntua -> filtra -> notifica con posicionamiento
y CV sugerido -> el humano decide y aplica. Cumple PRD tal cual. Punto de
partida y fallback permanente de todos los niveles superiores.

### L1 — Kit de aplicacion (recomendado: construir ya)

**Idea**: el sistema prepara TODO lo que el humano necesita para aplicar en
<= 5 minutos; el humano revisa y hace click. **Cero contacto del sistema con
empresas** -> cero cambios a los no-goals del PRD; solo adiciones.

Componentes del kit (por survivor con verdict Apply):

1. **CV PDF listo**: tras el cv_verifier, export del Doc a PDF via
   `GET https://www.googleapis.com/drive/v3/files/{id}/export?mimeType=application/pdf`
   (mismo access token del service account; +1 subrequest). Se guarda link (o
   se sirve proxy desde el worker con el token) — los forms de ATS piden
   upload de archivo, y hoy el flujo obliga a File->Download manual en Docs.
   OJO: el apendice "Suggested tweaks" debe removerse antes del export
   (render de una copia "clean" sin apendice para el PDF).
2. **Nota de posicionamiento**: ya existe en el contrato de salida
   (`positioning_lead`, `gap_to_address`, `project_to_feature`) — el kit la
   presenta lista para copiar/pegar como base de cover letter... redactada
   por el PROPIETARIO a partir de esos insumos (la IA sigue sin redactar
   contenido dirigido a empresas).
3. **Banco de respuestas (`profile_answers`)**: tabla nueva en D1, autoria
   100% del propietario (mismo modelo de gobernanza que blocks): work
   authorization por track, notice period, expectativa salarial por track,
   ubicacion, links (LinkedIn/GitHub/portfolio), "how did you hear about us",
   consentimientos GDPR tipicos. EN + ES con paridad, como los blocks.
4. **Deteccion de custom questions**:
   - Greenhouse: `?questions=true` (publico) -> el kit lista cada pregunta
     del form, marca las que matchean el banco de respuestas (matching
     determinista por tipo/keywords; opcionalmente un agente selector estilo
     cv_selector con enum de answer IDs — seleccion, nunca redaccion) y
     resalta en rojo las que requieren respuesta manual.
   - Lever/Ashby: sin API publica del form -> el kit marca "preguntas del
     form no inspeccionables; abrir el link". (Opcional futuro: fetch del
     HTML publico de la pagina de apply de Lever — requiere decision del
     propietario porque roza el no-goal de scraping, §6.1.)
5. **Deep link** + checklist de submit en la consola y boton en Telegram.
6. **Censo de preguntas** (side-effect valioso): un job semanal recorre los
   boards Greenhouse activos y persiste el inventario de preguntas por
   empresa -> datos reales para decidir si L2 alguna vez vale la pena, y
   para pre-poblar el banco de respuestas con las preguntas mas frecuentes.

Cambios de sistema (todos aditivos): estado `kit_ready` (o columna
`kit_url`), tabla `profile_answers`, tabla `application_kits` (o columnas en
`jobs`), ruta `/aplicaciones` en la consola, boton/link en el mensaje de
Telegram. Subrequests: +1-2 por Apply (export PDF, questions fetch) — holgado
dentro de los 50.

**Riesgo**: ninguno nuevo hacia empresas. El unico riesgo es interno
(respuestas del banco desactualizadas -> misma gobernanza de revision que
blocks).

### L2 — Envio aprobado por-job (tres variantes, solo una honesta)

El humano aprueba cada aplicacion (boton en Telegram o consola); el sistema
la envia. Tres variantes con factibilidad MUY distinta:

- **L2a — via API oficial del ATS: NO EXISTE para aplicantes.** Las tres
  keys son company-issued (§1.1-1.3). Descartada por imposibilidad, no por
  preferencia.
- **L2b — emulacion del form hosted desde el Worker**: construible solo para
  Greenhouse (form conocido + questions publicas), pero enfrenta invisible
  reCAPTCHA (analiza mouse/typing — un POST directo no tiene ninguno),
  posible verificacion por email, fraud detection por IP/user-agent (egress
  de Cloudflare = datacenter), y blocklists. Browser Rendering en free plan
  (10 min/dia) haria posible un headless real, pero con la misma IP y
  fingerprint de datacenter. **Modo de fallo: exito aparente + cola de spam
  + job quemado + email del propietario flaggeado.** Veredicto: NO
  construir. Es ademas la variante que exigiria TODOS los cambios de reglas
  de §6.3 y salvaguardas de §5.
- **L2c — companion local con click humano (en la practica "L1.5")**: la
  aprobacion en consola/Telegram habilita un endpoint `/api/kit/{id}` (tras
  el login); un userscript o extension minima en el navegador del
  propietario lee el kit y AUTOFILLA el form (patron Simplify: navegador
  real, IP residencial, humano presente que revisa y hace click en submit).
  El sistema nunca toca a la empresa; el click final es humano. Riesgo clase
  Simplify (aceptado por la industria, §1.5). Costo: un userscript de ~200
  lineas por ATS; sin cambios al Worker mas alla del endpoint del kit.
  **Esta es la unica variante de L2 con ROI positivo.** Nota honesta: como
  el click sigue siendo humano, no viola "el sistema nunca aplica" — es L1
  con menos tipeo, y por eso mismo es segura.

### L3 — Totalmente desatendido

Todo lo de L2b sin el unico gate de calidad restante (la revision humana).
Ademas de heredar todos los riesgos tecnicos de L2b, contradice el diseno del
proyecto en su nucleo: los survivors son pocos y valiosos; quemarlos sin
supervision es destruir el activo que el pipeline produce. Los datos de
mercado (LazyApply 2.4/5, 67% de hiring managers enlentecidos, Real Talent)
muestran que el entorno 2026 castiga activamente este patron. **Rechazado.**

---

## 4. Riesgos por nivel

| Riesgo | L0 | L1 (kit) | L2c (companion) | L2b (Worker submit) | L3 |
|---|---|---|---|---|---|
| Calidad de la aplicacion | Humano llena todo (error por fatiga) | MEJORA: datos consistentes del banco | MEJORA: autofill revisado | Respuestas mecanicas sin ojo humano en el form real | Sin revision: campos mal mapeados = LazyApply |
| Reputacional (por empresa objetivo) | Nulo | Nulo | Bajo (clase Simplify) | ALTO: flag de fraude / blocklist email+IP, silencioso y permanente | CRITICO |
| ToS / anti-bot | N/A | N/A | Bajo (humano presente) | Alto (evasion activa de reCAPTCHA = carrera armamentista) | Alto |
| Survivors quemados | No | No | No (humano confirma) | Si: exito aparente + spam queue; `closed` terminal impide reintento limpio | Si, en lote |
| Free tier / plataforma | — | +1-2 subrequests por Apply | — (corre en el navegador del dueno) | Browser Rendering 10 min/dia; fragilidad de mantenimiento alta | idem |
| Cambios de reglas | Ninguno | Ninguno (solo adiciones) | Ninguno (click humano) | Todos los de §6.3 | §6.3 + metricas PRD §7 |

---

## 5. Salvaguardas requeridas (si algun dia se construye envio real)

Obligatorias ANTES de cualquier L2b/L3 (y utiles parcialmente para L2c):

1. **Aprobacion por-job con token de un solo uso** (boton Telegram firmado o
   accion en consola); expira con el freshness del job.
2. **Verify-on-submit**: re-consultar `isLive(job)` inmediatamente antes del
   envio (mismo patron que verify-on-notify).
3. **Dry-run de aplicacion**: modo que arma el payload completo y lo persiste
   SIN enviar; el propietario puede inspeccionarlo en la consola. Default ON
   hasta decision explicita.
4. **Audit log inmutable** (`applications`): snapshot integro del payload,
   timestamp, endpoint, status code, respuesta cruda, quien aprobo. Nada se
   envia que no quede registrado.
5. **Rate limiting propio**: cap diario (p. ej. 3), cooldown por empresa
   (p. ej. 1 aplicacion/empresa/semana), jitter. Nunca reintentar en 4xx.
6. **Kill switch** en `config` (`AUTO_SUBMIT_ENABLED`), chequeado en cada
   envio.
7. **Custom question sin respuesta aprobada -> punt a humano** (degrada esa
   aplicacion a L1). Nunca inventar respuestas; EEOC/demograficos NUNCA se
   auto-responden.
8. **Respuestas solo del banco `profile_answers` aprobado** — extension
   natural de la regla "la IA nunca redacta": tampoco redacta respuestas de
   forms; solo selecciona respuestas aprobadas via enum.
9. **Alerta MANTENIMIENTO** ante cualquier respuesta anomala del envio
   (429, `blocked: true`, `success: false`, HTML inesperado).

---

## 6. Cambios exactos de reglas por nivel

### 6.1 Para L1 (kit): NINGUNA regla se rompe; 2 decisiones menores

- PRD §6 "No auto-apply" — intacto (el sistema sigue sin contactar
  empresas). PRD §2 fila Sistema "Nunca aplica, nunca contacta empresas" —
  intacto.
- Adiciones (no enmiendas): nuevo RF11 "Kit de aplicacion" en PRD §5; tablas
  `profile_answers` y `application_kits` en DATABASE; ruta `/aplicaciones`
  en UI.md; estado o columna `kit_ready`.
- **Decision 1 (propietario)**: ¿se permite fetch del HTML publico de la
  pagina de apply de Lever para detectar custom questions? El no-goal dice
  "No scraping detras de login ni de portales sin API publica" — la pagina
  es publica y Lever SI tiene API publica (de lectura), asi que hay
  ambiguedad; si se aprueba, anotar la excepcion explicita en PRD §6.
- **Decision 2 (propietario)**: la "positioning note" del kit ¿es solo el
  material ya existente (rule-based + enriquecido) o se permite un draft de
  cover letter? Lo segundo violaria "la IA nunca redacta contenido" — la
  recomendacion es NO: el kit entrega insumos, el propietario redacta.

### 6.2 Para L2c (companion con click humano): ninguna enmienda

El click final es humano y desde su navegador: "aplica manualmente" se
mantiene literal. Conviene documentarlo (TRD nueva seccion "Companion") y
agregar el endpoint `/api/kit/{id}` tras el login. El userscript vive en el
repo pero corre en la maquina del propietario.

### 6.3 Para L2b/L3 (el sistema envia): enmiendas obligatorias

1. **PRD §6, primer no-goal** — reescribir:
   de "**No auto-apply** ni contacto automatico con empresas o reclutadores"
   a "**No contacto no aprobado**: el sistema solo envia una aplicacion con
   aprobacion explicita por-job del propietario (L3 prohibido)". Para L3 el
   bullet se elimina — y con el, la principal proteccion del proyecto.
2. **PRD §2, tabla de actores** — 3 celdas:
   - Usuario / Hace: "aplica manualmente" -> "aprueba cada aplicacion".
   - Usuario / NO hace: "Nada automatico hacia empresas" -> se elimina.
   - Sistema / NO hace: "Nunca aplica, nunca contacta empresas" -> "Nunca
     aplica sin aprobacion por-job; nunca redacta contenido hacia empresas".
   - Empresas / Ve: "Trafico de lectura anonimo" -> "Trafico de lectura +
     aplicaciones aprobadas"; "No reciben datos del usuario" -> se elimina
     (reciben CV y datos de contacto — cambia el postulado de privacidad).
3. **PRD §5** — nuevo RF12 "Envio aprobado" con las salvaguardas de §5 como
   requisitos.
4. **PRD §7 metricas** — agregar "0 aplicaciones enviadas sin aprobacion
   por-job" y "0 respuestas de form no provenientes del banco aprobado".
5. **CLAUDE.md §7** — nueva regla 8: "El sistema solo envia aplicaciones con
   aprobacion explicita por-job; toda respuesta de form proviene del banco
   `profile_answers` aprobado (seleccion, nunca redaccion); EEOC nunca se
   auto-responde; audit log obligatorio; kill switch en config". Extension
   de la regla 1 (la IA nunca redacta contenido de CV **ni de formularios
   hacia empresas**).
6. **TRD §12** — lista de trafico saliente: agregar los endpoints de envio;
   DATABASE: maquina de estados extendida
   (`notified -> kit_ready -> approved -> submitted | submit_failed`) +
   tabla `applications` (audit).

---

## 7. Recomendacion final

**Target: L1 completo ahora; L2c (companion local, click humano) como
evolucion opcional; NO construir L2b ni L3.**

Razones, en orden:

1. **L2 "de verdad" no tiene via tecnica limpia**: las tres API de envio son
   company-side (hallazgo central de esta investigacion). Todo lo demas es
   pelear contra reCAPTCHA y deteccion de fraude desde una IP de datacenter
   — una carrera armamentista contra plataformas que la estan ganando
   (Real Talent, 2025) y cuyo modo de fallo es silencioso e irreversible.
2. **El calculo de valor es lopsided**: el pipeline produce survivors de un
   digito por dia; el submit manual con kit L1 cuesta ~5 minutos. El upside
   total de L2b/L3 son minutos/dia; el downside es quemar empresas de una
   lista curada de 84 — el activo que todo el resto del sistema existe para
   proteger. Los tracks del propietario (co-op Canada, permanente Colombia)
   son ademas mercados donde la reputacion individual pesa mas que el
   volumen.
3. **L1 captura ~80% del beneficio con 0% del riesgo**: PDF listo, respuestas
   estandar listas, custom questions detectadas (Greenhouse), deep link, un
   click desde Telegram. Sin tocar un solo no-goal.
4. **L2c hereda la legitimidad de Simplify**: navegador real, IP residencial,
   humano presente. Es la unica automatizacion de envio que la evidencia
   2026 muestra como aceptada.
5. **Decidir con datos, no con fe**: instrumentar en la consola el "time to
   apply" (notified -> applied) y el censo de custom questions. Si en 2-3
   meses el submit manual demuestra ser el cuello de botella real (no lo
   sera con volumen de un digito), se reabre L2c con numeros.

Integracion con la consola multipagina (para el diseno UI global): pagina
`/aplicaciones` (pipeline Apply pendientes -> kit -> aplicado, con checklist
por job), vista de kit (PDF, respuestas matcheadas, preguntas rojas, deep
link), pagina de audit si algun dia hay envio, y toggles de `config`
(`KIT_ENABLED`, caps). Botones de Telegram: "Ver kit" y "Marcar aplicado".

---

## 8. Fuentes

[1] Greenhouse Job Board API — https://developers.greenhouse.io/job-board.html
[2] Greenhouse API docs (applications, fuente) — https://github.com/grnhse/greenhouse-api-docs/blob/master/source/includes/job-board/_applications.md
[3] Create a job board API key for an integration — https://support.greenhouse.io/hc/en-us/articles/13446638483355-Create-a-job-board-API-key-for-an-integration
[4] Lever Postings API — https://github.com/lever/postings-api
[5] Ashby applicationForm.submit — https://developers.ashbyhq.com/reference/applicationformsubmit
[6] Ashby: Creating a Custom Careers Page — https://developers.ashbyhq.com/docs/creating-a-custom-careers-page
[7] Ashby: Authentication — https://developers.ashbyhq.com/docs/authentication
[8] Greenhouse: Invisible reCAPTCHA — https://support.greenhouse.io/hc/en-us/articles/115005448066-Invisible-reCAPTCHA
[9] Greenhouse: Fraud Detection and Spam Blocklist FAQ — https://support.greenhouse.io/hc/en-us/articles/45397232315035-Fraud-Detection-and-Spam-Blocklist-Security-Privacy-FAQ
[10] Greenhouse Real Talent — https://www.greenhouse.com/blog/introducing-greenhouse-real-talent
[11] CrossClassify: How to Detect Auto Apply Candidate Fraud — https://www.crossclassify.com/resources/articles/recruitment/how-to-detect-auto-apply-candidate-fraud-before-it-pollutes-your-ats/
[12] Simplify Copilot — https://simplify.jobs/copilot
[13] Hiration: AI resume/application detection — https://www.hiration.com/blog/ai-written-resume-detection/
[14] LazyApply en Trustpilot — https://www.trustpilot.com/review/lazyapply.com
[15] LazyApply review (Remote Job Assistant, 2026) — https://www.remotejobassistant.com/blog/lazyapply-review
[16] AIHawk (repo) — https://github.com/feder-cr/Jobs_Applier_AI_Agent_AIHawk
[17] AIHawk en Hacker News — https://news.ycombinator.com/item?id=41756371
[18] Hiration: Do AI Auto-Apply Bots Actually Work? (encuesta Robert Half) — https://www.hiration.com/blog/ai-auto-apply-bots/
[19] Greenhouse legal index — https://www.greenhouse.com/legal
[20] Cloudflare Browser Rendering pricing/limits (free: 10 min/dia) — https://developers.cloudflare.com/browser-run/pricing/

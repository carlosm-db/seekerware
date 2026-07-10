# Convenciones — Seekerware

Reglas de coherencia entre codigo y documentacion. Complemento de
[`../CLAUDE.md`](../CLAUDE.md): el codigo es la fuente de verdad; estas
convenciones existen para que codigo, docs, commits y debugging hablen el mismo
idioma.

## 1. Terminologia canonica (glosario)

Un concepto = UN termino, identico en codigo, docs, commits y mensajes de
debugging. La columna "evitar" lista sinonimos prohibidos. El glosario se
actualiza en el mismo commit que introduce el termino nuevo.

| Termino | Significado | Evitar |
|---------|-------------|--------|
| job | vacante normalizada `{id, company, title, location, url, description, posted_at, ats, raw}` | vacante, posting, opening, oferta |
| connector | modulo que lee el feed de un ATS y devuelve jobs normalizados | poller, fetcher, scraper |
| track | via de busqueda: `canada_coop`, `colombia_perm`, `contractor_usd` | variante, canal, linea |
| gate | condicion por track, tipo `hard` (elimina) o `penalty` (resta puntos) | filtro duro, regla, restriccion |
| score | puntaje 0-100 del motor de reglas | rating, puntuacion, calificacion |
| verdict | `Apply`, `Stretch-worth-it` o `Skip`; lo deciden las reglas, nunca la IA | resultado, decision, clasificacion |
| survivor | job con verdict Apply o Stretch-worth-it que paso gates y freshness | finalista, candidato, seleccionado |
| freshness | edad de publicacion <= `FRESHNESS_MAX_DAYS` (3 dias) | vigencia, antiguedad |
| verify-on-notify | re-consulta del job en la API del ATS inmediatamente antes de notificar | liveness check, verificacion de vida |
| store | persistencia del sistema en D1 (tabla `jobs`), accedida solo via `src/store.ts` | base de datos, DB, registro, historico |
| block | fraseo aprobado de un fact en el banco (tabla `blocks`), anclado a un anchor y diferenciado por angle e idioma | frase, snippet, bullet, oracion |
| fact | hecho profesional verificable del registro canonico, con metrica exacta unica; los blocks son sus fraseos | logro, claim, afirmacion, dato |
| anchor | rol o proyecto real al que se ancla un block (tabla `anchors`); neutro — los titulos mostrados son proyecciones por mercado | role_anchor, puesto, cargo |
| angle | proyeccion de un fact para un tipo de rol: `data`, `compliance`, `operations`, `leadership` | enfoque, variante, version |
| run | una ejecucion completa del pipeline disparada por el cron | corrida, ciclo, iteracion |
| dry-run | run sin escrituras al store ni notificaciones; via `GET /api/dry-run` o `wrangler dev` local | simulacion, test run |
| pipeline | orquestacion poll -> score -> gates -> dedup -> notify | flujo, proceso |
| worker | el servicio Cloudflare que ejecuta el pipeline (handler `scheduled`) y el dashboard (handler `fetch`) | funcion, lambda, script |
| dashboard | consola web servida por el worker (config, tracking, banco de blocks), detras de login | panel, admin, webapp, consola |
| migration | cambio versionado del schema D1, archivo en `migrations/` | script SQL, patch de schema |
| enricher | agente IA que mejora los textos de un survivor | analyst, mejorador |
| cv_selector | agente IA que selecciona IDs de blocks por seccion (JSON con enum de IDs) | selector de frases |
| cv_verifier | agente IA a temperatura 0 que verifica el Doc renderizado y sugiere tweaks | verifier, validador |

Regla de vocabulario compartido: los `tags` del banco de blocks y las
keywords de la tabla `config` usan los MISMOS terminos canonicos (familias
domain / tool / signal). Un termino nuevo se agrega en ambos lados en el
mismo cambio — son la superficie de matching job <-> contenido.

## 2. Codigo (TypeScript / Cloudflare Workers)

- TypeScript estricto (`strict: true`), modulos ES, imports explicitos. Sin
  `any`: usar `unknown` + narrowing y tipos por concepto canonico (`Job`,
  `Company`, `Verdict`, `Block`).
- Un modulo por concepto del glosario: `src/connectors/greenhouse.ts`,
  `src/scoring.ts`, `src/freshness.ts`, `src/store.ts`, `src/notify.ts`.
  Funciones exportadas usan el termino canonico (`scoreJob()`, `isFresh()`);
  privado = no exportado (el ambito de modulo reemplaza el prefijo `_` de GAS).
- Superficie publica invocable = rutas `/api/*` del worker (protegidas por el
  mismo login del dashboard).
- Secretos SOLO como Worker secrets, leidos del binding `env`. Jamas en codigo,
  comentarios, logs, commits ni en `wrangler.jsonc` (alli solo vars no
  sensibles).
- HTTP saliente con `fetch` y manejo explicito de errores: verificar `res.ok`,
  capturar por empresa; un fallo externo nunca tumba el run (equivalente al
  `muteHttpExceptions` de GAS).
- Acceso a D1 SOLO desde `src/store.ts`: statements preparados con bindings
  (nunca interpolacion de strings en SQL); `db.batch()` para escrituras
  multiples por run.
- Tests con vitest en `test/`, con fixtures de respuestas reales de los ATS
  (anonimizadas). Todo connector y el motor de scoring tienen tests; el
  pipeline se prueba localmente con `wrangler dev --test-scheduled`.

## 3. Documentacion

- Los .md documentan intencion; ante discrepancia manda el codigo (CLAUDE.md).
- Toda decision de diseno se fecha (yyyy-mm-dd).
- Sin datos personales del propietario en ningun archivo del repo.
- Mismo glosario en docs, codigo, commits y debugging; si un documento necesita
  un concepto nuevo, primero se agrega la fila al glosario.

## 4. Commits

- Mensajes en ingles, convencionales, en presente ("add lever connector").
- Nunca secretos, tokens ni IDs privados (carpeta Drive, plantilla de Doc, chat
  de Telegram, account id de Cloudflare) en mensajes ni en contenido commiteado.
- Un cambio de terminologia = commit propio que toca codigo + docs + glosario
  a la vez.

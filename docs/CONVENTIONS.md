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
| store | persistencia en el Sheet (tab `Jobs`) | base de datos, DB, registro, historico |
| block | frase pre-aprobada del banco (tab `Blocks`), anclada a un rol real | frase, snippet, bullet, oracion |
| run | una ejecucion completa del pipeline disparada por el trigger | corrida, ciclo, iteracion |
| dry-run | run sin escrituras al store ni notificaciones; imprime al log | simulacion, test run |
| pipeline | orquestacion poll -> score -> gates -> dedup -> notify | flujo, proceso |
| enricher | agente IA que mejora los textos de un survivor | analyst, mejorador |
| cv_selector | agente IA que selecciona IDs de blocks por seccion (JSON con enum de IDs) | selector de frases |
| cv_verifier | agente IA a temperatura 0 que verifica el Doc renderizado y sugiere tweaks | verifier, validador |

## 2. Codigo (GAS)

- Estilo del ecosistema DiversoLAB-GAS: `var`, `function` declarations, sin
  modulos/imports/npm; ambito global compartido entre archivos.
- Prefijos: `api_*` = superficie publica invocable; `_*` = funcion privada.
- Secretos y configuracion sensible SOLO en Script Properties, leidos via el
  helper cacheado `_p()`. Nunca credenciales en codigo, comentarios o logs.
- Nombres de archivos, funciones y variables usan el termino canonico del
  glosario (p. ej. `connectors.js`, `_scoreJob()`, `_isFresh()`).
- HTTP saliente solo con `UrlFetchApp.fetch` y `muteHttpExceptions: true`.

## 3. Documentacion

- Los .md documentan intencion; ante discrepancia manda el codigo (CLAUDE.md).
- Toda decision de diseno se fecha (yyyy-mm-dd).
- Sin datos personales del propietario en ningun archivo del repo.
- Mismo glosario en docs, codigo, commits y debugging; si un documento necesita
  un concepto nuevo, primero se agrega la fila al glosario.

## 4. Commits

- Mensajes en ingles, convencionales, en presente ("add lever connector").
- Nunca secretos, tokens ni IDs privados (Sheet, carpeta Drive, chat de
  Telegram) en mensajes ni en contenido commiteado.
- Un cambio de terminologia = commit propio que toca codigo + docs + glosario
  a la vez.

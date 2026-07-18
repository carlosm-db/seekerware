# Console UX audit — 2026-07-18

Audit of owner-reported console issues (5 points). Read-only pass over
`src/console/app.tsx` and `src/console/layout.tsx`. Code = source of truth.

## Findings

### 1. Spanish leftovers (routes + internal aliases)
- **Routes still Spanish**: `app.get('/semana')` (app.tsx:607), `app.get('/salud')`
  (app.tsx:927). The nav labels are already English ("Week", "Health") but the
  URLs are Spanish — visible in the address bar (owner's example: `/semana`).
- **Internal SQL aliases** in the `/semana` handler: `nuevos`, `notificados`,
  `aplicadas`, `entrevistas` (app.tsx:636) — code identifiers, not visible text,
  but Spanish. Also `DigestData` keys (`vistos/nuevos/notificados/aplicadas/
  rotas`) shared by pipeline.ts + notify.ts (deliberately kept as identifiers
  in the English rewrite).
- `/aplicaciones` appears only in UI.md (step 8, not built) — no live route.

### 2. Contact page not discoverable
- `/contact` exists and works but is NOT in the nav (`grep /contact
  layout.tsx` = 0). Only reachable via a link on Calibration and a warning
  banner on CVs. Owner correctly "does not see a contacts page".

### 3. Pagination missing
- List pages cap rows with a bare `LIMIT` and no prev/next UI:
  `/jobs` LIMIT 100 (app.tsx:194), `/cvs` LIMIT 50 (859), `/salud` runs LIMIT
  30 (930) + events LIMIT 20 (935), `/` triage LIMIT 50 (104), `/blocks` shows
  ALL rows, `/tracker` no limit at all. Beyond the cap, rows are silently
  invisible — no way to page through.

### 4. Flat, unorganized nav (no control panel)
- `layout.tsx:69-79`: a flat list of 9 links with no grouping
  (Today · Tracker · Jobs · Companies · Calibration · Bank · CVs · Week ·
  Health). No logical sections, no home hub. Owner wants a control panel with
  logically separated areas (operate / profile / companies / jobs / …).

### 5. Bank has no filter/organization
- `/blocks` (app.tsx:775): `SELECT … FROM blocks ORDER BY section, anchor_id,
  id` renders ALL ~69 blocks in one flat table. No filter controls (section,
  anchor, angle, status, es_status), no grouping UI. Owner cannot view "per
  category" — "full disorder".

## Scope of fix (all in the console layer)
Files: `src/console/app.tsx`, `src/console/layout.tsx`, minor route renames,
optional `DigestData` identifier cleanup (pipeline.ts + notify.ts). No schema
change. No behavior change to the pipeline/scoring.

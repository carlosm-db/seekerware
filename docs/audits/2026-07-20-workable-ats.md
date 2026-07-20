# Workable ATS — investigation + plan (2026-07-20)

Owner asked to investigate and plan adding **Workable** as a sixth connector. This
persists the live probe findings and the connector plan. Implementation is NOT started
(awaiting owner OK, per CLAUDE.md §1).

## Findings — live probes (2026-07-20)

Workable exposes a **public job-board API, no token** (the private `spi/v3` needs a
token; the public one does not). Confirmed against `nuvei` (52 open jobs):

| Purpose | Endpoint | Returns |
|---|---|---|
| Listings + inline details | `GET apply.workable.com/api/v1/widget/accounts/{account}?details=true` | `{name, jobs:[{shortcode, title, description, url, application_url, locations[], country, city, region, telecommuting, employment_type, published_on, hidden, ...}]}` |
| Listings (search) | `POST apply.workable.com/api/v3/accounts/{account}/jobs` body `{query,location,department,worktype,remote}` | `{total, results:[{shortcode, title, ...}]}` |
| Job detail | `GET apply.workable.com/api/v2/accounts/{account}/jobs/{shortcode}` | `{title, description, requirements, benefits, location, locations, remote, workplace, published, ...}` |

- `account` = the Workable subdomain (e.g. `nuvei` → `nuvei.workable.com`). This is the connector `token`.
- The **widget `?details=true` is the sweet spot**: one call returns listings AND full
  descriptions inline (descriptions present for all 55 jobs in the sample) — no per-job
  detail fetch needed for the common case (cheaper than Workday's paginated POST + N details).
- **Application form questions are NOT public.** Checked v1/v2/v3 + `/form`, `/questions`,
  `/application_form` — all absent or `Not Found`. The one `questions` hit in the widget was
  the word inside a job description ("ask questions"), not a field. → Workable is
  **`detectable:false`** for the kit, like SuccessFactors/Workday. The connector covers job
  discovery + notify; the kit's honest "form behind the apply flow" message already covers this.
- Dates: `published_on` (widget) / `published` (v2). Remote: `telecommuting`/`remote` + `locations[]`.
- Hidden/unpublished jobs carry `hidden:true` → filter out (mirrors ashby `isListed`).

## Plan — new connector `src/connectors/workable.ts`

1. **Type + registry:** add `'workable'` to `Ats` (`src/types.ts`); register in `src/connectors/index.ts`.
2. **`fetchJobs(company)`:** one `GET` to the widget `?details=true`. Map each non-hidden job →
   `Job { id: shortcode, company, title, location: locations.join('; ') (+ Remote if telecommuting),
   url: canonicalUrl(url ?? application_url), description: stripHtml(description), posted_at: published_on,
   ats:'workable', raw }`.
3. **`isLive(company, job)`:** re-fetch the widget and check the shortcode is still present and
   not hidden (never the SPA HTML — domain rule 3). v2 detail 404 is the backstop.
4. **`fetchDetail?` (optional):** v2 detail for full `description`/`requirements` if any widget
   description comes back truncated. Likely unnecessary — leave as a guard.
5. **Question detection:** none. `detectQuestions` returns `detectable:false` for `workable` (the
   default branch) — the console kit card already renders the honest message this covers.
6. **Companies:** added as data rows (`ats:'workable', token:'{account}'`); no migration.
7. **Tests:** `test/workable.test.ts` — parse a saved widget fixture (Nuvei) + a v2 fixture; hidden
   filter; location/remote join; `isLive` present vs absent.
8. **Docs:** Workable row in TRD §2 connector table; CLAUDE.md build status note.

## Effort / risk

- Low. Public API, same shape as `ashby`/`workday`, no secret, no migration, no scoring/agent change.
- One connector file + type + registry + tests + seed rows.
- Build-time check: confirm widget descriptions are complete against a live account with jobs
  (Nuvei = good fixture, 52 jobs today); if truncated, wire `fetchDetail` (already planned as a guard).

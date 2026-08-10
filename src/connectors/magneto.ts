// Magneto connector (Colombian job platform; per-company SSR boards + schema.org structured data —
// confirmed 2026-08-10 vs grupo-exito/Grupo Éxito, incl. from GitHub-runner IPs). There is NO
// public jobs API (listings hydrate via Next.js Server Actions; the client endpoints are
// auth-gated) — the SSR pages carry JSON-LD instead, which is what this connector reads.
// token = the company slug, e.g. 'grupo-exito' (from magneto365.com/co/empresas/grupo-exito).
// List:   GET /co/empresas/{token}/empleos -> ItemList JSON-LD with the 20 NEWEST postings
//         (newest-first verified; the SSR ignores page params — the Workday newest-N precedent,
//         fine at 2 polls/day for boards posting <20 jobs per half-day). Items carry only the
//         /co/empresas/... URL form; the public job page is /co/empleos/{slug}-{id} (canonical).
// Detail: GET /co/empleos/{slug}-{id} -> JobPosting JSON-LD: title, description, datePosted,
//         validThrough, hiringOrganization, jobLocation (address fields may be ARRAYS, country
//         as ISO 'CO'), baseSalary COP.
// verify-on-notify: GET the job page without following redirects. A nonexistent id returns HTTP
//         500 (indistinguishable from a server flake) -> 500 and redirects are INDETERMINATE;
//         only 404 is a clean dead signal; a 200 must still carry the JobPosting block.
// robots.txt: 'User-agent: *' allows the clean paths (only query-string URLs are disallowed);
//         the total bans are name-targeted at rival job-scraper bots.

import type { Company, Job } from '../types';
import { canonicalUrl, findJsonLd, padIsoDate, stripHtml } from './common';

const BASE = 'https://www.magneto365.com';

interface LdItemList {
  '@type'?: string;
  itemListElement?: Array<{ url?: string; item?: { '@id'?: string } }>;
}
interface LdAddress {
  addressLocality?: string | string[];
  addressRegion?: string | string[];
  addressCountry?: string | string[];
}
interface LdJobPosting {
  '@type'?: string;
  title?: string;
  description?: string;
  datePosted?: string;
  hiringOrganization?: { name?: string };
  jobLocation?: { address?: LdAddress } | Array<{ address?: LdAddress }>;
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/** "City, Department, Colombia" — Magneto uses correct schema.org semantics (locality = city) but
 * wraps the fields in arrays; the ISO 'CO' is mapped to the gate-matchable word "Colombia". */
function locationLabel(jp: LdJobPosting): string {
  const place = Array.isArray(jp.jobLocation) ? jp.jobLocation[0] : jp.jobLocation;
  const a = place?.address ?? {};
  const code = first(a.addressCountry);
  const country = code === 'CO' ? 'Colombia' : code;
  return [first(a.addressLocality), first(a.addressRegion), country].filter(Boolean).join(', ');
}

/** Provisional title from the URL slug ("asesor-a-viajes-exito-medellin") — fetchDetail replaces
 * it with the real JobPosting title before scoring/storage. */
function deslug(slug: string, id: string): string {
  return slug.slice(0, -(id.length + 1)).replace(/-/g, ' ').trim();
}

/** The 20 newest postings in one GET (the SSR list does not paginate). */
export async function fetchJobs(company: Company, doFetch: Fetcher = fetch): Promise<Job[]> {
  const res = await doFetch(`${BASE}/co/empresas/${encodeURIComponent(company.token)}/empleos`);
  if (!res.ok) throw new Error(`magneto feed ${company.token}: HTTP ${res.status}`);
  const list = findJsonLd<LdItemList>(await res.text(), 'ItemList');
  // A bogus slug renders a page without the ItemList: throwing keeps the console probe honest
  // instead of saving the company as "0 jobs OK".
  if (!list) throw new Error(`magneto feed ${company.token}: no ItemList structured data (bad token or page shape changed)`);
  const jobs: Job[] = [];
  for (const it of list.itemListElement ?? []) {
    const listUrl = it.url ?? it.item?.['@id'];
    const slug = listUrl ? new URL(listUrl).pathname.split('/').filter(Boolean).pop() : undefined;
    const id = slug ? /-(\d+)$/.exec(slug)?.[1] : undefined;
    if (!slug || !id) continue; // not an offer link (defensive)
    jobs.push({
      id,
      company: company.name,
      title: deslug(slug, id),
      location: '', // the list carries no location; fetchDetail() supplies "City, Dept, Colombia"
      // ONE canonical form for dedup: the public job page, not the /co/empresas/... list variant.
      url: canonicalUrl(`${BASE}/co/empleos/${slug}`),
      description: '', // filled by fetchDetail() — must stay empty so the pipeline pulls the detail
      posted_at: null, // detail-only date; the pipeline recomputes freshness post-merge
      ats: 'magneto',
      raw: { id, listUrl },
    });
  }
  return jobs;
}

/**
 * Pulls title/description/date/location from the JobPosting JSON-LD. Soft-fails (returns {})
 * like the other HTML-page sources. On these per-company boards the employer usually IS the
 * company, so the "Empleador:" prefix is added only when it differs from the roster name.
 */
export async function fetchDetail(company: Company, job: Job, doFetch: Fetcher = fetch): Promise<Partial<Job>> {
  const res = await doFetch(job.url);
  if (!res.ok) return {};
  const jp = findJsonLd<LdJobPosting>(await res.text(), 'JobPosting');
  if (!jp) return {};
  const patch: Partial<Job> = {};
  const employer = jp.hiringOrganization?.name?.trim();
  const prefix = employer && employer.toLowerCase() !== company.name.trim().toLowerCase() ? `Empleador: ${employer}` : '';
  const desc = jp.description ? stripHtml(jp.description).slice(0, 20000) : '';
  if (prefix || desc) patch.description = [prefix, desc].filter(Boolean).join('\n\n');
  if (jp.title) patch.title = jp.title;
  const posted = padIsoDate(jp.datePosted);
  if (posted) patch.posted_at = posted;
  const location = locationLabel(jp);
  if (location) patch.location = location;
  return patch;
}

/**
 * verify-on-notify: re-fetches the posting WITHOUT following redirects. Only 404 is a clean dead
 * signal; a nonexistent id returns 500 (verified 2026-08-10), indistinguishable from a flake, so
 * 500 — and any redirect — throws (indeterminate: never notify unverified, never falsely close;
 * auto-expire handles jobs that leave the list). A 200 must still carry the JobPosting block.
 */
export async function isLive(company: Company, job: Job, doFetch: Fetcher = fetch): Promise<boolean> {
  const res = await doFetch(job.url, { redirect: 'manual' });
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`magneto verify ${company.token}/${job.id}: HTTP ${res.status}`);
  return findJsonLd<LdJobPosting>(await res.text(), 'JobPosting') !== null;
}

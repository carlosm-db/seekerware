// elempleo connector (Colombian job board; SSR pages + schema.org structured data — confirmed
// 2026-08-10 vs trabajo-epm/EPM, incl. from GitHub-runner IPs). There is NO public jobs API:
// the internal /api/joboffers/findbyfilter is auth-gated (401) — never call it; the SSR pages
// carry JSON-LD instead (Google-for-Jobs contract), which is what this connector reads.
// token = the per-company page segment, e.g. 'trabajo-epm'
//         (from https://www.elempleo.com/co/ofertas-empleo/trabajo-epm).
// List:   GET /co/ofertas-empleo/{token} -> <script id="itemListStructuredData" ld+json>
//         (ItemList, newest-first, per-item {@id: job URL, name: title}; NO per-job date) +
//         per-card data-ga4-offerdata attrs ({id, company: REAL employer, location: city, ...}).
// Detail: GET {job url} -> one JobPosting JSON-LD: title, description, datePosted (UNPADDED
//         y-M-d), hiringOrganization (real employer), jobLocation (country as ISO 'CO'), salary.
// verify-on-notify: GET {job url} without following redirects — a dead job 301s to
//         /co/ofertas-empleo/?__not_found__=1; a live one is 200 with the JobPosting block.

import type { Company, Job } from '../types';
import { canonicalUrl, decodeEntities, findJsonLd, padIsoDate, stripHtml } from './common';

const BASE = 'https://www.elempleo.com';

interface Ga4Offer {
  id?: number | string;
  title?: string;
  company?: string;
  location?: string;
}
interface LdItemList {
  '@type'?: string;
  numberOfItems?: number;
  itemListElement?: Array<{ item?: { '@id'?: string; name?: string } }>;
}
interface LdJobPosting {
  '@type'?: string;
  title?: string;
  description?: string;
  datePosted?: string;
  hiringOrganization?: { name?: string };
  jobLocation?: { address?: LdAddress } | Array<{ address?: LdAddress }>;
}
interface LdAddress {
  addressLocality?: string;
  addressRegion?: string;
  addressCountry?: string;
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** The per-card analytics payloads, keyed by offer id (entity-encoded JSON in an attribute). */
function ga4Offers(html: string): Map<string, Ga4Offer> {
  const map = new Map<string, Ga4Offer>();
  for (const m of html.matchAll(/data-ga4-offerdata="([^"]+)"/gi)) {
    try {
      const o = JSON.parse(decodeEntities(m[1]!)) as Ga4Offer;
      if (o?.id !== undefined) map.set(String(o.id), o);
    } catch {
      // malformed attribute: the ItemList still carries url+title, so just skip the enrichment
    }
  }
  return map;
}

/**
 * "City, Department, Colombia" from the JobPosting address. elempleo swaps schema.org semantics
 * (addressRegion = city, addressLocality = department) — harmless, both go into the label. The ISO
 * addressCountry ('CO') is mapped to the word "Colombia" so the colombia_perm location gate matches
 * every Colombian city with zero config changes; other codes pass through as-is.
 */
function locationLabel(jp: LdJobPosting): string {
  const first = Array.isArray(jp.jobLocation) ? jp.jobLocation[0] : jp.jobLocation;
  const a = first?.address ?? {};
  const country = a.addressCountry === 'CO' ? 'Colombia' : a.addressCountry;
  return [a.addressRegion, a.addressLocality, country].filter(Boolean).join(', ');
}

/** The whole board in one GET: the per-company pages don't paginate (EPM=8, Bancolombia=4). */
export async function fetchJobs(company: Company, doFetch: Fetcher = fetch): Promise<Job[]> {
  const res = await doFetch(`${BASE}/co/ofertas-empleo/${encodeURIComponent(company.token)}`);
  if (!res.ok) throw new Error(`elempleo feed ${company.token}: HTTP ${res.status}`);
  const html = await res.text();
  const list = findJsonLd<LdItemList>(html, 'ItemList');
  // A bogus token 301s to the not-found search page (200 after the redirect, but no ItemList):
  // throwing keeps the console probe honest instead of saving the company as "0 jobs OK".
  if (!list) throw new Error(`elempleo feed ${company.token}: no ItemList structured data (bad token or page shape changed)`);
  const ga4 = ga4Offers(html);
  const items = list.itemListElement ?? [];
  if ((list.numberOfItems ?? 0) > items.length) {
    console.log(`elempleo ${company.token}: list shows ${items.length} of ${list.numberOfItems} items`);
  }
  const jobs: Job[] = [];
  for (const it of items) {
    const url = it.item?.['@id'];
    const id = url ? /-(\d+)$/.exec(new URL(url).pathname)?.[1] : undefined;
    if (!url || !id) continue; // not an offer link (defensive: ItemList should only carry offers)
    const extra = ga4.get(id);
    jobs.push({
      id,
      company: company.name,
      title: it.item?.name ?? extra?.title ?? '',
      location: extra?.location ?? '', // city only; fetchDetail() refines to "City, Dept, Colombia"
      url: canonicalUrl(url),
      description: '', // filled by fetchDetail() — must stay empty so the pipeline pulls the detail
      posted_at: null, // the list carries no per-job date; fetchDetail() supplies datePosted
      ats: 'elempleo',
      raw: { id, ga4: extra ?? null },
    });
  }
  return jobs;
}

/**
 * Pulls description/date/location/title from the detail page's JobPosting JSON-LD. Soft-fails
 * (returns {}) like the other HTML-page sources (SF/Workday): an empty description then scores
 * Skip. The real employer (often a contractor on EPM convocatorias) is prefixed into the
 * description — companies.name stays the roster label.
 */
export async function fetchDetail(company: Company, job: Job, doFetch: Fetcher = fetch): Promise<Partial<Job>> {
  const res = await doFetch(job.url);
  if (!res.ok) return {};
  const jp = findJsonLd<LdJobPosting>(await res.text(), 'JobPosting');
  if (!jp) return {};
  const patch: Partial<Job> = {};
  const employer = jp.hiringOrganization?.name;
  const desc = jp.description ? stripHtml(jp.description).slice(0, 20000) : '';
  if (employer || desc) {
    patch.description = [employer ? `Empleador: ${employer}` : '', desc].filter(Boolean).join('\n\n');
  }
  if (jp.title) patch.title = jp.title;
  const posted = padIsoDate(jp.datePosted);
  if (posted) patch.posted_at = posted;
  const location = locationLabel(jp);
  if (location) patch.location = location;
  return patch;
}

/**
 * verify-on-notify: re-fetches the posting WITHOUT following redirects. The known dead signal is
 * a 301 to ?__not_found__=1 (also treat 404 as dead); an UNEXPECTED redirect throws (indeterminate
 * — a site-wide URL change must not silently close jobs). 200 must still carry the JobPosting
 * block (an expired-but-200 page without it is dead).
 */
export async function isLive(company: Company, job: Job, doFetch: Fetcher = fetch): Promise<boolean> {
  const res = await doFetch(job.url, { redirect: 'manual' });
  if (res.status === 404) return false;
  if (res.status >= 300 && res.status < 400) {
    const target = res.headers.get('location') ?? '';
    if (target.includes('__not_found__')) return false;
    throw new Error(`elempleo verify ${company.token}/${job.id}: HTTP ${res.status} -> ${target.slice(0, 80)}`);
  }
  if (!res.ok) throw new Error(`elempleo verify ${company.token}/${job.id}: HTTP ${res.status}`);
  return findJsonLd<LdJobPosting>(await res.text(), 'JobPosting') !== null;
}

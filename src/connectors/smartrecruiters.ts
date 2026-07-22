// SmartRecruiters connector (public Posting API — no auth; confirmed 2026-07-22).
// token = the company's SmartRecruiters identifier, e.g. 'Wise' (from jobs.smartrecruiters.com/{token}).
// List:   GET api.smartrecruiters.com/v1/companies/{token}/postings?limit=100&offset=N
//         -> { totalFound, offset, limit, content:[{ id, name, location{...}, releasedDate }] }  (NO description)
// Detail: GET .../postings/{id} -> { jobAd:{ sections:{ jobDescription, qualifications, ... } } }  (via fetchDetail)
// Date field:      releasedDate (ISO 8601)
// verify-on-notify: GET .../postings/{id} -> 404 = closed
// The list omits the public URL, so it's built deterministically as jobs.smartrecruiters.com/{token}/{id}.

import type { Company, Job } from '../types';
import { canonicalUrl, stripHtml } from './common';

const BASE = 'https://api.smartrecruiters.com/v1/companies';
const PAGE = 100;
const MAX_PAGES = 5; // ~500 newest-ish per run — bounds subrequests; freshness-first trims the rest

interface SrLocation {
  city?: string;
  region?: string;
  country?: string;
  remote?: boolean;
  hybrid?: boolean;
  fullLocation?: string;
}

interface SrPosting {
  id: string;
  name: string;
  location?: SrLocation;
  releasedDate?: string;
}

interface SrList {
  totalFound?: number;
  offset?: number;
  limit?: number;
  content?: SrPosting[];
}

interface SrDetail {
  jobAd?: { sections?: Record<string, { text?: string } | undefined> };
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Reads the board's light list (no description) across pages; the pipeline pulls each fresh job's
 *  description via fetchDetail. Throws if the first page fails. */
export async function fetchJobs(company: Company, doFetch: Fetcher = fetch): Promise<Job[]> {
  const out: Job[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const offset = page * PAGE;
    const res = await doFetch(`${BASE}/${encodeURIComponent(company.token)}/postings?limit=${PAGE}&offset=${offset}`);
    if (!res.ok) {
      if (page === 0) throw new Error(`smartrecruiters feed ${company.token}: HTTP ${res.status}`);
      break;
    }
    const data = (await res.json()) as SrList;
    const content = data.content ?? [];
    for (const p of content) out.push(normalize(company, p));
    if (content.length < PAGE || offset + content.length >= (data.totalFound ?? 0)) break;
  }
  return out;
}

/** Fetches one posting's description (the light list omits it). Merged onto the Job before scoring. */
export async function fetchDetail(company: Company, job: Job, doFetch: Fetcher = fetch): Promise<Partial<Job>> {
  const res = await doFetch(`${BASE}/${encodeURIComponent(company.token)}/postings/${job.id}`);
  if (!res.ok) throw new Error(`smartrecruiters detail ${company.token}/${job.id}: HTTP ${res.status}`);
  const sections = ((await res.json()) as SrDetail).jobAd?.sections ?? {};
  const text = ['companyDescription', 'jobDescription', 'qualifications', 'additionalInformation']
    .map((k) => sections[k]?.text ?? '')
    .filter(Boolean)
    .join(' ');
  return { description: text ? stripHtml(text) : '' };
}

/** verify-on-notify: re-queries the individual posting. 404 = dead; other errors throw (indeterminate). */
export async function isLive(company: Company, job: Job, doFetch: Fetcher = fetch): Promise<boolean> {
  const res = await doFetch(`${BASE}/${encodeURIComponent(company.token)}/postings/${job.id}`);
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`smartrecruiters verify ${company.token}/${job.id}: HTTP ${res.status}`);
  return true;
}

/** "City, Region, Country" from the structured location, with Remote/Hybrid appended from the flags. */
function locationLabel(l: SrLocation | undefined): string {
  if (!l) return '';
  const base = l.fullLocation?.trim() || [l.city, l.region, l.country].filter(Boolean).join(', ');
  const tags = [l.remote ? 'Remote' : '', l.hybrid ? 'Hybrid' : ''].filter(Boolean);
  return [base, ...tags].filter(Boolean).join('; ');
}

function normalize(company: Company, p: SrPosting): Job {
  return {
    id: p.id,
    company: company.name,
    title: p.name,
    location: locationLabel(p.location),
    // The list carries no public URL — build the canonical job page deterministically.
    url: canonicalUrl(`https://jobs.smartrecruiters.com/${encodeURIComponent(company.token)}/${p.id}`),
    description: '', // filled by fetchDetail()
    posted_at: p.releasedDate ?? null,
    ats: 'smartrecruiters',
    raw: p,
  };
}

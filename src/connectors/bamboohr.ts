// BambooHR connector (public hosted careers API — no auth; confirmed 2026-07-24 vs opalrt/OPAL-RT).
// token = the company's BambooHR subdomain, e.g. 'opalrt' (from {token}.bamboohr.com).
// List:   GET https://{token}.bamboohr.com/careers/list
//         -> { meta:{totalCount}, result:[{ id, jobOpeningName, location:{city,state}, atsLocation:{...},
//              isRemote, locationType }] }   (NO description, NO posting date)
// Detail: GET https://{token}.bamboohr.com/careers/{id}/detail -> { result:{ jobOpening:{ description } } }
// verify-on-notify: GET .../careers/{id}/detail -> 404 = closed.
// No date in the feed -> posted_at=null (treated as unknown/fresh, like the SF urlset variant).

import type { Company, Job } from '../types';
import { canonicalUrl, stripHtml } from './common';

const base = (token: string) => `https://${encodeURIComponent(token)}.bamboohr.com`;

interface BhLoc {
  city?: string | null;
  state?: string | null;
  province?: string | null;
  country?: string | null;
}
interface BhJob {
  id: string | number;
  jobOpeningName?: string;
  location?: BhLoc | null;
  atsLocation?: BhLoc | null;
  isRemote?: boolean | null;
}
interface BhList { result?: BhJob[] }
interface BhDetail { result?: { jobOpening?: { description?: string; jobDescription?: string } } }

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** "City, State/Province[, Country]" from whichever location object is populated, + "Remote" when flagged. */
function locationLabel(j: BhJob): string {
  const primary = j.location && (j.location.city || j.location.state) ? j.location : (j.atsLocation ?? {});
  const base = [primary.city, primary.state ?? primary.province, primary.country].filter(Boolean).join(', ');
  return j.isRemote ? [base, 'Remote'].filter(Boolean).join('; ') : base;
}

function normalize(company: Company, j: BhJob): Job {
  return {
    id: String(j.id),
    company: company.name,
    title: j.jobOpeningName ?? '',
    location: locationLabel(j),
    url: canonicalUrl(`${base(company.token)}/careers/${j.id}`),
    description: '', // filled by fetchDetail()
    posted_at: null, // the careers/list feed carries no posting date
    ats: 'bamboohr',
    raw: j,
  };
}

/** The whole board in one GET (no pagination). Throws on a bad response (caller isolates per company). */
export async function fetchJobs(company: Company, doFetch: Fetcher = fetch): Promise<Job[]> {
  const res = await doFetch(`${base(company.token)}/careers/list`);
  if (!res.ok) throw new Error(`bamboohr feed ${company.token}: HTTP ${res.status}`);
  const data = (await res.json()) as BhList;
  return (data.result ?? []).map((j) => normalize(company, j));
}

/** Pulls the job description (the light list omits it). Merged onto the Job before scoring. */
export async function fetchDetail(company: Company, job: Job, doFetch: Fetcher = fetch): Promise<Partial<Job>> {
  const res = await doFetch(`${base(company.token)}/careers/${job.id}/detail`);
  if (!res.ok) throw new Error(`bamboohr detail ${company.token}/${job.id}: HTTP ${res.status}`);
  const jo = ((await res.json()) as BhDetail).result?.jobOpening ?? {};
  const desc = jo.description ?? jo.jobDescription ?? '';
  return { description: desc ? stripHtml(desc) : '' };
}

/** verify-on-notify: re-queries the individual posting. 404 = dead; other errors throw (indeterminate). */
export async function isLive(company: Company, job: Job, doFetch: Fetcher = fetch): Promise<boolean> {
  const res = await doFetch(`${base(company.token)}/careers/${job.id}/detail`);
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`bamboohr verify ${company.token}/${job.id}: HTTP ${res.status}`);
  return true;
}

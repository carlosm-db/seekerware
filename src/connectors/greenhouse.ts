// Greenhouse connector (docs/TRD.md §2).
// List (light):    boards-api.greenhouse.io/v1/boards/{token}/jobs  (NO content — cheap payload;
//                  first_published + location are present, enough for freshness + the location gate)
// Detail:          GET /boards/{token}/jobs/{id} -> full `content` (fetched per fresh new job)
// Date field:      first_published (preferred over updated_at, which some boards touch constantly)
// verify-on-notify: GET /boards/{token}/jobs/{id} -> 404 = closed

import type { Company, Job } from '../types';
import { canonicalUrl, stripHtml } from './common';

const BASE = 'https://boards-api.greenhouse.io/v1/boards';

interface GreenhouseJob {
  id: number;
  title: string;
  absolute_url: string;
  content?: string;
  first_published?: string;
  updated_at?: string;
  location?: { name?: string };
}

interface GreenhouseFeed {
  jobs?: GreenhouseJob[];
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * Reads the board's LIGHT feed (no `content`) and returns normalized jobs WITHOUT descriptions —
 * the pipeline pulls each fresh new job's description via fetchDetail. This keeps the per-run
 * payload small so mega boards don't blow the Worker CPU budget. Throws if the fetch fails.
 */
export async function fetchJobs(company: Company, doFetch: Fetcher = fetch): Promise<Job[]> {
  const res = await doFetch(`${BASE}/${company.token}/jobs`);
  if (!res.ok) {
    throw new Error(`greenhouse feed ${company.token}: HTTP ${res.status}`);
  }
  const feed = (await res.json()) as GreenhouseFeed;
  return (feed.jobs ?? []).map((j) => normalize(company, j));
}

/** Fetches one job's full `content` (the light list omits it). Merged onto the Job before scoring. */
export async function fetchDetail(company: Company, job: Job, doFetch: Fetcher = fetch): Promise<Partial<Job>> {
  const res = await doFetch(`${BASE}/${company.token}/jobs/${job.id}`);
  if (!res.ok) {
    throw new Error(`greenhouse detail ${company.token}/${job.id}: HTTP ${res.status}`);
  }
  const j = (await res.json()) as GreenhouseJob;
  return { description: j.content ? stripHtml(j.content) : '' };
}

/** verify-on-notify: re-queries the individual job in the API. 404 = dead. Other errors throw (indeterminate). */
export async function isLive(company: Company, job: Job, doFetch: Fetcher = fetch): Promise<boolean> {
  const res = await doFetch(`${BASE}/${company.token}/jobs/${job.id}`);
  if (res.status === 404) return false;
  if (!res.ok) {
    throw new Error(`greenhouse verify ${company.token}/${job.id}: HTTP ${res.status}`);
  }
  return true;
}

function normalize(company: Company, j: GreenhouseJob): Job {
  return {
    id: String(j.id),
    company: company.name,
    title: j.title,
    location: j.location?.name ?? '',
    url: canonicalUrl(j.absolute_url, ['gh_jid']),
    description: j.content ? stripHtml(j.content) : '',
    posted_at: j.first_published ?? null,
    ats: 'greenhouse',
    raw: j,
  };
}

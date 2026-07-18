// Ashby connector (docs/TRD.md §2).
// Feed:            api.ashbyhq.com/posting-api/job-board/{token}?includeCompensation=true
// Date field:      publishedAt (or publishedDate in older payloads)
// verify-on-notify: re-fetch the board and look for the id. The HTML page is a
//                   SPA that returns 200 even when the job is dead — NEVER
//                   verify against HTML (domain rule).

import type { Company, Job } from '../types';
import { canonicalUrl, stripHtml } from './common';

const BASE = 'https://api.ashbyhq.com/posting-api/job-board';

interface AshbyJob {
  id: string;
  title: string;
  location?: string;
  secondaryLocations?: Array<{ location?: string }>;
  isRemote?: boolean;
  publishedAt?: string;
  publishedDate?: string;
  jobUrl: string;
  descriptionHtml?: string;
  descriptionPlain?: string;
  isListed?: boolean;
}

interface AshbyBoard {
  jobs?: AshbyJob[];
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export async function fetchJobs(company: Company, doFetch: Fetcher = fetch): Promise<Job[]> {
  const res = await doFetch(`${BASE}/${company.token}?includeCompensation=true`);
  if (!res.ok) throw new Error(`ashby feed ${company.token}: HTTP ${res.status}`);
  const board = (await res.json()) as AshbyBoard;
  return (board.jobs ?? []).filter((j) => j.isListed !== false).map((j) => normalize(company, j));
}

/** Ashby has no public individual-posting endpoint: re-fetch the board and look for the id. */
export async function isLive(company: Company, job: Job, doFetch: Fetcher = fetch): Promise<boolean> {
  const res = await doFetch(`${BASE}/${company.token}`);
  if (!res.ok) throw new Error(`ashby verify ${company.token}: HTTP ${res.status}`);
  const board = (await res.json()) as AshbyBoard;
  return (board.jobs ?? []).some((j) => j.id === job.id && j.isListed !== false);
}

function normalize(company: Company, j: AshbyJob): Job {
  const locations = [
    j.location,
    ...(j.secondaryLocations ?? []).map((s) => s.location),
    j.isRemote ? 'Remote' : undefined,
  ].filter((x, i, arr): x is string => !!x && arr.indexOf(x) === i);
  return {
    id: j.id,
    company: company.name,
    title: j.title,
    location: locations.join('; '),
    url: canonicalUrl(j.jobUrl),
    description: j.descriptionPlain ?? (j.descriptionHtml ? stripHtml(j.descriptionHtml) : ''),
    posted_at: j.publishedAt ?? j.publishedDate ?? null,
    ats: 'ashby',
    raw: j,
  };
}

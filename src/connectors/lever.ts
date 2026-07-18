// Lever connector (docs/TRD.md §2).
// Feed:            api.lever.co/v0/postings/{token}?mode=json
// Date field:      createdAt (epoch ms)
// verify-on-notify: GET of the individual posting in JSON mode -> 404 = dead

import type { Company, Job } from '../types';
import { canonicalUrl, stripHtml } from './common';

const BASE = 'https://api.lever.co/v0/postings';

interface LeverPosting {
  id: string;
  text: string;
  hostedUrl: string;
  createdAt?: number;
  descriptionPlain?: string;
  description?: string;
  categories?: { location?: string; allLocations?: string[]; commitment?: string; team?: string };
  workplaceType?: string;
  lists?: Array<{ text: string; content: string }>;
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export async function fetchJobs(company: Company, doFetch: Fetcher = fetch): Promise<Job[]> {
  const res = await doFetch(`${BASE}/${company.token}?mode=json`);
  if (!res.ok) throw new Error(`lever feed ${company.token}: HTTP ${res.status}`);
  const postings = (await res.json()) as LeverPosting[];
  if (!Array.isArray(postings)) throw new Error(`lever feed ${company.token}: unexpected payload`);
  return postings.map((p) => normalize(company, p));
}

export async function isLive(company: Company, job: Job, doFetch: Fetcher = fetch): Promise<boolean> {
  const res = await doFetch(`${BASE}/${company.token}/${job.id}?mode=json`);
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`lever verify ${company.token}/${job.id}: HTTP ${res.status}`);
  return true;
}

function normalize(company: Company, p: LeverPosting): Job {
  const locations = [
    p.categories?.location,
    ...(p.categories?.allLocations ?? []),
    p.workplaceType,
  ].filter((x, i, arr): x is string => !!x && arr.indexOf(x) === i);
  const listsText = (p.lists ?? []).map((l) => `${l.text}: ${stripHtml(l.content)}`).join(' ');
  const description = p.descriptionPlain
    ? `${p.descriptionPlain} ${listsText}`.trim()
    : stripHtml(`${p.description ?? ''} ${listsText}`);
  return {
    id: p.id,
    company: company.name,
    title: p.text,
    location: locations.join('; '),
    url: canonicalUrl(p.hostedUrl),
    description,
    posted_at: p.createdAt ? new Date(p.createdAt).toISOString() : null,
    ats: 'lever',
    raw: p,
  };
}

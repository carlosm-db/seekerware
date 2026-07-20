// Workable connector — public widget API (no token; confirmed 2026-07-20).
// token = the Workable account slug, e.g. 'nuvei' (from apply.workable.com/{account}).
// Feed: GET https://apply.workable.com/api/v1/widget/accounts/{token}?details=true
//   -> { name, jobs:[{ shortcode, title, description(HTML), url, application_url,
//        telecommuting, published_on, locations:[{country,city,region,hidden}], ... }] }
//   The widget returns only PUBLISHED jobs, with full descriptions inline — one fetch,
//   no per-job detail needed. The application FORM is not public (checked v1/v2/v3), so
//   the kit is detectable:false for Workable (login-gated, like SuccessFactors/Workday).
// verify-on-notify: re-fetch the widget and look up the shortcode (never the SPA HTML).

import type { Company, Job } from '../types';
import { canonicalUrl, stripHtml } from './common';

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const BASE = 'https://apply.workable.com/api/v1/widget/accounts';

interface WorkableLocation {
  country?: string;
  city?: string;
  region?: string;
  hidden?: boolean;
}

interface WorkableJob {
  shortcode?: string;
  title?: string;
  description?: string;
  url?: string;
  application_url?: string;
  telecommuting?: boolean;
  published_on?: string;
  country?: string;
  city?: string;
  locations?: WorkableLocation[];
}

interface WorkableWidget {
  name?: string;
  jobs?: WorkableJob[];
}

function widgetUrl(token: string): string {
  return `${BASE}/${encodeURIComponent(token)}?details=true`;
}

/** Non-hidden locations as "City, Country"; adds "Remote" when telecommuting. */
function locationLabel(j: WorkableJob): string {
  const parts = (j.locations ?? [])
    .filter((l) => !l.hidden)
    .map((l) => [l.city, l.country].filter(Boolean).join(', '))
    .filter(Boolean);
  if (!parts.length && (j.city || j.country)) parts.push([j.city, j.country].filter(Boolean).join(', '));
  if (j.telecommuting) parts.push('Remote');
  return [...new Set(parts)].join('; ');
}

function normalize(company: Company, j: WorkableJob): Job {
  const link = j.url || j.application_url || `https://apply.workable.com/j/${j.shortcode}`;
  return {
    id: j.shortcode!,
    company: company.name,
    title: j.title ?? '',
    location: locationLabel(j),
    url: canonicalUrl(link),
    description: j.description ? stripHtml(j.description) : '',
    posted_at: j.published_on ?? null,
    ats: 'workable',
    raw: j,
  };
}

export async function fetchJobs(company: Company, doFetch: Fetcher = fetch): Promise<Job[]> {
  const res = await doFetch(widgetUrl(company.token));
  if (!res.ok) throw new Error(`workable feed ${company.token}: HTTP ${res.status}`);
  const w = (await res.json()) as WorkableWidget;
  return (w.jobs ?? []).filter((j) => j.shortcode && j.title).map((j) => normalize(company, j));
}

/** Workable has no public single-posting endpoint: re-fetch the widget and look for the shortcode. */
export async function isLive(company: Company, job: Job, doFetch: Fetcher = fetch): Promise<boolean> {
  const res = await doFetch(widgetUrl(company.token));
  if (!res.ok) throw new Error(`workable verify ${company.token}: HTTP ${res.status}`);
  const w = (await res.json()) as WorkableWidget;
  return (w.jobs ?? []).some((j) => j.shortcode === job.id);
}

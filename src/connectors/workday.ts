// Workday connector — public CxS JSON API (no login/cookie/browser; confirmed 2026-07-19).
// token = '{host}/{site}', e.g. 'nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite'.
// List:   POST https://{host}/wday/cxs/{tenant}/{site}/jobs  {limit,offset,searchText,appliedFacets}
//         -> { total, jobPostings:[{title, externalPath, locationsText, bulletFields:[reqId]}] }
// Detail: GET  https://{host}/wday/cxs/{tenant}/{site}{externalPath}
//         -> { jobPostingInfo:{ jobDescription(HTML), startDate, title } }  (via fetchDetail)
// Sorted newest-first; we pull a few pages/run. Description needs the per-job detail.

import type { Company, Job } from '../types';
import { stripHtml } from './common';

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const PAGE = 20;
const MAX_PAGES = 3; // ~60 newest jobs per run — bounds subrequests per company

function parts(token: string): { host: string; tenant: string; site: string } {
  const clean = token.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const [host = '', site = ''] = clean.split('/');
  return { host, tenant: host.split('.')[0] ?? '', site };
}

function cxsBase(token: string): string {
  const { host, tenant, site } = parts(token);
  return `https://${host}/wday/cxs/${tenant}/${site}`;
}

function extPath(job: Job): string {
  return (job.raw as { externalPath?: string } | undefined)?.externalPath ?? '';
}

interface WdPosting {
  title?: string;
  externalPath?: string;
  locationsText?: string;
  bulletFields?: string[];
}

export async function fetchJobs(company: Company, doFetch: Fetcher = fetch): Promise<Job[]> {
  const { host, site } = parts(company.token);
  const base = cxsBase(company.token);
  const out: Job[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await doFetch(`${base}/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ limit: PAGE, offset: page * PAGE, searchText: '', appliedFacets: {} }),
    });
    if (!res.ok) {
      if (page === 0) throw new Error(`workday feed ${company.token}: HTTP ${res.status}`);
      break;
    }
    const data = (await res.json()) as { total?: number; jobPostings?: WdPosting[] };
    const postings = data.jobPostings ?? [];
    for (const p of postings) {
      if (!p.externalPath) continue;
      out.push({
        id: p.bulletFields?.[0] || p.externalPath,
        company: company.name,
        title: p.title ?? '',
        // Workday collapses multi-location postings to "N Locations" (a count, not a
        // place) — treat as unknown ('') so the pipeline enriches it to learn the real
        // location from the detail instead of gating it out.
        location: /^\d+\s+locations?$/i.test(p.locationsText ?? '') ? '' : (p.locationsText ?? ''),
        url: `https://${host}/${site}${p.externalPath}`,
        description: '', // filled by fetchDetail()
        posted_at: null, // list carries only a relative "postedOn"; real date via fetchDetail
        ats: 'workday',
        raw: { externalPath: p.externalPath },
      });
    }
    if (postings.length < PAGE || (page + 1) * PAGE >= (data.total ?? 0)) break;
  }
  return out;
}

export async function fetchDetail(company: Company, job: Job, doFetch: Fetcher = fetch): Promise<Partial<Job>> {
  const ext = extPath(job);
  if (!ext) return {};
  const res = await doFetch(`${cxsBase(company.token)}${ext}`);
  if (!res.ok) return {};
  const info = ((await res.json()) as { jobPostingInfo?: { jobDescription?: string; startDate?: string; title?: string } }).jobPostingInfo ?? {};
  const out: Partial<Job> = {};
  if (info.jobDescription) out.description = stripHtml(info.jobDescription).slice(0, 20000);
  if (info.startDate && /^\d{4}-\d{2}-\d{2}/.test(info.startDate)) out.posted_at = info.startDate.slice(0, 10);
  if (info.title) out.title = info.title;
  return out;
}

export async function isLive(company: Company, job: Job, doFetch: Fetcher = fetch): Promise<boolean> {
  const ext = extPath(job);
  if (!ext) return true; // cannot verify without the path -> do not kill
  const res = await doFetch(`${cxsBase(company.token)}${ext}`);
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`workday verify ${company.token}: HTTP ${res.status}`);
  return true;
}

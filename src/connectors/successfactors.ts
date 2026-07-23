// SuccessFactors / RMK (jobs2web) connector.
// token = the career-site host, e.g. 'jobs.scotiabank.com'.
// Feed: https://{host}/sitemap.xml — comes in TWO public flavors (no login/cookie/
// browser), auto-detected:
//   1. RSS 2.0 (Google Base ns): <item> with <title>, <g:location>, <description>
//      (full HTML). Rich — one fetch, no per-job detail needed.
//   2. URL sitemap: <urlset> of <url><loc><lastmod>. Only URL + date; title/location
//      live in the slug and the description on the job page → fetchDetail() gets it.
// verify-on-notify: re-fetch the feed and look up the id (never the SPA HTML page).

import type { Company, Job } from '../types';
import { canonicalUrl, decodeEntities, stripHtml } from './common';

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** token may be a bare host or a full URL; normalize to https://{host}/sitemap.xml */
function feedUrl(token: string): string {
  const host = token.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return `https://${host}/sitemap.xml`;
}

/** Text of the first `<name>…</name>` (attributes allowed) inside a block, or ''. */
function tag(block: string, name: string): string {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return m ? m[1]!.trim() : '';
}

function cdata(raw: string): string {
  const m = raw.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  return m ? m[1]! : raw;
}

export async function fetchJobs(company: Company, doFetch: Fetcher = fetch): Promise<Job[]> {
  const res = await doFetch(feedUrl(company.token));
  if (!res.ok) throw new Error(`successfactors feed ${company.token}: HTTP ${res.status}`);
  const xml = await res.text();
  if (xml.includes('<urlset')) {
    const urls = xml.match(/<url>[\s\S]*?<\/url>/g) ?? [];
    return urls.map((u) => fromUrlset(company, u)).filter((j): j is Job => j !== null);
  }
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
  return items.map((it) => fromRss(company, it)).filter((j): j is Job => j !== null);
}

/** urlset jobs carry no description in the feed — fetch the job page (visible HTML). */
export async function fetchDetail(_company: Company, job: Job, doFetch: Fetcher = fetch): Promise<Partial<Job>> {
  const res = await doFetch(job.url);
  if (!res.ok) return {};
  const html = await res.text();
  const description = stripHtml(html).slice(0, 20000);
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const title = h1 ? stripHtml(h1[1]!) : undefined;
  return title ? { description, title } : { description };
}

export async function isLive(company: Company, job: Job, doFetch: Fetcher = fetch): Promise<boolean> {
  const res = await doFetch(feedUrl(company.token));
  if (!res.ok) throw new Error(`successfactors verify ${company.token}: HTTP ${res.status}`);
  const xml = await res.text();
  if (xml.includes('<urlset')) return xml.includes(`/${job.id}/`);
  return xml.includes(`<g:id>${job.id}</g:id>`);
}

function fromRss(company: Company, item: string): Job | null {
  const id = tag(item, 'g:id') || tag(item, 'guid').replace(/^.*\//, '');
  const link = tag(item, 'link') || tag(item, 'guid');
  if (!id || !link) return null;
  return {
    id,
    company: company.name,
    title: stripHtml(tag(item, 'title')),
    location: stripHtml(tag(item, 'g:location')),
    url: canonicalUrl(decodeEntities(link)),
    description: stripHtml(cdata(tag(item, 'description'))),
    posted_at: null,
    ats: 'successfactors',
    raw: { id, expiration_date: tag(item, 'g:expiration_date') },
  };
}

function fromUrlset(company: Company, block: string): Job | null {
  const loc = tag(block, 'loc');
  if (!loc) return null;
  const url = canonicalUrl(decodeEntities(loc));
  const idM = loc.match(/\/(\d+)\/?$/);
  const id = idM ? idM[1]! : url;
  const slugM = loc.match(/\/job\/([^/]+)\/\d+\/?$/);
  const slug = slugM ? decodeURIComponent(slugM[1]!).replace(/-/g, ' ').trim() : '';
  return {
    id,
    company: company.name,
    title: slug || url, // provisional; fetchDetail() refines from the job page
    location: '',
    url,
    description: '', // filled by fetchDetail()
    // A urlset <lastmod> is the SITEMAP's regeneration date (every job shares it), NOT the job's
    // posting date — using it made every job "age" together and freshness-drop the whole board once
    // the sitemap was >FRESHNESS_MAX_DAYS old (Bombardier: 1249 jobs all lastmod=one date → 0 stored).
    // Treat as unknown-date (like the RSS variant); freshness then processes them (fresh) and dedup
    // keeps each notified once.
    posted_at: null,
    ats: 'successfactors',
    raw: { id },
  };
}

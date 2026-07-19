// SuccessFactors / RMK (jobs2web) connector.
// Feed:  https://{host}/sitemap.xml  — a PUBLIC RSS 2.0 job feed (Google Base
//        namespace), no login / cookie / browser. One <item> per job with
//        <title> (includes location), <g:location>, <description> (HTML),
//        <link>, <g:id>, <g:employer>, <g:expiration_date>.
// token = the career-site host, e.g. 'jobs.scotiabank.com'.
// verify-on-notify: re-fetch the feed and look up the id (the HTML page is a
//        SPA that 200s even when dead — NEVER verify against it, cf. Ashby).
// Note: the feed carries expiration_date but no reliable posted date, so
//        posted_at is null (freshness falls back to first_seen upstream).

import type { Company, Job } from '../types';
import { canonicalUrl, decodeEntities, stripHtml } from './common';

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** token may be a bare host or a full URL; normalize to https://{host}/sitemap.xml */
function feedUrl(token: string): string {
  const host = token.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return `https://${host}/sitemap.xml`;
}

/** Text of the first `<name>…</name>` (attributes allowed) inside one item, or ''. */
function tag(item: string, name: string): string {
  const m = item.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
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
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
  return items.map((it) => normalize(company, it)).filter((j): j is Job => j !== null);
}

export async function isLive(company: Company, job: Job, doFetch: Fetcher = fetch): Promise<boolean> {
  const res = await doFetch(feedUrl(company.token));
  if (!res.ok) throw new Error(`successfactors verify ${company.token}: HTTP ${res.status}`);
  const xml = await res.text();
  return xml.includes(`<g:id>${job.id}</g:id>`);
}

function normalize(company: Company, item: string): Job | null {
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

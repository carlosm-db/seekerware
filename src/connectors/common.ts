// Rules common to all connectors (docs/TRD.md §2).

import type { Ats } from '../types';

/**
 * Canonical URL = no tracking query params or fragment, PRESERVING the ATS
 * identity params (`identityParams`). Boards with their own careers page carry
 * the job identity in the query string (e.g. Greenhouse `?gh_jid=123`);
 * removing it would collapse all of that company's jobs into the same url_hash
 * and break dedup.
 */
export function canonicalUrl(url: string, identityParams: string[] = []): string {
  try {
    const u = new URL(url);
    const kept = new URLSearchParams();
    for (const p of identityParams) {
      const v = u.searchParams.get(p);
      if (v !== null) kept.set(p, v);
    }
    const qs = kept.toString();
    return `${u.origin}${u.pathname}${qs ? `?${qs}` : ''}`;
  } catch {
    return url;
  }
}

/** Job identity for dedup: SHA-256 (hex) of the URL (already canonical). */
export async function urlHash(url: string): Promise<string> {
  const data = new TextEncoder().encode(url);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

/** Decode numeric + named HTML entities (one pass). */
export function decodeEntities(text: string): string {
  let t = text.replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));
  for (const [entity, char] of Object.entries(ENTITIES)) {
    t = t.replaceAll(entity, char);
  }
  return t;
}

/** Descriptions arrive as HTML (sometimes double-escaped) -> plain text for scoring and AI. */
export function stripHtml(html: string): string {
  // two passes: some feeds (Greenhouse, SF/RMK) escape the content's HTML
  let text = decodeEntities(decodeEntities(html));
  // drop <script>/<style> CONTENTS (matters when stripping a whole job page, not just a feed snippet)
  text = text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  text = text.replace(/<[^>]*>/g, ' ');
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Map a public career/board URL to its ATS + board token, or null if the host
 * is not a supported ATS board. Powers the console "add by URL" bulk flow.
 * Recognized: Greenhouse (boards/job-boards.greenhouse.io/{token} or
 * {token}.greenhouse.io), Lever (jobs.lever.co/{token}), Ashby
 * (jobs.ashbyhq.com/{token}), Workable (apply.workable.com/{token} or
 * {token}.workable.com).
 */
export function parseAtsUrl(input: string): { ats: Ats; token: string } | null {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const seg = u.pathname.split('/').filter(Boolean);
  const first = seg[0] ? decodeURIComponent(seg[0]) : '';

  if (host === 'boards.greenhouse.io' || host === 'job-boards.greenhouse.io') {
    return first ? { ats: 'greenhouse', token: first } : null;
  }
  if (host.endsWith('.greenhouse.io')) {
    const sub = host.slice(0, -'.greenhouse.io'.length);
    if (sub && !['boards', 'job-boards', 'boards-api'].includes(sub)) {
      return { ats: 'greenhouse', token: sub };
    }
  }
  if (host === 'jobs.lever.co' || host === 'lever.co') {
    return first ? { ats: 'lever', token: first } : null;
  }
  if (host === 'jobs.ashbyhq.com' || host === 'ashbyhq.com') {
    return first ? { ats: 'ashby', token: first } : null;
  }
  // Workable: apply.workable.com/{account} or {account}.workable.com -> token '{account}'.
  if (host === 'apply.workable.com') {
    return first ? { ats: 'workable', token: first } : null;
  }
  if (host.endsWith('.workable.com')) {
    const sub = host.slice(0, -'.workable.com'.length);
    if (sub && !['apply', 'www'].includes(sub)) return { ats: 'workable', token: sub };
  }
  // SuccessFactors / RMK: jobs2web.com subdomains are detectable; custom-domain SF
  // career sites (e.g. empleo.grupobancolombia.com) are added via the single-add form.
  if (host.endsWith('.jobs2web.com')) {
    return { ats: 'successfactors', token: host };
  }
  // Workday: {tenant}.wd{N}.myworkdayjobs.com/{locale?}/{site} -> token '{host}/{site}'.
  if (host.endsWith('.myworkdayjobs.com')) {
    const site = seg.find((s) => !/^[a-z]{2}-[A-Za-z]{2,4}$/.test(s));
    return site ? { ats: 'workday', token: `${host}/${site}` } : null;
  }
  return null;
}

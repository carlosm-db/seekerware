// Rules common to all connectors (docs/TRD.md §2).

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

/** Descriptions arrive as HTML (sometimes double-escaped) -> plain text for scoring and AI. */
export function stripHtml(html: string): string {
  let text = html;
  // decode entities (two passes: Greenhouse escapes the content's HTML)
  for (let i = 0; i < 2; i++) {
    text = text.replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));
    for (const [entity, char] of Object.entries(ENTITIES)) {
      text = text.replaceAll(entity, char);
    }
  }
  text = text.replace(/<[^>]*>/g, ' ');
  return text.replace(/\s+/g, ' ').trim();
}

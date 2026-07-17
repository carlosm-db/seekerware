// Reglas comunes a todos los connectors (docs/TRD.md §2).

/**
 * URL canonica = sin query params de tracking ni fragmento, PRESERVANDO los
 * params de identidad del ATS (`identityParams`). Boards con pagina de
 * carreras propia llevan la identidad del job en el query string (p. ej.
 * Greenhouse `?gh_jid=123`); eliminarla colapsaria todos los jobs de esa
 * empresa en un mismo url_hash y romperia el dedup.
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

/** Identidad del job para dedup: SHA-256 (hex) de la URL (ya canonica). */
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

/** Las descripciones llegan en HTML (a veces doblemente escapado) -> texto plano para scoring e IA. */
export function stripHtml(html: string): string {
  let text = html;
  // decodifica entidades (dos pasadas: Greenhouse escapa el HTML del content)
  for (let i = 0; i < 2; i++) {
    text = text.replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));
    for (const [entity, char] of Object.entries(ENTITIES)) {
      text = text.replaceAll(entity, char);
    }
  }
  text = text.replace(/<[^>]*>/g, ' ');
  return text.replace(/\s+/g, ' ').trim();
}

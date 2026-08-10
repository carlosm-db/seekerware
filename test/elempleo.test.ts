import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseAtsUrl } from '../src/connectors/common';
import { fetchDetail, fetchJobs, isLive } from '../src/connectors/elempleo';
import type { Company, Job } from '../src/types';

const company: Company = { id: 1, name: 'EPM', ats: 'elempleo', token: 'trabajo-epm', active: true };

// Mirrors the live per-company page shape verified 2026-08-10: an ItemList ld+json (url+title per
// item, NO dates) + per-card data-ga4-offerdata attrs (entity-encoded JSON with the real employer
// and the city). First job has no ga4 card on purpose (fallback branch).
const LIST_HTML = `<!doctype html><html><body>
<script type="application/ld+json" id="itemListStructuredData">
{ "@context": "https://schema.org", "@type": "ItemList", "numberOfItems": 2,
  "itemListOrder": "https://schema.org/ItemListOrderDescending",
  "itemListElement": [
    { "@type": "ListItem", "position": 1, "item": { "@id": "https://www.elempleo.com/co/ofertas-trabajo/residente-civil-epm-1886733221", "@type": "WebPage", "name": "Residente civil epm" } },
    { "@type": "ListItem", "position": 2, "item": { "@id": "https://www.elempleo.com/co/ofertas-trabajo/topografo-epm-1886724667", "@type": "WebPage", "name": "Topógrafo epm" } }
  ] }
</script>
<div class="result-item" data-url="/co/ofertas-trabajo/topografo-epm-1886724667" data-ga4-offerdata="{&quot;section&quot;:&quot;SEARCH&quot;,&quot;id&quot;:1886724667,&quot;title&quot;:&quot;Top&#243;grafo epm&quot;,&quot;company&quot;:&quot;MAB INGENIERIA DE VALOR SA&quot;,&quot;location&quot;:&quot;Medell&#237;n&quot;,&quot;salary&quot;:&quot;$3 a $3,5 millones&quot;}">Ver oferta</div>
</body></html>`;

// Mirrors the live detail page: the script tag carries id= BEFORE type= (attribute order matters),
// datePosted is unpadded, addressCountry is the ISO code 'CO'.
const DETAIL_HTML = `<!doctype html><html><body>
<script id="JobPosting" type="application/ld+json" strategy="afterInteractive">
{ "@context": "https://schema.org/", "@type": "JobPosting", "title": "residente civil EPM",
  "description": "<p>Importante compañía requiere Residente Civil &amp; obras.</p>",
  "datePosted": "2026-7-1", "validThrough": "2026-08-30", "employmentType": "PER_DIEM",
  "hiringOrganization": { "@type": "Organization", "name": "APPLUS NORCONTROL COLOMBIA LTDA" },
  "jobLocation": { "@type": "Place", "address": { "@type": "PostalAddress",
    "addressLocality": "Antioquia", "addressRegion": "Barbosa", "addressCountry": "CO" } } }
</script>
</body></html>`;

// The not-found search page a bogus token redirects to: 200 after the redirect, but no ItemList.
const NOT_FOUND_HTML = '<!doctype html><html><body><div>No encontramos ofertas</div></body></html>';

function mockFetch(handler: (url: string) => { status?: number; body?: string; headers?: Record<string, string> }) {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const { status = 200, body, headers } = handler(String(input));
    return new Response(body ?? null, { status, headers });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe('parseAtsUrl (elempleo)', () => {
  it('detects the per-company page (with and without www)', () => {
    expect(parseAtsUrl('https://www.elempleo.com/co/ofertas-empleo/trabajo-epm')).toEqual({ ats: 'elempleo', token: 'trabajo-epm' });
    expect(parseAtsUrl('https://elempleo.com/co/ofertas-empleo/trabajo-grupo-exito')).toEqual({ ats: 'elempleo', token: 'trabajo-grupo-exito' });
  });
  it('ignores job pages and non-company paths', () => {
    expect(parseAtsUrl('https://www.elempleo.com/co/ofertas-trabajo/residente-civil-epm-1886733221')).toBeNull();
    expect(parseAtsUrl('https://www.elempleo.com/co/ofertas-empleo/')).toBeNull();
  });
});

describe('fetchJobs', () => {
  it('normalizes the ItemList: id from the slug, ga4 city when present, no date -> null', async () => {
    mockFetch(() => ({ body: LIST_HTML }));
    const jobs = await fetchJobs(company);
    expect(jobs).toHaveLength(2);
    const [a, b] = jobs;
    expect(a).toMatchObject({
      id: '1886733221', company: 'EPM', title: 'Residente civil epm',
      url: 'https://www.elempleo.com/co/ofertas-trabajo/residente-civil-epm-1886733221',
      location: '', posted_at: null, ats: 'elempleo',
    });
    expect(a!.description).toBe(''); // must stay empty so the pipeline pulls the detail
    // ga4 card enriches the city (entities decoded); the real employer travels in raw
    expect(b).toMatchObject({ id: '1886724667', title: 'Topógrafo epm', location: 'Medellín' });
    expect((b!.raw as { ga4: { company: string } }).ga4.company).toBe('MAB INGENIERIA DE VALOR SA');
  });

  it('throws if the feed errors (caller isolates per company)', async () => {
    mockFetch(() => ({ status: 500, body: '' }));
    await expect(fetchJobs(company)).rejects.toThrow('elempleo feed trabajo-epm: HTTP 500');
  });

  it('throws on a 200 page without ItemList (bogus token lands on the not-found search page)', async () => {
    mockFetch(() => ({ body: NOT_FOUND_HTML }));
    await expect(fetchJobs(company)).rejects.toThrow('no ItemList');
  });
});

describe('fetchDetail', () => {
  const job = { id: '1886733221', url: 'https://www.elempleo.com/co/ofertas-trabajo/residente-civil-epm-1886733221' } as Job;

  it('parses the JobPosting: employer prefix, ISO date, "City, Dept, Colombia" location', async () => {
    mockFetch(() => ({ body: DETAIL_HTML }));
    const patch = await fetchDetail(company, job);
    expect(patch.description).toBe('Empleador: APPLUS NORCONTROL COLOMBIA LTDA\n\nImportante compañía requiere Residente Civil & obras.');
    expect(patch.posted_at).toBe('2026-07-01'); // "2026-7-1" normalized — never handed raw downstream
    expect(patch.location).toBe('Barbosa, Antioquia, Colombia'); // ISO 'CO' -> the gate-matchable word
    expect(patch.title).toBe('residente civil EPM');
  });

  it('soft-fails on HTTP error and on a page without JobPosting (SF/Workday precedent)', async () => {
    mockFetch(() => ({ status: 500, body: '' }));
    expect(await fetchDetail(company, job)).toEqual({});
    mockFetch(() => ({ body: NOT_FOUND_HTML }));
    expect(await fetchDetail(company, job)).toEqual({});
  });
});

describe('isLive (verify-on-notify)', () => {
  const job = { id: '1886733221', url: 'https://www.elempleo.com/co/ofertas-trabajo/residente-civil-epm-1886733221' } as Job;

  it('301 to the not-found page = dead (redirects are NOT followed)', async () => {
    const fn = mockFetch(() => ({ status: 301, headers: { location: 'https://www.elempleo.com/co/ofertas-empleo/?__not_found__=1' } }));
    expect(await isLive(company, job)).toBe(false);
    expect(fn).toHaveBeenCalledWith(job.url, { redirect: 'manual' });
  });

  it('an UNEXPECTED redirect throws (indeterminate — a site change must not close jobs)', async () => {
    mockFetch(() => ({ status: 301, headers: { location: 'https://www.elempleo.com/co/nueva-ruta' } }));
    await expect(isLive(company, job)).rejects.toThrow('HTTP 301');
  });

  it('200 with JobPosting = alive; 200 without it = dead (expired-but-200 page)', async () => {
    mockFetch(() => ({ body: DETAIL_HTML }));
    expect(await isLive(company, job)).toBe(true);
    mockFetch(() => ({ body: NOT_FOUND_HTML }));
    expect(await isLive(company, job)).toBe(false);
  });

  it('404 = dead; other errors throw (indeterminate, never mark closed)', async () => {
    mockFetch(() => ({ status: 404 }));
    expect(await isLive(company, job)).toBe(false);
    mockFetch(() => ({ status: 503 }));
    await expect(isLive(company, job)).rejects.toThrow('HTTP 503');
  });
});

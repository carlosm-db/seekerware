import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseAtsUrl } from '../src/connectors/common';
import { fetchDetail, fetchJobs, isLive } from '../src/connectors/magneto';
import type { Company, Job } from '../src/types';

const company: Company = { id: 1, name: 'Grupo Éxito', ats: 'magneto', token: 'grupo-exito', active: true };

// Mirrors the live per-company board verified 2026-08-10: an ItemList ld+json whose ListItems
// carry the /co/empresas/... URL form directly on `url` (no name, no dates).
const LIST_HTML = `<!doctype html><html><body>
<script type="application/ld+json">
{ "@context": "https://schema.org", "@type": "ItemList", "name": "Empleos en Grupo Éxito",
  "itemListElement": [
    { "@type": "ListItem", "position": 1, "url": "https://www.magneto365.com/co/empresas/grupo-exito/empleos/asesor-a-viajes-exito-medellin-1018059" },
    { "@type": "ListItem", "position": 2, "url": "https://www.magneto365.com/co/empresas/grupo-exito/empleos/operador-a-de-pedido-medellin-979251" }
  ] }
</script>
</body></html>`;

// Mirrors the live detail page: id= before type= on the script tag, address fields as ARRAYS,
// ISO country code, already-padded datePosted.
const DETAIL_HTML = `<!doctype html><html><body>
<script id="JobPosting" type="application/ld+json" strategy="afterInteractive">
{ "@context": "https://schema.org", "@type": "JobPosting", "title": "Asesor(a) Viajes Éxito Medellín",
  "datePosted": "2026-08-07", "validThrough": "2026-08-30",
  "description": "<p>Como Asesor(a) de Viajes serás responsable &amp; más.</p>",
  "employmentType": "FULL_TIME",
  "hiringOrganization": { "@type": "Organization", "name": "Grupo Éxito" },
  "jobLocation": { "@type": "Place", "address": { "@type": "PostalAddress",
    "addressLocality": ["Medellín"], "addressRegion": ["Antioquia"], "addressCountry": "CO" } },
  "baseSalary": { "@type": "MonetaryAmount", "currency": "COP" } }
</script>
</body></html>`;

const NO_LD_HTML = '<!doctype html><html><body><div>Página sin datos estructurados</div></body></html>';

function mockFetch(handler: (url: string) => { status?: number; body?: string }) {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const { status = 200, body } = handler(String(input));
    return new Response(body ?? null, { status });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe('parseAtsUrl (magneto)', () => {
  it('detects the per-company board (with and without /empleos, with and without www)', () => {
    expect(parseAtsUrl('https://www.magneto365.com/co/empresas/grupo-exito')).toEqual({ ats: 'magneto', token: 'grupo-exito' });
    expect(parseAtsUrl('https://magneto365.com/co/empresas/bancolombia/empleos')).toEqual({ ats: 'magneto', token: 'bancolombia' });
  });
  it('ignores job pages and non-company paths', () => {
    expect(parseAtsUrl('https://www.magneto365.com/co/empleos/asesor-a-viajes-exito-medellin-1018059')).toBeNull();
    expect(parseAtsUrl('https://www.magneto365.com/co/trabajos/bolsa-de-empleo')).toBeNull();
  });
});

describe('fetchJobs', () => {
  it('normalizes the ItemList: id from the slug, canonical /co/empleos/ URL, de-slugged provisional title', async () => {
    mockFetch(() => ({ body: LIST_HTML }));
    const jobs = await fetchJobs(company);
    expect(jobs).toHaveLength(2);
    const [a, b] = jobs;
    expect(a).toMatchObject({
      id: '1018059', company: 'Grupo Éxito', title: 'asesor a viajes exito medellin',
      url: 'https://www.magneto365.com/co/empleos/asesor-a-viajes-exito-medellin-1018059',
      location: '', posted_at: null, ats: 'magneto',
    });
    expect(a!.description).toBe(''); // must stay empty so the pipeline pulls the detail
    expect(b).toMatchObject({ id: '979251', url: 'https://www.magneto365.com/co/empleos/operador-a-de-pedido-medellin-979251' });
  });

  it('throws if the feed errors (caller isolates per company)', async () => {
    mockFetch(() => ({ status: 500, body: '' }));
    await expect(fetchJobs(company)).rejects.toThrow('magneto feed grupo-exito: HTTP 500');
  });

  it('throws on a 200 page without ItemList (bogus slug must not save as "0 jobs OK")', async () => {
    mockFetch(() => ({ body: NO_LD_HTML }));
    await expect(fetchJobs(company)).rejects.toThrow('no ItemList');
  });
});

describe('fetchDetail', () => {
  const job = { id: '1018059', url: 'https://www.magneto365.com/co/empleos/asesor-a-viajes-exito-medellin-1018059' } as Job;

  it('parses the JobPosting: array address -> "City, Dept, Colombia", real title, ISO date', async () => {
    mockFetch(() => ({ body: DETAIL_HTML }));
    const patch = await fetchDetail(company, job);
    expect(patch.location).toBe('Medellín, Antioquia, Colombia'); // arrays unwrapped, 'CO' mapped
    expect(patch.posted_at).toBe('2026-08-07');
    expect(patch.title).toBe('Asesor(a) Viajes Éxito Medellín');
    // employer equals the roster name -> NO "Empleador:" prefix on these per-company boards
    expect(patch.description).toBe('Como Asesor(a) de Viajes serás responsable & más.');
  });

  it('prefixes the employer only when it differs from the roster name', async () => {
    mockFetch(() => ({ body: DETAIL_HTML }));
    const other: Company = { ...company, name: 'Viva Envigado' };
    const patch = await fetchDetail(other, job);
    expect(patch.description).toBe('Empleador: Grupo Éxito\n\nComo Asesor(a) de Viajes serás responsable & más.');
  });

  it('soft-fails on HTTP error and on a page without JobPosting (SF/Workday precedent)', async () => {
    mockFetch(() => ({ status: 500, body: '' }));
    expect(await fetchDetail(company, job)).toEqual({});
    mockFetch(() => ({ body: NO_LD_HTML }));
    expect(await fetchDetail(company, job)).toEqual({});
  });
});

describe('isLive (verify-on-notify)', () => {
  const job = { id: '1018059', url: 'https://www.magneto365.com/co/empleos/asesor-a-viajes-exito-medellin-1018059' } as Job;

  it('200 with JobPosting = alive; 200 without it = dead; redirects are NOT followed', async () => {
    const fn = mockFetch(() => ({ body: DETAIL_HTML }));
    expect(await isLive(company, job)).toBe(true);
    expect(fn).toHaveBeenCalledWith(job.url, { redirect: 'manual' });
    mockFetch(() => ({ body: NO_LD_HTML }));
    expect(await isLive(company, job)).toBe(false);
  });

  it('404 = dead', async () => {
    mockFetch(() => ({ status: 404 }));
    expect(await isLive(company, job)).toBe(false);
  });

  it('500 throws (a nonexistent id returns 500 — indistinguishable from a flake, never close on it)', async () => {
    mockFetch(() => ({ status: 500 }));
    await expect(isLive(company, job)).rejects.toThrow('magneto verify grupo-exito/1018059: HTTP 500');
  });

  it('a redirect throws (indeterminate — a site change must not close jobs)', async () => {
    mockFetch(() => ({ status: 301 }));
    await expect(isLive(company, job)).rejects.toThrow('HTTP 301');
  });
});

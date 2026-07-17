import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalUrl, stripHtml, urlHash } from '../src/connectors/common';
import { fetchJobs, isLive } from '../src/connectors/greenhouse';
import type { Company } from '../src/types';

const company: Company = { id: 1, name: 'Acme', ats: 'greenhouse', token: 'acme', active: true };

// Fixture con la forma real del feed de Greenhouse (content escapado, query params de tracking).
const FEED = {
  jobs: [
    {
      id: 101,
      title: 'Business Analyst, Payments',
      absolute_url: 'https://boards.greenhouse.io/acme/jobs/101?gh_src=abc123&utm_source=x',
      content: '&lt;p&gt;Reconciliation &amp;amp; settlement ops.&lt;/p&gt;&lt;ul&gt;&lt;li&gt;SQL&lt;/li&gt;&lt;/ul&gt;',
      first_published: '2026-07-15T10:00:00-04:00',
      updated_at: '2026-07-16T09:00:00-04:00',
      location: { name: 'Vancouver, BC' },
    },
    {
      id: 102,
      title: 'Data Analyst Co-op',
      // patron "pagina de carreras propia": la identidad viaja en gh_jid (caso real: Thinkific)
      absolute_url: 'https://acme.com/careers/job-post?gh_jid=102&gh_src=track123',
      // sin content, sin first_published (boards viejos): fallback a null
      location: undefined,
    },
  ],
};

function mockFetch(response: { status?: number; body?: unknown }) {
  const fn = vi.fn(async () => {
    return new Response(response.body === undefined ? null : JSON.stringify(response.body), {
      status: response.status ?? 200,
    });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe('canonicalUrl', () => {
  it('quita query params de tracking y fragmento', () => {
    expect(canonicalUrl('https://x.io/jobs/1?gh_src=a&utm=b#top')).toBe('https://x.io/jobs/1');
  });
  it('preserva los params de identidad del ATS y elimina el resto', () => {
    expect(canonicalUrl('https://x.io/careers?gh_src=a&gh_jid=42&utm=b', ['gh_jid'])).toBe(
      'https://x.io/careers?gh_jid=42',
    );
  });
  it('devuelve el valor crudo si no parsea', () => {
    expect(canonicalUrl('no-es-url')).toBe('no-es-url');
  });
});

describe('urlHash', () => {
  it('es sha-256 hex determinista', async () => {
    const a = await urlHash(canonicalUrl('https://x.io/jobs/1?tracking=si'));
    const b = await urlHash(canonicalUrl('https://x.io/jobs/1'));
    const c = await urlHash(canonicalUrl('https://x.io/jobs/2'));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b); // el tracking no rompe el dedup
    expect(a).not.toBe(c);
  });

  it('jobs distintos en pagina de carreras propia NO colapsan (bug Thinkific)', async () => {
    const a = await urlHash(canonicalUrl('https://x.io/careers/job-post?gh_jid=1', ['gh_jid']));
    const b = await urlHash(canonicalUrl('https://x.io/careers/job-post?gh_jid=2', ['gh_jid']));
    expect(a).not.toBe(b);
  });
});

describe('stripHtml', () => {
  it('decodifica entidades (doble escape de Greenhouse) y elimina tags', () => {
    const input = '&lt;p&gt;Reconciliation &amp;amp; settlement&lt;/p&gt;';
    expect(stripHtml(input)).toBe('Reconciliation & settlement');
  });
});

describe('fetchJobs', () => {
  it('normaliza el feed: url canonica, posted_at de first_published, descripcion plana', async () => {
    mockFetch({ body: FEED });
    const jobs = await fetchJobs(company);
    expect(jobs).toHaveLength(2);

    const [a, b] = jobs;
    expect(a).toMatchObject({
      id: '101',
      company: 'Acme',
      title: 'Business Analyst, Payments',
      url: 'https://boards.greenhouse.io/acme/jobs/101',
      posted_at: '2026-07-15T10:00:00-04:00',
      location: 'Vancouver, BC',
      ats: 'greenhouse',
    });
    expect(a!.description).toContain('Reconciliation & settlement ops.');
    expect(a!.description).not.toContain('<');

    // identidad preservada en boards con pagina propia: gh_jid queda, el tracking se va
    expect(b!.url).toBe('https://acme.com/careers/job-post?gh_jid=102');
    // fallback: sin fecha confiable -> posted_at null (freshness_ok='unknown' lo decide el pipeline)
    expect(b).toMatchObject({ id: '102', posted_at: null, location: '', description: '' });
  });

  it('lanza si el feed responde error (el caller aisla por empresa)', async () => {
    mockFetch({ status: 500, body: {} });
    await expect(fetchJobs(company)).rejects.toThrow('HTTP 500');
  });
});

describe('isLive (verify-on-notify)', () => {
  const job = { id: '101', url: 'https://x.io/jobs/101' } as Parameters<typeof isLive>[1];

  it('404 = cerrado', async () => {
    mockFetch({ status: 404 });
    expect(await isLive(company, job)).toBe(false);
  });

  it('200 = vivo', async () => {
    mockFetch({ body: { id: 101 } });
    expect(await isLive(company, job)).toBe(true);
  });

  it('otros errores lanzan (indeterminado, nunca marcar closed)', async () => {
    mockFetch({ status: 503 });
    await expect(isLive(company, job)).rejects.toThrow('HTTP 503');
  });
});

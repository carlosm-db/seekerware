import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalUrl, stripHtml, urlHash } from '../src/connectors/common';
import { fetchDetail, fetchJobs, isLive } from '../src/connectors/greenhouse';
import type { Company } from '../src/types';

const company: Company = { id: 1, name: 'Acme', ats: 'greenhouse', token: 'acme', active: true };

// Fixture with the real shape of the Greenhouse LIGHT list (no `content`; tracking query params,
// custom career page). The description is pulled per-job by fetchDetail, not present here.
const FEED = {
  jobs: [
    {
      id: 101,
      title: 'Business Analyst, Payments',
      absolute_url: 'https://boards.greenhouse.io/acme/jobs/101?gh_src=abc123&utm_source=x',
      first_published: '2026-07-15T10:00:00-04:00',
      updated_at: '2026-07-16T09:00:00-04:00',
      location: { name: 'Vancouver, BC' },
    },
    {
      id: 102,
      title: 'Data Analyst Co-op',
      // pattern "custom career page": identity travels in gh_jid (real case: Thinkific)
      absolute_url: 'https://acme.com/careers/job-post?gh_jid=102&gh_src=track123',
      // no content, no first_published (old boards): fallback to null
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
  it('strips tracking query params and fragment', () => {
    expect(canonicalUrl('https://x.io/jobs/1?gh_src=a&utm=b#top')).toBe('https://x.io/jobs/1');
  });
  it('preserves the ATS identity params and strips the rest', () => {
    expect(canonicalUrl('https://x.io/careers?gh_src=a&gh_jid=42&utm=b', ['gh_jid'])).toBe(
      'https://x.io/careers?gh_jid=42',
    );
  });
  it('returns the raw value if it does not parse', () => {
    expect(canonicalUrl('no-es-url')).toBe('no-es-url');
  });
});

describe('urlHash', () => {
  it('is deterministic sha-256 hex', async () => {
    const a = await urlHash(canonicalUrl('https://x.io/jobs/1?tracking=si'));
    const b = await urlHash(canonicalUrl('https://x.io/jobs/1'));
    const c = await urlHash(canonicalUrl('https://x.io/jobs/2'));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b); // tracking does not break dedup
    expect(a).not.toBe(c);
  });

  it('distinct jobs on a custom career page do NOT collapse (Thinkific bug)', async () => {
    const a = await urlHash(canonicalUrl('https://x.io/careers/job-post?gh_jid=1', ['gh_jid']));
    const b = await urlHash(canonicalUrl('https://x.io/careers/job-post?gh_jid=2', ['gh_jid']));
    expect(a).not.toBe(b);
  });
});

describe('stripHtml', () => {
  it('decodes entities (Greenhouse double-escape) and strips tags', () => {
    const input = '&lt;p&gt;Reconciliation &amp;amp; settlement&lt;/p&gt;';
    expect(stripHtml(input)).toBe('Reconciliation & settlement');
  });
});

describe('fetchJobs', () => {
  it('normalizes the LIGHT list: canonical url, posted_at from first_published, no description', async () => {
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
    // the light list carries no content — the pipeline pulls it via fetchDetail before scoring
    expect(a!.description).toBe('');

    // identity preserved on boards with a custom page: gh_jid stays, tracking is stripped
    expect(b!.url).toBe('https://acme.com/careers/job-post?gh_jid=102');
    // fallback: no reliable date -> posted_at null (freshness_ok='unknown' decided by the pipeline)
    expect(b).toMatchObject({ id: '102', posted_at: null, location: '', description: '' });
  });

  it('throws if the feed returns an error (the caller isolates per company)', async () => {
    mockFetch({ status: 500, body: {} });
    await expect(fetchJobs(company)).rejects.toThrow('HTTP 500');
  });
});

// The single-job detail carries the full `content` the light list omits.
const DETAIL = {
  id: 101,
  title: 'Business Analyst, Payments',
  content: '&lt;p&gt;Reconciliation &amp;amp; settlement ops.&lt;/p&gt;&lt;ul&gt;&lt;li&gt;SQL&lt;/li&gt;&lt;/ul&gt;',
};

describe('fetchDetail', () => {
  const job = { id: '101' } as Parameters<typeof fetchDetail>[1];

  it('returns the plain-text description from the single-job content', async () => {
    mockFetch({ body: DETAIL });
    const patch = await fetchDetail(company, job);
    expect(patch.description).toContain('Reconciliation & settlement ops.');
    expect(patch.description).not.toContain('<');
  });

  it('throws on HTTP error (the pipeline logs a warn and moves on)', async () => {
    mockFetch({ status: 500, body: {} });
    await expect(fetchDetail(company, job)).rejects.toThrow('HTTP 500');
  });
});

describe('isLive (verify-on-notify)', () => {
  const job = { id: '101', url: 'https://x.io/jobs/101' } as Parameters<typeof isLive>[1];

  it('404 = closed', async () => {
    mockFetch({ status: 404 });
    expect(await isLive(company, job)).toBe(false);
  });

  it('200 = alive', async () => {
    mockFetch({ body: { id: 101 } });
    expect(await isLive(company, job)).toBe(true);
  });

  it('other errors throw (indeterminate, never mark closed)', async () => {
    mockFetch({ status: 503 });
    await expect(isLive(company, job)).rejects.toThrow('HTTP 503');
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseAtsUrl } from '../src/connectors/common';
import { fetchDetail, fetchJobs, isLive } from '../src/connectors/smartrecruiters';
import type { Company } from '../src/types';

const company: Company = { id: 1, name: 'Wise', ats: 'smartrecruiters', token: 'Wise', active: true };

// Real shape of the SmartRecruiters LIGHT list (no description; rich structured location + releasedDate).
const LIST = {
  totalFound: 2,
  offset: 0,
  limit: 100,
  content: [
    {
      id: '744000139148459',
      name: 'Senior Backend Engineer',
      location: { fullLocation: 'Toronto, ON, Canada', city: 'Toronto', region: 'ON', country: 'ca', remote: true },
      releasedDate: '2026-07-22T19:46:39.056Z',
    },
    {
      id: '900',
      name: 'Analyst, Payments',
      location: { city: 'Bogotá', country: 'co', hybrid: true },
      releasedDate: undefined,
    },
  ],
};

/** Stub global fetch with a per-call handler (URL -> {status, body}) so pagination can be exercised. */
function mockFetch(handler: (url: string) => { status?: number; body?: unknown }) {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const { status = 200, body } = handler(String(input));
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe('parseAtsUrl (smartrecruiters)', () => {
  it('detects the public job board host', () => {
    expect(parseAtsUrl('https://jobs.smartrecruiters.com/Wise/744000139148459-senior-eng')).toEqual({
      ats: 'smartrecruiters', token: 'Wise',
    });
    expect(parseAtsUrl('https://careers.smartrecruiters.com/Avianca')).toEqual({
      ats: 'smartrecruiters', token: 'Avianca',
    });
  });
  it('detects the API host via the companies/{id} segment', () => {
    expect(parseAtsUrl('https://api.smartrecruiters.com/v1/companies/Wise/postings')).toEqual({
      ats: 'smartrecruiters', token: 'Wise',
    });
  });
});

describe('fetchJobs', () => {
  it('normalizes the light list: deterministic URL, location incl. remote/hybrid, releasedDate -> posted_at', async () => {
    mockFetch(() => ({ body: LIST }));
    const jobs = await fetchJobs(company);
    expect(jobs).toHaveLength(2);
    const [a, b] = jobs;
    expect(a).toMatchObject({
      id: '744000139148459',
      company: 'Wise',
      title: 'Senior Backend Engineer',
      url: 'https://jobs.smartrecruiters.com/Wise/744000139148459',
      location: 'Toronto, ON, Canada; Remote',
      posted_at: '2026-07-22T19:46:39.056Z',
      ats: 'smartrecruiters',
    });
    expect(a!.description).toBe(''); // list omits it
    // structured fallback + hybrid tag; missing date -> null
    expect(b).toMatchObject({ id: '900', location: 'Bogotá, co; Hybrid', posted_at: null, description: '' });
  });

  it('paginates by offset and stops at totalFound', async () => {
    const fn = mockFetch((url) => {
      const offset = Number(new URL(url).searchParams.get('offset'));
      const content = Array.from({ length: offset === 0 ? 100 : 20 }, (_, i) => ({
        id: String(offset + i), name: 'Role', location: { city: 'Toronto' }, releasedDate: '2026-07-20',
      }));
      return { body: { totalFound: 120, offset, limit: 100, content } };
    });
    const jobs = await fetchJobs(company);
    expect(jobs).toHaveLength(120);
    expect(fn).toHaveBeenCalledTimes(2); // offset 0 then 100, then stops (120 >= totalFound)
  });

  it('throws if the first page errors (caller isolates per company)', async () => {
    mockFetch(() => ({ status: 500, body: {} }));
    await expect(fetchJobs(company)).rejects.toThrow('HTTP 500');
  });
});

describe('fetchDetail', () => {
  const job = { id: '744000139148459' } as Parameters<typeof fetchDetail>[1];
  it('concatenates the jobAd sections into plain-text description', async () => {
    mockFetch(() => ({ body: { jobAd: { sections: {
      jobDescription: { text: '<p>Build &amp; ship payments.</p>' },
      qualifications: { text: '<ul><li>SQL</li></ul>' },
    } } } }));
    const patch = await fetchDetail(company, job);
    expect(patch.description).toContain('Build & ship payments.');
    expect(patch.description).toContain('SQL');
    expect(patch.description).not.toContain('<');
  });
  it('throws on HTTP error', async () => {
    mockFetch(() => ({ status: 500, body: {} }));
    await expect(fetchDetail(company, job)).rejects.toThrow('HTTP 500');
  });
});

describe('isLive (verify-on-notify)', () => {
  const job = { id: '744000139148459' } as Parameters<typeof isLive>[1];
  it('404 = closed', async () => {
    mockFetch(() => ({ status: 404 }));
    expect(await isLive(company, job)).toBe(false);
  });
  it('200 = alive', async () => {
    mockFetch(() => ({ body: { id: '744000139148459' } }));
    expect(await isLive(company, job)).toBe(true);
  });
  it('other errors throw (indeterminate, never mark closed)', async () => {
    mockFetch(() => ({ status: 503 }));
    await expect(isLive(company, job)).rejects.toThrow('HTTP 503');
  });
});

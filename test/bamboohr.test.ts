import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseAtsUrl } from '../src/connectors/common';
import { fetchDetail, fetchJobs, isLive } from '../src/connectors/bamboohr';
import type { Company, Job } from '../src/types';

const company: Company = { id: 1, name: 'OPAL-RT', ats: 'bamboohr', token: 'opalrt', active: true };

// Real shape of the BambooHR careers/list feed (no description, no posting date).
const LIST = {
  meta: { totalCount: 2 },
  result: [
    { id: '631', jobOpeningName: 'Integrated Systems Tester', location: { city: 'Montreal', state: 'Quebec' }, atsLocation: { country: null, state: null, province: null, city: null }, isRemote: null, locationType: '0' },
    { id: '700', jobOpeningName: 'Remote Support', location: { city: null, state: null }, atsLocation: { city: 'Toronto', province: 'Ontario', country: 'Canada' }, isRemote: true },
  ],
};

function mockFetch(handler: (url: string) => { status?: number; body?: unknown }) {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const { status = 200, body } = handler(String(input));
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe('parseAtsUrl (bamboohr)', () => {
  it('detects the hosted careers subdomain (and the embed script)', () => {
    expect(parseAtsUrl('https://opalrt.bamboohr.com/careers/631')).toEqual({ ats: 'bamboohr', token: 'opalrt' });
    expect(parseAtsUrl('https://opalrt.bamboohr.com/js/jobs2.php')).toEqual({ ats: 'bamboohr', token: 'opalrt' });
  });
  it('ignores www', () => {
    expect(parseAtsUrl('https://www.bamboohr.com/careers')).toBeNull();
  });
});

describe('fetchJobs', () => {
  it('normalizes the list: deterministic URL, location from location/atsLocation + Remote, no date -> null', async () => {
    mockFetch(() => ({ body: LIST }));
    const jobs = await fetchJobs(company);
    expect(jobs).toHaveLength(2);
    const [a, b] = jobs;
    expect(a).toMatchObject({
      id: '631', company: 'OPAL-RT', title: 'Integrated Systems Tester',
      url: 'https://opalrt.bamboohr.com/careers/631', location: 'Montreal, Quebec',
      posted_at: null, ats: 'bamboohr',
    });
    expect(a!.description).toBe('');
    // falls back to atsLocation when location is empty; Remote appended from isRemote
    expect(b).toMatchObject({ id: '700', location: 'Toronto, Ontario, Canada; Remote', posted_at: null });
  });

  it('throws if the feed errors (caller isolates per company)', async () => {
    mockFetch(() => ({ status: 500, body: {} }));
    await expect(fetchJobs(company)).rejects.toThrow('HTTP 500');
  });
});

describe('fetchDetail', () => {
  const job = { id: '631' } as Job;
  it('pulls the plain-text description from result.jobOpening', async () => {
    mockFetch(() => ({ body: { result: { jobOpening: { description: '<p>Test &amp; validate systems.</p>' } } } }));
    const patch = await fetchDetail(company, job);
    expect(patch.description).toBe('Test & validate systems.');
  });
  it('throws on HTTP error', async () => {
    mockFetch(() => ({ status: 500, body: {} }));
    await expect(fetchDetail(company, job)).rejects.toThrow('HTTP 500');
  });
});

describe('isLive (verify-on-notify)', () => {
  const job = { id: '631' } as Job;
  it('404 = closed', async () => {
    mockFetch(() => ({ status: 404 }));
    expect(await isLive(company, job)).toBe(false);
  });
  it('200 = alive', async () => {
    mockFetch(() => ({ body: { result: {} } }));
    expect(await isLive(company, job)).toBe(true);
  });
  it('other errors throw (indeterminate, never mark closed)', async () => {
    mockFetch(() => ({ status: 503 }));
    await expect(isLive(company, job)).rejects.toThrow('HTTP 503');
  });
});

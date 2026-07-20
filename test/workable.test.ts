import { afterEach, describe, expect, it, vi } from 'vitest';
import * as workable from '../src/connectors/workable';
import { parseAtsUrl } from '../src/connectors/common';
import type { Company } from '../src/types';

function mockFetch(body: unknown, status = 200) {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

const co: Company = { id: 1, name: 'Nuvei', ats: 'workable', token: 'nuvei', active: true };

// Mirrors the live Nuvei widget shape verified 2026-07-20.
const WIDGET = {
  name: 'Nuvei',
  jobs: [
    {
      shortcode: 'B4A6068599',
      title: 'Accountant',
      description: '<p>Accountant&nbsp;<br>Vilnius, Lithuania</p><p>The world of payments &amp; growth.</p>',
      url: 'https://apply.workable.com/j/B4A6068599',
      application_url: 'https://apply.workable.com/j/B4A6068599/apply',
      telecommuting: false,
      published_on: '2026-06-10',
      country: 'Lithuania',
      city: 'Vilnius',
      locations: [{ country: 'Lithuania', countryCode: 'LT', city: 'Vilnius', region: 'Vilnius', hidden: false }],
    },
    {
      shortcode: 'REMOTE001',
      title: 'Senior Data Analyst',
      description: '<p>SQL, dashboards.</p>',
      url: 'https://apply.workable.com/j/REMOTE001',
      telecommuting: true,
      published_on: '2026-07-01',
      locations: [
        { country: 'Canada', city: 'Toronto', hidden: false },
        { country: 'USA', city: 'Austin', hidden: true },
      ],
    },
    { title: 'No shortcode — dropped' },
  ],
};

describe('connector workable', () => {
  it('normalizes: id=shortcode, canonical url, stripped description, date, location', async () => {
    mockFetch(WIDGET);
    const jobs = await workable.fetchJobs(co);
    expect(jobs).toHaveLength(2); // the shortcode-less job is dropped

    const acct = jobs[0]!;
    expect(acct).toMatchObject({ id: 'B4A6068599', ats: 'workable', title: 'Accountant' });
    expect(acct.url).toBe('https://apply.workable.com/j/B4A6068599');
    expect(acct.posted_at).toBe('2026-06-10');
    expect(acct.location).toBe('Vilnius, Lithuania');
    expect(acct.description).toContain('Vilnius, Lithuania');
    expect(acct.description).toContain('payments & growth'); // entities decoded, tags stripped
    expect(acct.description).not.toContain('<p>');
  });

  it('joins non-hidden locations and adds Remote when telecommuting', async () => {
    mockFetch(WIDGET);
    const jobs = await workable.fetchJobs(co);
    const remote = jobs.find((j) => j.id === 'REMOTE001')!;
    expect(remote.location).toBe('Toronto, Canada; Remote'); // Austin is hidden -> dropped
  });

  it('throws on feed HTTP error', async () => {
    mockFetch({}, 500);
    await expect(workable.fetchJobs(co)).rejects.toThrow('workable feed nuvei: HTTP 500');
  });

  it('isLive: true when shortcode present, false when gone', async () => {
    mockFetch(WIDGET);
    expect(await workable.isLive(co, { id: 'B4A6068599' } as never)).toBe(true);
    mockFetch(WIDGET);
    expect(await workable.isLive(co, { id: 'GONE999' } as never)).toBe(false);
  });
});

describe('parseAtsUrl — Workable', () => {
  it('maps apply.workable.com/{account} and {account}.workable.com', () => {
    expect(parseAtsUrl('https://apply.workable.com/nuvei/')).toEqual({ ats: 'workable', token: 'nuvei' });
    expect(parseAtsUrl('https://nuvei.workable.com/jobs/123')).toEqual({ ats: 'workable', token: 'nuvei' });
  });
  it('does not treat apply/www subdomains as accounts', () => {
    expect(parseAtsUrl('https://www.workable.com/')).toBeNull();
  });
});

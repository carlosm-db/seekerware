import { afterEach, describe, expect, it, vi } from 'vitest';
import * as lever from '../src/connectors/lever';
import * as ashby from '../src/connectors/ashby';
import * as successfactors from '../src/connectors/successfactors';
import { parseAtsUrl } from '../src/connectors/common';
import type { Company, Job } from '../src/types';

function mockText(body: string, status = 200) {
  const fn = vi.fn(async () => new Response(body, { status }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

const leverCo: Company = { id: 1, name: 'Yuno', ats: 'lever', token: 'yuno', active: true };
const ashbyCo: Company = { id: 2, name: 'Trulioo', ats: 'ashby', token: 'trulioo', active: true };

function mockFetch(body: unknown, status = 200) {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe('connector lever', () => {
  const FEED = [
    {
      id: 'abc-123',
      text: 'Payments Operations Analyst',
      hostedUrl: 'https://jobs.lever.co/yuno/abc-123?lever-origin=applied',
      createdAt: 1784000000000,
      descriptionPlain: 'Reconciliation and settlement.',
      categories: { location: 'Bogota, Colombia', allLocations: ['Bogota, Colombia', 'Remote - LATAM'] },
      workplaceType: 'remote',
      lists: [{ text: 'Requisitos', content: '<li>SQL</li><li>Excel</li>' }],
    },
  ];

  it('normalizes: date from epoch ms, combined locations, lists into text', async () => {
    mockFetch(FEED);
    const [j] = await lever.fetchJobs(leverCo);
    expect(j).toMatchObject({
      id: 'abc-123',
      ats: 'lever',
      title: 'Payments Operations Analyst',
      url: 'https://jobs.lever.co/yuno/abc-123',
    });
    expect(j!.posted_at).toBe(new Date(1784000000000).toISOString());
    expect(j!.location).toContain('Bogota');
    expect(j!.location).toContain('Remote - LATAM');
    expect(j!.description).toContain('Reconciliation');
    expect(j!.description).toContain('SQL');
  });

  it('non-array payload throws (parse_fail upstream)', async () => {
    mockFetch({ error: 'Document not found' });
    await expect(lever.fetchJobs(leverCo)).rejects.toThrow('unexpected payload');
  });

  it('isLive: 404 = dead', async () => {
    mockFetch({}, 404);
    const job = { id: 'abc-123' } as Job;
    expect(await lever.isLive(leverCo, job)).toBe(false);
  });
});

describe('connector ashby', () => {
  const BOARD = {
    jobs: [
      {
        id: 'uuid-1',
        title: 'KYC Analyst',
        location: 'Vancouver',
        secondaryLocations: [{ location: 'Toronto' }],
        isRemote: true,
        publishedAt: '2026-07-15T00:00:00Z',
        jobUrl: 'https://jobs.ashbyhq.com/trulioo/uuid-1?utm_source=x',
        descriptionHtml: '<p>Compliance &amp; identity.</p>',
        isListed: true,
      },
      {
        id: 'uuid-2',
        title: 'Hidden',
        jobUrl: 'https://jobs.ashbyhq.com/trulioo/uuid-2',
        isListed: false,
      },
    ],
  };

  it('normalizes and excludes unlisted', async () => {
    mockFetch(BOARD);
    const jobs = await ashby.fetchJobs(ashbyCo);
    expect(jobs).toHaveLength(1);
    const j = jobs[0]!;
    expect(j).toMatchObject({
      id: 'uuid-1',
      ats: 'ashby',
      url: 'https://jobs.ashbyhq.com/trulioo/uuid-1',
      posted_at: '2026-07-15T00:00:00Z',
    });
    expect(j.location).toBe('Vancouver; Toronto; Remote');
    expect(j.description).toContain('Compliance & identity.');
  });

  it('isLive checks against the re-fetched BOARD (never HTML): present=alive, absent or unlisted=dead', async () => {
    mockFetch(BOARD);
    expect(await ashby.isLive(ashbyCo, { id: 'uuid-1' } as Job)).toBe(true);
    mockFetch(BOARD);
    expect(await ashby.isLive(ashbyCo, { id: 'uuid-2' } as Job)).toBe(false);
    mockFetch(BOARD);
    expect(await ashby.isLive(ashbyCo, { id: 'no-existe' } as Job)).toBe(false);
  });
});

describe('connector successfactors', () => {
  const sfCo: Company = { id: 3, name: 'Scotiabank', ats: 'successfactors', token: 'jobs.scotiabank.com', active: true };
  const FEED = `<?xml version="1.0" encoding="UTF-8" ?><rss version="2.0" xmlns:g="http://base.google.com/ns/1.0"><channel><title></title>
<item><title>Data Analyst (Toronto, ON, CA)</title>
<description><![CDATA[&lt;p&gt;Payments &amp;amp; reconciliation&lt;/p&gt;&lt;img src=&quot;data:image/png;base64,QUJDQUJD&quot;&gt;]]></description>
<link>https://jobs.scotiabank.com/job/Data-&amp;-Analytics-123?src=rss</link>
<guid isPermaLink="false">https://jobs.scotiabank.com/job/123</guid>
<g:id>123</g:id><g:location>Toronto, ON</g:location><g:employer>Scotiabank</g:employer><g:expiration_date>2026-12-31</g:expiration_date></item>
</channel></rss>`;

  it('parses the RSS feed: title, location, canonical url, description without base64', async () => {
    mockText(FEED);
    const jobs = await successfactors.fetchJobs(sfCo);
    expect(jobs).toHaveLength(1);
    const j = jobs[0]!;
    expect(j).toMatchObject({
      id: '123',
      ats: 'successfactors',
      title: 'Data Analyst (Toronto, ON, CA)',
      location: 'Toronto, ON',
      url: 'https://jobs.scotiabank.com/job/Data-&-Analytics-123',
      posted_at: null,
    });
    expect(j.url).not.toContain('&amp;'); // link entities decoded
    expect(j.description).toContain('Payments & reconciliation');
    expect(j.description).not.toContain('QUJDQUJD'); // base64 image stripped
  });

  it('isLive: id present in the re-fetched feed = alive, absent = dead', async () => {
    mockText(FEED);
    expect(await successfactors.isLive(sfCo, { id: '123' } as Job)).toBe(true);
    mockText(FEED);
    expect(await successfactors.isLive(sfCo, { id: '999' } as Job)).toBe(false);
  });
});

describe('parseAtsUrl', () => {
  it('detects greenhouse (boards / job-boards / subdomain)', () => {
    expect(parseAtsUrl('https://boards.greenhouse.io/stripe')).toEqual({ ats: 'greenhouse', token: 'stripe' });
    expect(parseAtsUrl('https://job-boards.greenhouse.io/gitlab/jobs/123')).toEqual({ ats: 'greenhouse', token: 'gitlab' });
    expect(parseAtsUrl('https://acme.greenhouse.io/')).toEqual({ ats: 'greenhouse', token: 'acme' });
  });

  it('detects lever and ashby', () => {
    expect(parseAtsUrl('https://jobs.lever.co/dlocal')).toEqual({ ats: 'lever', token: 'dlocal' });
    expect(parseAtsUrl('https://jobs.ashbyhq.com/ramp/uuid?utm=x')).toEqual({ ats: 'ashby', token: 'ramp' });
  });

  it('returns null for unsupported hosts and junk', () => {
    expect(parseAtsUrl('https://jobs.scotiabank.com/search/?q=')).toBeNull(); // SuccessFactors
    expect(parseAtsUrl('https://acme.myworkdayjobs.com/en-US/careers')).toBeNull(); // Workday
    expect(parseAtsUrl('not a url')).toBeNull();
    expect(parseAtsUrl('https://boards.greenhouse.io/')).toBeNull(); // no token
  });
});

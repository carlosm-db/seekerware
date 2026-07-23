import { afterEach, describe, expect, it, vi } from 'vitest';
import * as lever from '../src/connectors/lever';
import * as ashby from '../src/connectors/ashby';
import * as successfactors from '../src/connectors/successfactors';
import * as workday from '../src/connectors/workday';
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

  const URLSET = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.google.com/schemas/sitemap/0.9">
<url><loc>https://empleo.grupobancolombia.com/job/Bogota-Analista-de-Datos-Senior-CO/604033/</loc><lastmod>2026-07-18</lastmod></url>
</urlset>`;

  it('parses the <urlset> flavor: url, slug title, empty description, posted_at NULL (lastmod is the sitemap date, not the job date)', async () => {
    mockText(URLSET);
    const jobs = await successfactors.fetchJobs(sfCo);
    expect(jobs).toHaveLength(1);
    const j = jobs[0]!;
    expect(j.id).toBe('604033');
    expect(j.url).toBe('https://empleo.grupobancolombia.com/job/Bogota-Analista-de-Datos-Senior-CO/604033/');
    expect(j.posted_at).toBeNull(); // <lastmod> is the sitemap regen date, unreliable per-job -> unknown
    expect(j.title.toLowerCase()).toContain('analista de datos');
    expect(j.description).toBe(''); // filled later by fetchDetail
  });

  it('fetchDetail: pulls description + clean title from the job page HTML', async () => {
    mockText('<html><head><title>x</title></head><body><h1>Analista de Datos</h1><p>SQL, Power BI, reconciliación de pagos.</p></body></html>');
    const d = await successfactors.fetchDetail(sfCo, { url: 'https://empleo.grupobancolombia.com/job/x/604033/' } as Job);
    expect(d.title).toBe('Analista de Datos');
    expect(d.description).toContain('Power BI');
  });
});

describe('connector workday', () => {
  const wdCo: Company = { id: 4, name: 'Acme', ats: 'workday', token: 'acme.wd3.myworkdayjobs.com/AcmeSite', active: true };
  const LIST = {
    total: 2,
    jobPostings: [
      { title: 'Data Analyst', externalPath: '/job/Toronto/Data-Analyst_JR1', locationsText: 'Toronto, ON', bulletFields: ['JR1'] },
      { title: 'Ops Manager', externalPath: '/job/Various/Ops-Manager_JR2', locationsText: '2 Locations', bulletFields: ['JR2'] },
    ],
  };

  it('fetchJobs: maps CxS postings; collapses "N Locations" to unknown', async () => {
    mockFetch(LIST);
    const jobs = await workday.fetchJobs(wdCo);
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      id: 'JR1', ats: 'workday', title: 'Data Analyst', location: 'Toronto, ON',
      url: 'https://acme.wd3.myworkdayjobs.com/AcmeSite/job/Toronto/Data-Analyst_JR1',
      description: '', posted_at: null,
    });
    expect(jobs[1]!.location).toBe(''); // "2 Locations" -> unknown, enriched later
  });

  it('fetchDetail: description + real date from the job detail', async () => {
    mockFetch(LIST);
    const [j] = await workday.fetchJobs(wdCo);
    mockFetch({ jobPostingInfo: { jobDescription: '<p>SQL, Power BI, payments reconciliation.</p>', startDate: '2026-07-10', title: 'Data Analyst II' } });
    const d = await workday.fetchDetail(wdCo, j!);
    expect(d.posted_at).toBe('2026-07-10');
    expect(d.title).toBe('Data Analyst II');
    expect(d.description).toContain('payments reconciliation');
  });

  it('isLive: 404 = dead, 200 = alive', async () => {
    mockFetch(LIST);
    const [j] = await workday.fetchJobs(wdCo);
    mockFetch({}, 404);
    expect(await workday.isLive(wdCo, j!)).toBe(false);
    mockFetch({});
    expect(await workday.isLive(wdCo, j!)).toBe(true);
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

  it('detects SuccessFactors jobs2web subdomains (token = host)', () => {
    expect(parseAtsUrl('https://assaabloy.jobs2web.com/search')).toEqual({ ats: 'successfactors', token: 'assaabloy.jobs2web.com' });
  });

  it('detects Workday, skipping the locale segment (token = host/site)', () => {
    expect(parseAtsUrl('https://acme.wd3.myworkdayjobs.com/en-US/AcmeSite/job/x'))
      .toEqual({ ats: 'workday', token: 'acme.wd3.myworkdayjobs.com/AcmeSite' });
  });

  it('returns null for unsupported hosts and junk', () => {
    expect(parseAtsUrl('https://jobs.scotiabank.com/search/?q=')).toBeNull(); // custom-domain SF → single-add form
    expect(parseAtsUrl('not a url')).toBeNull();
    expect(parseAtsUrl('https://boards.greenhouse.io/')).toBeNull(); // no token
  });
});

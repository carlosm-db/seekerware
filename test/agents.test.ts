import { describe, expect, it } from 'vitest';
import { jobAnalyst } from '../src/ia/agents';
import type { Env, Job } from '../src/types';

const job = (over: Partial<Job> = {}): Job => ({
  id: '1', company: 'Acme', title: 'Data Analyst', location: 'Remote', url: 'https://x.io/1',
  description: 'SQL, Power BI, payments reconciliation. Junior friendly.', posted_at: null,
  ats: 'greenhouse', raw: {}, ...over,
});

/** A doFetch that returns a Gemini generateContent envelope wrapping `payload` as JSON. */
function geminiOk(payload: unknown, spy?: (url: string) => void): typeof fetch {
  return (async (url: RequestInfo | URL) => {
    spy?.(String(url));
    return new Response(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
}

describe('jobAnalyst', () => {
  it('returns the parsed structured analysis and calls the primary model first', async () => {
    let url = '';
    const doFetch = geminiOk(
      {
        must_haves: ['SQL'], nice_to_haves: ['Power BI'], seniority: 'junior',
        domain_signals: ['payments'], positioning_angle: 'data in banking', screening_topics: ['SQL'],
      },
      (u) => { url = u; },
    );
    const r = await jobAnalyst({ GEMINI_API_KEY: 'test-key' } as unknown as Env, job(), doFetch);
    expect(r.ok).toBe(true);
    expect(r.data?.must_haves).toContain('SQL');
    expect(r.data?.seniority).toBe('junior');
    expect(url).toContain('gemini-3.5-flash'); // primary tier is tried first
  });

  it('fails (not ok) when GEMINI_API_KEY is absent — never crashes the run', async () => {
    const r = await jobAnalyst({} as unknown as Env, job(), geminiOk({}));
    expect(r.ok).toBe(false);
  });
});

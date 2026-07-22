import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunStats, atsTimeoutMs, trackedFetch } from '../src/runstats';

afterEach(() => vi.unstubAllGlobals());

describe('trackedFetch', () => {
  it('counts the subrequest and attaches an AbortSignal (timeout) to every fetch', async () => {
    let seen: RequestInit | undefined;
    const fn = vi.fn((_i: RequestInfo | URL, init?: RequestInit) => {
      seen = init;
      return Promise.resolve(new Response('ok'));
    });
    vi.stubGlobal('fetch', fn);

    const stats = new RunStats();
    await trackedFetch(stats, 20000)('https://x.io/jobs');

    expect(stats.subrequests).toBe(1);
    expect(seen?.signal).toBeInstanceOf(AbortSignal);
  });

  it('preserves a caller-provided signal instead of overriding it', async () => {
    let seen: RequestInit | undefined;
    vi.stubGlobal('fetch', vi.fn((_i: RequestInfo | URL, init?: RequestInit) => {
      seen = init;
      return Promise.resolve(new Response('ok'));
    }));

    const stats = new RunStats();
    const ctrl = new AbortController();
    await trackedFetch(stats)('https://x.io', { signal: ctrl.signal });

    expect(seen?.signal).toBe(ctrl.signal);
  });
});

describe('atsTimeoutMs', () => {
  it('a config override wins over the baked default', () => {
    expect(atsTimeoutMs({ successfactors: 40000 }, 'successfactors', 20000)).toBe(40000);
  });
  it('slow list-only ATS get the longer baked default when unconfigured', () => {
    expect(atsTimeoutMs({}, 'workday', 20000)).toBe(35000);
    expect(atsTimeoutMs({}, 'successfactors', 20000)).toBe(35000);
  });
  it('everything else falls back to the general timeout', () => {
    expect(atsTimeoutMs({}, 'greenhouse', 20000)).toBe(20000);
    expect(atsTimeoutMs({}, 'lever', 20000)).toBe(20000);
  });
});

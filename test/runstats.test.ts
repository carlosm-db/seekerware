import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunStats, trackedFetch } from '../src/runstats';

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

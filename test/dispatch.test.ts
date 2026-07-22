import { describe, expect, it, vi } from 'vitest';
import { dispatchKey, maybeDispatchPoll, triggerWorkflow } from '../src/dispatch';
import type { Env } from '../src/types';

describe('dispatchKey', () => {
  it('returns a YYYY-MM-DDTHH key inside a dispatch hour (17, 22 UTC)', () => {
    expect(dispatchKey(new Date('2026-07-22T17:03:00Z'))).toBe('2026-07-22T17');
    expect(dispatchKey(new Date('2026-07-22T22:58:00Z'))).toBe('2026-07-22T22');
  });
  it('returns null outside dispatch hours', () => {
    expect(dispatchKey(new Date('2026-07-22T16:59:00Z'))).toBeNull();
    expect(dispatchKey(new Date('2026-07-22T07:00:00Z'))).toBeNull();
  });
  it('key is stable across the whole hour (fires once per window)', () => {
    const a = dispatchKey(new Date('2026-07-22T17:00:00Z'));
    const b = dispatchKey(new Date('2026-07-22T17:55:00Z'));
    expect(a).toBe(b);
  });
});

describe('triggerWorkflow', () => {
  it('POSTs workflow_dispatch with ref=main, source=cron, and bearer auth', async () => {
    const f = vi.fn((_u: RequestInfo | URL, _i?: RequestInit) => Promise.resolve(new Response(null, { status: 204 })));
    const r = await triggerWorkflow('tok', f as unknown as typeof fetch);
    expect(r.ok).toBe(true);
    const [url, init] = f.mock.calls[0]! as [string, RequestInit];
    expect(url).toContain('/repos/carlosm-db/seekerware/actions/workflows/poll.yml/dispatches');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body as string)).toEqual({ ref: 'main', inputs: { source: 'cron' } });
  });
  it('reports failure on a non-2xx', async () => {
    const f = vi.fn(() => Promise.resolve(new Response('nope', { status: 403 })));
    const r = await triggerWorkflow('tok', f as unknown as typeof fetch);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('403');
  });
});

// Minimal in-memory Env stub: a config map behind the D1 prepare()/bind()/first()/run() shape used here.
function stubEnv(config: Record<string, string>, token: string | undefined, fired: string[]): Env {
  const db = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      return {
        bind(...v: unknown[]) { bound = v; return this; },
        async first<T>() {
          // getConfigValue: SELECT value FROM config WHERE key = ?
          const key = String(bound[0]);
          return (config[key] !== undefined ? { value: config[key] } : null) as T | null;
        },
        async run() {
          // INSERT OR REPLACE INTO config ... VALUES ('poll_dispatch_last', ?)
          if (sql.includes('poll_dispatch_last')) { config.poll_dispatch_last = String(bound[0]); fired.push(String(bound[0])); }
          return {} as unknown;
        },
      };
    },
  };
  return { DB: db as unknown as Env['DB'], GH_DISPATCH_TOKEN: token } as Env;
}

describe('maybeDispatchPoll', () => {
  const inWindow = new Date('2026-07-22T17:04:00Z');
  const okFetch = () => vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));

  it('no-ops without a token', async () => {
    const f = okFetch();
    await maybeDispatchPoll(stubEnv({}, undefined, []), f as unknown as typeof fetch);
    expect(f).not.toHaveBeenCalled();
  });

  it('fires once and claims the window; a second tick in the same window does not re-fire', async () => {
    vi.useFakeTimers(); vi.setSystemTime(inWindow);
    try {
      const config: Record<string, string> = {};
      const fired: string[] = [];
      const f = okFetch();
      await maybeDispatchPoll(stubEnv(config, 'tok', fired), f as unknown as typeof fetch);
      await maybeDispatchPoll(stubEnv(config, 'tok', fired), f as unknown as typeof fetch);
      expect(f).toHaveBeenCalledTimes(1);
      expect(config.poll_dispatch_last).toBe('2026-07-22T17');
    } finally { vi.useRealTimers(); }
  });

  it('does not claim the window when the dispatch fails (so it retries)', async () => {
    vi.useFakeTimers(); vi.setSystemTime(inWindow);
    try {
      const config: Record<string, string> = {};
      const f = vi.fn(() => Promise.resolve(new Response('nope', { status: 500 })));
      await maybeDispatchPoll(stubEnv(config, 'tok', []), f as unknown as typeof fetch);
      expect(config.poll_dispatch_last).toBeUndefined();
    } finally { vi.useRealTimers(); }
  });
});

import { describe, expect, it, vi } from 'vitest';
import { D1HttpClient } from '../src/d1-http';

// Wraps a JSON payload in a fetch-like mock so we can assert the request shape and parse the reply.
// Params are declared so mock.calls is typed as [url, init].
function mockFetch(payload: unknown, status = 200) {
  return vi.fn((_url: RequestInfo | URL, _init?: RequestInit) =>
    Promise.resolve(new Response(JSON.stringify(payload), { status })));
}
const ok = (result: unknown) => ({ success: true, errors: [], result });
const client = (f: ReturnType<typeof mockFetch>) =>
  new D1HttpClient({ accountId: 'a', databaseId: 'd', apiToken: 't', fetchImpl: f as unknown as typeof fetch });

describe('D1HttpClient', () => {
  it('first() returns the first row and sends {sql,params} to the right endpoint', async () => {
    const f = mockFetch(ok([{ results: [{ id: 7 }], meta: { rows_read: 1 }, success: true }]));
    const row = await client(f).prepare('SELECT id FROM runs WHERE x = ?').bind(1).first<{ id: number }>();
    expect(row).toEqual({ id: 7 });
    const init = f.mock.calls[0]![1]!;
    expect(f.mock.calls[0]![0]).toBe('https://api.cloudflare.com/client/v4/accounts/a/d1/database/d/query');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer t');
    expect(JSON.parse(init.body as string)).toEqual({ sql: 'SELECT id FROM runs WHERE x = ?', params: [1] });
  });

  it('first() returns null when there are no rows', async () => {
    const row = await client(mockFetch(ok([{ results: [], meta: {}, success: true }]))).prepare('SELECT 1').first();
    expect(row).toBeNull();
  });

  it('all() returns results and meta for accounting', async () => {
    const res = await client(mockFetch(ok([{ results: [{ n: 1 }, { n: 2 }], meta: { rows_read: 2 }, success: true }])))
      .prepare('SELECT n FROM t').all<{ n: number }>();
    expect(res.results).toHaveLength(2);
    expect(res.meta.rows_read).toBe(2);
  });

  it('batch() sends one {batch:[...]} body and returns a result per statement', async () => {
    const f = mockFetch(ok([
      { results: [], meta: { rows_written: 1 }, success: true },
      { results: [], meta: { rows_written: 2 }, success: true },
    ]));
    const db = client(f);
    const res = await db.batch([
      db.prepare('INSERT INTO t VALUES (?)').bind('x'),
      db.prepare('UPDATE t SET a = ?').bind(2),
    ]);
    expect(res).toHaveLength(2);
    expect(res[1]!.meta.rows_written).toBe(2);
    expect(JSON.parse(f.mock.calls[0]![1]!.body as string)).toEqual({
      batch: [
        { sql: 'INSERT INTO t VALUES (?)', params: ['x'] },
        { sql: 'UPDATE t SET a = ?', params: [2] },
      ],
    });
  });

  it('throws with the API error message on failure', async () => {
    await expect(
      client(mockFetch({ success: false, errors: [{ message: 'bad sql' }] }, 400)).prepare('NOPE').all(),
    ).rejects.toThrow(/bad sql/);
  });
});

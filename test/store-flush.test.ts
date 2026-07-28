import { describe, expect, it } from 'vitest';
import { RunBatch } from '../src/store';
import { RunStats } from '../src/runstats';
import type { Env } from '../src/types';

const NOW = '2026-07-28T17:00:00.000Z';

// Minimal in-memory D1 stub (same shape as test/dispatch.test.ts): records the size of every
// batch() chunk and every prepare().run() — the final run-row UPDATE included. `failOnChunk`
// makes one chunk throw, reproducing D1 rejecting an oversized batch.
function stubEnv(opts: { failOnChunk?: number } = {}) {
  const chunks: number[] = [];
  const ran: Array<{ sql: string; params: unknown[] }> = [];
  let chunkIndex = 0;
  const db = {
    prepare(sql: string) {
      let params: unknown[] = [];
      const stmt = {
        sql,
        bind(...v: unknown[]) {
          params = v;
          return stmt;
        },
        async run() {
          ran.push({ sql, params });
          return { results: [], meta: {}, success: true };
        },
        async first() {
          return null;
        },
      };
      return stmt;
    },
    async batch(statements: unknown[]) {
      const i = chunkIndex++;
      chunks.push(statements.length);
      if (opts.failOnChunk === i) throw new Error('D1 REST 413: request body too large');
      return statements.map(() => ({ results: [], meta: { rows_read: 1, rows_written: 2 }, success: true }));
    },
  };
  return { env: { DB: db as unknown as Env['DB'] } as Env, chunks, ran };
}

/** The single `UPDATE runs SET ...` that closes the run row. */
function runClose(ran: Array<{ sql: string; params: unknown[] }>) {
  return ran.find((r) => r.sql.includes('UPDATE runs SET'));
}

describe('RunBatch.flush — chunking', () => {
  it('splits the queued writes into batches of FLUSH_CHUNK and accumulates every chunk meta', async () => {
    const { env, chunks, ran } = stubEnv();
    const batch = new RunBatch(env);
    const stats = new RunStats();
    batch.closeJobs(
      Array.from({ length: 450 }, (_, i) => `hash-${i}`),
      NOW,
    );

    await batch.flush(1, stats, 'ok', NOW, Date.now());

    expect(chunks).toEqual([200, 200, 50]); // never ONE oversized batch
    expect(stats.d1Reads).toBe(450); // meta of EVERY chunk, not just the last
    expect(stats.d1Writes).toBe(900);
    expect(runClose(ran)?.params[1]).toBe('ok');
  });

  it('closes the run row without a batch when nothing was queued', async () => {
    const { env, chunks, ran } = stubEnv();
    await new RunBatch(env).flush(7, new RunStats(), 'ok', NOW, Date.now());

    expect(chunks).toEqual([]);
    expect(runClose(ran)?.params.at(-1)).toBe(7);
  });

  it('drops the queued statements so a reused batch cannot double-write', async () => {
    const { env, chunks } = stubEnv();
    const batch = new RunBatch(env);
    batch.closeJobs(['a', 'b'], NOW);

    await batch.flush(1, new RunStats(), 'ok', NOW, Date.now());
    await batch.flush(1, new RunStats(), 'ok', NOW, Date.now());

    expect(chunks).toEqual([2]);
  });
});

describe('RunBatch.flush — a failing flush is data, not silence', () => {
  it('still closes the run row as `fail` with the D1 error, then rethrows', async () => {
    const { env, chunks, ran } = stubEnv({ failOnChunk: 1 });
    const batch = new RunBatch(env);
    const stats = new RunStats();
    stats.companiesTotal = 204;
    batch.closeJobs(
      Array.from({ length: 300 }, (_, i) => `hash-${i}`),
      NOW,
    );

    await expect(batch.flush(18, stats, 'ok', NOW, Date.now())).rejects.toThrow(/request body too large/);

    expect(chunks).toEqual([200, 100]); // it died on the second chunk
    const close = runClose(ran);
    expect(close).toBeDefined();
    expect(close?.params[1]).toBe('fail'); // NOT left 'running' for the orphan sweep to guess at
    expect(close?.params[16]).toBe(1); // errors: the flush failure counts as one
    expect(String(close?.params[17])).toContain('flush_fail: D1 REST 413');
    expect(close?.params.at(-1)).toBe(18);
  });
});

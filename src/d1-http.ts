// D1 over the Cloudflare REST API — lets the pipeline (written against the Worker's D1 binding)
// run unchanged in Node (the GitHub Actions poller, scripts/poll.ts). Only the subset the pipeline
// uses is implemented: prepare().bind().first()/.all()/.run() and batch().
// Endpoint: POST /accounts/{account_id}/d1/database/{database_id}/query
//   body { sql, params } | { batch: [{ sql, params }] }  ·  Authorization: Bearer <token>
//   response: { success, errors, result: [{ results, meta:{rows_read,rows_written,...}, success }] }

export interface D1HttpConfig {
  accountId: string;
  databaseId: string;
  apiToken: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

interface RestMeta {
  rows_read?: number;
  rows_written?: number;
  last_row_id?: number;
  changes?: number;
}
interface RestResult<T> {
  results: T[];
  meta: RestMeta;
  success: boolean;
}

/** Mirrors the fraction of D1PreparedStatement the pipeline calls. */
class D1HttpStatement {
  private boundParams: unknown[] = [];

  constructor(private readonly client: D1HttpClient, readonly sql: string) {}

  bind(...values: unknown[]): this {
    this.boundParams = values;
    return this;
  }

  /** Read by D1HttpClient.batch() to serialize this statement. */
  get params(): unknown[] {
    return this.boundParams;
  }

  async first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
    const res = await this.client.runOne<Record<string, unknown>>(this.sql, this.boundParams);
    const row = res.results[0];
    if (row == null) return null;
    return colName === undefined ? (row as unknown as T) : (row[colName] as T);
  }

  async all<T = Record<string, unknown>>(): Promise<RestResult<T>> {
    return this.client.runOne<T>(this.sql, this.boundParams);
  }

  async run<T = Record<string, unknown>>(): Promise<RestResult<T>> {
    return this.client.runOne<T>(this.sql, this.boundParams);
  }
}

export class D1HttpClient {
  private readonly endpoint: string;
  private readonly apiToken: string;
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: D1HttpConfig) {
    this.endpoint = `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/d1/database/${cfg.databaseId}/query`;
    this.apiToken = cfg.apiToken;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  prepare(sql: string): D1HttpStatement {
    return new D1HttpStatement(this, sql);
  }

  async batch<T = Record<string, unknown>>(statements: D1HttpStatement[]): Promise<RestResult<T>[]> {
    if (!statements.length) return [];
    const batch = statements.map((s) => ({ sql: s.sql, params: s.params }));
    return this.request<T>({ batch });
  }

  async runOne<T>(sql: string, params: unknown[]): Promise<RestResult<T>> {
    const out = await this.request<T>({ sql, params });
    return out[0] ?? { results: [], meta: {}, success: true };
  }

  private async request<T>(body: unknown): Promise<RestResult<T>[]> {
    const res = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as {
      success: boolean;
      errors?: Array<{ code?: number; message: string }>;
      result?: RestResult<T>[];
    };
    if (!res.ok || !json.success) {
      const msg = json.errors?.map((e) => e.message).join('; ') || `HTTP ${res.status}`;
      throw new Error(`D1 REST ${res.status}: ${msg}`);
    }
    return json.result ?? [];
  }
}

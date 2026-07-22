// GitHub Actions poller: runs the full Seekerware pipeline in Node (no Worker 10 ms CPU limit),
// covering every active company each run. Writes to D1 via the REST adapter and delivers
// notifications through the Worker's /api/notify (so the Telegram token stays in Cloudflare).
// Run: `npx tsx scripts/poll.ts` (see .github/workflows/poll.yml). Not part of tsconfig — tsx
// transpiles it at runtime; the substantive code it imports (src/*) is typechecked normally.
import { runPipeline } from '../src/pipeline';
import { D1HttpClient } from '../src/d1-http';
import type { Env } from '../src/types';

declare const process: {
  env: Record<string, string | undefined>;
  exit(code: number): never;
};

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env: ${name}`);
  return v;
}

async function main(): Promise<void> {
  const db = new D1HttpClient({
    accountId: required('CLOUDFLARE_ACCOUNT_ID'),
    databaseId: required('D1_DATABASE_ID'),
    apiToken: required('CLOUDFLARE_API_TOKEN'),
  });
  const env = {
    DB: db as unknown as Env['DB'],
    WORKER_URL: required('WORKER_URL'),
    WORKER_TOKEN: required('WORKER_API_TOKEN'),
  } as Env;

  // Honest trigger: GitHub sets GITHUB_EVENT_NAME to 'schedule' for the cron and 'workflow_dispatch'
  // for a manual run — record it so the console doesn't label every manual run as "cron".
  const trigger = process.env.GITHUB_EVENT_NAME === 'schedule' ? 'cron' : 'manual';
  const stats = await runPipeline(env, trigger);
  console.log(
    `poll: ${stats.companiesOk}/${stats.companiesTotal} companies OK · ${stats.jobsNew} new · ` +
      `${stats.survivors} survivors · ${stats.notified} notified · ${stats.closed} closed · ${stats.errors} errors`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});

// Canonical glossary types (docs/CONVENTIONS.md §1).

export type Ats = 'greenhouse' | 'lever' | 'ashby' | 'successfactors' | 'workday' | 'workable' | 'smartrecruiters' | 'bamboohr' | 'elempleo';

export type Verdict = 'Apply' | 'Stretch-worth-it' | 'Skip';

/** Company to watch (row of the `companies` table). */
export interface Company {
  id: number;
  name: string;
  ats: Ats;
  token: string;
  active: boolean;
}

/** Normalized job returned by every connector. */
export interface Job {
  /** External ID of the job in the ATS. */
  id: string;
  company: string;
  title: string;
  location: string;
  url: string;
  description: string;
  /** ISO 8601, or null if the feed carries no reliable date. */
  posted_at: string | null;
  ats: Ats;
  raw: unknown;
}

/** Worker bindings and secrets. */
export interface Env {
  DB: D1Database;
  /** Worker secret: protects the whole fetch() until cookie login (step 4). */
  API_TOKEN?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  GEMINI_API_KEY?: string;
  /** Full JSON of the GCP service account (step 6). */
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
  GOOGLE_OAUTH_REFRESH_TOKEN?: string;
  DRIVE_FOLDER_ID?: string;
  CV_TEMPLATE_DOC_ID?: string;
  /** Secret path segment of the Telegram webhook (step 8 two-way bot). */
  TELEGRAM_WEBHOOK_TOKEN?: string;
  /** Poller only (scripts/poll.ts): base URL of the Worker, to POST /api/notify. */
  WORKER_URL?: string;
  /** Poller only: the Worker's API_TOKEN value, sent as Bearer to /api/notify. */
  WORKER_TOKEN?: string;
  /** Worker secret: fine-grained GitHub PAT (Actions RW) to fire the poll Action via workflow_dispatch. */
  GH_DISPATCH_TOKEN?: string;
}

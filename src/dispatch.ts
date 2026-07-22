// Reliable poll trigger: the Worker's scheduled() (Cloudflare cron, reliable) fires the GitHub poll
// Action via workflow_dispatch at the dispatch windows. GitHub's own schedule cron proved unreliable
// (never fired for this repo), so Cloudflare is the single source of truth for timing.

import type { Env } from './types';
import { getConfigValue } from './store';
import { formatMaintenance, sendTelegram } from './notify';

export const DISPATCH_HOURS_UTC = [17, 22]; // noon & 17:00 America/Bogota (UTC-5, no DST)
export const GH_REPO = 'carlosm-db/seekerware';
export const GH_WORKFLOW = 'poll.yml';

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * The per-hour claim key if `now` falls in a dispatch window, else null. YYYY-MM-DDTHH so a window is
 * fired exactly once even though the cron ticks every 5 min (and a missed :00 still fires at :05).
 */
export function dispatchKey(now: Date, hoursUtc: number[] = DISPATCH_HOURS_UTC): string | null {
  return hoursUtc.includes(now.getUTCHours()) ? now.toISOString().slice(0, 13) : null;
}

/** POSTs a workflow_dispatch for poll.yml (source=cron → the run labels itself 'cron', not 'manual'). */
export async function triggerWorkflow(token: string, doFetch: Fetcher = fetch): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await doFetch(`https://api.github.com/repos/${GH_REPO}/actions/workflows/${GH_WORKFLOW}/dispatches`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'seekerware',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ref: 'main', inputs: { source: 'cron' } }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, error: `HTTP ${res.status}${body ? `: ${body.slice(0, 120)}` : ''}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'network error' };
  }
}

/**
 * Called on every cron tick: if we're in a dispatch window and haven't fired it yet, trigger the poll
 * Action and claim the window. No-op without a token (setup gate). The claim is written only on success,
 * so a failed dispatch retries next tick; a failure also raises a Telegram maintenance alert so a broken
 * trigger can't fail silently.
 */
export async function maybeDispatchPoll(env: Env, doFetch: Fetcher = fetch): Promise<void> {
  if (!env.GH_DISPATCH_TOKEN) return; // secret not set → polling paused until the owner adds it
  const key = dispatchKey(new Date());
  if (!key) return; // outside a dispatch window
  if ((await getConfigValue(env, 'poll_dispatch_last')) === key) return; // already fired this window

  const sent = await triggerWorkflow(env.GH_DISPATCH_TOKEN, doFetch);
  if (sent.ok) {
    await env.DB.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('poll_dispatch_last', ?)")
      .bind(key).run();
    console.log(`dispatch: poll triggered for window ${key}`);
  } else {
    console.log(`dispatch: FAILED for window ${key}: ${sent.error}`);
    await sendTelegram(env, formatMaintenance(`poll dispatch failed (${key}): ${sent.error}`), doFetch);
  }
}

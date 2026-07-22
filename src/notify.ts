// Telegram (docs/UI.md §1): one message per notified job, parse mode HTML.
// No personal data of the user; only job data.

import type { Env, Job, Verdict } from './types';
import type { ScoreResult } from './scoring';

const API = 'https://api.telegram.org';

export interface TelegramResult {
  ok: boolean;
  message_id?: number;
  error?: string;
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export async function sendTelegram(
  env: Env,
  text: string,
  doFetch: Fetcher = fetch,
  replyMarkup?: unknown,
): Promise<TelegramResult> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    return { ok: false, error: 'TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not configured' };
  }
  try {
    const res = await doFetch(`${API}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      }),
    });
    const body = (await res.json()) as { ok: boolean; result?: { message_id: number }; description?: string };
    if (!body.ok) return { ok: false, error: body.description ?? `HTTP ${res.status}` };
    return { ok: true, message_id: body.result?.message_id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'network error' };
  }
}

export interface NotifyPayload {
  /** Pre-formatted message text (built with the formatters below). */
  text: string;
  /** Job url_hash — present only for job notifications; the Worker attaches the kit buttons. */
  hash?: string;
  kind: 'job' | 'maintenance' | 'digest';
}

/**
 * Poller path (scripts/poll.ts): send a notification THROUGH the Worker's /api/notify instead of
 * calling Telegram directly, so TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID stay in Cloudflare and are
 * never copied into GitHub Actions. The Worker formats buttons + calls sendTelegram, and returns
 * the same TelegramResult shape (message_id) so the run records it exactly as before.
 */
export async function notifyViaWorker(
  env: Env,
  payload: NotifyPayload,
  doFetch: Fetcher = fetch,
): Promise<TelegramResult> {
  if (!env.WORKER_URL || !env.WORKER_TOKEN) {
    return { ok: false, error: 'WORKER_URL/WORKER_TOKEN not configured' };
  }
  try {
    const res = await doFetch(`${env.WORKER_URL.replace(/\/$/, '')}/api/notify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.WORKER_TOKEN}` },
      body: JSON.stringify(payload),
    });
    const body = (await res.json()) as TelegramResult;
    if (!res.ok || !body.ok) return { ok: false, error: body.error ?? `HTTP ${res.status}` };
    return body;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'network error' };
  }
}

/** Escapes third-party content for parse_mode HTML (job titles are untrusted text). */
export function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export interface JobMessageInput {
  job: Job;
  verdict: Verdict;
  track: string;
  score: number;
  ageDays: number;
  whyItFits: string;
  gapToAddress: string;
  positioningLead: string;
  ruleBased: boolean;
}

/** UI.md §1 format (buttons and CV arrive in steps 6/8; missing lines are omitted). */
export function formatJobMessage(m: JobMessageInput): string {
  const t = escapeHtml(m.job.title);
  const c = escapeHtml(m.job.company);
  const loc = escapeHtml(m.job.location || 'no location');
  const age = m.ageDays < 1 ? 'today' : `${Math.round(m.ageDays)} d ago`;
  const mark = m.ruleBased ? ' <i>(rule-based)</i>' : '';
  return [
    `🎯 <b>${t}</b> — ${c}`,
    `📍 ${loc} · 🏷 ${escapeHtml(m.track)} · ⏱ posted ${age}`,
    '',
    `Verdict: <b>${m.verdict}</b> · Score ${m.score}/100`,
    '',
    `<b>Why it fits:</b> ${escapeHtml(m.whyItFits)}${mark}`,
    `<b>Gap to address:</b> ${escapeHtml(m.gapToAddress)}`,
    `<b>Positioning:</b> ${escapeHtml(m.positioningLead)}`,
    '',
    `🔗 ${m.job.url}`,
  ].join('\n');
}

export function formatMaintenance(detail: string): string {
  return `⚠️ MAINTENANCE\n${escapeHtml(detail)}`;
}

export interface DigestData {
  runsTotal: number;
  runsOk: number;
  seen: number;
  newJobs: number;
  survivors: number;
  notified: number;
  applied: number;
  topCompany: string | null;
  failing: number;
}

/** Weekly Monday digest (UI.md §1): compact funnel summary. */
export function formatDigest(d: DigestData): string {
  const lines = [
    '📊 <b>Seekerware week</b>',
    `runs: ${d.runsOk}/${d.runsTotal} OK · seen ${d.seen} · new ${d.newJobs}`,
    // Plain personal count — never a quota/ratio (owner decision 2026-07-18).
    `survivors ${d.survivors} · notified ${d.notified} · applied <b>${d.applied}</b>`,
  ];
  if (d.topCompany) lines.push(`top company: ${escapeHtml(d.topCompany)}`);
  if (d.failing > 0) lines.push(`⚠️ ${d.failing} company(ies) failing — check /companies`);
  return lines.join('\n');
}

/** Rule-based texts (TRD §3.5): templates from the triggered categories; the enricher arrives in step 6. */
export function ruleBasedTexts(result: ScoreResult): {
  whyItFits: string;
  gapToAddress: string;
  positioningLead: string;
} {
  const cats: Array<[string, string]> = [
    ['domain', 'domain'],
    ['role_type', 'role type'],
    ['tool_overlap', 'tools'],
    ['level_fit', 'level'],
  ];
  const strong: string[] = [];
  let weakest: { label: string; points: number } | null = null;
  for (const [key, label] of cats) {
    const b = result.breakdown[key as keyof typeof result.breakdown];
    const top = b.matches.filter((x) => x.weight > 0).slice(0, 3).map((x) => x.term);
    if (top.length) strong.push(`${label}: ${top.join(', ')}`);
    if (!weakest || b.points < weakest.points) weakest = { label, points: b.points };
  }
  const lead = strong[0] ?? 'general profile';
  return {
    whyItFits: strong.slice(0, 3).join(' · ') || 'general profile match',
    gapToAddress: weakest ? `weak signals in ${weakest.label} — reinforce in the application` : '—',
    positioningLead: `lead with ${lead}`,
  };
}

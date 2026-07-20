// Two-way Telegram bot (step 8, ratified L1 design): inline buttons on job
// notifications ("Prepare" / "I applied" / "Dismiss") and a one-question-at-a-time chat
// flow for red questions. The bot never submits anything anywhere; owner
// replies become DRAFT answers the owner approves in the console before reuse.

import type { Env } from './types';
import { escapeHtml, sendTelegram } from './notify';
import { normalizeQuestion, type MatchedAnswer } from './kit/questions';

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const API = 'https://api.telegram.org';

/** Inline keyboard for a job notification (callback_data ≤ 64 bytes → hash prefix). */
export function kitButtons(urlHash: string): unknown {
  const p = urlHash.slice(0, 32);
  return {
    inline_keyboard: [[
      { text: '🛠 Prepare', callback_data: `p:${p}` },
      { text: '✅ I applied', callback_data: `a:${p}` },
      { text: '🗑 Dismiss', callback_data: `d:${p}` },
    ]],
  };
}

interface TgUpdate {
  callback_query?: {
    id: string;
    data?: string;
    message?: { chat?: { id?: number } };
  };
  message?: { text?: string; chat?: { id?: number } };
}

interface PendingQuestion {
  url_hash: string;
  question: string;
  remaining: string[];
}

async function answerCallback(env: Env, id: string, text: string, doFetch: Fetcher): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  await doFetch(`${API}/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callback_query_id: id, text: text.slice(0, 190) }),
  });
}

async function resolveHash(env: Env, prefix: string): Promise<string | null> {
  if (!/^[0-9a-f]{8,64}$/.test(prefix)) return null;
  const rows = (
    await env.DB.prepare("SELECT url_hash FROM jobs WHERE url_hash LIKE ? || '%' LIMIT 2")
      .bind(prefix).all<{ url_hash: string }>()
  ).results;
  return rows.length === 1 ? rows[0]!.url_hash : null;
}

interface KitRow {
  answers: string | null;
  red_questions: string | null;
  eeoc_questions: string | null;
  positioning: string | null;
  cv_doc_url: string | null;
  deep_link: string | null;
}

function formatKitMessage(title: string, company: string, kit: KitRow): string {
  const answers = JSON.parse(kit.answers ?? '[]') as MatchedAnswer[];
  const red = JSON.parse(kit.red_questions ?? '[]') as string[];
  const eeoc = JSON.parse(kit.eeoc_questions ?? '[]') as string[];
  const pos = JSON.parse(kit.positioning ?? '{}') as { why_it_fits?: string; positioning_lead?: string };
  const lines = [
    `📋 <b>Kit — ${escapeHtml(title)}</b> @ ${escapeHtml(company)}`,
    kit.cv_doc_url ? `📄 CV: ${kit.cv_doc_url}` : '📄 CV: not built yet (build retrying — check the job page)',
    pos.why_it_fits ? `<b>Why it fits:</b> ${escapeHtml(pos.why_it_fits)}` : '',
    pos.positioning_lead ? `<b>Positioning:</b> ${escapeHtml(pos.positioning_lead)}` : '',
  ];
  const matched = answers.filter((a) => !a.red);
  if (matched.length) {
    lines.push('', `<b>Matched answers (${matched.length}):</b>`);
    for (const a of matched.slice(0, 6)) {
      lines.push(`• ${escapeHtml(a.question.slice(0, 80))} → ${escapeHtml(String(a.answer ?? '').slice(0, 120))}`);
    }
  }
  if (red.length) {
    lines.push('', `<b>🔴 Unanswered (${red.length}):</b>`);
    for (const q of red.slice(0, 8)) lines.push(`• ${escapeHtml(q.slice(0, 100))}`);
  }
  if (eeoc.length) {
    lines.push('', `⚖️ ${eeoc.length} EEOC/demographic question(s) — never auto-answered; decide on the form.`);
  }
  if (kit.deep_link) lines.push('', `🔗 ${kit.deep_link}`);
  lines.push('', 'The submit click is always yours.');
  return lines.filter((l) => l !== '').join('\n').slice(0, 4000);
}

/** Entry point for POST /tg/:token updates. Chat-guarded; errors are swallowed into events. */
export async function handleTelegramUpdate(
  env: Env, update: TgUpdate, doFetch: Fetcher = fetch, waitUntil?: (p: Promise<unknown>) => void,
): Promise<void> {
  const chatId = update.callback_query?.message?.chat?.id ?? update.message?.chat?.id;
  if (!chatId || String(chatId) !== String(env.TELEGRAM_CHAT_ID ?? '')) return; // foreign chat: ignore silently

  // ---- Buttons ----
  const cb = update.callback_query;
  if (cb?.data) {
    const [kind, prefix] = cb.data.split(':') as [string, string?];
    const hash = prefix ? await resolveHash(env, prefix) : null;
    if (!hash) { await answerCallback(env, cb.id, 'job not found', doFetch); return; }

    if (kind === 'a') {
      const nowIso = new Date().toISOString();
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO applications (url_hash, stage, applied_at, updated_at) VALUES (?, 'applied', ?, ?)
           ON CONFLICT(url_hash) DO UPDATE SET stage='applied', applied_at=excluded.applied_at, updated_at=excluded.updated_at`,
        ).bind(hash, nowIso, nowIso),
        env.DB.prepare("INSERT INTO job_events (url_hash, ts, actor, event, detail) VALUES (?,?,?,?,?)")
          .bind(hash, nowIso, 'user', 'applied', 'marked applied via Telegram'),
      ]);
      await answerCallback(env, cb.id, 'Marked applied ✓', doFetch);
      return;
    }

    if (kind === 'd') {
      const nowIso = new Date().toISOString();
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO applications (url_hash, stage, updated_at) VALUES (?, 'dismissed', ?)
           ON CONFLICT(url_hash) DO UPDATE SET stage='dismissed', updated_at=excluded.updated_at`,
        ).bind(hash, nowIso),
        env.DB.prepare("INSERT INTO job_events (url_hash, ts, actor, event, detail) VALUES (?,?,?,?,?)")
          .bind(hash, nowIso, 'user', 'dismissed', 'dismissed via Telegram'),
      ]);
      await answerCallback(env, cb.id, 'Dismissed', doFetch);
      return;
    }

    if (kind === 'p') {
      // Prepare via Telegram = build the kit (Q&A) NOW and QUEUE the CV. A Telegram webhook
      // can't block ~30s, so we do NOT build the CV here (waitUntil gets killed mid-PDF — the
      // regression reverted in the console). Instead mark cv_pending=1 ("the order") and the
      // 15-min tick builds it reliably. The kit build is fast + safe in waitUntil. Submit stays
      // the owner's (§7.8).
      await answerCallback(env, cb.id, 'Armando Q&A… el CV queda en cola ⏳', doFetch);
      const finish = (async () => {
        const { buildKit } = await import('./kit/kit');
        const preparedIso = new Date().toISOString();
        await env.DB.batch([
          env.DB.prepare(
            `INSERT INTO applications (url_hash, stage, updated_at) VALUES (?, 'prepared', ?)
             ON CONFLICT(url_hash) DO UPDATE SET stage='prepared', updated_at=excluded.updated_at`,
          ).bind(hash, preparedIso),
          env.DB.prepare('UPDATE jobs SET cv_pending = 1 WHERE url_hash = ?').bind(hash),
          env.DB.prepare('INSERT INTO job_events (url_hash, ts, actor, event, detail) VALUES (?,?,?,?,?)')
            .bind(hash, preparedIso, 'user', 'stage:prepared', 'prepare via Telegram (kit; CV queued)'),
        ]);
        await buildKit(env, hash, doFetch);
        const kit = await env.DB.prepare(
          'SELECT answers, red_questions, eeoc_questions, positioning, cv_doc_url, deep_link FROM application_kits WHERE url_hash = ?',
        ).bind(hash).first<KitRow>();
        const j = await env.DB.prepare(
          'SELECT j.title, c.name company FROM jobs j JOIN companies c ON c.id = j.company_id WHERE j.url_hash = ?',
        ).bind(hash).first<{ title: string; company: string }>();
        if (!kit || !j) { await sendTelegram(env, '⚠️ Prepare failed — open the job in the console.', doFetch); return; }
        await sendTelegram(env, formatKitMessage(j.title, j.company, kit), doFetch);
        const red = JSON.parse(kit.red_questions ?? '[]') as string[];
        if (red.length) {
          const pending: PendingQuestion = { url_hash: hash, question: red[0]!, remaining: red.slice(1) };
          await env.DB.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('tg_pending', ?)")
            .bind(JSON.stringify(pending)).run();
          await sendTelegram(env, `❓ Reply here to answer:\n<b>${escapeHtml(red[0]!)}</b>`, doFetch);
        }
      })();
      if (waitUntil) waitUntil(finish); else await finish;
      return;
    }
    await answerCallback(env, cb.id, 'unknown action', doFetch);
    return;
  }

  // ---- Text replies: one-question-at-a-time red-question flow ----
  const text = update.message?.text?.trim();
  if (!text) return;
  const pendingRow = await env.DB.prepare("SELECT value FROM config WHERE key='tg_pending'").first<{ value: string }>();
  if (!pendingRow) {
    await sendTelegram(env, 'No question is pending. Tap 🛠 Prepare on a job notification to start.', doFetch);
    return;
  }
  const pending = JSON.parse(pendingRow.value) as PendingQuestion;
  const nowIso = new Date().toISOString();

  // Attach the answer to the kit and save it as a DRAFT Q&A answer (the owner
  // approves it in the console before it is ever reused automatically).
  const kit = await env.DB.prepare('SELECT answers FROM application_kits WHERE url_hash = ?')
    .bind(pending.url_hash).first<{ answers: string | null }>();
  const answers = JSON.parse(kit?.answers ?? '[]') as MatchedAnswer[];
  for (const a of answers) {
    if (a.question === pending.question) { a.answer = text; a.source = 'chat'; a.red = false; }
  }
  const stillRed = answers.filter((a) => a.red).map((a) => a.question);
  await env.DB.batch([
    env.DB.prepare('UPDATE application_kits SET answers = ?, red_questions = ?, updated_at = ? WHERE url_hash = ?')
      .bind(JSON.stringify(answers), JSON.stringify(stillRed), nowIso, pending.url_hash),
    env.DB.prepare(
      `INSERT INTO profile_answers (question_norm, question_label, answer_en, status, updated_at)
       VALUES (?,?,?,'draft',?)
       ON CONFLICT(question_norm) DO NOTHING`,
    ).bind(normalizeQuestion(pending.question), pending.question, text, nowIso),
    env.DB.prepare('INSERT INTO job_events (url_hash, ts, actor, event, detail) VALUES (?,?,?,?,?)')
      .bind(pending.url_hash, nowIso, 'user', 'kit_answer', pending.question.slice(0, 120)),
  ]);

  if (pending.remaining.length) {
    const next: PendingQuestion = {
      url_hash: pending.url_hash, question: pending.remaining[0]!, remaining: pending.remaining.slice(1),
    };
    await env.DB.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('tg_pending', ?)")
      .bind(JSON.stringify(next)).run();
    await sendTelegram(env, `Saved ✓ (draft in Q&A)\n\n❓ Next:\n<b>${escapeHtml(next.question)}</b>`, doFetch);
  } else {
    await env.DB.prepare("DELETE FROM config WHERE key='tg_pending'").run();
    await sendTelegram(env, 'Saved ✓ — all red questions answered. The kit is ready on the job page; review draft answers under Q&A to reuse them.', doFetch);
  }
}

// Telegram (docs/UI.md §1): un mensaje por job notificado, parse mode HTML.
// Sin datos personales del usuario; solo datos del job.

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
): Promise<TelegramResult> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    return { ok: false, error: 'TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID sin configurar' };
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
      }),
    });
    const body = (await res.json()) as { ok: boolean; result?: { message_id: number }; description?: string };
    if (!body.ok) return { ok: false, error: body.description ?? `HTTP ${res.status}` };
    return { ok: true, message_id: body.result?.message_id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'error de red' };
  }
}

/** Escapa contenido de terceros para parse_mode HTML (titulos de jobs son texto no confiable). */
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

/** Formato de UI.md §1 (botones y CV llegan en pasos 6/8; las lineas ausentes se omiten). */
export function formatJobMessage(m: JobMessageInput): string {
  const t = escapeHtml(m.job.title);
  const c = escapeHtml(m.job.company);
  const loc = escapeHtml(m.job.location || 'sin ubicacion');
  const age = m.ageDays < 1 ? 'hoy' : `hace ${Math.round(m.ageDays)} d`;
  const mark = m.ruleBased ? ' <i>(rule-based)</i>' : '';
  return [
    `🎯 <b>${t}</b> — ${c}`,
    `📍 ${loc} · 🏷 ${escapeHtml(m.track)} · ⏱ publicado ${age}`,
    '',
    `Verdict: <b>${m.verdict}</b> · Score ${m.score}/100`,
    '',
    `<b>Por que encaja:</b> ${escapeHtml(m.whyItFits)}${mark}`,
    `<b>Brecha a mitigar:</b> ${escapeHtml(m.gapToAddress)}`,
    `<b>Posicionamiento:</b> ${escapeHtml(m.positioningLead)}`,
    '',
    `🔗 ${m.job.url}`,
  ].join('\n');
}

export function formatMaintenance(detail: string): string {
  return `⚠️ MANTENIMIENTO\n${escapeHtml(detail)}`;
}

/** Textos rule-based (TRD §3.5): plantillas desde las categorias disparadas; el enricher llega en paso 6. */
export function ruleBasedTexts(result: ScoreResult): {
  whyItFits: string;
  gapToAddress: string;
  positioningLead: string;
} {
  const cats: Array<[string, string]> = [
    ['domain', 'dominio'],
    ['role_type', 'tipo de rol'],
    ['tool_overlap', 'herramientas'],
    ['level_fit', 'nivel'],
  ];
  const strong: string[] = [];
  let weakest: { label: string; points: number } | null = null;
  for (const [key, label] of cats) {
    const b = result.breakdown[key as keyof typeof result.breakdown];
    const top = b.matches.filter((x) => x.weight > 0).slice(0, 3).map((x) => x.term);
    if (top.length) strong.push(`${label}: ${top.join(', ')}`);
    if (!weakest || b.points < weakest.points) weakest = { label, points: b.points };
  }
  const lead = strong[0] ?? 'perfil general';
  return {
    whyItFits: strong.slice(0, 3).join(' · ') || 'coincidencia general de perfil',
    gapToAddress: weakest ? `senales debiles en ${weakest.label} — reforzar en la aplicacion` : '—',
    positioningLead: `abrir por ${lead}`,
  };
}

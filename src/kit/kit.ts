// Application-kit assembly (step 8, ratified L1): CV artifacts + rule-based
// positioning inputs + matched answers from the APPROVED Q&A + red questions
// + deep link. The kit prepares; the human submits. Zero AI in this module.

import type { Ats, Env, Job } from '../types';
import { detectQuestions, matchAnswers, type AnswerRow, type MatchedAnswer } from './questions';
import { answerPolisher, type RoleAnalysis } from '../ia/agents';

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface KitResult {
  ok: boolean;
  matched: number;
  red: number;
  eeoc: number;
  detectable: boolean;
  error?: string;
}

/** Builds (or rebuilds) the kit for one job and upserts application_kits. */
export async function buildKit(env: Env, urlHash: string, doFetch: Fetcher = fetch): Promise<KitResult> {
  const j = await env.DB.prepare(
    `SELECT j.url_hash, j.ats, j.ext_id, j.url, j.why_it_fits, j.positioning_lead,
            j.cv_doc_url, j.cv_pdf_key, c.token
     FROM jobs j JOIN companies c ON c.id = j.company_id WHERE j.url_hash = ?`,
  ).bind(urlHash).first<Record<string, string | null>>();
  if (!j) return { ok: false, matched: 0, red: 0, eeoc: 0, detectable: false, error: 'job not found' };

  let questions: string[] = [];
  let eeoc: string[] = [];
  let detectable = false;
  let detectError: string | undefined;
  try {
    const det = await detectQuestions(
      (j.ats ?? 'greenhouse') as Ats, String(j.token ?? ''), String(j.ext_id ?? ''), doFetch,
    );
    questions = det.questions;
    eeoc = det.eeoc;
    detectable = det.detectable;
  } catch (err) {
    detectError = err instanceof Error ? err.message : 'question detection failed';
  }

  const bank = (
    await env.DB.prepare(
      "SELECT id, question_norm, question_label, answer_en FROM profile_answers WHERE status = 'approved'",
    ).all<AnswerRow>()
  ).results;
  const answers: MatchedAnswer[] = matchAnswers(questions, bank);
  const red = answers.filter((a) => a.red).map((a) => a.question);

  const nowIso = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO application_kits (url_hash, positioning, answers, red_questions, eeoc_questions,
         cv_doc_url, cv_pdf_id, deep_link, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(url_hash) DO UPDATE SET positioning=excluded.positioning, answers=excluded.answers,
         red_questions=excluded.red_questions, eeoc_questions=excluded.eeoc_questions,
         cv_doc_url=excluded.cv_doc_url, cv_pdf_id=excluded.cv_pdf_id,
         deep_link=excluded.deep_link, updated_at=excluded.updated_at`,
    ).bind(
      urlHash,
      JSON.stringify({ why_it_fits: j.why_it_fits, positioning_lead: j.positioning_lead }),
      JSON.stringify(answers),
      JSON.stringify(red),
      JSON.stringify(eeoc),
      j.cv_doc_url, j.cv_pdf_key, j.url, nowIso, nowIso,
    ),
    env.DB.prepare('INSERT INTO job_events (url_hash, ts, actor, event, detail) VALUES (?,?,?,?,?)')
      .bind(urlHash, nowIso, 'system', 'kit_built',
        detectError
          ? `questions not detected (${detectError}); Q&A ready`
          : `${answers.length - red.length} matched · ${red.length} red · ${eeoc.length} EEOC-flagged`),
  ]);

  return {
    ok: true,
    matched: answers.length - red.length,
    red: red.length,
    eeoc: eeoc.length,
    detectable,
    error: detectError,
  };
}

/**
 * On-demand (NOT part of buildKit, which stays zero-AI): suggest job-tailored
 * versions of the matched Q&A answers and store them on the kit
 * (application_kits.answer_suggestions). SUGGESTIONS only — never auto-applied,
 * never written to the generic Q&A bank (that would pollute reuse); the owner
 * reviews them and uses them when filling THIS form (§7.1/§7.8).
 */
export async function polishAnswers(
  env: Env, urlHash: string, doFetch: Fetcher = fetch,
): Promise<{ ok: boolean; count: number; error?: string }> {
  const kit = await env.DB.prepare('SELECT answers FROM application_kits WHERE url_hash = ?')
    .bind(urlHash).first<{ answers: string | null }>();
  if (!kit) return { ok: false, count: 0, error: 'kit not built yet' };
  const matched = (JSON.parse(kit.answers ?? '[]') as MatchedAnswer[])
    .filter((a) => !a.red && a.answer)
    .map((a) => ({ question: a.question, answer: String(a.answer) }));
  if (!matched.length) return { ok: true, count: 0 };

  const j = await env.DB.prepare('SELECT title, description_text, role_analysis FROM jobs WHERE url_hash = ?')
    .bind(urlHash).first<{ title: string; description_text: string | null; role_analysis: string | null }>();
  if (!j) return { ok: false, count: 0, error: 'job not found' };
  let analysis: RoleAnalysis | null = null;
  try { analysis = j.role_analysis ? (JSON.parse(j.role_analysis) as RoleAnalysis) : null; } catch { analysis = null; }

  const job: Job = {
    id: '', company: '', title: j.title, location: '', url: '',
    description: j.description_text ?? '', posted_at: null, ats: 'greenhouse', raw: null,
  };
  const res = await answerPolisher(env, job, analysis, matched, doFetch);
  if (!res.ok || !res.data) return { ok: false, count: 0, error: res.error };

  await env.DB.prepare('UPDATE application_kits SET answer_suggestions = ?, updated_at = ? WHERE url_hash = ?')
    .bind(JSON.stringify(res.data.suggestions), new Date().toISOString(), urlHash).run();
  return { ok: true, count: res.data.suggestions.length };
}

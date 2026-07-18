// Application-form question detection + answer matching (step 8, ratified L1
// design). Greenhouse exposes questions via public API; Lever via the public
// apply page HTML (the one approved scraping exception); Ashby has no public
// form API. EEOC/demographic questions are flagged and NEVER auto-answered
// (domain rule 1). Pure parts (normalize/eeoc/match) are unit-tested.

import type { Ats } from '../types';

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface DetectedQuestions {
  /** Regular form questions (labels, in page order). */
  questions: string[];
  /** EEOC/demographic questions — listed, never matched or answered. */
  eeoc: string[];
  /** false when the ATS form is not publicly readable (Ashby). */
  detectable: boolean;
}

export interface AnswerRow {
  id: number;
  question_norm: string;
  question_label: string;
  answer_en: string | null;
}

export interface MatchedAnswer {
  question: string;
  answer: string | null;
  source: 'bank' | 'chat' | null;
  red: boolean;
}

/** Normalizes a question for matching: lowercase, no accents/punctuation, collapsed spaces. */
export function normalizeQuestion(text: string): string {
  return text
    .normalize('NFD').replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const EEOC_MARKERS = [
  'gender', 'race', 'ethnic', 'veteran', 'disability', 'disabled',
  'sexual orientation', 'pronoun', 'transgender', 'lgbtq', 'demographic',
  'protected', 'hispanic', 'latino',
];

/** True when a question is EEOC/demographic — flagged, never auto-answered. */
export function isEeocQuestion(text: string): boolean {
  const n = normalizeQuestion(text);
  return EEOC_MARKERS.some((m) => n.includes(m));
}

/**
 * Matches detected questions against the APPROVED answers bank.
 * Exact normalized match first; then containment either way (min 10 chars) —
 * conservative on purpose: a wrong auto-match is worse than a red question.
 */
export function matchAnswers(questions: string[], bank: AnswerRow[]): MatchedAnswer[] {
  return questions.map((q) => {
    const norm = normalizeQuestion(q);
    let hit = bank.find((a) => a.question_norm === norm);
    if (!hit && norm.length >= 10) {
      hit = bank.find((a) =>
        a.question_norm.length >= 10 && (norm.includes(a.question_norm) || a.question_norm.includes(norm)));
    }
    return {
      question: q,
      answer: hit?.answer_en ?? null,
      source: hit ? 'bank' as const : null,
      red: !hit,
    };
  });
}

interface GreenhouseQuestion { label?: string }
interface GreenhouseJobDetail {
  questions?: GreenhouseQuestion[];
  compliance?: Array<{ questions?: GreenhouseQuestion[] }>;
  demographic_questions?: { questions?: GreenhouseQuestion[] };
  location_questions?: GreenhouseQuestion[];
}

async function greenhouseQuestions(token: string, extId: string, doFetch: Fetcher): Promise<DetectedQuestions> {
  const res = await doFetch(
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs/${encodeURIComponent(extId)}?questions=true`,
  );
  if (!res.ok) throw new Error(`greenhouse questions: HTTP ${res.status}`);
  const body = (await res.json()) as GreenhouseJobDetail;
  const regular = [
    ...(body.questions ?? []),
    ...(body.location_questions ?? []),
  ].map((q) => q.label ?? '').filter(Boolean);
  const eeoc = [
    ...(body.demographic_questions?.questions ?? []),
    ...(body.compliance ?? []).flatMap((s) => s.questions ?? []),
  ].map((q) => q.label ?? '').filter(Boolean);
  // Some boards put EEOC-ish items in the regular list — reflag defensively.
  const [clean, extraEeoc] = [regular.filter((q) => !isEeocQuestion(q)), regular.filter(isEeocQuestion)];
  return { questions: clean, eeoc: [...eeoc, ...extraEeoc], detectable: true };
}

async function leverQuestions(token: string, extId: string, doFetch: Fetcher): Promise<DetectedQuestions> {
  // Approved exception (2026-07-17 design): public HTML of Lever's apply page.
  const res = await doFetch(`https://jobs.lever.co/${encodeURIComponent(token)}/${encodeURIComponent(extId)}/apply`);
  if (!res.ok) throw new Error(`lever apply page: HTTP ${res.status}`);
  const html = await res.text();
  const labels: string[] = [];
  for (const m of html.matchAll(/class="application-label[^"]*"[^>]*>([\s\S]*?)<\//g)) {
    const text = m[1]!.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (text && text.length < 300) labels.push(text);
  }
  const unique = [...new Set(labels)];
  return {
    questions: unique.filter((q) => !isEeocQuestion(q)),
    eeoc: unique.filter(isEeocQuestion),
    detectable: true,
  };
}

/** Detects the job's form questions per ATS; Ashby is not publicly readable. */
export async function detectQuestions(
  ats: Ats, token: string, extId: string, doFetch: Fetcher = fetch,
): Promise<DetectedQuestions> {
  if (ats === 'greenhouse') return greenhouseQuestions(token, extId, doFetch);
  if (ats === 'lever') return leverQuestions(token, extId, doFetch);
  return { questions: [], eeoc: [], detectable: false };
}

// Application-form question detection + answer matching (step 8, ratified L1
// design). Greenhouse exposes questions via public API; Lever via the public
// apply page HTML; Ashby via its public job-board GraphQL (op ApiJobPosting,
// unauthenticated — verified live 2026-07-20). SuccessFactors and Workday put
// the application form behind a candidate login, so they are not detectable.
// EEOC/demographic questions are flagged and NEVER auto-answered (domain rule
// 1). Pure parts (normalize/eeoc/match/ashbyLabels) are unit-tested.

import type { Ats } from '../types';

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface DetectedQuestions {
  /** Regular form questions (labels, in page order). */
  questions: string[];
  /** EEOC/demographic questions — listed, never matched or answered. */
  eeoc: string[];
  /** false when the ATS form is behind a candidate login (SuccessFactors, Workday). */
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
 * Matches detected questions against the APPROVED Q&A answers.
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

// Ashby's public job-board SPA reads its form from this unauthenticated GraphQL op
// (introspection is disabled, but the op resolves without a token — verified live
// 2026-07-20). `field` is a JSON scalar carrying the field definition. It is
// undocumented: the caller isolates this in try/catch, so a schema change degrades
// to detectable:false and never breaks the kit.
interface AshbyFormField {
  path?: string;
  title?: string;
  humanReadablePath?: string;
  type?: string;
  isDeactivated?: boolean;
}
export interface AshbyFormSection {
  fieldEntries?: Array<{ field?: AshbyFormField }>;
}
interface AshbyFormResponse {
  data?: { jobPosting?: { applicationForm?: { sections?: AshbyFormSection[] } } };
}

const ASHBY_FORM_QUERY =
  'query ApiJobPosting($organizationHostedJobsPageName: String!, $jobPostingId: String!)' +
  ' { jobPosting(organizationHostedJobsPageName: $organizationHostedJobsPageName, jobPostingId: $jobPostingId)' +
  ' { applicationForm { sections { fieldEntries { field } } } } }';

/**
 * Pure: extracts custom-question labels from Ashby form sections, in order.
 * System autofill fields (`_systemfield_name/email/resume/…`) and deactivated
 * fields are dropped — only real screening questions remain. Unit-tested.
 */
export function ashbyLabels(sections: AshbyFormSection[]): string[] {
  const labels: string[] = [];
  for (const s of sections) {
    for (const fe of s.fieldEntries ?? []) {
      const f = fe.field;
      if (!f || f.isDeactivated) continue;
      if (f.path?.startsWith('_systemfield_')) continue;
      const label = (f.title || f.humanReadablePath || '').trim();
      if (label && label.length < 300) labels.push(label);
    }
  }
  return [...new Set(labels)];
}

async function ashbyQuestions(board: string, jobPostingId: string, doFetch: Fetcher): Promise<DetectedQuestions> {
  const res = await doFetch('https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      operationName: 'ApiJobPosting',
      variables: { organizationHostedJobsPageName: board, jobPostingId },
      query: ASHBY_FORM_QUERY,
    }),
  });
  if (!res.ok) throw new Error(`ashby form: HTTP ${res.status}`);
  const body = (await res.json()) as AshbyFormResponse;
  const sections = body.data?.jobPosting?.applicationForm?.sections;
  if (!sections) throw new Error('ashby form: applicationForm missing (schema changed?)');
  const labels = ashbyLabels(sections);
  return {
    questions: labels.filter((q) => !isEeocQuestion(q)),
    eeoc: labels.filter(isEeocQuestion),
    detectable: true,
  };
}

/** Detects the job's form questions per ATS; SuccessFactors/Workday are login-gated. */
export async function detectQuestions(
  ats: Ats, token: string, extId: string, doFetch: Fetcher = fetch,
): Promise<DetectedQuestions> {
  if (ats === 'greenhouse') return greenhouseQuestions(token, extId, doFetch);
  if (ats === 'lever') return leverQuestions(token, extId, doFetch);
  if (ats === 'ashby') return ashbyQuestions(token, extId, doFetch);
  return { questions: [], eeoc: [], detectable: false };
}

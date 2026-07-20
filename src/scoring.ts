// Scoring engine (docs/TRD.md §3): 100% deterministic, pure function.
// The knowledge lives in the `config` table (key 'scoring'); zero keywords in code.

import type { Job, Verdict } from './types';

export type Category = 'domain' | 'role_type' | 'tool_overlap' | 'level_fit';
export const CATEGORIES: Category[] = ['domain', 'role_type', 'tool_overlap', 'level_fit'];

/** One concept with BOTH languages required. `es` equals `en` when the word is
 * the same in both (e.g. "sql"); a distinct Spanish otherwise (payments/pagos).
 * The engine matches `en` OR `es` and counts the concept ONCE (no double count). */
export interface Keyword {
  en: string;
  es: string;
  /** Weight; negative = signal against (subtracts within the category, floor 0). */
  weight: number;
}

/** A gate term as a concept with both languages (`es` equals `en` when the same). */
export interface GateTerm {
  en: string;
  es: string;
}

export interface Gate {
  id: string;
  type: 'hard' | 'penalty';
  /** Points a penalty subtracts (ignored on hard). */
  points?: number;
  /** Passes if AT LEAST ONE matches (en or es); hard fails / penalty if none match. */
  require?: GateTerm[];
  /** Fails (hard) / subtracts (penalty) if ANY matches (en or es). */
  reject?: GateTerm[];
  /** Where to search. Default: 'text' (title + location + description). */
  scope?: 'title' | 'location' | 'title_location' | 'text';
}

export interface TrackConfig {
  id: string;
  gates: Gate[];
  /** Track-specific thresholds (optional); if missing, the global ones apply. */
  thresholds?: { apply: number; stretch: number };
}

export interface ScoringConfig {
  /** Weights per category (sum to 100) and saturation (matched weight that equals 1.0). */
  weights: Record<Category, { weight: number; saturation: number }>;
  /** Multiplier when the match occurs in the title. */
  title_multiplier: number;
  thresholds: { apply: number; stretch: number };
  keywords: Record<Category, Keyword[]>;
  /** Conditional level_fit negatives: apply only if role_type matched one of these terms. */
  level_negatives_only_if_role?: string[];
  /** level_fit negative terms subject to the condition above (e.g. 'senior'). */
  conditional_level_negatives?: Keyword[];
  tracks: TrackConfig[];
}

export interface KeywordMatch {
  term: string;
  weight: number;
  in_title: boolean;
}

export interface CategoryBreakdown {
  matches: KeywordMatch[];
  /** Raw matched weight (with title multiplier; floor 0). */
  raw: number;
  /** raw / saturation, capped at 1. */
  normalized: number;
  /** normalized * weight — contribution to the 100. */
  points: number;
}

export interface GateResult {
  id: string;
  type: 'hard' | 'penalty';
  passed: boolean;
  /** Evidence: term that matched (in reject) or that was missing (in require). */
  evidence: string;
  points_delta: number;
}

export interface TrackResult {
  gates: GateResult[];
  hard_failed: boolean;
  adjusted_score: number;
  verdict: Verdict;
}

export interface ScoreResult {
  /** Core score 0-100, before gates. */
  score: number;
  breakdown: Record<Category, CategoryBreakdown>;
  tracks: Record<string, TrackResult>;
  best: { track: string | null; verdict: Verdict; adjusted_score: number };
  /** Only when best.verdict === 'Skip': the closest reason, in plain language. */
  near_miss_reason?: string;
}

/** Normalizes for matching: lowercase + no diacritics (matches EN/ES regardless of accents). */
export function normalizeText(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** Normalized title for the similar-jobs radar: no parentheses, no seniority tokens. */
export function normalizeTitle(title: string): string {
  return normalizeText(title)
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(sr|jr|senior|junior|staff|principal|lead|i{1,3}|iv|v|1|2|3)\b\.?/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const regexCache = new Map<string, RegExp>();

/** Unicode word-boundary, case/accent-insensitive (the text arrives already normalized). */
function termRegex(term: string): RegExp {
  let re = regexCache.get(term);
  if (!re) {
    const escaped = normalizeText(term)
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\s+/g, '[\\s/-]+');
    re = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'u');
    regexCache.set(term, re);
  }
  return re;
}

function matchesIn(term: string, normalizedText: string): boolean {
  return termRegex(term).test(normalizedText);
}

/** Match a concept's term; an empty string (a language not filled yet) never matches. */
function hitTerm(term: string, normalizedText: string): boolean {
  return !!term && matchesIn(term, normalizedText);
}

interface Corpus {
  title: string;
  location: string;
  text: string; // title + location + description
  title_location: string;
}

function buildCorpus(job: Job): Corpus {
  const title = normalizeText(job.title);
  const location = normalizeText(job.location);
  const description = normalizeText(job.description);
  return {
    title,
    location,
    title_location: `${title}\n${location}`,
    text: `${title}\n${location}\n${description}`,
  };
}

function scoreCategory(
  category: Category,
  keywords: Keyword[],
  corpus: Corpus,
  config: ScoringConfig,
  roleMatchedTerms: Set<string>,
): CategoryBreakdown {
  const matches: KeywordMatch[] = [];
  let raw = 0;

  const effective = [...keywords];
  if (category === 'level_fit' && config.conditional_level_negatives?.length) {
    const conditionTerms = config.level_negatives_only_if_role ?? [];
    const conditionMet = conditionTerms.some((t) => roleMatchedTerms.has(normalizeText(t)));
    if (conditionMet) effective.push(...config.conditional_level_negatives);
  }

  for (const kw of effective) {
    // One concept = one match check across BOTH languages → counted once (no double count).
    const inTitle = hitTerm(kw.en, corpus.title) || hitTerm(kw.es, corpus.title);
    const inBody = inTitle || hitTerm(kw.en, corpus.text) || hitTerm(kw.es, corpus.text);
    if (!inBody) continue;
    const contribution = kw.weight * (inTitle && kw.weight > 0 ? config.title_multiplier : 1);
    matches.push({ term: kw.en, weight: contribution, in_title: inTitle });
    raw += contribution;
  }

  raw = Math.max(0, raw);
  const { weight, saturation } = config.weights[category];
  const normalized = Math.min(1, saturation > 0 ? raw / saturation : 0);
  return { matches, raw, normalized, points: normalized * weight };
}

function evaluateGate(gate: Gate, corpus: Corpus): GateResult {
  const scope = corpus[gate.scope ?? 'text'];
  const points = gate.points ?? 0;
  const gmatch = (t: GateTerm) => hitTerm(t.en, scope) || hitTerm(t.es, scope);

  if (gate.reject?.length) {
    const hit = gate.reject.find(gmatch);
    if (hit) {
      return {
        id: gate.id, type: gate.type, passed: false,
        evidence: `matched '${hit.en}'`,
        points_delta: gate.type === 'penalty' ? -points : 0,
      };
    }
  }
  if (gate.require?.length) {
    const hit = gate.require.find(gmatch);
    if (!hit) {
      return {
        id: gate.id, type: gate.type, passed: false,
        evidence: `no match for: ${gate.require.slice(0, 4).map((t) => t.en).join(', ')}…`,
        points_delta: gate.type === 'penalty' ? -points : 0,
      };
    }
    return { id: gate.id, type: gate.type, passed: true, evidence: `matched '${hit.en}'`, points_delta: 0 };
  }
  return { id: gate.id, type: gate.type, passed: true, evidence: 'no failing conditions', points_delta: 0 };
}

function verdictFor(score: number, thresholds: ScoringConfig['thresholds']): Verdict {
  if (score >= thresholds.apply) return 'Apply';
  if (score >= thresholds.stretch) return 'Stretch-worth-it';
  return 'Skip';
}

const VERDICT_RANK: Record<Verdict, number> = { 'Apply': 2, 'Stretch-worth-it': 1, 'Skip': 0 };

/** Pure engine function: job + config -> complete result (persistable in jobs.score_breakdown). */
export function scoreJob(job: Job, config: ScoringConfig): ScoreResult {
  const corpus = buildCorpus(job);

  const roleBreakdownProbe = scoreCategory('role_type', config.keywords.role_type, corpus, config, new Set());
  const roleMatchedTerms = new Set(
    roleBreakdownProbe.matches.filter((m) => m.weight > 0).map((m) => normalizeText(m.term)),
  );

  const breakdown = {} as Record<Category, CategoryBreakdown>;
  for (const cat of CATEGORIES) {
    breakdown[cat] =
      cat === 'role_type'
        ? roleBreakdownProbe
        : scoreCategory(cat, config.keywords[cat], corpus, config, roleMatchedTerms);
  }

  const score = Math.round(CATEGORIES.reduce((acc, c) => acc + breakdown[c].points, 0));

  const tracks: Record<string, TrackResult> = {};
  for (const track of config.tracks) {
    const gates = track.gates.map((g) => evaluateGate(g, corpus));
    const hardFailed = gates.some((g) => g.type === 'hard' && !g.passed);
    const penalty = gates.reduce((acc, g) => acc + g.points_delta, 0);
    const adjusted = Math.max(0, score + penalty);
    tracks[track.id] = {
      gates,
      hard_failed: hardFailed,
      adjusted_score: adjusted,
      verdict: hardFailed ? 'Skip' : verdictFor(adjusted, track.thresholds ?? config.thresholds),
    };
  }

  let best: ScoreResult['best'] | null = null;
  for (const [id, t] of Object.entries(tracks)) {
    if (
      !best ||
      VERDICT_RANK[t.verdict] > VERDICT_RANK[best.verdict] ||
      (VERDICT_RANK[t.verdict] === VERDICT_RANK[best.verdict] && t.adjusted_score > best.adjusted_score)
    ) {
      best = { track: id, verdict: t.verdict, adjusted_score: t.adjusted_score };
    }
  }
  if (!best) best = { track: null, verdict: 'Skip', adjusted_score: score };

  const result: ScoreResult = { score, breakdown, tracks, best };
  if (best.verdict === 'Skip') result.near_miss_reason = nearMissReason(result, config);
  return result;
}

/** Plain-language "why NOT" explainer (console chip). */
function nearMissReason(result: ScoreResult, config: ScoringConfig): string {
  let closest: { track: string; t: TrackResult } | null = null;
  for (const [track, t] of Object.entries(result.tracks)) {
    if (!closest || t.adjusted_score > closest.t.adjusted_score) closest = { track, t };
  }
  if (!closest) return 'no tracks configured';
  const { track, t } = closest;
  const failedHard = t.gates.find((g) => g.type === 'hard' && !g.passed);
  if (failedHard) return `gate: ${failedHard.id} (${track}) — ${failedHard.evidence}`;
  const stretch =
    config.tracks.find((tc) => tc.id === track)?.thresholds?.stretch ?? config.thresholds.stretch;
  const gap = stretch - t.adjusted_score;
  return `score ${t.adjusted_score} < ${stretch} (${track}, short by ${gap})`;
}

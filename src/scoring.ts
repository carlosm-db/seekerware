// Motor de scoring (docs/TRD.md §3): 100% determinista, funcion pura.
// El conocimiento vive en la tabla `config` (clave 'scoring'); cero keywords en codigo.

import type { Job, Verdict } from './types';

export type Category = 'domain' | 'role_type' | 'tool_overlap' | 'level_fit';
export const CATEGORIES: Category[] = ['domain', 'role_type', 'tool_overlap', 'level_fit'];

export interface Keyword {
  term: string;
  /** Peso; negativo = senal en contra (resta dentro de la categoria, piso 0). */
  weight: number;
}

export interface Gate {
  id: string;
  type: 'hard' | 'penalty';
  /** Puntos que resta un penalty (ignorado en hard). */
  points?: number;
  /** Pasa si AL MENOS UNO matchea; hard falla / penalty resta si ninguno matchea. */
  require?: string[];
  /** Falla (hard) / resta (penalty) si ALGUNO matchea. */
  reject?: string[];
  /** Donde buscar. Default: 'text' (titulo + ubicacion + descripcion). */
  scope?: 'title' | 'location' | 'title_location' | 'text';
}

export interface TrackConfig {
  id: string;
  gates: Gate[];
  /** Umbrales propios del track (opcional); si faltan, aplican los globales. */
  thresholds?: { apply: number; stretch: number };
}

export interface ScoringConfig {
  /** Pesos por categoria (suman 100) y saturacion (peso matcheado que equivale a 1.0). */
  weights: Record<Category, { weight: number; saturation: number }>;
  /** Multiplicador cuando el match ocurre en el titulo. */
  title_multiplier: number;
  thresholds: { apply: number; stretch: number };
  keywords: Record<Category, Keyword[]>;
  /** Negativos de level_fit condicionados: solo aplican si role_type matcheo alguno de estos terminos. */
  level_negatives_only_if_role?: string[];
  /** Terminos negativos de level_fit sujetos a la condicion anterior (p. ej. 'senior'). */
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
  /** Peso bruto matcheado (con multiplicador de titulo; piso 0). */
  raw: number;
  /** raw / saturation, tope 1. */
  normalized: number;
  /** normalized * weight — aporte a los 100. */
  points: number;
}

export interface GateResult {
  id: string;
  type: 'hard' | 'penalty';
  passed: boolean;
  /** Evidencia: termino que matcheo (en reject) o que falto (en require). */
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
  /** Score core 0-100, previo a gates. */
  score: number;
  breakdown: Record<Category, CategoryBreakdown>;
  tracks: Record<string, TrackResult>;
  best: { track: string | null; verdict: Verdict; adjusted_score: number };
  /** Solo cuando best.verdict === 'Skip': la razon mas cercana, en lenguaje claro. */
  near_miss_reason?: string;
}

/** Normaliza para matching: lowercase + sin diacriticos (matchea EN/ES sin importar tildes). */
export function normalizeText(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** Titulo normalizado para el radar de similares: sin parentesis ni tokens de seniority. */
export function normalizeTitle(title: string): string {
  return normalizeText(title)
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(sr|jr|senior|junior|staff|principal|lead|i{1,3}|iv|v|1|2|3)\b\.?/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const regexCache = new Map<string, RegExp>();

/** Word-boundary Unicode, case/acento-insensible (el texto llega ya normalizado). */
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
    const inTitle = matchesIn(kw.term, corpus.title);
    const inBody = inTitle || matchesIn(kw.term, corpus.text);
    if (!inBody) continue;
    const contribution = kw.weight * (inTitle && kw.weight > 0 ? config.title_multiplier : 1);
    matches.push({ term: kw.term, weight: contribution, in_title: inTitle });
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

  if (gate.reject?.length) {
    const hit = gate.reject.find((t) => matchesIn(t, scope));
    if (hit) {
      return {
        id: gate.id, type: gate.type, passed: false,
        evidence: `matcheo '${hit}'`,
        points_delta: gate.type === 'penalty' ? -points : 0,
      };
    }
  }
  if (gate.require?.length) {
    const hit = gate.require.find((t) => matchesIn(t, scope));
    if (!hit) {
      return {
        id: gate.id, type: gate.type, passed: false,
        evidence: `sin match de: ${gate.require.slice(0, 4).join(', ')}…`,
        points_delta: gate.type === 'penalty' ? -points : 0,
      };
    }
    return { id: gate.id, type: gate.type, passed: true, evidence: `matcheo '${hit}'`, points_delta: 0 };
  }
  return { id: gate.id, type: gate.type, passed: true, evidence: 'sin condiciones que fallen', points_delta: 0 };
}

function verdictFor(score: number, thresholds: ScoringConfig['thresholds']): Verdict {
  if (score >= thresholds.apply) return 'Apply';
  if (score >= thresholds.stretch) return 'Stretch-worth-it';
  return 'Skip';
}

const VERDICT_RANK: Record<Verdict, number> = { 'Apply': 2, 'Stretch-worth-it': 1, 'Skip': 0 };

/** Funcion pura del motor: job + config -> resultado completo (persistible en jobs.score_breakdown). */
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

/** Explicador "por que NO" en lenguaje claro (chip de la consola). */
function nearMissReason(result: ScoreResult, config: ScoringConfig): string {
  let closest: { track: string; t: TrackResult } | null = null;
  for (const [track, t] of Object.entries(result.tracks)) {
    if (!closest || t.adjusted_score > closest.t.adjusted_score) closest = { track, t };
  }
  if (!closest) return 'sin tracks configurados';
  const { track, t } = closest;
  const failedHard = t.gates.find((g) => g.type === 'hard' && !g.passed);
  if (failedHard) return `gate: ${failedHard.id} (${track}) — ${failedHard.evidence}`;
  const stretch =
    config.tracks.find((tc) => tc.id === track)?.thresholds?.stretch ?? config.thresholds.stretch;
  const gap = stretch - t.adjusted_score;
  return `score ${t.adjusted_score} < ${stretch} (${track}, faltan ${gap})`;
}

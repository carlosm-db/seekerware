// Loads, normalizes and validates the scoring configuration from the `config`
// table. Config is one concept = one object with BOTH languages ({en, es}).
// The normalizer coerces every entry to that shape and validates; the console
// writes the config directly (edits apply on save — no draft/activate step).

import type { Env } from './types';
import { CATEGORIES, type Category, type GateTerm, type Keyword, type ScoringConfig } from './scoring';

export async function loadScoringConfig(env: Env): Promise<ScoringConfig> {
  const row = await env.DB.prepare('SELECT value FROM config WHERE key = ?')
    .bind('scoring')
    .first<{ value: string }>();
  if (!row) {
    throw new Error("config 'scoring' does not exist in D1 — apply the seed (seeds/seed_config.sql)");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.value);
  } catch {
    throw new Error("config 'scoring' is not valid JSON");
  }
  return normalizeScoringConfig(parsed);
}

/** Normalize to the {en, es} shape and validate. */
export function validateScoringConfig(raw: unknown): ScoringConfig {
  return normalizeScoringConfig(raw);
}

// ---------- normalization ({en, es}) ----------

interface RawKeyword { en?: string; es?: string; weight?: number; scope?: unknown }

/** One concept = one {en, es, weight} (+ optional scope). */
function normalizeKeywordList(raw: unknown): Keyword[] {
  const list = Array.isArray(raw) ? (raw as RawKeyword[]) : [];
  return list.map((k) => ({
    en: String(k.en ?? ''),
    es: String(k.es ?? ''),
    weight: Number(k.weight),
    // `scope` is carried through the same way gate scope is below. Rebuilding the object without it
    // would strip every title-scoped term on load AND on each console save — silently turning the
    // narrowing off while the config still looked right.
    ...(k.scope === undefined ? {} : { scope: k.scope as Keyword['scope'] }),
  }));
}

function normalizeGateTerms(raw: unknown): GateTerm[] {
  const list = Array.isArray(raw) ? (raw as Array<{ en?: unknown; es?: unknown }>) : [];
  return list.map((t) => ({ en: String(t?.en ?? ''), es: String(t?.es ?? '') }));
}

export function normalizeScoringConfig(raw: unknown): ScoringConfig {
  const c = raw as Record<string, unknown>;
  if (!c || typeof c !== 'object') throw new Error("config 'scoring': object expected");

  const keywords = {} as Record<Category, Keyword[]>;
  const rawKeywords = (c.keywords ?? {}) as Record<string, unknown>;
  for (const cat of CATEGORIES) keywords[cat] = normalizeKeywordList(rawKeywords[cat]);

  const rawTracks = Array.isArray(c.tracks) ? (c.tracks as Record<string, unknown>[]) : [];
  const tracks = rawTracks.map((t) => ({
    ...t,
    // Gates are always hard (pass/fail); only {id, scope, require, reject} are kept.
    gates: (Array.isArray(t.gates) ? (t.gates as Record<string, unknown>[]) : []).map((g) => ({
      id: g.id,
      ...(g.scope === undefined ? {} : { scope: g.scope }),
      ...(g.require === undefined ? {} : { require: normalizeGateTerms(g.require) }),
      ...(g.reject === undefined ? {} : { reject: normalizeGateTerms(g.reject) }),
    })),
  }));

  const normalized = {
    ...c,
    keywords,
    tracks,
    conditional_level_negatives:
      c.conditional_level_negatives === undefined ? undefined : normalizeKeywordList(c.conditional_level_negatives),
  } as unknown as ScoringConfig;

  return validate(normalized);
}

function validate(c: ScoringConfig): ScoringConfig {
  if (!c || typeof c !== 'object') throw new Error("config 'scoring': object expected");
  for (const cat of CATEGORIES) {
    if (!c.weights?.[cat] || typeof c.weights[cat].weight !== 'number' || typeof c.weights[cat].saturation !== 'number') {
      throw new Error(`config 'scoring': missing weights.${cat} {weight, saturation}`);
    }
    if (!Array.isArray(c.keywords?.[cat])) {
      throw new Error(`config 'scoring': missing keywords.${cat}[]`);
    }
    for (const k of c.keywords[cat]) {
      // en is required; es may be '' defensively — the console enforces both languages.
      if (!k.en || typeof k.en !== 'string' || typeof k.weight !== 'number') {
        throw new Error(`config 'scoring': keywords.${cat} needs {en, es, weight} (en required)`);
      }
      // A typo'd scope would silently widen the term back to full text; fail loudly instead.
      if (k.scope !== undefined && k.scope !== 'title' && k.scope !== 'text') {
        throw new Error(`config 'scoring': keywords.${cat} "${k.en}" scope must be 'title' or 'text'`);
      }
    }
  }
  const totalWeight = CATEGORIES.reduce((acc, cat) => acc + c.weights[cat].weight, 0);
  if (Math.round(totalWeight) !== 100) {
    throw new Error(`config 'scoring': weights must sum to 100 (they sum ${totalWeight})`);
  }
  if (typeof c.title_multiplier !== 'number' || c.title_multiplier < 1) {
    throw new Error("config 'scoring': title_multiplier >= 1 required");
  }
  if (typeof c.thresholds?.apply !== 'number' || typeof c.thresholds?.stretch !== 'number' ||
      c.thresholds.apply <= c.thresholds.stretch) {
    throw new Error("config 'scoring': thresholds.apply > thresholds.stretch required");
  }
  if (!Array.isArray(c.tracks) || c.tracks.length === 0) {
    throw new Error("config 'scoring': tracks[] empty");
  }
  for (const t of c.tracks) {
    if (!t.id || !Array.isArray(t.gates)) throw new Error("config 'scoring': track without id or gates");
    // A track may carry its OWN verdict bar (co-op postings cannot reach a bar tuned for experienced
    // roles). An inverted one would silently mark everything on that route as Apply.
    if (t.thresholds !== undefined) {
      const { apply, stretch } = t.thresholds;
      if (typeof apply !== 'number' || typeof stretch !== 'number' || apply <= stretch) {
        throw new Error(`config 'scoring': track ${t.id} thresholds need apply > stretch`);
      }
    }
    for (const g of t.gates) {
      if (!g.id) throw new Error(`config 'scoring': gate without id in track ${t.id}`);
    }
  }
  return c;
}

// Loads, normalizes and validates the scoring configuration from the `config`
// table. Config is one concept = one object with BOTH languages ({en, es}).
// A normalizer up-converts the legacy shape ({term, lang, pair} + string[] gates)
// on read, so a deploy never breaks on an old live config; the owner then
// activates the cleaned config through the console (Preview → Activate).

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

/** Normalize + validate. Accepts both the new {en,es} shape and the legacy shape. */
export function validateScoringConfig(raw: unknown): ScoringConfig {
  return normalizeScoringConfig(raw);
}

// ---------- normalization (legacy → {en, es}) ----------

interface LegacyKeyword { term?: string; en?: string; es?: string; weight: number; lang?: 'es'; pair?: string }

/** One concept = one {en, es, weight}. Legacy twins (two entries sharing a pair)
 * merge; a legacy single keeps es='' (contamination — filled later by the owner). */
function normalizeKeywordList(raw: unknown): Keyword[] {
  const list = Array.isArray(raw) ? (raw as LegacyKeyword[]) : [];
  if (list.every((k) => k && typeof k === 'object' && 'en' in k)) {
    return list.map((k) => ({ en: String(k.en ?? ''), es: String(k.es ?? ''), weight: Number(k.weight) }));
  }
  const byPair = new Map<string, LegacyKeyword[]>();
  for (const k of list) {
    const pid = k.pair ?? k.term ?? '';
    const arr = byPair.get(pid) ?? [];
    arr.push(k);
    byPair.set(pid, arr);
  }
  const out: Keyword[] = [];
  for (const entries of byPair.values()) {
    const enE = entries.find((e) => e.lang !== 'es') ?? entries[0]!;
    const esE = entries.find((e) => e.lang === 'es' && e.term !== enE.term);
    out.push({ en: String(enE.term ?? ''), es: esE ? String(esE.term ?? '') : '', weight: Number(enE.weight) });
  }
  return out;
}

function normalizeGateTerms(raw: unknown): GateTerm[] {
  const list = Array.isArray(raw) ? raw : [];
  return list.map((t) =>
    typeof t === 'string' ? { en: t, es: '' } : { en: String(t?.en ?? ''), es: String(t?.es ?? '') },
  );
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
    // Gates are always hard (pass/fail). Legacy `type`/`points` are dropped here.
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
      // en is required; es may be '' during the contamination cleanup (filled by the owner).
      if (!k.en || typeof k.en !== 'string' || typeof k.weight !== 'number') {
        throw new Error(`config 'scoring': keywords.${cat} needs {en, es, weight} (en required)`);
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
    for (const g of t.gates) {
      if (!g.id) throw new Error(`config 'scoring': gate without id in track ${t.id}`);
    }
  }
  return c;
}

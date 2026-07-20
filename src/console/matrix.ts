// Calibration matrix projection (2026-07-19 rebuild): the grid is now BANK-style
// — one collapsible GROUP per category (Location, Role titles, Seniority,
// Industry & domain, Tools), and inside it CONCEPT ROWS with English in front of
// Spanish. This module is a pure PROJECTION over the existing ScoringConfig that
// reflects the DB 1:1 — NO mirror, no cloning. A concept is one of three honest
// states: a real EN/ES twin, `same` (identical word in both languages, stored
// once), or a GAP (English present, Spanish missing). Gates keep owning verdicts
// (domain rule 2); nothing here softens them. DB-free so it can be unit-tested.

import { CATEGORIES, type Category, type Keyword, type ScoringConfig } from '../scoring';

export type MatrixCategory = Category | 'location';
/** Row order per the owner's sketch: Location, Role titles, Seniority, Industry, Tools. */
export const MATRIX_CATEGORIES: MatrixCategory[] = ['location', 'role_type', 'level_fit', 'domain', 'tool_overlap'];

/**
 * Console-only display metadata for GATE terms (config key 'matrix_meta').
 * Gate lists stay plain string[] — zero engine risk; this is cosmetic:
 * which column a gate term renders in, which two terms form one pair, and which
 * are confirmed identical in both languages.
 */
export interface MatrixMeta {
  /** Gate terms displayed in the Español column (absent = English). */
  gate_langs: Record<string, 'es'>;
  /** Pair id per gate term (both twins of one concept share an id). */
  gate_pairs: Record<string, string>;
  /** Gate terms confirmed identical in both languages (display "= same word"). */
  gate_same: Record<string, true>;
}

export const emptyMeta = (): MatrixMeta => ({ gate_langs: {}, gate_pairs: {}, gate_same: {} });

export function parseMeta(raw: string | null | undefined): MatrixMeta {
  if (!raw) return emptyMeta();
  try {
    const p = JSON.parse(raw) as Partial<MatrixMeta>;
    return {
      gate_langs: p.gate_langs ?? {},
      gate_pairs: p.gate_pairs ?? {},
      gate_same: p.gate_same ?? {},
    };
  } catch {
    return emptyMeta();
  }
}

/** Where a concept lives — the remove/complete round-trips need it. */
export type ConceptSource =
  | { kind: 'keyword' }
  | { kind: 'gate'; track: string; gate: string; list: 'require' | 'reject' };

/** One concept = ONE row: English in front of Spanish, honest about pairing. */
export interface ConceptRow {
  category: MatrixCategory;
  favor: boolean;
  /** English term (canonical; always present). */
  en: string;
  /** Distinct Spanish twin, or null when `same` or a gap. */
  es: string | null;
  /** True when the concept reads the same in both languages (stored once). */
  same: boolean;
  /** Keyword chips: signed weight. Gate chips carry no weight (gates are absolute). */
  weight?: number;
  /** Points, when the owning gate is a penalty (display "−N"). */
  penalty?: number;
  /** Track whose gate contains this term — the path badge. */
  path?: string;
  source: ConceptSource;
}

/** A collapsible category group with its concept rows and a parity meter. */
export interface MatrixGroup {
  category: MatrixCategory;
  favor: ConceptRow[];
  against: ConceptRow[];
  /** paired = real EN/ES twin · same = identical · gap = Spanish missing. */
  counts: { paired: number; same: number; gap: number };
}

interface GateHit { track: string; gate: string; list: 'require' | 'reject'; penalty?: number; titleScope: boolean }

/** Index every gate term once (first hit wins) for path derivation and gate-only chips. */
function indexGates(cfg: ScoringConfig): Map<string, GateHit> {
  const idx = new Map<string, GateHit>();
  for (const t of cfg.tracks) {
    for (const g of t.gates) {
      const titleScope = g.scope === 'title' || g.scope === 'title_location';
      for (const list of ['require', 'reject'] as const) {
        for (const term of g[list] ?? []) {
          if (!idx.has(term)) {
            idx.set(term, {
              track: t.id, gate: g.id, list,
              penalty: g.type === 'penalty' ? (g.points ?? 0) : undefined,
              titleScope,
            });
          }
        }
      }
    }
  }
  return idx;
}

/** Strongest first (by |weight| desc), stable otherwise. */
function sortRows(rows: ConceptRow[]): ConceptRow[] {
  return [...rows].sort((a, b) => Math.abs(b.weight ?? 0) - Math.abs(a.weight ?? 0));
}

function countStates(rows: ConceptRow[]): { paired: number; same: number; gap: number } {
  let paired = 0, same = 0, gap = 0;
  for (const r of rows) {
    if (r.es) paired++;
    else if (r.same) same++;
    else gap++;
  }
  return { paired, same, gap };
}

/**
 * Projects the ScoringConfig into the BANK-style matrix, DB 1:1 (no mirror):
 * every concept-row maps to real entries. A single entry marked `same` renders
 * as identical; a single entry without a twin and without `same` is a GAP.
 */
export function buildMatrix(cfg: ScoringConfig, meta: MatrixMeta): MatrixGroup[] {
  const gateIdx = indexGates(cfg);
  const groups = new Map<MatrixCategory, { favor: ConceptRow[]; against: ConceptRow[] }>();
  for (const cat of MATRIX_CATEGORIES) groups.set(cat, { favor: [], against: [] });
  const push = (row: ConceptRow) => {
    const g = groups.get(row.category)!;
    (row.favor ? g.favor : g.against).push(row);
  };

  // 1) Keyword concepts (the 4 scoring categories), grouped by pair id.
  const keywordTerms = new Set<string>();
  for (const cat of CATEGORIES) {
    const list = cfg.keywords[cat] ?? [];
    const byPair = new Map<string, Keyword[]>();
    for (const k of list) {
      keywordTerms.add(k.term);
      const pid = k.pair ?? k.term;
      const arr = byPair.get(pid) ?? [];
      arr.push(k);
      byPair.set(pid, arr);
    }
    for (const entries of byPair.values()) {
      const enEntry = entries.find((e) => e.lang !== 'es') ?? entries[0];
      if (!enEntry) continue;
      const esEntry = entries.find((e) => e.lang === 'es' && e.term !== enEntry.term);
      const en = enEntry.term;
      const es = esEntry ? esEntry.term : null;
      const hit = gateIdx.get(en);
      push({
        category: cat,
        favor: enEntry.weight > 0,
        en,
        es,
        same: !es && enEntry.same === true,
        weight: enEntry.weight,
        path: hit?.track,
        penalty: hit?.penalty,
        source: { kind: 'keyword' },
      });
    }
  }

  // 2) Gate-only concepts (terms in no keyword list). Title-scope gates project
  // into Role titles; everything else (location/text) into the Location row.
  // Pairing/language/identity come from matrix_meta (display-only).
  const gatePairs = new Map<string, string[]>();
  for (const [term] of gateIdx) {
    if (keywordTerms.has(term)) continue;
    const pid = meta.gate_pairs[term] ?? term;
    const arr = gatePairs.get(pid) ?? [];
    arr.push(term);
    gatePairs.set(pid, arr);
  }
  for (const terms of gatePairs.values()) {
    const enTerm = terms.find((t) => meta.gate_langs[t] !== 'es') ?? terms[0];
    if (!enTerm) continue;
    const esTerm = terms.find((t) => meta.gate_langs[t] === 'es' && t !== enTerm) ?? null;
    const hit = gateIdx.get(enTerm);
    if (!hit) continue;
    const category: MatrixCategory = hit.titleScope ? 'role_type' : 'location';
    push({
      category,
      favor: hit.list === 'require',
      en: enTerm,
      es: esTerm,
      same: !esTerm && meta.gate_same[enTerm] === true,
      path: hit.track,
      penalty: hit.penalty,
      source: { kind: 'gate', track: hit.track, gate: hit.gate, list: hit.list },
    });
  }

  return MATRIX_CATEGORIES.map((cat) => {
    const g = groups.get(cat)!;
    const favor = sortRows(g.favor);
    const against = sortRows(g.against);
    return { category: cat, favor, against, counts: countStates([...favor, ...against]) };
  });
}

// ---------- Mutations (draft-side; the caller persists) ----------

export interface WordAddInput {
  en: string;
  es: string;
  category: MatrixCategory;
  favor: boolean;
  /** Magnitude 1–3 (favor) or 2–3 (against). Ignored for location (gates are absolute). */
  weight: number;
  /** Track id. Optional for scoring words; REQUIRED for location. */
  path?: string;
}

export interface ApplyError { error: string }

const norm = (s: string) => s.trim().toLowerCase();

/** Tracks that can take a path word for a category+direction (existing gates only — never creates gates). */
export function pathOptions(cfg: ScoringConfig, category: MatrixCategory, favor: boolean): string[] {
  return cfg.tracks
    .filter((t) => t.gates.some((g) => {
      const titleScope = g.scope === 'title' || g.scope === 'title_location';
      const scopeOk = category === 'location' ? !titleScope : titleScope;
      return scopeOk && (favor ? (g.require?.length ?? 0) > 0 : (g.reject?.length ?? 0) > 0);
    }))
    .map((t) => t.id);
}

function findGate(cfg: ScoringConfig, track: string, category: MatrixCategory, favor: boolean) {
  const t = cfg.tracks.find((x) => x.id === track);
  if (!t) return null;
  return t.gates.find((g) => {
    const titleScope = g.scope === 'title' || g.scope === 'title_location';
    const scopeOk = category === 'location' ? !titleScope : titleScope;
    return scopeOk && (favor ? (g.require?.length ?? 0) > 0 : (g.reject?.length ?? 0) > 0);
  }) ?? null;
}

/** Adds one concept (EN + ES, both required) to the draft config/meta in place. */
export function applyWordAdd(cfg: ScoringConfig, meta: MatrixMeta, input: WordAddInput): ApplyError | null {
  const en = norm(input.en);
  const es = norm(input.es);
  if (!en || !es) return { error: 'both languages are required — English AND Español' };
  const weight = Math.round(input.weight);
  if (input.favor ? weight < 1 || weight > 3 : weight < 2 || weight > 3) {
    return { error: input.favor ? 'weight must be +1..+3' : 'against weight must be −2 or −3' };
  }

  if (input.category === 'location') {
    if (!input.path) return { error: 'location words need a path — they ARE the track gates' };
    const gate = findGate(cfg, input.path, 'location', input.favor);
    if (!gate) {
      return { error: `track ${input.path} has no ${input.favor ? 'require' : 'against'} location list — add it once via Advanced raw JSON` };
    }
    const list = input.favor ? gate.require! : gate.reject!;
    if (list.includes(en) && list.includes(es)) return { error: `"${en}" is already listed` };
    for (const term of new Set([en, es])) if (!list.includes(term)) list.push(term);
    meta.gate_pairs[en] = en;
    meta.gate_pairs[es] = en;
    if (es !== en) meta.gate_langs[es] = 'es';
    else meta.gate_same[en] = true;
    return null;
  }

  const list = cfg.keywords[input.category];
  if (!list) return { error: 'invalid category' };
  if (list.some((k) => k.term === en || k.term === es)) return { error: `"${en}" / "${es}" is already listed` };
  const signed = input.favor ? weight : -weight;
  if (en === es) {
    // One concept, one entry (twice would double-count in scoring); marked identical.
    list.push({ term: en, weight: signed, pair: en, same: true });
  } else {
    list.push({ term: en, weight: signed, pair: en });
    list.push({ term: es, weight: signed, lang: 'es', pair: en });
  }
  if (input.path) {
    const gate = findGate(cfg, input.path, input.category, input.favor);
    if (!gate) {
      return { error: `track ${input.path} has no ${input.favor ? 'require' : 'against'} title gate — path not available here` };
    }
    const glist = input.favor ? gate.require! : gate.reject!;
    for (const term of new Set([en, es])) if (!glist.includes(term)) glist.push(term);
  }
  return null;
}

/** Completes a GAP concept in place: adds the real Spanish twin, or marks it identical. */
export interface PairCompleteInput {
  category: MatrixCategory;
  /** The existing English term to complete. */
  en: string;
  /** The real Spanish twin (empty when marking identical). */
  es?: string;
  /** Mark the concept identical in both languages instead of adding a twin. */
  same?: boolean;
  favor: boolean;
  kind: 'keyword' | 'gate';
  /** Gate coordinates (from the row) when kind === 'gate'. */
  track?: string;
  gate?: string;
}

export function applyPairComplete(cfg: ScoringConfig, meta: MatrixMeta, input: PairCompleteInput): ApplyError | null {
  const en = norm(input.en);
  if (!en) return { error: 'missing concept' };
  const es = norm(input.es ?? '');
  const asSame = input.same || (!!es && es === en);
  if (!asSame && !es) return { error: 'type the Spanish twin, or mark "= same word"' };

  if (input.kind === 'gate') {
    const track = cfg.tracks.find((t) => t.id === input.track);
    const gate = track?.gates.find((g) => g.id === input.gate);
    if (!gate) return { error: `gate ${input.gate ?? '?'} not found in ${input.track ?? '?'}` };
    meta.gate_pairs[en] = en;
    if (asSame) {
      meta.gate_same[en] = true;
      return null;
    }
    const list = input.favor ? (gate.require ?? (gate.require = [])) : (gate.reject ?? (gate.reject = []));
    if (!list.includes(es)) list.push(es);
    meta.gate_pairs[es] = en;
    meta.gate_langs[es] = 'es';
    delete meta.gate_same[en];
    return null;
  }

  const list = cfg.keywords[input.category as Category];
  if (!list) return { error: 'invalid category' };
  const existing = list.find((k) => k.term === en);
  if (!existing) return { error: `"${en}" not found in ${input.category}` };
  const pid = existing.pair ?? en;
  existing.pair = pid;
  if (asSame) {
    existing.same = true;
    return null;
  }
  if (list.some((k) => k.term === es)) return { error: `"${es}" is already listed` };
  delete existing.same;
  list.push({ term: es, weight: existing.weight, lang: 'es', pair: pid });
  return null;
}

export type RemoveTarget =
  | { kind: 'keyword'; category: Category; term: string }
  | { kind: 'gate'; track: string; gate: string; term: string };

/** ✕ removes the FULL pair everywhere (owner decision 2026-07-18): both twins, keywords AND their gate entries. */
export function applyPairRemove(cfg: ScoringConfig, meta: MatrixMeta, target: RemoveTarget): { removed: string[] } | ApplyError {
  if (target.kind === 'keyword') {
    const list = cfg.keywords[target.category];
    const k = list?.find((x) => x.term === target.term);
    if (!list || !k) return { error: `"${target.term}" not found in ${target.category}` };
    const group = k.pair ? list.filter((x) => x.pair === k.pair) : [k];
    const terms = group.map((x) => x.term);
    cfg.keywords[target.category] = list.filter((x) => !group.includes(x));
    // Path-linked twins also leave every gate list they were pushed into.
    for (const t of cfg.tracks) {
      for (const g of t.gates) {
        for (const lname of ['require', 'reject'] as const) {
          if (g[lname]) g[lname] = g[lname]!.filter((x) => !terms.includes(x));
        }
      }
    }
    for (const term of terms) { delete meta.gate_pairs[term]; delete meta.gate_langs[term]; delete meta.gate_same[term]; }
    return { removed: terms };
  }

  const track = cfg.tracks.find((t) => t.id === target.track);
  const gate = track?.gates.find((g) => g.id === target.gate);
  if (!gate) return { error: `gate ${target.gate} not found in ${target.track}` };
  const pairId = meta.gate_pairs[target.term];
  const terms = pairId
    ? Object.keys(meta.gate_pairs).filter((t) => meta.gate_pairs[t] === pairId)
    : [target.term];
  for (const lname of ['require', 'reject'] as const) {
    if (gate[lname]) gate[lname] = gate[lname]!.filter((x) => !terms.includes(x));
  }
  for (const term of terms) { delete meta.gate_pairs[term]; delete meta.gate_langs[term]; delete meta.gate_same[term]; }
  return { removed: terms };
}

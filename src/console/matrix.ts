// Calibration matrix projection (2026-07-18 redesign, mockups v3.3): ONE grid
// — 5 category rows × (in favor / against) × (EN / ES) — where the track is a
// `path` attribute of the word. This module is a pure PROJECTION over the
// existing ScoringConfig: gates keep owning verdicts (domain rule 2); nothing
// here softens them. DB-free so it can be unit-tested.

import { CATEGORIES, type Category, type ScoringConfig } from '../scoring';

export type MatrixCategory = Category | 'location';
/** Row order per the owner's sketch: Location, Role titles, Seniority, Industry, Tools. */
export const MATRIX_CATEGORIES: MatrixCategory[] = ['location', 'role_type', 'level_fit', 'domain', 'tool_overlap'];

/**
 * Console-only display metadata for GATE terms (config key 'matrix_meta').
 * Gate lists stay plain string[] — zero engine risk; this is cosmetic:
 * which column a gate term renders in, and which two terms form one pair.
 */
export interface MatrixMeta {
  /** Gate terms displayed in the Español column (absent = English). */
  gate_langs: Record<string, 'es'>;
  /** Pair id per gate term (both twins of one concept share an id). */
  gate_pairs: Record<string, string>;
}

export const emptyMeta = (): MatrixMeta => ({ gate_langs: {}, gate_pairs: {} });

export function parseMeta(raw: string | null | undefined): MatrixMeta {
  if (!raw) return emptyMeta();
  try {
    const p = JSON.parse(raw) as Partial<MatrixMeta>;
    return { gate_langs: p.gate_langs ?? {}, gate_pairs: p.gate_pairs ?? {} };
  } catch {
    return emptyMeta();
  }
}

export interface Chip {
  term: string;
  lang: 'en' | 'es';
  favor: boolean;
  category: MatrixCategory;
  /** Keyword chips: signed weight. Gate chips carry no weight (gates are absolute). */
  weight?: number;
  /** Track whose gate contains this term — the path badge. */
  path?: string;
  /** Points, when the owning gate is a penalty (display “−N”). */
  penalty?: number;
  /** True when this EN==ES concept is one stored entry mirrored into both columns. */
  mirrored?: boolean;
  /** Where the term lives — the remove round-trip needs it. */
  source: { kind: 'keyword' } | { kind: 'gate'; track: string; gate: string; list: 'require' | 'reject' };
}

export interface MatrixRow {
  category: MatrixCategory;
  favor_en: Chip[];
  favor_es: Chip[];
  against_en: Chip[];
  against_es: Chip[];
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

/** Strongest first (keyword chips by |weight| desc), gate chips after, stable otherwise. */
function sortChips(chips: Chip[]): Chip[] {
  return [...chips].sort((a, b) => Math.abs(b.weight ?? 0) - Math.abs(a.weight ?? 0));
}

export function buildMatrix(cfg: ScoringConfig, meta: MatrixMeta): MatrixRow[] {
  const gateIdx = indexGates(cfg);
  const rows = new Map<MatrixCategory, MatrixRow>();
  for (const cat of MATRIX_CATEGORIES) {
    rows.set(cat, { category: cat, favor_en: [], favor_es: [], against_en: [], against_es: [] });
  }
  const place = (row: MatrixRow, chip: Chip) => {
    const cell = chip.favor
      ? (chip.lang === 'es' ? row.favor_es : row.favor_en)
      : (chip.lang === 'es' ? row.against_es : row.against_en);
    cell.push(chip);
  };

  // Keyword chips (the 4 scoring categories). Path derived from gate membership.
  const keywordTerms = new Set<string>();
  for (const cat of CATEGORIES) {
    const row = rows.get(cat)!;
    const list = cfg.keywords[cat] ?? [];
    const pairCount = new Map<string, number>();
    for (const k of list) if (k.pair) pairCount.set(k.pair, (pairCount.get(k.pair) ?? 0) + 1);
    for (const k of list) {
      keywordTerms.add(k.term);
      const hit = gateIdx.get(k.term);
      const base: Chip = {
        term: k.term, lang: k.lang === 'es' ? 'es' : 'en', favor: k.weight > 0,
        category: cat, weight: k.weight, path: hit?.track, penalty: hit?.penalty,
        source: { kind: 'keyword' },
      };
      place(row, base);
      // A paired concept stored once (EN == ES) mirrors into the other column.
      if (k.pair && pairCount.get(k.pair) === 1) {
        place(row, { ...base, lang: base.lang === 'es' ? 'en' : 'es', mirrored: true });
      }
    }
  }

  // Gate-only chips (terms in no keyword list): title-scope gates project into
  // Role titles; everything else (location/text) is the Location row. A concept
  // stored as ONE term (same word in both languages, e.g. "colombia") MIRRORS
  // into both language columns — full EN/ES parity in the grid; a distinct twin
  // pair (latin america / latinoamérica) already fills both columns on its own.
  const gatePairCount = new Map<string, number>();
  for (const [term] of gateIdx) {
    if (keywordTerms.has(term)) continue;
    const pid = meta.gate_pairs[term] ?? term;
    gatePairCount.set(pid, (gatePairCount.get(pid) ?? 0) + 1);
  }
  for (const [term, hit] of gateIdx) {
    if (keywordTerms.has(term)) continue;
    const row = rows.get(hit.titleScope ? 'role_type' : 'location')!;
    const base: Chip = {
      term, lang: meta.gate_langs[term] === 'es' ? 'es' : 'en',
      favor: hit.list === 'require', category: row.category,
      path: hit.track, penalty: hit.penalty,
      source: { kind: 'gate', track: hit.track, gate: hit.gate, list: hit.list },
    };
    place(row, base);
    if ((gatePairCount.get(meta.gate_pairs[term] ?? term) ?? 0) === 1) {
      place(row, { ...base, lang: base.lang === 'es' ? 'en' : 'es', mirrored: true });
    }
  }

  return MATRIX_CATEGORIES.map((cat) => {
    const r = rows.get(cat)!;
    return {
      ...r,
      favor_en: sortChips(r.favor_en), favor_es: sortChips(r.favor_es),
      against_en: sortChips(r.against_en), against_es: sortChips(r.against_es),
    };
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
    return null;
  }

  const list = cfg.keywords[input.category];
  if (!list) return { error: 'invalid category' };
  if (list.some((k) => k.term === en || k.term === es)) return { error: `"${en}" / "${es}" is already listed` };
  const signed = input.favor ? weight : -weight;
  if (en === es) {
    // One concept, one entry (twice would double-count in scoring); mirrored in display.
    list.push({ term: en, weight: signed, pair: en });
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
    for (const term of terms) { delete meta.gate_pairs[term]; delete meta.gate_langs[term]; }
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
  for (const term of terms) { delete meta.gate_pairs[term]; delete meta.gate_langs[term]; }
  return { removed: terms };
}

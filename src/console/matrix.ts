// Calibration matrix projection (2026-07-19 rebuild): the config is now one
// concept = one object with BOTH languages ({en, es}). This module is a pure
// PROJECTION over that config, 1:1 — no mirror, no cloning, no display metadata.
// The grid is BANK-style: one collapsible GROUP per category, each split into
// In favor / Against, rows = English | Español | Strength | Path. Gates keep
// owning verdicts (domain rule 2). DB-free so it can be unit-tested.

import { CATEGORIES, type Category, type ScoringConfig } from '../scoring';

export type MatrixCategory = Category | 'location';
/** Row order per the owner's sketch: Location, Role titles, Seniority, Industry, Tools. */
export const MATRIX_CATEGORIES: MatrixCategory[] = ['location', 'role_type', 'level_fit', 'domain', 'tool_overlap'];

/** Where a concept lives — the remove round-trip needs it. */
export type ConceptSource =
  | { kind: 'keyword' }
  | { kind: 'gate'; track: string; gate: string; list: 'require' | 'reject' };

/** One concept = ONE row: English in front of Español (es='' = not filled yet). */
export interface ConceptRow {
  category: MatrixCategory;
  favor: boolean;
  en: string;
  es: string;
  /** Keyword rows: signed weight. Gate rows carry no weight (gates are absolute). */
  weight?: number;
  /** Points, when the owning gate is a penalty (display "−N"). */
  penalty?: number;
  /** Track whose gate contains this term — the path badge. */
  path?: string;
  source: ConceptSource;
}

/** A collapsible category group with its concept rows. */
export interface MatrixGroup {
  category: MatrixCategory;
  favor: ConceptRow[];
  against: ConceptRow[];
  count: number;
}

interface GateHit { track: string; gate: string; list: 'require' | 'reject'; penalty?: number; titleScope: boolean }

/** Index every gate term (by en, first hit wins) for keyword path derivation. */
function indexGates(cfg: ScoringConfig): Map<string, GateHit> {
  const idx = new Map<string, GateHit>();
  for (const t of cfg.tracks) {
    for (const g of t.gates) {
      const titleScope = g.scope === 'title' || g.scope === 'title_location';
      for (const list of ['require', 'reject'] as const) {
        for (const term of g[list] ?? []) {
          if (!idx.has(term.en)) {
            idx.set(term.en, {
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

function sortRows(rows: ConceptRow[]): ConceptRow[] {
  return [...rows].sort((a, b) => Math.abs(b.weight ?? 0) - Math.abs(a.weight ?? 0));
}

/** Projects the ScoringConfig into the BANK-style matrix, DB 1:1. */
export function buildMatrix(cfg: ScoringConfig): MatrixGroup[] {
  const gateIdx = indexGates(cfg);
  const groups = new Map<MatrixCategory, { favor: ConceptRow[]; against: ConceptRow[] }>();
  for (const cat of MATRIX_CATEGORIES) groups.set(cat, { favor: [], against: [] });
  const push = (row: ConceptRow) => {
    const g = groups.get(row.category)!;
    (row.favor ? g.favor : g.against).push(row);
  };

  // Keyword concepts (the 4 scoring categories). Path derived from gate membership.
  const keywordEns = new Set<string>();
  for (const cat of CATEGORIES) {
    for (const k of cfg.keywords[cat] ?? []) {
      keywordEns.add(k.en);
      const hit = gateIdx.get(k.en);
      push({
        category: cat, favor: k.weight > 0, en: k.en, es: k.es,
        weight: k.weight, path: hit?.track, penalty: hit?.penalty,
        source: { kind: 'keyword' },
      });
    }
  }

  // Gate-only concepts (in a gate, not in any keyword list). Title-scope gates
  // project into Role titles; location/text gates into the Location row.
  const seenGate = new Set<string>();
  for (const t of cfg.tracks) {
    for (const g of t.gates) {
      const titleScope = g.scope === 'title' || g.scope === 'title_location';
      const category: MatrixCategory = titleScope ? 'role_type' : 'location';
      const penalty = g.type === 'penalty' ? (g.points ?? 0) : undefined;
      for (const list of ['require', 'reject'] as const) {
        for (const term of g[list] ?? []) {
          if (keywordEns.has(term.en) || seenGate.has(term.en)) continue;
          seenGate.add(term.en);
          push({
            category, favor: list === 'require', en: term.en, es: term.es,
            path: t.id, penalty, source: { kind: 'gate', track: t.id, gate: g.id, list },
          });
        }
      }
    }
  }

  return MATRIX_CATEGORIES.map((cat) => {
    const g = groups.get(cat)!;
    const favor = sortRows(g.favor);
    const against = sortRows(g.against);
    return { category: cat, favor, against, count: favor.length + against.length };
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

function findGate(cfg: ScoringConfig, track: string, category: MatrixCategory, favor: boolean) {
  const t = cfg.tracks.find((x) => x.id === track);
  if (!t) return null;
  return t.gates.find((g) => {
    const titleScope = g.scope === 'title' || g.scope === 'title_location';
    const scopeOk = category === 'location' ? !titleScope : titleScope;
    return scopeOk && (favor ? (g.require?.length ?? 0) > 0 : (g.reject?.length ?? 0) > 0);
  }) ?? null;
}

/** Adds one concept (EN + ES, both required) to the draft config in place. */
export function applyWordAdd(cfg: ScoringConfig, input: WordAddInput): ApplyError | null {
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
      return { error: `track ${input.path} has no ${input.favor ? 'require' : 'reject'} location list — add it once via Advanced raw JSON` };
    }
    const list = input.favor ? (gate.require ?? (gate.require = [])) : (gate.reject ?? (gate.reject = []));
    if (list.some((t) => t.en === en)) return { error: `"${en}" is already listed` };
    list.push({ en, es });
    return null;
  }

  const list = cfg.keywords[input.category];
  if (!list) return { error: 'invalid category' };
  if (list.some((k) => k.en === en)) return { error: `"${en}" is already listed` };
  list.push({ en, es, weight: input.favor ? weight : -weight });
  if (input.path) {
    const gate = findGate(cfg, input.path, input.category, input.favor);
    if (!gate) {
      return { error: `track ${input.path} has no ${input.favor ? 'require' : 'reject'} title gate — path not available here` };
    }
    const glist = input.favor ? (gate.require ?? (gate.require = [])) : (gate.reject ?? (gate.reject = []));
    if (!glist.some((t) => t.en === en)) glist.push({ en, es });
  }
  return null;
}

export type RemoveTarget =
  | { kind: 'keyword'; category: Category; en: string }
  | { kind: 'gate'; track: string; gate: string; en: string };

/** ✕ removes the concept everywhere (keyword list AND any gate it was linked into). */
export function applyPairRemove(cfg: ScoringConfig, target: RemoveTarget): { removed: string[] } | ApplyError {
  if (target.kind === 'keyword') {
    const list = cfg.keywords[target.category];
    const k = list?.find((x) => x.en === target.en);
    if (!list || !k) return { error: `"${target.en}" not found in ${target.category}` };
    cfg.keywords[target.category] = list.filter((x) => x.en !== target.en);
    for (const t of cfg.tracks) {
      for (const g of t.gates) {
        for (const lname of ['require', 'reject'] as const) {
          if (g[lname]) g[lname] = g[lname]!.filter((x) => x.en !== target.en);
        }
      }
    }
    return { removed: [target.en] };
  }

  const track = cfg.tracks.find((t) => t.id === target.track);
  const gate = track?.gates.find((g) => g.id === target.gate);
  if (!gate) return { error: `gate ${target.gate} not found in ${target.track}` };
  for (const lname of ['require', 'reject'] as const) {
    if (gate[lname]) gate[lname] = gate[lname]!.filter((x) => x.en !== target.en);
  }
  return { removed: [target.en] };
}

export type EditTarget =
  | { kind: 'keyword'; category: Category; oldEn: string; en: string; es: string; weight: number }
  | { kind: 'gate'; track: string; gate: string; oldEn: string; en: string; es: string };

const VALID_WEIGHTS = new Set([1, 2, 3, -2, -3]);

/** ✏️ edits a concept in place (both languages required). Keeps path-linked gate copies in sync. */
export function applyWordEdit(cfg: ScoringConfig, t: EditTarget): ApplyError | null {
  const oldEn = norm(t.oldEn);
  const en = norm(t.en);
  const es = norm(t.es);
  if (!en || !es) return { error: 'both languages are required — English AND Español' };

  if (t.kind === 'keyword') {
    const list = cfg.keywords[t.category];
    const k = list?.find((x) => x.en === oldEn);
    if (!list || !k) return { error: `"${t.oldEn}" not found in ${t.category}` };
    if (en !== oldEn && list.some((x) => x !== k && x.en === en)) return { error: `"${en}" already exists` };
    const weight = Math.round(t.weight);
    if (!VALID_WEIGHTS.has(weight)) return { error: 'strength must be +1..+3 or −2/−3' };
    k.en = en; k.es = es; k.weight = weight;
    if (en !== oldEn) {
      // keep path-linked gate copies in sync with the renamed concept
      for (const tr of cfg.tracks) {
        for (const g of tr.gates) {
          for (const lname of ['require', 'reject'] as const) {
            const item = g[lname]?.find((x) => x.en === oldEn);
            if (item) { item.en = en; item.es = es; }
          }
        }
      }
    }
    return null;
  }

  const track = cfg.tracks.find((x) => x.id === t.track);
  const gate = track?.gates.find((g) => g.id === t.gate);
  if (!gate) return { error: `gate ${t.gate} not found in ${t.track}` };
  for (const lname of ['require', 'reject'] as const) {
    const item = gate[lname]?.find((x) => x.en === oldEn);
    if (item) {
      if (en !== oldEn && gate[lname]!.some((x) => x !== item && x.en === en)) return { error: `"${en}" already exists` };
      item.en = en; item.es = es;
      return null;
    }
  }
  return { error: `"${t.oldEn}" not found in gate ${t.gate}` };
}

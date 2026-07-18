// Bank block form helpers (docs/UI.md §2): pure normalization for the /blocks
// add/edit console forms, kept DB-free so it can be unit-tested. The owner
// authors/edits content here; blocks enter as `draft` (domain rule 1). Column
// constraints mirror migrations/0001 (section/angle/es_status CHECK enums,
// fact_key NOT NULL — the route fills an empty fact_key with the block id).

export const SECTIONS = ['summary', 'skills', 'experience', 'projects'] as const;
export const ANGLES = ['data', 'compliance', 'operations', 'leadership'] as const;

const ID_PREFIX: Record<string, string> = {
  summary: 'sum', skills: 'skl', experience: 'exp', projects: 'prj',
};

export interface NormalizedBlock {
  section: string;
  anchor_id: string | null;
  angle: string | null;
  fact_key: string;
  text_en: string;
  text_es: string | null;
  es_status: 'draft' | 'missing';
  tags: string;
  evidence: string;
  source: string;
}

/**
 * Validates + coerces raw /blocks form fields. Returns {error} for a bad
 * section, missing text_en, or an angle outside the enum. es_status is derived
 * from ES presence; fact_key may be '' here — the create/update route fills it
 * with the block id (fact_key is NOT NULL). `status` is set by the route.
 */
export function normalizeBlockInput(
  body: Record<string, unknown>,
): NormalizedBlock | { error: string } {
  const s = (k: string) => String(body[k] ?? '').trim();
  const section = s('section');
  if (!(SECTIONS as readonly string[]).includes(section)) return { error: 'invalid section' };
  const text_en = s('text_en');
  if (!text_en) return { error: 'text_en is required' };
  const angle = s('angle');
  if (angle && !(ANGLES as readonly string[]).includes(angle)) return { error: 'invalid angle' };
  const text_es = s('text_es') || null;
  return {
    section,
    anchor_id: s('anchor_id') || null,
    angle: angle || null,
    fact_key: s('fact_key'),
    text_en,
    text_es,
    es_status: text_es ? 'draft' : 'missing',
    tags: s('tags'),
    evidence: s('evidence'),
    source: s('source'),
  };
}

/** Unique, section-prefixed block id (opaque PK; never shown in a CV). */
export function newBlockId(section: string): string {
  return `${ID_PREFIX[section] ?? 'blk'}-${crypto.randomUUID().slice(0, 8)}`;
}

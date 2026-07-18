// Bank block form helpers (docs/UI.md §2): pure normalization for the /blocks
// add/edit console forms, kept DB-free so it can be unit-tested. The owner
// authors/edits content here; SAVING is the approval (owner decision
// 2026-07-18, bank v4) — the routes write status directly.
// Post-0007 schema: no fact_key/evidence/source/suggested/angle; the skill
// category is the real column `skcat`.

export const SECTIONS = ['summary', 'skills', 'experience', 'projects'] as const;
export const SKCATS = ['technical', 'methodologies', 'academic', 'emerging'] as const;

const ID_PREFIX: Record<string, string> = {
  summary: 'sum', skills: 'skl', experience: 'exp', projects: 'prj',
};

export interface NormalizedBlock {
  section: string;
  anchor_id: string | null;
  skcat: string | null;
  text_en: string;
  text_es: string;
  tags: string;
}

/**
 * Validates + coerces raw /blocks form fields. Guardrails against
 * silently-invisible content (2026-07-18 audit): an experience/project bullet
 * without a role, or a skill without a category, is accepted by the DB but can
 * never be placed in a CV slot — reject at the door instead. English AND
 * Spanish are both required (owner rule 2026-07-18: everything in the bank
 * exists in both languages); `status` is set by the route.
 */
export function normalizeBlockInput(
  body: Record<string, unknown>,
): NormalizedBlock | { error: string } {
  const s = (k: string) => String(body[k] ?? '').trim();
  const section = s('section');
  if (!(SECTIONS as readonly string[]).includes(section)) return { error: 'invalid section' };
  const text_en = s('text_en');
  if (!text_en) return { error: 'text_en is required' };
  const anchor_id = s('anchor_id') || null;
  const skcat = s('skcat') || null;
  if ((section === 'experience' || section === 'projects') && !anchor_id) {
    return { error: `${section} blocks need a role (otherwise they can never appear in a CV)` };
  }
  if (section === 'skills' && (!skcat || !(SKCATS as readonly string[]).includes(skcat))) {
    return { error: 'skills need a category (technical / methodologies / academic / emerging)' };
  }
  if (section !== 'skills' && skcat) {
    return { error: 'only skills have a category' };
  }
  if ((section === 'summary' || section === 'skills') && anchor_id) {
    return { error: `${section} entries are not tied to a role — leave the role empty` };
  }
  const text_es = s('text_es');
  if (!text_es) return { error: 'text_es is required (every bullet exists in English AND Spanish)' };
  return {
    section,
    anchor_id,
    skcat,
    text_en,
    text_es,
    tags: s('tags'),
  };
}

/** Unique, section-prefixed block id (opaque PK; never shown in a CV). */
export function newBlockId(section: string): string {
  return `${ID_PREFIX[section] ?? 'blk'}-${crypto.randomUUID().slice(0, 8)}`;
}

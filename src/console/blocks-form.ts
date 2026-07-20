// Blocks Bank form helpers (docs/UI.md §2; v6 2026-07-18, owner's sketch): a role or
// group is edited as ONE form — its fields plus ALL its bullets — saved in one
// transaction. This module is the pure, DB-free parser for that form's bullet
// fields so it can be unit-tested. SAVING is the approval (owner decision):
// the routes write status='approved' directly.

export const SECTIONS = ['summary', 'skills', 'experience', 'projects'] as const;
export const SKCATS = ['technical', 'methodologies', 'academic', 'emerging'] as const;

const ID_PREFIX: Record<string, string> = {
  summary: 'sum', skills: 'skl', experience: 'exp', projects: 'prj',
};

export interface BulletEdits {
  /** Existing bullets kept: id + both texts (EN AND ES required). */
  updates: Array<{ id: string; en: string; es: string }>;
  /** Existing bullets marked 🗑 — deleted in the same save. */
  deletes: string[];
  /** New bullets added via ＋ add a bullet (both texts required). */
  added: Array<{ en: string; es: string }>;
}

/**
 * Parses the bullet fields of a role/group save form:
 *   en_<id> / es_<id>   existing bullet texts
 *   del_<id> = '1'      existing bullet marked for deletion (its texts ignored)
 *   new_en_<k> / new_es_<k>  added bullet pairs (empty pair = skipped)
 * EN+ES are both required on every kept/added bullet (owner rule).
 */
export function parseBulletEdits(body: Record<string, unknown>): BulletEdits | { error: string } {
  const s = (v: unknown) => String(v ?? '').trim();
  const deletes: string[] = [];
  for (const key of Object.keys(body)) {
    const del = /^del_(.+)$/.exec(key);
    if (del && s(body[key]) === '1') deletes.push(del[1]!);
  }
  const updates: BulletEdits['updates'] = [];
  const added: BulletEdits['added'] = [];
  for (const key of Object.keys(body)) {
    const ex = /^en_(.+)$/.exec(key);
    if (ex) {
      const id = ex[1]!;
      if (deletes.includes(id)) continue;
      const en = s(body[key]);
      const es = s(body[`es_${id}`]);
      if (!en || !es) return { error: 'every bullet needs BOTH texts — English AND Español' };
      updates.push({ id, en, es });
      continue;
    }
    const nw = /^new_en_(.+)$/.exec(key);
    if (nw) {
      const en = s(body[key]);
      const es = s(body[`new_es_${nw[1]!}`]);
      if (!en && !es) continue;
      if (!en || !es) return { error: 'a new bullet needs BOTH texts — English AND Español' };
      added.push({ en, es });
    }
  }
  return { updates, deletes, added };
}

/** Unique, section-prefixed block id (opaque PK; never shown in a CV). */
export function newBlockId(section: string): string {
  return `${ID_PREFIX[section] ?? 'blk'}-${crypto.randomUUID().slice(0, 8)}`;
}

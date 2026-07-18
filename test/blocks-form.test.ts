import { describe, expect, it } from 'vitest';
import { newBlockId, parseBulletEdits, type BulletEdits } from '../src/console/blocks-form';

const ok = (r: BulletEdits | { error: string }): BulletEdits => {
  if ('error' in r) throw new Error(`unexpected error: ${r.error}`);
  return r;
};

describe('parseBulletEdits (bank v6: one form per role/group)', () => {
  it('collects kept bullets with both texts, trimmed', () => {
    const r = ok(parseBulletEdits({
      'en_exp-a1': ' Led X ', 'es_exp-a1': ' Lideré X ',
      'en_exp-b2': 'Did Y', 'es_exp-b2': 'Hice Y',
    }));
    expect(r.updates).toEqual([
      { id: 'exp-a1', en: 'Led X', es: 'Lideré X' },
      { id: 'exp-b2', en: 'Did Y', es: 'Hice Y' },
    ]);
    expect(r.deletes).toEqual([]);
    expect(r.added).toEqual([]);
  });

  it('a 🗑-marked bullet is deleted and its texts are ignored (even if blank)', () => {
    const r = ok(parseBulletEdits({
      'en_exp-a1': '', 'es_exp-a1': '', 'del_exp-a1': '1',
      'en_exp-b2': 'Did Y', 'es_exp-b2': 'Hice Y',
    }));
    expect(r.deletes).toEqual(['exp-a1']);
    expect(r.updates).toEqual([{ id: 'exp-b2', en: 'Did Y', es: 'Hice Y' }]);
  });

  it('del flag not set to 1 does not delete', () => {
    const r = ok(parseBulletEdits({ 'en_exp-a1': 'x', 'es_exp-a1': 'y', 'del_exp-a1': '' }));
    expect(r.deletes).toEqual([]);
    expect(r.updates).toHaveLength(1);
  });

  it('kept bullet missing one language is rejected', () => {
    expect(parseBulletEdits({ 'en_exp-a1': 'only english', 'es_exp-a1': '  ' }))
      .toMatchObject({ error: expect.stringContaining('BOTH') });
  });

  it('new bullet pairs are collected; empty pairs are skipped', () => {
    const r = ok(parseBulletEdits({
      'new_en_1': 'New thing', 'new_es_1': 'Cosa nueva',
      'new_en_2': '', 'new_es_2': '',
    }));
    expect(r.added).toEqual([{ en: 'New thing', es: 'Cosa nueva' }]);
  });

  it('half-filled new bullet is rejected', () => {
    expect(parseBulletEdits({ 'new_en_1': 'English only', 'new_es_1': '' }))
      .toMatchObject({ error: expect.stringContaining('BOTH') });
  });

  it('empty form is a no-op', () => {
    expect(ok(parseBulletEdits({}))).toEqual({ updates: [], deletes: [], added: [] });
  });
});

describe('newBlockId', () => {
  it('prefixes by section', () => {
    expect(newBlockId('experience')).toMatch(/^exp-[0-9a-f]{8}$/);
    expect(newBlockId('skills')).toMatch(/^skl-[0-9a-f]{8}$/);
    expect(newBlockId('summary')).toMatch(/^sum-[0-9a-f]{8}$/);
  });
});

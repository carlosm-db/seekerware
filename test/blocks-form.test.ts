import { describe, expect, it } from 'vitest';
import { normalizeBlockInput, type NormalizedBlock } from '../src/console/blocks-form';

const ok = (r: NormalizedBlock | { error: string }): NormalizedBlock => {
  if ('error' in r) throw new Error(`unexpected error: ${r.error}`);
  return r;
};

describe('normalizeBlockInput (post-0007 schema)', () => {
  it('accepts a valid skill with both languages', () => {
    const r = ok(normalizeBlockInput({
      section: 'skills', text_en: 'SQL', text_es: 'SQL', skcat: 'technical', tags: 'sql',
    }));
    expect(r).toMatchObject({
      section: 'skills', anchor_id: null, skcat: 'technical',
      text_en: 'SQL', text_es: 'SQL', tags: 'sql',
    });
  });

  it('rejects a missing ES text (EN+ES always — owner rule 2026-07-18)', () => {
    const r = normalizeBlockInput({ section: 'summary', text_en: 'Hi' });
    expect('error' in r && r.error).toMatch(/text_es is required/);
  });

  it('rejects blank text_es', () => {
    const r = normalizeBlockInput({ section: 'summary', text_en: 'Hi', text_es: '   ' });
    expect('error' in r && r.error).toMatch(/text_es is required/);
  });

  it('accepts an experience bullet tied to a role', () => {
    const r = ok(normalizeBlockInput({ section: 'experience', text_en: 'Led X', text_es: 'Lideré X', anchor_id: 'DLAB1' }));
    expect(r.anchor_id).toBe('DLAB1');
    expect(r.skcat).toBeNull();
  });

  it('trims text', () => {
    const r = ok(normalizeBlockInput({ section: 'skills', text_en: '  Python  ', text_es: ' Python ', skcat: 'technical' }));
    expect(r.text_en).toBe('Python');
    expect(r.text_es).toBe('Python');
  });

  it('rejects a bad section', () => {
    expect(normalizeBlockInput({ section: 'nope', text_en: 'x' })).toEqual({ error: 'invalid section' });
  });

  it('rejects blank text_en', () => {
    expect(normalizeBlockInput({ section: 'skills', text_en: '   ', skcat: 'technical' }))
      .toEqual({ error: 'text_en is required' });
  });

  // Guardrails against silently-invisible content (2026-07-18 audit)
  it('rejects an experience bullet without a role (it could never render)', () => {
    const r = normalizeBlockInput({ section: 'experience', text_en: 'Led X' });
    expect('error' in r && r.error).toMatch(/need a role/);
  });

  it('rejects a skill without a category (it would vanish from CVs)', () => {
    const r = normalizeBlockInput({ section: 'skills', text_en: 'SQL' });
    expect('error' in r && r.error).toMatch(/category/);
  });

  it('rejects an invalid category', () => {
    const r = normalizeBlockInput({ section: 'skills', text_en: 'SQL', skcat: 'wrong' });
    expect('error' in r && r.error).toMatch(/category/);
  });

  it('rejects a category on a non-skill', () => {
    const r = normalizeBlockInput({ section: 'summary', text_en: 'Hi', skcat: 'technical' });
    expect('error' in r && r.error).toMatch(/only skills/);
  });

  it('rejects a summary line tied to a role', () => {
    const r = normalizeBlockInput({ section: 'summary', text_en: 'Hi', anchor_id: 'BNS1' });
    expect('error' in r && r.error).toMatch(/leave the role empty/);
  });
});

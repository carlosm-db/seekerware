import { describe, expect, it } from 'vitest';
import { normalizeBlockInput, type NormalizedBlock } from '../src/console/blocks-form';

const ok = (r: NormalizedBlock | { error: string }): NormalizedBlock => {
  if ('error' in r) throw new Error(`unexpected error: ${r.error}`);
  return r;
};

describe('normalizeBlockInput', () => {
  it('accepts a valid block and derives es_status when ES is present', () => {
    const r = ok(normalizeBlockInput({
      section: 'skills', text_en: 'SQL', text_es: 'SQL', tags: 'skcat:technical',
      anchor_id: '', angle: '', fact_key: 'skl-sql', evidence: 'e', source: 's',
    }));
    expect(r).toMatchObject({
      section: 'skills', anchor_id: null, angle: null, fact_key: 'skl-sql',
      text_en: 'SQL', text_es: 'SQL', es_status: 'draft', tags: 'skcat:technical',
    });
  });

  it('missing ES -> text_es null, es_status missing', () => {
    const r = ok(normalizeBlockInput({ section: 'summary', text_en: 'Hi' }));
    expect(r.text_es).toBeNull();
    expect(r.es_status).toBe('missing');
  });

  it('coerces empty anchor/angle to null and keeps a valid angle + anchor', () => {
    const r = ok(normalizeBlockInput({ section: 'experience', text_en: 'Led X', angle: 'leadership', anchor_id: 'DLAB1' }));
    expect(r.angle).toBe('leadership');
    expect(r.anchor_id).toBe('DLAB1');
    expect(r.tags).toBe('');
  });

  it('trims text and fact_key (route fills empty fact_key with the id)', () => {
    const r = ok(normalizeBlockInput({ section: 'skills', text_en: '  Python  ', fact_key: '  ', tags: 'skcat:technical' }));
    expect(r.text_en).toBe('Python');
    expect(r.fact_key).toBe('');
  });

  it('rejects a bad section', () => {
    expect(normalizeBlockInput({ section: 'nope', text_en: 'x' })).toEqual({ error: 'invalid section' });
  });

  it('rejects blank text_en', () => {
    expect(normalizeBlockInput({ section: 'skills', text_en: '   ', tags: 'skcat:technical' })).toEqual({ error: 'text_en is required' });
  });

  it('rejects an angle outside the enum', () => {
    expect(normalizeBlockInput({ section: 'experience', text_en: 'x', angle: 'wrong', anchor_id: 'BNS1' })).toEqual({ error: 'invalid angle' });
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

  it('rejects a summary line tied to a role', () => {
    const r = normalizeBlockInput({ section: 'summary', text_en: 'Hi', anchor_id: 'BNS1' });
    expect('error' in r && r.error).toMatch(/leave the anchor empty/);
  });
});

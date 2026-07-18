import { describe, expect, it } from 'vitest';
import { buildSlotMap } from '../src/ia/cv_factory';
import type { CatalogBlock, Selection } from '../src/ia/agents';

function blk(id: string, section: string, anchor_id: string | null, tags: string, text: string): CatalogBlock {
  return { id, section, anchor_id, angle: null, tags, text };
}

/** Canonical tokens as the template would carry them ({{name}}, unpadded). */
const tok = (...names: string[]) => names.map((name) => ({ name, raw: `{{${name}}}` }));

const catalog: CatalogBlock[] = [
  blk('sum-1', 'summary', null, '', 'Summary bullet one'),
  blk('sum-2', 'summary', null, '', 'Summary bullet two'),
  blk('sk-sql', 'skills', null, 'skcat:technical', 'SQL'),
  blk('sk-py', 'skills', null, 'skcat:technical', 'Python'),
  blk('sk-agile', 'skills', null, 'skcat:methodologies', 'Agile'),
  blk('e-bns1-a', 'experience', 'BNS1', '', 'Led X'),
  blk('e-bns1-b', 'experience', 'BNS1', '', 'Built Y'),
  blk('e-dlab-a', 'experience', 'DLAB1', '', 'Advised Z'),
];
const byId = new Map(catalog.map((b) => [b.id, b]));
const roleCodes = ['DLAB1', 'BNS1', 'BAC1'];
const selection: Selection = {
  summary: ['sum-1', 'sum-2'],
  skills: ['sk-sql', 'sk-py', 'sk-agile'],
  experience: ['e-bns1-a', 'e-bns1-b', 'e-dlab-a'],
  projects: [],
  rationale: 'x',
};
const contact = { '{{phone}}': '+1', '{{location}}': 'Medellín' };

describe('buildSlotMap', () => {
  it('fills contact, summary, skills-by-category, and responsibilities-by-role', () => {
    const fill = buildSlotMap(
      tok('phone', 'location', 'sum_1', 'sum_2', 'skills_technical', 'skills_methodologies', 'BNS1R1', 'BNS1R2', 'DLAB1R1'),
      selection, byId, roleCodes, contact,
    );
    expect(fill.map['{{phone}}']).toBe('+1');
    expect(fill.map['{{location}}']).toBe('Medellín');
    expect(fill.map['{{sum_1}}']).toBe('Summary bullet one');
    expect(fill.map['{{sum_2}}']).toBe('Summary bullet two');
    expect(fill.map['{{skills_technical}}']).toBe('SQL, Python');
    expect(fill.map['{{skills_methodologies}}']).toBe('Agile');
    expect(fill.map['{{BNS1R1}}']).toBe('Led X');
    expect(fill.map['{{BNS1R2}}']).toBe('Built Y');
    expect(fill.map['{{DLAB1R1}}']).toBe('Advised Z');
    expect(fill.filled).toHaveLength(9);
    expect(fill.blanked).toEqual([]);
    expect(fill.unrecognized).toEqual([]);
    expect(fill.unplaced_blocks).toEqual([]); // every selected block landed
  });

  it('replaces PADDED hand-typed tokens by their raw literal', () => {
    const fill = buildSlotMap(
      [{ name: 'phone', raw: '{{ phone }}' }, { name: 'sum_1', raw: '{{  sum_1}}' }],
      selection, byId, roleCodes, contact,
    );
    expect(fill.map['{{ phone }}']).toBe('+1'); // keyed by the raw literal
    expect(fill.map['{{  sum_1}}']).toBe('Summary bullet one');
    expect(fill.map['{{phone}}']).toBeUndefined(); // no phantom canonical entry
  });

  it('empties unused slots and unknown tokens, and reports them; never leaks a raw {{', () => {
    const fill = buildSlotMap(
      tok('sum_3', 'BNS1R3', 'skills_emerging', 'BAC1R1', 'stray_token'),
      selection, byId, roleCodes, contact,
    );
    expect(fill.map['{{sum_3}}']).toBe(''); // only 2 summary blocks selected
    expect(fill.map['{{BNS1R3}}']).toBe(''); // only 2 BNS1 responsibilities selected
    expect(fill.map['{{skills_emerging}}']).toBe(''); // no emerging skills selected
    expect(fill.map['{{BAC1R1}}']).toBe(''); // role has no selected blocks
    expect(fill.map['{{stray_token}}']).toBe(''); // unrecognized -> empty
    expect(fill.blanked).toEqual(['sum_3', 'BNS1R3', 'skills_emerging', 'BAC1R1']);
    expect(fill.unrecognized).toEqual(['stray_token']);
    for (const v of Object.values(fill.map)) expect(v).not.toContain('{{');
  });

  it('reports selected blocks that found no slot (template lacks tokens)', () => {
    const fill = buildSlotMap(tok('sum_1'), selection, byId, roleCodes, contact);
    expect(fill.used_block_ids).toEqual(['sum-1']);
    // everything else selected but unplaced — the truthful audit trail
    expect(fill.unplaced_blocks.sort()).toEqual(
      ['sum-2', 'sk-sql', 'sk-py', 'sk-agile', 'e-bns1-a', 'e-bns1-b', 'e-dlab-a'].sort(),
    );
  });

  it('preserves selection order within a role', () => {
    const reordered: Selection = { ...selection, experience: ['e-bns1-b', 'e-bns1-a', 'e-dlab-a'] };
    const fill = buildSlotMap(tok('BNS1R1', 'BNS1R2'), reordered, byId, roleCodes, contact);
    expect(fill.map['{{BNS1R1}}']).toBe('Built Y');
    expect(fill.map['{{BNS1R2}}']).toBe('Led X');
  });

  it('only fills tokens present in the template (does not invent slots)', () => {
    const fill = buildSlotMap(tok('sum_1'), selection, byId, roleCodes, contact);
    expect(Object.keys(fill.map)).toEqual(['{{sum_1}}']);
  });
});

import { describe, expect, it } from 'vitest';
import { buildSlotMap } from '../src/ia/cv_factory';
import type { CatalogBlock, Selection } from '../src/ia/agents';

function blk(id: string, section: string, anchor_id: string | null, tags: string, text: string): CatalogBlock {
  return { id, section, anchor_id, angle: null, tags, text };
}

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
    const tokens = new Set([
      'phone', 'location', 'sum_1', 'sum_2',
      'skills_technical', 'skills_methodologies', 'BNS1R1', 'BNS1R2', 'DLAB1R1',
    ]);
    const map = buildSlotMap(tokens, selection, byId, roleCodes, contact);
    expect(map['{{phone}}']).toBe('+1');
    expect(map['{{location}}']).toBe('Medellín');
    expect(map['{{sum_1}}']).toBe('Summary bullet one');
    expect(map['{{sum_2}}']).toBe('Summary bullet two');
    expect(map['{{skills_technical}}']).toBe('SQL, Python');
    expect(map['{{skills_methodologies}}']).toBe('Agile');
    expect(map['{{BNS1R1}}']).toBe('Led X');
    expect(map['{{BNS1R2}}']).toBe('Built Y');
    expect(map['{{DLAB1R1}}']).toBe('Advised Z');
  });

  it('empties unused slots and unknown tokens; never leaks a raw {{', () => {
    const tokens = new Set(['sum_3', 'BNS1R3', 'skills_emerging', 'BAC1R1', 'stray_token']);
    const map = buildSlotMap(tokens, selection, byId, roleCodes, contact);
    expect(map['{{sum_3}}']).toBe(''); // only 2 summary blocks selected
    expect(map['{{BNS1R3}}']).toBe(''); // only 2 BNS1 responsibilities selected
    expect(map['{{skills_emerging}}']).toBe(''); // no emerging skills selected
    expect(map['{{BAC1R1}}']).toBe(''); // role has no selected blocks
    expect(map['{{stray_token}}']).toBe(''); // unrecognized -> empty
    for (const v of Object.values(map)) expect(v).not.toContain('{{');
  });

  it('preserves selection order within a role', () => {
    const tokens = new Set(['BNS1R1', 'BNS1R2']);
    const reordered: Selection = { ...selection, experience: ['e-bns1-b', 'e-bns1-a', 'e-dlab-a'] };
    const map = buildSlotMap(tokens, reordered, byId, roleCodes, contact);
    expect(map['{{BNS1R1}}']).toBe('Built Y');
    expect(map['{{BNS1R2}}']).toBe('Led X');
  });

  it('only fills tokens present in the template (does not invent slots)', () => {
    const tokens = new Set(['sum_1']);
    const map = buildSlotMap(tokens, selection, byId, roleCodes, contact);
    expect(Object.keys(map)).toEqual(['{{sum_1}}']);
  });
});

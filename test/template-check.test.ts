import { describe, expect, it } from 'vitest';
import { checkTemplate, type BankShape } from '../src/console/template-check';

const tok = (...names: string[]) => names.map((name) => ({ name, raw: `{{${name}}}` }));
const bank: BankShape = {
  roles: [
    { id: 'DLAB1', bullets: 5, approved: 5 },
    { id: 'BNS1', bullets: 12, approved: 12 },
  ],
  skillCats: { technical: 11, methodologies: 10, academic: 5, emerging: 4 },
  summaryCount: 12,
};

const fullTokens = tok(
  'phone', 'location', 'sum_1', 'sum_2',
  'skills_technical', 'skills_methodologies', 'skills_academic', 'skills_emerging',
  'DLAB1R1', 'DLAB1R2', 'DLAB1R3', 'DLAB1R4', 'DLAB1R5', 'BNS1R1', 'BNS1R2',
);

describe('checkTemplate', () => {
  it('clean template + bank -> single ok', () => {
    const f = checkTemplate(fullTokens, bank);
    expect(f).toEqual([{ level: 'ok', text: expect.stringContaining('match') }]);
  });

  it('flags a role with bullets but no tokens (silent-content error)', () => {
    const f = checkTemplate(tok('phone', 'location', 'sum_1', 'skills_technical', 'skills_methodologies', 'skills_academic', 'skills_emerging', 'DLAB1R1'), bank);
    expect(f.some((x) => x.level === 'error' && x.text.includes('BNS1') && x.text.includes('NO'))).toBe(true);
  });

  it('flags more slots than bullets (blank lines)', () => {
    const small: BankShape = { ...bank, roles: [{ id: 'DLAB1', bullets: 2, approved: 2 }, { id: 'BNS1', bullets: 12, approved: 12 }] };
    const f = checkTemplate(fullTokens, small);
    expect(f.some((x) => x.level === 'warn' && x.text.includes('DLAB1') && x.text.includes('blank'))).toBe(true);
  });

  it('flags approved shortfall against slots', () => {
    const unapproved: BankShape = { ...bank, roles: [{ id: 'DLAB1', bullets: 5, approved: 1 }, { id: 'BNS1', bullets: 12, approved: 12 }] };
    const f = checkTemplate(fullTokens, unapproved);
    expect(f.some((x) => x.level === 'warn' && x.text.includes('APPROVED'))).toBe(true);
  });

  it('flags the greedy-parse trap: role-shaped token with no active role', () => {
    const f = checkTemplate([...fullTokens, ...tok('BAR1')], bank);
    expect(f.some((x) => x.level === 'error' && x.text.includes('BAR1') && x.text.includes('"BA"'))).toBe(true);
  });

  it('flags unknown tokens and padded raws', () => {
    const f = checkTemplate(
      [...fullTokens, { name: 'stray', raw: '{{stray}}' }, { name: 'phone', raw: '{{ phone }}' }],
      bank,
    );
    expect(f.some((x) => x.level === 'error' && x.text.includes('stray'))).toBe(true);
    expect(f.some((x) => x.level === 'warn' && x.text.includes('extra spaces'))).toBe(true);
  });

  it('flags summary slots beyond the bank and empty skill categories', () => {
    const thin: BankShape = { ...bank, summaryCount: 1, skillCats: { ...bank.skillCats, emerging: 0 } };
    const f = checkTemplate(fullTokens, thin);
    expect(f.some((x) => x.level === 'error' && x.text.includes('summary'))).toBe(true);
    expect(f.some((x) => x.level === 'warn' && x.text.includes('skills_emerging'))).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { tokensOfRole, validateRoleCode } from '../src/console/roles';

const existing = ['DLAB1', 'BNS1', 'BNS2', 'UPS1', 'BAC1'];

describe('validateRoleCode', () => {
  it('accepts a clean new code', () => {
    expect(validateRoleCode('ACME2', existing)).toBeNull();
    expect(validateRoleCode('TD1', existing)).toBeNull();
  });

  it('rejects bad shapes', () => {
    expect(validateRoleCode('x1', existing)).toMatch(/uppercase/); // lowercase
    expect(validateRoleCode('1ABC', existing)).toMatch(/uppercase/); // digit first
    expect(validateRoleCode('A', existing)).toMatch(/uppercase/); // too short
    expect(validateRoleCode('ABCDEFGHI', existing)).toMatch(/uppercase/); // too long
    expect(validateRoleCode('AB-1', existing)).toMatch(/uppercase/); // symbol
  });

  it('rejects codes ending in R<digits> (token grammar)', () => {
    expect(validateRoleCode('BAR1', existing)).toMatch(/cannot end in R/);
    expect(validateRoleCode('XR22', existing)).toMatch(/cannot end in R/);
  });

  it('rejects duplicates case-insensitively', () => {
    expect(validateRoleCode('BNS1', existing)).toMatch(/already exists/);
  });

  it('rejects a code that shadows an existing role token in either direction', () => {
    // 'BNS1R2'-shaped candidates already die on the R<digits> rule; the reverse
    // direction: adding 'BNS' when 'BNS1'... 'BNS1' = 'BNS' + 'R'? No — R must
    // be literal. 'BNSR7' exists? simulate: existing role 'QRR7' vs candidate 'Q'?
    expect(validateRoleCode('BNS', ['BNSR7'])).toMatch(/would collide/);
  });
});

describe('tokensOfRole', () => {
  it('finds only the exact role prefix', () => {
    const names = ['BNS1R1', 'BNS1R2', 'BNS2R1', 'DLAB1R5', 'sum_1', 'BNS1'];
    expect(tokensOfRole('BNS1', names)).toEqual(['BNS1R1', 'BNS1R2']);
    expect(tokensOfRole('BNS2', names)).toEqual(['BNS2R1']);
  });
});

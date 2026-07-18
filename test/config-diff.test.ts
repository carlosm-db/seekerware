import { describe, expect, it } from 'vitest';
import { diffScoring } from '../src/console/config-diff';
import type { ScoringConfig } from '../src/scoring';

const base: ScoringConfig = {
  weights: {
    domain: { weight: 40, saturation: 8 }, role_type: { weight: 25, saturation: 5 },
    tool_overlap: { weight: 20, saturation: 6 }, level_fit: { weight: 15, saturation: 3 },
  },
  title_multiplier: 2,
  thresholds: { apply: 75, stretch: 55 },
  keywords: {
    domain: [{ term: 'payments', weight: 3 }],
    role_type: [{ term: 'data analyst', weight: 3 }],
    tool_overlap: [{ term: 'sql', weight: 3 }],
    level_fit: [{ term: 'junior', weight: 2 }],
  },
  tracks: [
    { id: 'canada_coop', gates: [{ id: 'coop_signal', type: 'penalty', points: 25, require: ['co-op'], scope: 'title' }] },
  ],
};
const clone = (): ScoringConfig => JSON.parse(JSON.stringify(base));

describe('diffScoring', () => {
  it('no changes -> explicit "no effective changes"', () => {
    expect(diffScoring(base, clone())).toBe('no effective changes');
  });

  it('describes threshold changes in words', () => {
    const n = clone(); n.thresholds.apply = 70;
    expect(diffScoring(base, n)).toContain('notify threshold 75→70');
  });

  it('describes keyword adds/removes/reweights per category', () => {
    const n = clone();
    n.keywords.domain.push({ term: 'fintech', weight: 3 });
    n.keywords.tool_overlap = [];
    n.keywords.level_fit = [{ term: 'junior', weight: 3 }];
    const d = diffScoring(base, n);
    expect(d).toContain('domain: +fintech');
    expect(d).toContain('tool_overlap: −sql');
    expect(d).toContain('level_fit: junior 2→3');
  });

  it('describes gate list and penalty changes', () => {
    const n = clone();
    n.tracks[0]!.gates[0]!.points = 15;
    n.tracks[0]!.gates[0]!.require = ['co-op', 'work term'];
    const d = diffScoring(base, n);
    expect(d).toContain('coop_signal penalty 25→15');
    expect(d).toContain('coop_signal.require: +work term');
  });
});

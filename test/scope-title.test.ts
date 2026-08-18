// `scope: 'title'` on a keyword, plus the repair of the conditional seniority penalty.
// Both come from docs/audits/2026-08-18-calibration-role-fit.md: role names leak through job
// descriptions ("partner with business analysts"), and negatives fired on boilerplate ("our recruiter
// will reach out") — measured on 54 Apply postings for `recruiter` alone.
import { describe, expect, it } from 'vitest';
import { scoreJob, type ScoringConfig } from '../src/scoring';
import { normalizeScoringConfig } from '../src/config-store';
import type { Job } from '../src/types';

function cfgWith(roleKeywords: unknown[]): ScoringConfig {
  return normalizeScoringConfig({
    weights: {
      domain: { weight: 15, saturation: 8 }, role_type: { weight: 50, saturation: 8 },
      tool_overlap: { weight: 25, saturation: 6 }, level_fit: { weight: 10, saturation: 3 },
    },
    title_multiplier: 2,
    thresholds: { apply: 62, stretch: 48 },
    keywords: {
      domain: [{ en: 'banking', es: 'banca', weight: 3 }],
      role_type: roleKeywords,
      tool_overlap: [{ en: 'sql', es: 'sql', weight: 3 }],
      level_fit: [{ en: 'analyst', es: 'analista', weight: 1 }],
    },
    level_negatives_only_if_role: ['software engineer'],
    conditional_level_negatives: [{ en: 'senior', es: 'senior', weight: -2 }],
    tracks: [
      { id: 'canada', gates: [{ id: 'loc_ca', require: [{ en: 'canada', es: 'canada' }, { en: 'toronto', es: 'toronto' }], scope: 'location' }] },
    ],
  });
}

function job(over: Partial<Job>): Job {
  return {
    id: '1', company: 'Acme', title: '', location: 'Toronto, Canada', url: 'https://x.io/1',
    description: '', posted_at: null, ats: 'greenhouse', raw: {},
    ...over,
  };
}

const roleRaw = (j: Job, cfg: ScoringConfig) => scoreJob(j, cfg).breakdown.role_type.raw;

describe("keyword scope: 'title'", () => {
  const titleScoped = cfgWith([{ en: 'analyst', es: 'analista', weight: 3, scope: 'title' }]);
  const textScoped = cfgWith([{ en: 'analyst', es: 'analista', weight: 3 }]);

  it('counts the term when it is in the TITLE', () => {
    const j = job({ title: 'Analyst, Asset Servicing', description: 'Banking operations.' });
    expect(roleRaw(j, titleScoped)).toBeGreaterThan(0);
  });

  it('ignores the same term when it only appears in the DESCRIPTION', () => {
    const j = job({ title: 'Marketing Coordinator', description: 'You will partner with business analysts and analyst teams.' });
    expect(roleRaw(j, titleScoped)).toBe(0);
    // Same config without the scope DOES count it — that is the leak the flag closes.
    expect(roleRaw(j, textScoped)).toBeGreaterThan(0);
  });

  it('keeps the title multiplier for a title-scoped positive', () => {
    const j = job({ title: 'Analyst, Payments', description: '' });
    // weight 3 x 1 occurrence x title_multiplier 2
    expect(roleRaw(j, titleScoped)).toBe(6);
  });

  it('stops a negative from firing on description boilerplate', () => {
    const scoped = cfgWith([
      { en: 'operations analyst', es: 'analista de operaciones', weight: 3, scope: 'title' },
      { en: 'recruiter', es: 'reclutador', weight: -3, scope: 'title' },
    ]);
    const j = job({
      title: 'Operations Analyst, Reconciliation',
      description: 'Our recruiter will reach out. The recruiter handles scheduling.',
    });
    // Title-scoped: the boilerplate recruiter mentions no longer subtract, so the real role survives.
    expect(roleRaw(j, scoped)).toBe(6);
    // Unscoped, the same posting is dragged to the category floor of 0.
    const unscoped = cfgWith([
      { en: 'operations analyst', es: 'analista de operaciones', weight: 3 },
      { en: 'recruiter', es: 'reclutador', weight: -3 },
    ]);
    expect(roleRaw(j, unscoped)).toBe(0);
  });

  it('survives the config normalizer instead of being silently stripped', () => {
    expect(titleScoped.keywords.role_type[0]!.scope).toBe('title');
  });

  it('rejects a misspelled scope loudly rather than widening the term', () => {
    expect(() => cfgWith([{ en: 'analyst', es: 'analista', weight: 3, scope: 'titel' }]))
      .toThrow(/scope must be 'title' or 'text'/);
  });
});

describe('conditional seniority penalty (was unreachable)', () => {
  // `level_negatives_only_if_role` lists 'software engineer', whose weight is NEGATIVE. The trigger set
  // used to keep only weight > 0 matches, so the penalty could never fire for it.
  const cfg = cfgWith([
    { en: 'software engineer', es: 'ingeniero de software', weight: -2 },
    { en: 'operations analyst', es: 'analista de operaciones', weight: 3, scope: 'title' },
  ]);

  // Asserted on the matched terms, not on `raw`: raw is floored at 0 (scoring.ts:196), so a penalty
  // applied to an otherwise-empty category is invisible there.
  const seniorFired = (title: string) =>
    scoreJob(job({ title, description: 'Banking. SQL.' }), cfg)
      .breakdown.level_fit.matches.some((m) => m.term === 'senior');

  it('fires `senior` for a matched engineer title', () => {
    expect(seniorFired('Senior Software Engineer')).toBe(true);
  });

  it('leaves `senior` alone when no trigger role matched', () => {
    expect(seniorFired('Senior Operations Analyst')).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { locationClears, normalizeTitle, scoreJob, type ScoringConfig } from '../src/scoring';
import { normalizeScoringConfig } from '../src/config-store';
import type { Job } from '../src/types';

// Authored in the {en, es} shape and run through the real normalizer, so this
// suite exercises the engine on the same config shape a live deploy loads.
const config: ScoringConfig = normalizeScoringConfig({
  weights: {
    domain: { weight: 40, saturation: 6 },
    role_type: { weight: 25, saturation: 4 },
    tool_overlap: { weight: 20, saturation: 5 },
    level_fit: { weight: 15, saturation: 3 },
  },
  title_multiplier: 2,
  thresholds: { apply: 75, stretch: 55 },
  keywords: {
    domain: [
      { en: 'payments', es: 'pagos', weight: 3 },
      { en: 'reconciliation', es: 'conciliacion', weight: 3 },
      { en: 'collections', es: 'cobranza', weight: 3 },
      { en: 'banking', es: 'banca', weight: 3 },
      { en: 'compliance', es: 'cumplimiento', weight: 2 },
    ],
    role_type: [
      { en: 'business analyst', es: 'analista de negocio', weight: 3 },
      { en: 'data analyst', es: 'analista de datos', weight: 3 },
      { en: 'data engineer', es: 'ingeniero de datos', weight: 2 },
      { en: 'recruiter', es: 'reclutador', weight: -3 },
    ],
    tool_overlap: [
      { en: 'sql', es: 'sql', weight: 3 },
      { en: 'power bi', es: 'power bi', weight: 3 },
      { en: 'excel', es: 'excel', weight: 2 },
      { en: 'python', es: 'python', weight: 2 },
    ],
    level_fit: [
      { en: 'co-op', es: 'co-op', weight: 3 },
      { en: 'junior', es: 'junior', weight: 2 },
      { en: 'intermediate', es: 'intermedio', weight: 2 },
      { en: 'principal', es: 'principal', weight: -3 },
    ],
  },
  level_negatives_only_if_role: ['data engineer'],
  conditional_level_negatives: [{ en: 'senior', es: 'senior', weight: -2 }],
  tracks: [
    {
      id: 'canada_coop',
      gates: [
        { id: 'ubicacion_canada', require: [{ en: 'canada', es: 'canada' }, { en: 'vancouver', es: 'vancouver' }, { en: 'toronto', es: 'toronto' }], scope: 'location' },
        { id: 'senal_coop', require: [{ en: 'co-op', es: 'co-op' }, { en: 'coop', es: 'coop' }, { en: 'intern', es: 'intern' }, { en: 'work term', es: 'work term' }], scope: 'title' },
      ],
    },
    {
      id: 'colombia_perm',
      gates: [
        { id: 'ubicacion_latam', require: [{ en: 'colombia', es: 'colombia' }, { en: 'latam', es: 'latam' }, { en: 'remote', es: 'remoto' }, { en: 'americas', es: 'americas' }], scope: 'text' },
        { id: 'rechazo_us_only', reject: [{ en: 'us only', es: 'solo estados unidos' }, { en: 'no sponsorship', es: 'sin patrocinio' }], scope: 'text' },
      ],
    },
    {
      id: 'contractor_usd',
      gates: [
        { id: 'remoto', require: [{ en: 'remote', es: 'remoto' }, { en: 'worldwide', es: 'mundial' }, { en: 'anywhere', es: 'en cualquier lugar' }], scope: 'text' },
      ],
    },
  ],
});

describe('locationClears (verifier CA/CO tally — location-scope gates only, word-boundary)', () => {
  const locCfg: ScoringConfig = normalizeScoringConfig({
    weights: {
      domain: { weight: 40, saturation: 6 }, role_type: { weight: 25, saturation: 4 },
      tool_overlap: { weight: 20, saturation: 5 }, level_fit: { weight: 15, saturation: 3 },
    },
    title_multiplier: 1, thresholds: { apply: 75, stretch: 55 },
    keywords: { domain: [], role_type: [], tool_overlap: [], level_fit: [] },
    tracks: [
      { id: 'canada_coop', gates: [{ id: 'loc_ca', require: [{ en: 'canada', es: 'canada' }, { en: 'can', es: 'can' }, { en: 'toronto', es: 'toronto' }, { en: 'montreal', es: 'montreal' }], scope: 'location' }] },
      { id: 'colombia_perm', gates: [
        { id: 'loc_co', require: [{ en: 'colombia', es: 'colombia' }, { en: 'bogota', es: 'bogota' }, { en: 'latam', es: 'latam' }], scope: 'location' },
        { id: 'reject_us', reject: [{ en: 'no sponsorship', es: 'sin patrocinio' }], scope: 'text' }, // text-scope → ignored by the tally
      ] },
    ],
  });
  it('clears canada_coop for Canadian cities (accent-insensitive)', () => {
    expect([...locationClears('Toronto, ON, Canada', locCfg)]).toContain('canada_coop');
    expect([...locationClears('Montréal, QC', locCfg)]).toContain('canada_coop');
  });
  it('clears colombia_perm for Colombia / LATAM', () => {
    expect([...locationClears('Bogotá, Colombia', locCfg)]).toContain('colombia_perm');
    expect([...locationClears('Remote - LATAM', locCfg)]).toContain('colombia_perm');
  });
  it('clears neither for off-target locations', () => {
    expect(locationClears('São Paulo; Remote', locCfg).size).toBe(0);
    expect(locationClears('Palo Alto', locCfg).size).toBe(0);
  });
  it('word-boundary: "candidate" does NOT false-match the "can" term', () => {
    expect(locationClears('candidate experience center', locCfg).has('canada_coop')).toBe(false);
  });
  it('empty location (SF-urlset list) clears nothing', () => {
    expect(locationClears('', locCfg).size).toBe(0);
  });
});

function job(over: Partial<Job>): Job {
  return {
    id: '1', company: 'Acme', title: '', location: '', url: 'https://x.io/1',
    description: '', posted_at: null, ats: 'greenhouse', raw: {},
    ...over,
  };
}

describe('scoreJob — tracks and gates', () => {
  it('co-op in Canada passes the canada_coop gates and wins as best track', () => {
    const r = scoreJob(job({
      title: 'Data Analyst Co-op',
      location: 'Vancouver, BC, Canada',
      description: 'Banking reconciliation team. SQL, Power BI, Excel. Co-op work term.',
    }), config);
    expect(r.tracks.canada_coop!.hard_failed).toBe(false);
    expect(r.best.track).toBe('canada_coop');
    expect(['Apply', 'Stretch-worth-it']).toContain(r.best.verdict);
  });

  it('"US only" kills colombia_perm via a hard gate even when the score is high', () => {
    const r = scoreJob(job({
      title: 'Business Analyst, Payments',
      location: 'Remote',
      description: 'Payments reconciliation, collections, SQL, Power BI. US only, no sponsorship.',
    }), config);
    expect(r.tracks.colombia_perm!.hard_failed).toBe(true);
    expect(r.tracks.colombia_perm!.verdict).toBe('Skip');
    const gate = r.tracks.colombia_perm!.gates.find((g) => g.id === 'rechazo_us_only')!;
    expect(gate.passed).toBe(false);
    expect(gate.evidence).toContain('us only');
  });

});

describe('scoreJob — near-miss and explainability', () => {
  it('Skip due to low score carries near_miss_reason with the gap', () => {
    const r = scoreJob(job({
      title: 'Office Manager',
      location: 'Remote',
      description: 'General admin duties.',
    }), config);
    expect(r.best.verdict).toBe('Skip');
    expect(r.near_miss_reason).toMatch(/score \d+ < 55|gate:/);
  });

  it('the breakdown points sum to the score (rounded)', () => {
    const r = scoreJob(job({
      title: 'Data Analyst',
      location: 'Canada',
      description: 'Banking payments reconciliation with SQL and Excel. Junior friendly.',
    }), config);
    const sum = Object.values(r.breakdown).reduce((a, b) => a + b.points, 0);
    expect(r.score).toBe(Math.round(sum));
  });
});

describe('scoreJob — conditional seniority nuance', () => {
  it("'senior' penalizes the data engineer but NOT the business analyst", () => {
    const de = scoreJob(job({
      title: 'Senior Data Engineer',
      location: 'Remote',
      description: 'SQL pipelines.',
    }), config);
    const ba = scoreJob(job({
      title: 'Senior Business Analyst',
      location: 'Remote',
      description: 'SQL analysis.',
    }), config);
    const deNeg = de.breakdown.level_fit.matches.find((m) => m.term === 'senior');
    const baNeg = ba.breakdown.level_fit.matches.find((m) => m.term === 'senior');
    expect(deNeg).toBeDefined();
    expect(deNeg!.weight).toBeLessThan(0);
    expect(baNeg).toBeUndefined();
  });
});

describe('scoreJob — EN/ES matching and title', () => {
  it("a pair matches on its ES side ('conciliación') and records the EN term", () => {
    const r = scoreJob(job({
      title: 'Analista',
      location: 'Bogotá, Colombia',
      description: 'Responsable de la conciliación bancaria y pagos.',
    }), config);
    // es='conciliacion' matched the accented text; the concept is logged under its en.
    const m = r.breakdown.domain.matches.map((x) => x.term);
    expect(m).toContain('reconciliation');
  });

  it('a title match counts double (title_multiplier=2)', () => {
    const enTitulo = scoreJob(job({ title: 'Payments Analyst', location: 'Canada', description: 'x' }), config);
    const enCuerpo = scoreJob(job({ title: 'Analyst', location: 'Canada', description: 'payments x' }), config);
    const wTitulo = enTitulo.breakdown.domain.matches.find((m) => m.term === 'payments')!.weight;
    const wCuerpo = enCuerpo.breakdown.domain.matches.find((m) => m.term === 'payments')!.weight;
    expect(wTitulo).toBe(wCuerpo * 2);
  });

  it('word boundary: "sql" does not match inside "mysqlite"', () => {
    const r = scoreJob(job({ title: 'x', location: 'x', description: 'mysqlite database' }), config);
    expect(r.breakdown.tool_overlap.matches.map((m) => m.term)).not.toContain('sql');
  });
});

describe('scoreJob — one score, gates route only, but the BAR can differ per route', () => {
  // Reinstated 2026-08-18 (docs/audits/2026-08-18-calibration-role-fit.md): routes hold different
  // populations. A co-op posting is short and thin on domain/tools and can never reach a bar tuned for
  // experienced roles. This moves the verdict bar per route — the score itself stays one number.
  const withCoopBar = (apply: number, stretch: number): ScoringConfig => ({
    ...config,
    tracks: config.tracks.map((t) => (t.id === 'canada_coop' ? { ...t, thresholds: { apply, stretch } } : t)),
  });
  const j = job({
    title: 'Co-op Software Developer',
    location: 'Vancouver, Canada',
    description: 'Compliance team. Python.',
  });

  it('a track with its own bar is judged by it, not by the global one', () => {
    const base = scoreJob(j, config);
    const score = base.score;
    // A bar strictly under the score must turn that route's verdict into Apply, whatever the global says.
    const lowered = scoreJob(j, withCoopBar(Math.max(1, score - 1), Math.max(0, score - 20)));
    expect(lowered.tracks.canada_coop!.verdict).toBe('Apply');
    expect(lowered.score).toBe(score); // the SCORE is untouched — only the bar moved
  });

  it('the routed verdict (`best`) uses the route\'s own bar', () => {
    const score = scoreJob(j, config).score;
    const r = scoreJob(j, withCoopBar(Math.max(1, score - 1), Math.max(0, score - 20)));
    expect(r.best.track).toBe('canada_coop');
    expect(r.best.verdict).toBe('Apply');
  });

  it('a route without its own bar still inherits the global one', () => {
    const cfg = withCoopBar(1, 0); // only canada_coop overridden
    const co = job({ title: 'Business Analyst', location: 'Bogota, Colombia', description: 'Payments. SQL.' });
    expect(scoreJob(co, cfg).tracks.colombia_perm!.verdict)
      .toBe(scoreJob(co, config).tracks.colombia_perm!.verdict);
  });

  it('an unreachable bar sends that route to Skip while the score stays put', () => {
    const r = scoreJob(j, withCoopBar(101, 100));
    expect(r.tracks.canada_coop!.verdict).toBe('Skip');
    expect(r.tracks.canada_coop!.adjusted_score).toBe(r.score);
  });
});

describe('normalizeTitle (radar de similares)', () => {
  it('strips seniority, parenthesized content, and normalizes', () => {
    expect(normalizeTitle('Senior Data Analyst II (Payments) — Remote')).toBe('data analyst remote');
    expect(normalizeTitle('Jr. Business Analyst')).toBe('business analyst');
  });
});

describe('per-track bar validation (config-store)', () => {
  const withTrackBar = (thresholds: unknown) => () =>
    normalizeScoringConfig({
      ...config,
      tracks: config.tracks.map((t) => (t.id === 'canada_coop' ? { ...t, thresholds } : t)),
    });

  it('accepts a route bar with apply > stretch', () => {
    expect(withTrackBar({ apply: 50, stretch: 40 })).not.toThrow();
  });

  it('rejects an inverted route bar — it would mark everything on that route Apply', () => {
    expect(withTrackBar({ apply: 30, stretch: 40 })).toThrow(/canada_coop thresholds need apply > stretch/);
  });

  it('rejects a half-typed route bar', () => {
    expect(withTrackBar({ apply: 50 })).toThrow(/canada_coop thresholds need apply > stretch/);
  });
});

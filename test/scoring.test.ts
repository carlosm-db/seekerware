import { describe, expect, it } from 'vitest';
import { normalizeTitle, scoreJob, type ScoringConfig } from '../src/scoring';
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

describe('scoreJob — per-track thresholds', () => {
  it('a track with its own thresholds uses them instead of the globals', () => {
    const cfg: ScoringConfig = {
      ...config,
      tracks: config.tracks.map((t) =>
        t.id === 'canada_coop' ? { ...t, thresholds: { apply: 60, stretch: 30 } } : t,
      ),
    };
    const j = job({
      title: 'Co-op Software Developer',
      location: 'Vancouver, Canada',
      description: 'Compliance team. Python.',
    });
    const global = scoreJob(j, config);
    const perTrack = scoreJob(j, cfg);
    expect(global.tracks.canada_coop!.verdict).toBe('Skip');
    expect(perTrack.tracks.canada_coop!.verdict).toBe('Stretch-worth-it');
  });
});

describe('normalizeTitle (radar de similares)', () => {
  it('strips seniority, parenthesized content, and normalizes', () => {
    expect(normalizeTitle('Senior Data Analyst II (Payments) — Remote')).toBe('data analyst remote');
    expect(normalizeTitle('Jr. Business Analyst')).toBe('business analyst');
  });
});

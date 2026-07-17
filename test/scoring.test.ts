import { describe, expect, it } from 'vitest';
import { normalizeTitle, scoreJob, type ScoringConfig } from '../src/scoring';
import type { Job } from '../src/types';

const config: ScoringConfig = {
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
      { term: 'payments', weight: 3 },
      { term: 'reconciliation', weight: 3 },
      { term: 'conciliacion', weight: 3 },
      { term: 'collections', weight: 3 },
      { term: 'banking', weight: 3 },
      { term: 'compliance', weight: 2 },
    ],
    role_type: [
      { term: 'business analyst', weight: 3 },
      { term: 'data analyst', weight: 3 },
      { term: 'data engineer', weight: 2 },
      { term: 'recruiter', weight: -3 },
    ],
    tool_overlap: [
      { term: 'sql', weight: 3 },
      { term: 'power bi', weight: 3 },
      { term: 'excel', weight: 2 },
      { term: 'python', weight: 2 },
    ],
    level_fit: [
      { term: 'co-op', weight: 3 },
      { term: 'junior', weight: 2 },
      { term: 'intermediate', weight: 2 },
      { term: 'principal', weight: -3 },
    ],
  },
  level_negatives_only_if_role: ['data engineer'],
  conditional_level_negatives: [{ term: 'senior', weight: -2 }],
  tracks: [
    {
      id: 'canada_coop',
      gates: [
        { id: 'ubicacion_canada', type: 'hard', require: ['canada', 'vancouver', 'toronto'], scope: 'location' },
        { id: 'senal_coop', type: 'hard', require: ['co-op', 'coop', 'intern', 'work term'], scope: 'title' },
      ],
    },
    {
      id: 'colombia_perm',
      gates: [
        { id: 'ubicacion_latam', type: 'hard', require: ['colombia', 'latam', 'remote', 'americas'], scope: 'text' },
        { id: 'rechazo_us_only', type: 'hard', reject: ['us only', 'no sponsorship'], scope: 'text' },
      ],
    },
    {
      id: 'contractor_usd',
      gates: [
        { id: 'remoto', type: 'hard', require: ['remote', 'worldwide', 'anywhere'], scope: 'text' },
        { id: 'senal_contractor', type: 'penalty', points: 15, require: ['contractor', 'b2b', 'freelance'], scope: 'text' },
      ],
    },
  ],
};

function job(over: Partial<Job>): Job {
  return {
    id: '1', company: 'Acme', title: '', location: '', url: 'https://x.io/1',
    description: '', posted_at: null, ats: 'greenhouse', raw: {},
    ...over,
  };
}

describe('scoreJob — tracks y gates', () => {
  it('co-op en Canada pasa los gates de canada_coop y gana como best track', () => {
    const r = scoreJob(job({
      title: 'Data Analyst Co-op',
      location: 'Vancouver, BC, Canada',
      description: 'Banking reconciliation team. SQL, Power BI, Excel. Co-op work term.',
    }), config);
    expect(r.tracks.canada_coop!.hard_failed).toBe(false);
    expect(r.best.track).toBe('canada_coop');
    expect(['Apply', 'Stretch-worth-it']).toContain(r.best.verdict);
  });

  it('"US only" mata colombia_perm por gate hard aunque el score sea alto', () => {
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

  it('contractor remoto sin senal B2B recibe penalty (resta 15)', () => {
    const conJob = job({
      title: 'Business Analyst',
      location: 'Remote worldwide',
      description: 'Payments and banking. SQL. Independent contractor, B2B.',
    });
    const sinJob = job({
      title: 'Business Analyst',
      location: 'Remote worldwide',
      description: 'Payments and banking. SQL.',
    });
    const con = scoreJob(conJob, config).tracks.contractor_usd!;
    const sin = scoreJob(sinJob, config).tracks.contractor_usd!;
    expect(con.adjusted_score - sin.adjusted_score).toBeGreaterThanOrEqual(15);
  });
});

describe('scoreJob — near-miss y explicabilidad', () => {
  it('Skip por score bajo trae near_miss_reason con la brecha', () => {
    const r = scoreJob(job({
      title: 'Office Manager',
      location: 'Remote',
      description: 'General admin duties.',
    }), config);
    expect(r.best.verdict).toBe('Skip');
    expect(r.near_miss_reason).toMatch(/score \d+ < 55|gate:/);
  });

  it('los puntos del breakdown suman el score (redondeado)', () => {
    const r = scoreJob(job({
      title: 'Data Analyst',
      location: 'Canada',
      description: 'Banking payments reconciliation with SQL and Excel. Junior friendly.',
    }), config);
    const sum = Object.values(r.breakdown).reduce((a, b) => a + b.points, 0);
    expect(r.score).toBe(Math.round(sum));
  });
});

describe('scoreJob — nuance de seniority condicionada', () => {
  it("'senior' penaliza al data engineer pero NO al business analyst", () => {
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

describe('scoreJob — matching EN/ES y titulo', () => {
  it("keyword 'conciliacion' matchea texto con tildes ('conciliación')", () => {
    const r = scoreJob(job({
      title: 'Analista',
      location: 'Bogotá, Colombia',
      description: 'Responsable de la conciliación bancaria y pagos.',
    }), config);
    const m = r.breakdown.domain.matches.map((x) => x.term);
    expect(m).toContain('conciliacion');
  });

  it('match en el titulo vale doble (title_multiplier=2)', () => {
    const enTitulo = scoreJob(job({ title: 'Payments Analyst', location: 'Canada', description: 'x' }), config);
    const enCuerpo = scoreJob(job({ title: 'Analyst', location: 'Canada', description: 'payments x' }), config);
    const wTitulo = enTitulo.breakdown.domain.matches.find((m) => m.term === 'payments')!.weight;
    const wCuerpo = enCuerpo.breakdown.domain.matches.find((m) => m.term === 'payments')!.weight;
    expect(wTitulo).toBe(wCuerpo * 2);
  });

  it('word boundary: "sql" no matchea dentro de "mysqlite"', () => {
    const r = scoreJob(job({ title: 'x', location: 'x', description: 'mysqlite database' }), config);
    expect(r.breakdown.tool_overlap.matches.map((m) => m.term)).not.toContain('sql');
  });
});

describe('scoreJob — umbrales por track', () => {
  it('un track con thresholds propios los usa en lugar de los globales', () => {
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
  it('quita seniority, contenido entre parentesis, y normaliza', () => {
    expect(normalizeTitle('Senior Data Analyst II (Payments) — Remote')).toBe('data analyst remote');
    expect(normalizeTitle('Jr. Business Analyst')).toBe('business analyst');
  });
});

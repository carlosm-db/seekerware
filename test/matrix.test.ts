import { describe, expect, it } from 'vitest';
import type { ScoringConfig } from '../src/scoring';
import {
  applyPairRemove, applyWordAdd, applyWordEdit, buildMatrix, mineProfileKeywords, type MatrixGroup,
} from '../src/console/matrix';

/** Miniature config in the {en, es} shape (mirrors the seed structure). */
const makeCfg = (): ScoringConfig => ({
  weights: {
    domain: { weight: 40, saturation: 8 },
    role_type: { weight: 25, saturation: 5 },
    tool_overlap: { weight: 20, saturation: 6 },
    level_fit: { weight: 15, saturation: 3 },
  },
  title_multiplier: 2,
  thresholds: { apply: 75, stretch: 55 },
  keywords: {
    domain: [{ en: 'payments', es: 'pagos', weight: 3 }],
    role_type: [
      { en: 'business analyst', es: 'analista de negocio', weight: 3 },
      { en: 'co-op', es: 'co-op', weight: 3 },
      { en: 'recruiter', es: '', weight: -3 }, // gap: Spanish not filled yet
    ],
    tool_overlap: [{ en: 'sql', es: 'sql', weight: 3 }],
    level_fit: [],
  },
  tracks: [
    {
      id: 'canada_coop',
      gates: [
        { id: 'location_canada', scope: 'location', require: [{ en: 'canada', es: 'canada' }, { en: 'toronto', es: 'toronto' }] },
        { id: 'coop_signal', scope: 'title', require: [{ en: 'co-op', es: 'co-op' }, { en: 'work term', es: 'período de trabajo' }] },
      ],
    },
    {
      id: 'colombia_perm',
      gates: [
        { id: 'location_latam', scope: 'location', require: [{ en: 'colombia', es: 'colombia' }, { en: 'latam', es: 'latam' }] },
        { id: 'reject_us_only', scope: 'text', reject: [{ en: 'us only', es: 'solo estados unidos' }, { en: 'no sponsorship', es: 'sin patrocinio' }] },
      ],
    },
    {
      id: 'contractor_usd',
      gates: [
        { id: 'remote_required', scope: 'location', require: [{ en: 'remote', es: 'remoto' }, { en: 'worldwide', es: 'mundial' }] },
        { id: 'reject_restricted_remote', scope: 'location', reject: [{ en: 'emea', es: 'emea' }, { en: 'san francisco', es: 'san francisco' }] },
      ],
    },
  ],
});

const row = (rows: MatrixGroup[], cat: string) => rows.find((r) => r.category === cat)!;
const ens = (rows: { en: string }[]) => rows.map((r) => r.en);

describe('mineProfileKeywords', () => {
  it('suggests recurring profile terms not already calibrated; excludes calibrated + stopwords; ranks by block count; bigrams work', () => {
    const blocks = [
      { text_en: 'Led reconciliation and forecasting for banking clients' },
      { text_en: 'Banking reconciliation with Python and dashboards' },
      { text_en: 'Payments and SQL for a business analyst team' },
      { text_en: 'Forecasting dashboards for banking business intelligence' },
      { text_en: 'Business intelligence reporting for the business analyst' },
    ];
    const res = mineProfileKeywords(makeCfg(), blocks);
    const terms = res.map((r) => r.term);
    expect(terms).toContain('banking');               // 3 blocks, not calibrated
    expect(terms).toContain('reconciliation');        // 2 blocks
    expect(terms).toContain('business intelligence');  // bigram, 2 blocks
    expect(terms).not.toContain('payments');          // calibrated keyword
    expect(terms).not.toContain('sql');               // calibrated keyword
    expect(terms).not.toContain('business analyst');   // calibrated bigram
    expect(terms).not.toContain('and');               // stopword
    expect(res[0]!.term).toBe('banking');             // highest block count
  });
});

describe('buildMatrix', () => {
  const rows = buildMatrix(makeCfg());

  it('projects the 5 categories in sketch order (location first)', () => {
    expect(rows.map((r) => r.category)).toEqual(['location', 'role_type', 'level_fit', 'domain', 'tool_overlap']);
  });

  it('keyword rows carry both languages, split by direction', () => {
    const rt = row(rows, 'role_type');
    const ba = rt.favor.find((r) => r.en === 'business analyst')!;
    expect(ba.es).toBe('analista de negocio');
    expect(ba.weight).toBe(3);
    expect(ens(rt.against)).toContain('recruiter');
  });

  it('a concept with no Spanish yet shows es="" (an honest gap, no clone)', () => {
    const rec = row(rows, 'role_type').against.find((r) => r.en === 'recruiter')!;
    expect(rec.es).toBe('');
  });

  it('derives the path badge from gate membership', () => {
    const coop = row(rows, 'role_type').favor.find((r) => r.en === 'co-op')!;
    expect(coop.path).toBe('canada_coop');
    expect(coop.source.kind).toBe('keyword');
  });

  it('synthesizes the Location row from location/text gates (both languages)', () => {
    const loc = row(rows, 'location');
    expect(ens(loc.favor)).toEqual(expect.arrayContaining(['canada', 'colombia', 'remote']));
    expect(ens(loc.against)).toEqual(expect.arrayContaining(['us only', 'emea']));
    expect(loc.against.find((r) => r.en === 'us only')!.es).toBe('solo estados unidos');
    expect(loc.favor.find((r) => r.en === 'remote')!.es).toBe('remoto');
    expect(loc.favor.find((r) => r.en === 'canada')!.path).toBe('canada_coop');
    expect(loc.against.find((r) => r.en === 'emea')!.source).toMatchObject({ kind: 'gate', track: 'contractor_usd' });
  });

  it('puts title-scope gate-only terms in Role titles, not Location', () => {
    expect(ens(row(rows, 'role_type').favor)).toContain('work term');
    expect(ens(row(rows, 'location').favor)).not.toContain('work term');
  });
});

describe('applyWordEdit', () => {
  it('edits a keyword concept (Spanish + strength) in place', () => {
    const cfg = makeCfg();
    const err = applyWordEdit(cfg, { kind: 'keyword', category: 'role_type', oldEn: 'business analyst', en: 'business analyst', es: 'analista funcional', weight: 2 });
    expect(err).toBeNull();
    const k = cfg.keywords.role_type.find((x) => x.en === 'business analyst')!;
    expect(k.es).toBe('analista funcional');
    expect(k.weight).toBe(2);
  });

  it('renaming a keyword en also syncs its path-linked gate copy', () => {
    const cfg = makeCfg();
    const err = applyWordEdit(cfg, { kind: 'keyword', category: 'role_type', oldEn: 'co-op', en: 'coop program', es: 'programa co-op', weight: 3 });
    expect(err).toBeNull();
    expect(cfg.keywords.role_type.some((k) => k.en === 'coop program')).toBe(true);
    const gate = cfg.tracks.find((t) => t.id === 'canada_coop')!.gates.find((g) => g.id === 'coop_signal')!;
    expect(gate.require!.some((t) => t.en === 'coop program' && t.es === 'programa co-op')).toBe(true);
    expect(gate.require!.some((t) => t.en === 'co-op')).toBe(false);
  });

  it('edits a gate concept (both languages)', () => {
    const cfg = makeCfg();
    const err = applyWordEdit(cfg, { kind: 'gate', track: 'contractor_usd', gate: 'remote_required', oldEn: 'remote', en: 'remote', es: 'remoto total' });
    expect(err).toBeNull();
    const gate = cfg.tracks.find((t) => t.id === 'contractor_usd')!.gates.find((g) => g.id === 'remote_required')!;
    expect(gate.require!.find((t) => t.en === 'remote')!.es).toBe('remoto total');
  });

  it('requires both languages and a valid strength', () => {
    const cfg = makeCfg();
    expect(applyWordEdit(cfg, { kind: 'keyword', category: 'role_type', oldEn: 'business analyst', en: 'x', es: '', weight: 3 }))
      .toMatchObject({ error: expect.stringContaining('both languages') });
    expect(applyWordEdit(cfg, { kind: 'keyword', category: 'role_type', oldEn: 'business analyst', en: 'business analyst', es: 'x', weight: 0 }))
      .toMatchObject({ error: expect.stringContaining('strength') });
  });

  it('errors when the concept is not found', () => {
    const cfg = makeCfg();
    expect(applyWordEdit(cfg, { kind: 'keyword', category: 'role_type', oldEn: 'nope', en: 'nope', es: 'nope', weight: 3 }))
      .toMatchObject({ error: expect.stringContaining('not found') });
  });
});

describe('applyWordAdd', () => {
  it('adds a concept with both languages', () => {
    const cfg = makeCfg();
    const err = applyWordAdd(cfg, { en: 'Data Engineer', es: 'ingeniero de datos', category: 'role_type', favor: true, weight: 2 });
    expect(err).toBeNull();
    const k = cfg.keywords.role_type.find((x) => x.en === 'data engineer')!;
    expect(k.es).toBe('ingeniero de datos');
    expect(k.weight).toBe(2);
  });

  it('requires BOTH languages', () => {
    const cfg = makeCfg();
    expect(applyWordAdd(cfg, { en: 'x', es: '  ', category: 'domain', favor: true, weight: 2 }))
      .toMatchObject({ error: expect.stringContaining('both languages') });
  });

  it('against words store negative weight and only allow −2/−3', () => {
    const cfg = makeCfg();
    expect(applyWordAdd(cfg, { en: 'seller', es: 'vendedor', category: 'role_type', favor: false, weight: 1 }))
      .toMatchObject({ error: expect.stringContaining('−2 or −3') });
    expect(applyWordAdd(cfg, { en: 'seller', es: 'vendedor', category: 'role_type', favor: false, weight: 3 })).toBeNull();
    expect(cfg.keywords.role_type.find((k) => k.en === 'seller')!.weight).toBe(-3);
  });

  it('rejects a duplicate en', () => {
    const cfg = makeCfg();
    expect(applyWordAdd(cfg, { en: 'payments', es: 'pagos', category: 'domain', favor: true, weight: 2 }))
      .toMatchObject({ error: expect.stringContaining('already listed') });
  });

  it('a path on a scoring word also appends the concept to the track title gate', () => {
    const cfg = makeCfg();
    const err = applyWordAdd(cfg, { en: 'work placement', es: 'pasantía', category: 'role_type', favor: true, weight: 2, path: 'canada_coop' });
    expect(err).toBeNull();
    const gate = cfg.tracks.find((t) => t.id === 'canada_coop')!.gates.find((g) => g.id === 'coop_signal')!;
    expect(gate.require!.some((t) => t.en === 'work placement' && t.es === 'pasantía')).toBe(true);
  });

  it('location words require a path and land in that track gate', () => {
    const cfg = makeCfg();
    expect(applyWordAdd(cfg, { en: 'medellin', es: 'medellín', category: 'location', favor: true, weight: 2 }))
      .toMatchObject({ error: expect.stringContaining('need a path') });
    const err = applyWordAdd(cfg, { en: 'medellin', es: 'medellín', category: 'location', favor: true, weight: 2, path: 'colombia_perm' });
    expect(err).toBeNull();
    const gate = cfg.tracks.find((t) => t.id === 'colombia_perm')!.gates.find((g) => g.id === 'location_latam')!;
    expect(gate.require!.some((t) => t.en === 'medellin' && t.es === 'medellín')).toBe(true);
  });
});

describe('applyPairRemove', () => {
  it('keyword ✕ removes the concept and any gate entry it was linked into', () => {
    const cfg = makeCfg();
    const r = applyPairRemove(cfg, { kind: 'keyword', category: 'role_type', en: 'co-op' });
    expect(r).toMatchObject({ removed: ['co-op'] });
    expect(cfg.keywords.role_type.some((k) => k.en === 'co-op')).toBe(false);
    const gate = cfg.tracks.find((t) => t.id === 'canada_coop')!.gates.find((g) => g.id === 'coop_signal')!;
    expect(gate.require!.some((t) => t.en === 'co-op')).toBe(false);
    expect(gate.require!.some((t) => t.en === 'work term')).toBe(true);
  });

  it('gate ✕ removes the concept from that gate', () => {
    const cfg = makeCfg();
    const r = applyPairRemove(cfg, { kind: 'gate', track: 'colombia_perm', gate: 'location_latam', en: 'colombia' });
    expect(r).toMatchObject({ removed: ['colombia'] });
    const gate = cfg.tracks.find((t) => t.id === 'colombia_perm')!.gates.find((g) => g.id === 'location_latam')!;
    expect(gate.require!.some((t) => t.en === 'colombia')).toBe(false);
    expect(gate.require!.some((t) => t.en === 'latam')).toBe(true);
  });
});

describe("title-only scope round-trip (console <-> config)", () => {
  it('add with titleOnly writes scope, and the matrix row reports it', () => {
    const cfg = makeCfg();
    expect(applyWordAdd(cfg, {
      en: 'analyst', es: 'analista', category: 'role_type', favor: true, weight: 3, titleOnly: true,
    })).toBeNull();
    const k = cfg.keywords.role_type.find((x) => x.en === 'analyst');
    expect(k?.scope).toBe('title');
    const row = buildMatrix(cfg).find((g) => g.category === 'role_type')!.favor.find((r) => r.en === 'analyst');
    expect(row?.titleOnly).toBe(true);
  });

  it('add without titleOnly leaves the term full-text (no scope key)', () => {
    const cfg = makeCfg();
    applyWordAdd(cfg, { en: 'analyst', es: 'analista', category: 'role_type', favor: true, weight: 3 });
    expect(cfg.keywords.role_type.find((x) => x.en === 'analyst')?.scope).toBeUndefined();
  });

  it('edit toggles the scope both ways', () => {
    const cfg = makeCfg();
    const edit = (titleOnly: boolean) => applyWordEdit(cfg, {
      kind: 'keyword', category: 'role_type', oldEn: 'business analyst',
      en: 'business analyst', es: 'analista de negocio', weight: 3, titleOnly,
    });
    expect(edit(true)).toBeNull();
    expect(cfg.keywords.role_type.find((x) => x.en === 'business analyst')?.scope).toBe('title');
    // Unchecking must WIDEN it back — an unchecked box is absent from the POST body.
    expect(edit(false)).toBeNull();
    expect(cfg.keywords.role_type.find((x) => x.en === 'business analyst')?.scope).toBeUndefined();
  });
});

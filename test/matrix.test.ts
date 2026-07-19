import { describe, expect, it } from 'vitest';
import type { ScoringConfig } from '../src/scoring';
import {
  applyPairRemove, applyWordAdd, buildMatrix, emptyMeta, parseMeta, pathOptions,
  type MatrixMeta, type MatrixRow,
} from '../src/console/matrix';

/** Miniature of the real v1.7 config shape (tracks/gates mirror the seed). */
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
    domain: [
      { term: 'payments', weight: 3 },
      { term: 'conciliacion', weight: 3, lang: 'es' },
    ],
    role_type: [
      { term: 'business analyst', weight: 3, pair: 'business analyst' },
      { term: 'analista de negocio', weight: 3, lang: 'es', pair: 'business analyst' },
      { term: 'co-op', weight: 3 },
      { term: 'recruiter', weight: -3 },
    ],
    tool_overlap: [
      { term: 'sql', weight: 3, pair: 'sql' },
    ],
    level_fit: [],
  },
  tracks: [
    {
      id: 'canada_coop',
      gates: [
        { id: 'location_canada', type: 'hard', scope: 'location', require: ['canada', 'toronto'] },
        { id: 'coop_signal', type: 'penalty', points: 15, scope: 'title', require: ['co-op', 'work term'] },
      ],
    },
    {
      id: 'colombia_perm',
      gates: [
        { id: 'location_latam', type: 'hard', scope: 'location', require: ['colombia', 'latam'] },
        { id: 'reject_us_only', type: 'hard', scope: 'text', reject: ['us only', 'no sponsorship'] },
      ],
    },
    {
      id: 'contractor_usd',
      gates: [
        { id: 'remote_required', type: 'hard', scope: 'location', require: ['remote', 'worldwide'] },
        { id: 'reject_restricted_remote', type: 'hard', scope: 'location', reject: ['emea', 'san francisco'] },
      ],
    },
  ],
});

const row = (rows: MatrixRow[], cat: string) => rows.find((r) => r.category === cat)!;
const terms = (chips: { term: string }[]) => chips.map((c) => c.term);

describe('buildMatrix', () => {
  const rows = buildMatrix(makeCfg(), emptyMeta());

  it('projects the 5 categories in sketch order (location first)', () => {
    expect(rows.map((r) => r.category)).toEqual(['location', 'role_type', 'level_fit', 'domain', 'tool_overlap']);
  });

  it('splits keywords by language and direction', () => {
    const rt = row(rows, 'role_type');
    expect(terms(rt.favor_en)).toContain('business analyst');
    expect(terms(rt.favor_es)).toContain('analista de negocio');
    expect(terms(rt.against_en)).toContain('recruiter');
    expect(rt.against_es).toEqual([]);
  });

  it('derives the path badge from gate membership', () => {
    const coop = row(rows, 'role_type').favor_en.find((c) => c.term === 'co-op')!;
    expect(coop.path).toBe('canada_coop');
    expect(coop.penalty).toBe(15);
    expect(coop.source.kind).toBe('keyword');
  });

  it('synthesizes the Location row from location/text gates with paths', () => {
    const loc = row(rows, 'location');
    expect(terms(loc.favor_en)).toEqual(expect.arrayContaining(['canada', 'colombia', 'remote']));
    expect(terms(loc.against_en)).toEqual(expect.arrayContaining(['us only', 'emea']));
    expect(loc.favor_en.find((c) => c.term === 'canada')!.path).toBe('canada_coop');
    expect(loc.against_en.find((c) => c.term === 'emea')!.source).toMatchObject({ kind: 'gate', track: 'contractor_usd' });
  });

  it('puts title-scope gate-only terms in Role titles, not Location', () => {
    expect(terms(row(rows, 'role_type').favor_en)).toContain('work term');
    expect(terms(row(rows, 'location').favor_en)).not.toContain('work term');
  });

  it('mirrors a single-entry pair (EN == ES) into both columns', () => {
    const tools = row(rows, 'tool_overlap');
    expect(terms(tools.favor_en)).toContain('sql');
    expect(terms(tools.favor_es)).toContain('sql');
    expect(tools.favor_es.find((c) => c.term === 'sql')!.mirrored).toBe(true);
  });

  it('respects meta.gate_langs and mirrors a solo gate term into both columns', () => {
    const meta: MatrixMeta = { gate_langs: { colombia: 'es' }, gate_pairs: {} };
    const loc = row(buildMatrix(makeCfg(), meta), 'location');
    // gate_langs sets the PRIMARY column (ES); a same-word solo term (no distinct
    // twin) mirrors into the EN column too — full EN/ES parity in the grid.
    expect(terms(loc.favor_es)).toContain('colombia');
    expect(terms(loc.favor_en)).toContain('colombia');
    expect(loc.favor_en.find((c) => c.term === 'colombia')!.mirrored).toBe(true);
  });
});

describe('pathOptions', () => {
  const cfg = makeCfg();
  it('location: favor = every track with a require list; against = tracks with reject lists', () => {
    expect(pathOptions(cfg, 'location', true)).toEqual(['canada_coop', 'colombia_perm', 'contractor_usd']);
    expect(pathOptions(cfg, 'location', false)).toEqual(['colombia_perm', 'contractor_usd']);
  });
  it('scoring categories: only tracks with a title-scope gate', () => {
    expect(pathOptions(cfg, 'role_type', true)).toEqual(['canada_coop']);
    expect(pathOptions(cfg, 'role_type', false)).toEqual([]);
  });
});

describe('applyWordAdd', () => {
  it('adds EN+ES twins sharing a pair id', () => {
    const cfg = makeCfg();
    const err = applyWordAdd(cfg, emptyMeta(), {
      en: 'Data Engineer', es: 'ingeniero de datos', category: 'role_type', favor: true, weight: 2,
    });
    expect(err).toBeNull();
    const added = cfg.keywords.role_type.filter((k) => k.pair === 'data engineer');
    expect(added).toHaveLength(2);
    expect(added.find((k) => k.lang === 'es')!.term).toBe('ingeniero de datos');
    expect(added.every((k) => k.weight === 2)).toBe(true);
  });

  it('EN == ES stores ONE entry (no double counting in scoring)', () => {
    const cfg = makeCfg();
    applyWordAdd(cfg, emptyMeta(), { en: 'python', es: 'python', category: 'tool_overlap', favor: true, weight: 2 });
    expect(cfg.keywords.tool_overlap.filter((k) => k.term === 'python')).toHaveLength(1);
  });

  it('against words store negative weight and only allow −2/−3', () => {
    const cfg = makeCfg();
    expect(applyWordAdd(cfg, emptyMeta(), { en: 'seller', es: 'vendedor', category: 'role_type', favor: false, weight: 1 }))
      .toMatchObject({ error: expect.stringContaining('−2 or −3') });
    expect(applyWordAdd(cfg, emptyMeta(), { en: 'seller', es: 'vendedor', category: 'role_type', favor: false, weight: 3 })).toBeNull();
    expect(cfg.keywords.role_type.find((k) => k.term === 'vendedor')!.weight).toBe(-3);
  });

  it('rejects duplicates and missing languages', () => {
    const cfg = makeCfg();
    expect(applyWordAdd(cfg, emptyMeta(), { en: 'payments', es: 'pagos', category: 'domain', favor: true, weight: 2 }))
      .toMatchObject({ error: expect.stringContaining('already listed') });
    expect(applyWordAdd(cfg, emptyMeta(), { en: 'x', es: '  ', category: 'domain', favor: true, weight: 2 }))
      .toMatchObject({ error: expect.stringContaining('both languages') });
  });

  it('a path on a scoring word also appends both twins to the track title gate', () => {
    const cfg = makeCfg();
    const err = applyWordAdd(cfg, emptyMeta(), {
      en: 'work placement', es: 'pasantía', category: 'role_type', favor: true, weight: 2, path: 'canada_coop',
    });
    expect(err).toBeNull();
    const gate = cfg.tracks.find((t) => t.id === 'canada_coop')!.gates.find((g) => g.id === 'coop_signal')!;
    expect(gate.require).toEqual(expect.arrayContaining(['work placement', 'pasantía']));
  });

  it('a path pointing at a track without a suitable gate is refused (never creates gates)', () => {
    const cfg = makeCfg();
    const err = applyWordAdd(cfg, emptyMeta(), {
      en: 'consultant', es: 'consultor', category: 'role_type', favor: true, weight: 2, path: 'colombia_perm',
    });
    expect(err).toMatchObject({ error: expect.stringContaining('no require title gate') });
  });

  it('location words require a path and land in that track gate + meta', () => {
    const cfg = makeCfg();
    const meta = emptyMeta();
    expect(applyWordAdd(cfg, meta, { en: 'medellin', es: 'medellín', category: 'location', favor: true, weight: 2 }))
      .toMatchObject({ error: expect.stringContaining('need a path') });
    const err = applyWordAdd(cfg, meta, {
      en: 'medellin', es: 'medellín', category: 'location', favor: true, weight: 2, path: 'colombia_perm',
    });
    expect(err).toBeNull();
    const gate = cfg.tracks.find((t) => t.id === 'colombia_perm')!.gates.find((g) => g.id === 'location_latam')!;
    expect(gate.require).toEqual(expect.arrayContaining(['medellin', 'medellín']));
    expect(meta.gate_pairs['medellín']).toBe('medellin');
    expect(meta.gate_langs['medellín']).toBe('es');
  });
});

describe('applyPairRemove', () => {
  it('keyword ✕ removes BOTH twins and their gate entries', () => {
    const cfg = makeCfg();
    const meta = emptyMeta();
    applyWordAdd(cfg, meta, { en: 'work placement', es: 'practicas', category: 'role_type', favor: true, weight: 2, path: 'canada_coop' });
    const r = applyPairRemove(cfg, meta, { kind: 'keyword', category: 'role_type', term: 'practicas' });
    expect(r).toMatchObject({ removed: expect.arrayContaining(['work placement', 'practicas']) });
    expect(cfg.keywords.role_type.some((k) => k.term === 'work placement')).toBe(false);
    const gate = cfg.tracks.find((t) => t.id === 'canada_coop')!.gates.find((g) => g.id === 'coop_signal')!;
    expect(gate.require).not.toContain('work placement');
    expect(gate.require).toContain('co-op');
  });

  it('gate ✕ removes the pair from that gate via meta', () => {
    const cfg = makeCfg();
    const meta = emptyMeta();
    applyWordAdd(cfg, meta, { en: 'bogota', es: 'bogotá', category: 'location', favor: true, weight: 2, path: 'colombia_perm' });
    const r = applyPairRemove(cfg, meta, { kind: 'gate', track: 'colombia_perm', gate: 'location_latam', term: 'bogotá' });
    expect(r).toMatchObject({ removed: expect.arrayContaining(['bogota', 'bogotá']) });
    const gate = cfg.tracks.find((t) => t.id === 'colombia_perm')!.gates.find((g) => g.id === 'location_latam')!;
    expect(gate.require).not.toContain('bogota');
    expect(gate.require).toContain('colombia');
    expect(meta.gate_pairs['bogotá']).toBeUndefined();
  });

  it('legacy single terms (no pair) remove just themselves', () => {
    const cfg = makeCfg();
    const r = applyPairRemove(cfg, emptyMeta(), { kind: 'keyword', category: 'domain', term: 'payments' });
    expect(r).toMatchObject({ removed: ['payments'] });
    expect(cfg.keywords.domain.some((k) => k.term === 'payments')).toBe(false);
  });
});

describe('parseMeta', () => {
  it('tolerates null and garbage', () => {
    expect(parseMeta(null)).toEqual({ gate_langs: {}, gate_pairs: {} });
    expect(parseMeta('not json')).toEqual({ gate_langs: {}, gate_pairs: {} });
    expect(parseMeta('{"gate_langs":{"x":"es"}}').gate_langs.x).toBe('es');
  });
});

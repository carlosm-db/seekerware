import { describe, expect, it } from 'vitest';
import type { ScoringConfig } from '../src/scoring';
import {
  applyPairComplete, applyPairRemove, applyWordAdd, buildMatrix, emptyMeta, parseMeta, pathOptions,
  type MatrixGroup, type MatrixMeta,
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

const row = (rows: MatrixGroup[], cat: string) => rows.find((r) => r.category === cat)!;
const ens = (rows: { en: string }[]) => rows.map((r) => r.en);

describe('buildMatrix', () => {
  const rows = buildMatrix(makeCfg(), emptyMeta());

  it('projects the 5 categories in sketch order (location first)', () => {
    expect(rows.map((r) => r.category)).toEqual(['location', 'role_type', 'level_fit', 'domain', 'tool_overlap']);
  });

  it('splits keywords by direction, English in front of Español', () => {
    const rt = row(rows, 'role_type');
    const ba = rt.favor.find((r) => r.en === 'business analyst')!;
    expect(ba.es).toBe('analista de negocio');
    expect(ens(rt.against)).toContain('recruiter');
    // a lone against keyword with no twin is a gap (honest — no cloned ES).
    const rec = rt.against.find((r) => r.en === 'recruiter')!;
    expect(rec.es).toBeNull();
    expect(rec.same).toBe(false);
  });

  it('derives the path badge from gate membership', () => {
    const coop = row(rows, 'role_type').favor.find((r) => r.en === 'co-op')!;
    expect(coop.path).toBe('canada_coop');
    expect(coop.penalty).toBe(15);
    expect(coop.source.kind).toBe('keyword');
  });

  it('synthesizes the Location row from location/text gates with paths', () => {
    const loc = row(rows, 'location');
    expect(ens(loc.favor)).toEqual(expect.arrayContaining(['canada', 'colombia', 'remote']));
    expect(ens(loc.against)).toEqual(expect.arrayContaining(['us only', 'emea']));
    expect(loc.favor.find((r) => r.en === 'canada')!.path).toBe('canada_coop');
    expect(loc.against.find((r) => r.en === 'emea')!.source).toMatchObject({ kind: 'gate', track: 'contractor_usd' });
  });

  it('puts title-scope gate-only terms in Role titles, not Location', () => {
    expect(ens(row(rows, 'role_type').favor)).toContain('work term');
    expect(ens(row(rows, 'location').favor)).not.toContain('work term');
  });

  it('a single entry with no twin and no `same` is an honest GAP (no mirror)', () => {
    const sql = row(rows, 'tool_overlap').favor.find((r) => r.en === 'sql')!;
    expect(sql.es).toBeNull();
    expect(sql.same).toBe(false);
    // counts reflect the gap, not a fake pair.
    expect(row(rows, 'tool_overlap').counts).toMatchObject({ paired: 0, same: 0, gap: 1 });
  });

  it('a `same` keyword renders identical (es=null, same=true), stored once', () => {
    const cfg = makeCfg();
    cfg.keywords.tool_overlap.push({ term: 'excel', weight: 2, pair: 'excel', same: true });
    const excel = row(buildMatrix(cfg, emptyMeta()), 'tool_overlap').favor.find((r) => r.en === 'excel')!;
    expect(excel.es).toBeNull();
    expect(excel.same).toBe(true);
  });

  it('gate concepts: real ES twin shows both; gate_same = identical; bare = gap', () => {
    const cfg = makeCfg();
    cfg.tracks.find((t) => t.id === 'colombia_perm')!.gates.find((g) => g.id === 'location_latam')!.require!.push('latinoamerica');
    const meta: MatrixMeta = {
      gate_langs: { latinoamerica: 'es' },
      gate_pairs: { latam: 'latam', latinoamerica: 'latam' },
      gate_same: { colombia: true },
    };
    const loc = row(buildMatrix(cfg, meta), 'location');
    expect(loc.favor.find((r) => r.en === 'latam')!.es).toBe('latinoamerica');
    const co = loc.favor.find((r) => r.en === 'colombia')!;
    expect(co.same).toBe(true);
    expect(co.es).toBeNull();
    const remote = loc.favor.find((r) => r.en === 'remote')!;
    expect(remote.es).toBeNull();
    expect(remote.same).toBe(false);
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

  it('EN == ES stores ONE entry marked `same` (no double counting in scoring)', () => {
    const cfg = makeCfg();
    applyWordAdd(cfg, emptyMeta(), { en: 'python', es: 'python', category: 'tool_overlap', favor: true, weight: 2 });
    const py = cfg.keywords.tool_overlap.filter((k) => k.term === 'python');
    expect(py).toHaveLength(1);
    expect(py[0]!.same).toBe(true);
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

  it('location EN == ES marks gate_same instead of a language twin', () => {
    const cfg = makeCfg();
    const meta = emptyMeta();
    const err = applyWordAdd(cfg, meta, { en: 'bogota', es: 'bogota', category: 'location', favor: true, weight: 2, path: 'colombia_perm' });
    expect(err).toBeNull();
    expect(meta.gate_same['bogota']).toBe(true);
    expect(meta.gate_langs['bogota']).toBeUndefined();
  });
});

describe('applyPairComplete', () => {
  it('keyword gap → adds the real ES twin sharing the pair id', () => {
    const cfg = makeCfg();
    const err = applyPairComplete(cfg, emptyMeta(), {
      category: 'domain', en: 'payments', es: 'pagos', favor: true, kind: 'keyword',
    });
    expect(err).toBeNull();
    const grp = cfg.keywords.domain.filter((k) => k.pair === 'payments');
    expect(grp).toHaveLength(2);
    expect(grp.find((k) => k.lang === 'es')!.term).toBe('pagos');
    expect(grp.every((k) => k.weight === 3)).toBe(true);
  });

  it('keyword gap → mark same sets the flag and keeps one entry', () => {
    const cfg = makeCfg();
    const err = applyPairComplete(cfg, emptyMeta(), {
      category: 'tool_overlap', en: 'sql', same: true, favor: true, kind: 'keyword',
    });
    expect(err).toBeNull();
    const sql = cfg.keywords.tool_overlap.filter((k) => k.term === 'sql');
    expect(sql).toHaveLength(1);
    expect(sql[0]!.same).toBe(true);
  });

  it('gate gap → adds the ES twin to the gate list + meta', () => {
    const cfg = makeCfg();
    const meta = emptyMeta();
    const err = applyPairComplete(cfg, meta, {
      category: 'location', en: 'remote', es: 'remoto', favor: true, kind: 'gate',
      track: 'contractor_usd', gate: 'remote_required',
    });
    expect(err).toBeNull();
    const gate = cfg.tracks.find((t) => t.id === 'contractor_usd')!.gates.find((g) => g.id === 'remote_required')!;
    expect(gate.require).toContain('remoto');
    expect(meta.gate_langs['remoto']).toBe('es');
    expect(meta.gate_pairs['remoto']).toBe('remote');
  });

  it('gate gap → mark same sets gate_same', () => {
    const cfg = makeCfg();
    const meta = emptyMeta();
    const err = applyPairComplete(cfg, meta, {
      category: 'location', en: 'canada', same: true, favor: true, kind: 'gate',
      track: 'canada_coop', gate: 'location_canada',
    });
    expect(err).toBeNull();
    expect(meta.gate_same['canada']).toBe(true);
  });

  it('requires either a Spanish twin or same', () => {
    const cfg = makeCfg();
    expect(applyPairComplete(cfg, emptyMeta(), { category: 'domain', en: 'payments', favor: true, kind: 'keyword' }))
      .toMatchObject({ error: expect.stringContaining('same') });
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
    expect(parseMeta(null)).toEqual({ gate_langs: {}, gate_pairs: {}, gate_same: {} });
    expect(parseMeta('not json')).toEqual({ gate_langs: {}, gate_pairs: {}, gate_same: {} });
    expect(parseMeta('{"gate_langs":{"x":"es"}}').gate_langs.x).toBe('es');
  });
});

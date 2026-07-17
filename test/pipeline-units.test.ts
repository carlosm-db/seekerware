import { describe, expect, it } from 'vitest';
import { checkFreshness } from '../src/freshness';
import { escapeHtml, formatJobMessage, formatMaintenance } from '../src/notify';
import type { Job } from '../src/types';

const NOW = new Date('2026-07-17T12:00:00Z');

describe('checkFreshness', () => {
  it('fresco: publicado hace 1 dia', () => {
    const f = checkFreshness('2026-07-16T12:00:00Z', '2026-07-17T12:00:00Z', 3, NOW);
    expect(f).toMatchObject({ fresh: true, freshness_ok: 'true', age_days: 1 });
  });

  it('viejo: publicado hace 5 dias -> no fresco (jamas se notifica)', () => {
    const f = checkFreshness('2026-07-12T12:00:00Z', '2026-07-17T12:00:00Z', 3, NOW);
    expect(f.fresh).toBe(false);
    expect(f.freshness_ok).toBe('true');
  });

  it('sin fecha confiable: fallback a first_seen y freshness_ok=unknown', () => {
    const f = checkFreshness(null, '2026-07-17T11:00:00Z', 3, NOW);
    expect(f.fresh).toBe(true);
    expect(f.freshness_ok).toBe('unknown');
  });

  it('fecha invalida cuenta como no confiable', () => {
    const f = checkFreshness('no-es-fecha', '2026-07-17T11:00:00Z', 3, NOW);
    expect(f.freshness_ok).toBe('unknown');
  });
});

describe('mensajes de Telegram', () => {
  const job: Job = {
    id: '1', company: 'Acme <Corp>', title: 'Data Analyst & Ops <img>', location: 'Vancouver',
    url: 'https://x.io/1', description: '', posted_at: null, ats: 'greenhouse', raw: {},
  };

  it('escapa HTML de terceros (titulos y empresa son texto no confiable)', () => {
    const msg = formatJobMessage({
      job, verdict: 'Apply', track: 'canada_coop', score: 80, ageDays: 0.5,
      whyItFits: 'x', gapToAddress: 'y', positioningLead: 'z', ruleBased: true,
    });
    expect(msg).toContain('Data Analyst &amp; Ops &lt;img&gt;');
    expect(msg).toContain('Acme &lt;Corp&gt;');
    expect(msg).not.toContain('<img>');
  });

  it('contiene verdict, score, track y marca rule-based; sin datos personales', () => {
    const msg = formatJobMessage({
      job, verdict: 'Stretch-worth-it', track: 'canada_coop', score: 61, ageDays: 2,
      whyItFits: 'dominio: payments', gapToAddress: 'nivel', positioningLead: 'abrir por payments',
      ruleBased: true,
    });
    expect(msg).toContain('Stretch-worth-it');
    expect(msg).toContain('61/100');
    expect(msg).toContain('canada_coop');
    expect(msg).toContain('(rule-based)');
    expect(msg).toContain('hace 2 d');
  });

  it('MANTENIMIENTO lleva el prefijo de UI.md', () => {
    expect(formatMaintenance('feed roto')).toMatch(/^⚠️ MANTENIMIENTO\nfeed roto$/);
  });

  it('escapeHtml cubre & < >', () => {
    expect(escapeHtml('a<b>&c')).toBe('a&lt;b&gt;&amp;c');
  });
});

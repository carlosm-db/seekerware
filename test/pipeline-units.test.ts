import { describe, expect, it } from 'vitest';
import { checkFreshness } from '../src/freshness';
import { escapeHtml, formatJobMessage, formatMaintenance } from '../src/notify';
import type { Job } from '../src/types';

const NOW = new Date('2026-07-17T12:00:00Z');

describe('checkFreshness', () => {
  it('fresh: published 1 day ago', () => {
    const f = checkFreshness('2026-07-16T12:00:00Z', '2026-07-17T12:00:00Z', 3, NOW);
    expect(f).toMatchObject({ fresh: true, freshness_ok: 'true', age_days: 1 });
  });

  it('old: published 5 days ago -> not fresh (never notified)', () => {
    const f = checkFreshness('2026-07-12T12:00:00Z', '2026-07-17T12:00:00Z', 3, NOW);
    expect(f.fresh).toBe(false);
    expect(f.freshness_ok).toBe('true');
  });

  it('no reliable date: fallback to first_seen and freshness_ok=unknown', () => {
    const f = checkFreshness(null, '2026-07-17T11:00:00Z', 3, NOW);
    expect(f.fresh).toBe(true);
    expect(f.freshness_ok).toBe('unknown');
  });

  it('invalid date counts as unreliable', () => {
    const f = checkFreshness('not-a-date', '2026-07-17T11:00:00Z', 3, NOW);
    expect(f.freshness_ok).toBe('unknown');
  });
});

describe('Telegram messages', () => {
  const job: Job = {
    id: '1', company: 'Acme <Corp>', title: 'Data Analyst & Ops <img>', location: 'Vancouver',
    url: 'https://x.io/1', description: '', posted_at: null, ats: 'greenhouse', raw: {},
  };

  it('escapes third-party HTML (titles and company are untrusted text)', () => {
    const msg = formatJobMessage({
      job, verdict: 'Apply', track: 'canada_coop', score: 80, ageDays: 0.5,
      whyItFits: 'x', gapToAddress: 'y', positioningLead: 'z', ruleBased: true,
    });
    expect(msg).toContain('Data Analyst &amp; Ops &lt;img&gt;');
    expect(msg).toContain('Acme &lt;Corp&gt;');
    expect(msg).not.toContain('<img>');
  });

  it('contains verdict, score, track and rule-based mark; no personal data', () => {
    const msg = formatJobMessage({
      job, verdict: 'Stretch-worth-it', track: 'canada_coop', score: 61, ageDays: 2,
      whyItFits: 'domain: payments', gapToAddress: 'level', positioningLead: 'lead with payments',
      ruleBased: true,
    });
    expect(msg).toContain('Stretch-worth-it');
    expect(msg).toContain('61/100');
    expect(msg).toContain('canada_coop');
    expect(msg).toContain('(rule-based)');
    expect(msg).toContain('2 d ago');
  });

  it('MAINTENANCE carries the UI.md prefix', () => {
    expect(formatMaintenance('broken feed')).toMatch(/^⚠️ MAINTENANCE\nbroken feed$/);
  });

  it('escapeHtml covers & < >', () => {
    expect(escapeHtml('a<b>&c')).toBe('a&lt;b&gt;&amp;c');
  });
});

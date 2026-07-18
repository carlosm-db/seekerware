// Human-readable scoring-config diff (2026-07-18 calibration rework): the
// history must say WHAT changed in words — no more blind reverts. Pure and
// unit-tested.

import type { ScoringConfig } from '../scoring';

export function diffScoring(oldC: ScoringConfig, newC: ScoringConfig): string {
  const parts: string[] = [];

  if (oldC.thresholds.apply !== newC.thresholds.apply) {
    parts.push(`notify threshold ${oldC.thresholds.apply}→${newC.thresholds.apply}`);
  }
  if (oldC.thresholds.stretch !== newC.thresholds.stretch) {
    parts.push(`borderline threshold ${oldC.thresholds.stretch}→${newC.thresholds.stretch}`);
  }

  for (const cat of Object.keys(newC.keywords) as Array<keyof ScoringConfig['keywords']>) {
    const oldTerms = new Map((oldC.keywords[cat] ?? []).map((k) => [k.term, k.weight]));
    const newTerms = new Map((newC.keywords[cat] ?? []).map((k) => [k.term, k.weight]));
    const added = [...newTerms.keys()].filter((t) => !oldTerms.has(t));
    const removed = [...oldTerms.keys()].filter((t) => !newTerms.has(t));
    const reweighted = [...newTerms.keys()].filter((t) => oldTerms.has(t) && oldTerms.get(t) !== newTerms.get(t));
    const bits = [
      ...added.map((t) => `+${t}`),
      ...removed.map((t) => `−${t}`),
      ...reweighted.map((t) => `${t} ${oldTerms.get(t)}→${newTerms.get(t)}`),
    ];
    if (bits.length) parts.push(`${cat}: ${bits.join(', ')}`);
  }

  const oldTracks = new Map(oldC.tracks.map((t) => [t.id, t]));
  for (const nt of newC.tracks) {
    const ot = oldTracks.get(nt.id);
    if (!ot) { parts.push(`track ${nt.id} added`); continue; }
    const oldGates = new Map(ot.gates.map((g) => [g.id, g]));
    for (const ng of nt.gates) {
      const og = oldGates.get(ng.id);
      if (!og) { parts.push(`${nt.id}: gate ${ng.id} added`); continue; }
      if ((og.points ?? 0) !== (ng.points ?? 0)) parts.push(`${ng.id} penalty ${og.points ?? 0}→${ng.points ?? 0}`);
      for (const list of ['require', 'reject'] as const) {
        const o = new Set(og[list] ?? []);
        const n = new Set(ng[list] ?? []);
        const bits = [
          ...[...n].filter((t) => !o.has(t)).map((t) => `+${t}`),
          ...[...o].filter((t) => !n.has(t)).map((t) => `−${t}`),
        ];
        if (bits.length) parts.push(`${ng.id}.${list}: ${bits.join(', ')}`);
      }
    }
    for (const og of ot.gates) if (!nt.gates.some((g) => g.id === og.id)) parts.push(`${nt.id}: gate ${og.id} removed`);
  }
  for (const ot of oldC.tracks) if (!newC.tracks.some((t) => t.id === ot.id)) parts.push(`track ${ot.id} removed`);

  return parts.join('; ') || 'no effective changes';
}

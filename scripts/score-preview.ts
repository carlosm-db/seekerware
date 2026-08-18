// Calibration preview (docs/audits/2026-08-18-calibration-role-fit.md): re-scores a SAMPLE of
// already-stored jobs with a CANDIDATE config and prints the verdict delta, so a calibration change
// can be judged BEFORE it goes live. Exists because Re-score was removed on 2026-07-19 and the
// notify window is <= 3 days: tuning blind, an over-tightening silently loses postings that cannot be
// recovered, and the feedback loop is only 2 runs/day.
//
// Read-only and OFFLINE: the job sample and the live config are exported beforehand with
// `wrangler d1 execute --remote --json` (owner's wrangler session — no API token is handled here) and
// passed in as files. Nothing is written to D1; nothing is deployed.
//
// The candidate is expressed as a PATCH over the live config, not as a hand-copied blob, so the diff
// stays reviewable and doubles as the exact edit list to apply in the console's /calibration.
//
// Run: npx tsx scripts/score-preview.ts --jobs sample.json --base live-config.json --patch cand.json
// Not part of tsconfig (same as scripts/poll.ts) — tsx transpiles it at runtime.

import { readFileSync, writeFileSync } from 'node:fs';
import { validateScoringConfig } from '../src/config-store';
import { scoreJob, CATEGORIES, normalizeTitle } from '../src/scoring';
import type { ScoringConfig, Category, Keyword } from '../src/scoring';
import type { Job, Verdict } from '../src/types';

declare const process: { argv: string[]; exit(code: number): never };

const VERDICTS: Verdict[] = ['Apply', 'Stretch-worth-it', 'Skip'];

interface StoredJob {
  url_hash: string;
  title: string;
  location: string | null;
  description_text: string | null;
  score: number | null;
  verdict: Verdict | null;
}

/** Candidate = live config + this patch. `set` takes dotted paths (e.g. thresholds.apply). */
interface ConfigPatch {
  remove?: Partial<Record<Category, string[]>>;
  add?: Partial<Record<Category, Keyword[]>>;
  /** Force a scope on EVERY term of a category — `role_type` is title-scoped as a whole. */
  scope?: Partial<Record<Category, 'title' | 'text'>>;
  /**
   * Terms that HARD-fail every track when they appear in the title. Modelled as a title-scoped
   * `reject` gate, which is the engine's only "must not appear" mechanism — a negative weight merely
   * subtracts and can be outvoted (domain rule 2: verdicts belong to the rules, not to arithmetic).
   */
  reject_title?: string[];
  set?: Record<string, unknown>;
}

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (!v) throw new Error(`missing --${name}`);
  return v;
}

/** Accepts a bare value or a wrangler `--json` envelope: [{ results: [...] }]. */
function unwrap(raw: string): unknown {
  const parsed = JSON.parse(raw) as unknown;
  if (
    Array.isArray(parsed) && parsed.length &&
    typeof parsed[0] === 'object' && parsed[0] !== null && 'results' in (parsed[0] as object)
  ) {
    return (parsed as Array<{ results: unknown[] }>).flatMap((r) => r.results);
  }
  return parsed;
}

function loadJobs(path: string): StoredJob[] {
  return unwrap(readFileSync(path, 'utf8')) as StoredJob[];
}

/** The live config arrives as config['scoring'] — a JSON STRING inside a row. */
function loadBaseConfig(path: string): ScoringConfig {
  const u = unwrap(readFileSync(path, 'utf8'));
  const rows = Array.isArray(u) ? (u as Array<{ value?: string }>) : [];
  const value = rows[0]?.value;
  return (typeof value === 'string' ? JSON.parse(value) : u) as ScoringConfig;
}

function applyPatch(base: ScoringConfig, patch: ConfigPatch): ScoringConfig {
  const cfg = JSON.parse(JSON.stringify(base)) as ScoringConfig;
  for (const cat of CATEGORIES) {
    const drop = new Set((patch.remove?.[cat] ?? []).map((t) => t.toLowerCase()));
    if (drop.size) cfg.keywords[cat] = cfg.keywords[cat].filter((k) => !drop.has(k.en.toLowerCase()));
    const added = patch.add?.[cat] ?? [];
    if (added.length) {
      // Adding a term that already exists would double-count the concept: replace it instead.
      const names = new Set(added.map((k) => k.en.toLowerCase()));
      cfg.keywords[cat] = cfg.keywords[cat].filter((k) => !names.has(k.en.toLowerCase())).concat(added);
    }
  }
  // Applied AFTER add/remove so it covers the terms this patch introduced too.
  for (const cat of CATEGORIES) {
    const scope = patch.scope?.[cat];
    if (scope) cfg.keywords[cat] = cfg.keywords[cat].map((k) => ({ ...k, scope }));
  }
  if (patch.reject_title?.length) {
    const reject = patch.reject_title.map((en) => ({ en, es: en }));
    for (const t of cfg.tracks) t.gates.push({ id: 'reject_over_band', scope: 'title', reject });
  }
  for (const [dotted, val] of Object.entries(patch.set ?? {})) {
    const parts = dotted.split('.');
    let node = cfg as unknown as Record<string, unknown>;
    for (const p of parts.slice(0, -1)) node = node[p] as Record<string, unknown>;
    node[parts[parts.length - 1]!] = val;
  }
  return cfg;
}

/**
 * Does the title belong to the owner's target families (Business Operations x Technical Solutions)?
 * Deliberately title-only and coarse: it measures the SHARE of alerts landing on-profile, which is the
 * number the calibration is tuned against — it is NOT a scoring input.
 */
const ON_TARGET_ROLES = [
  'operations analyst', 'business operations', 'business analyst', 'business systems',
  'systems analyst', 'operations manager', 'operations specialist', 'process analyst',
  'data analyst', 'reporting analyst', 'business intelligence', 'bi analyst',
  'solutions analyst', 'solutions consultant', 'technical solutions', 'service delivery',
  'operational excellence', 'process improvement', 'operations', 'operation',
  'program manager', 'project manager',
];
/** Banking functions the owner adjudicated as Apply on 2026-08-18 (the `Analyst, <function>` grammar). */
const ON_TARGET_FUNCTIONS = [
  'aml', 'kyc', 'financial crime', 'payments', 'settlement', 'clearing', 'fraud', 'chargeback',
  'disputes', 'reconciliation', 'asset servicing', 'custody', 'income processing',
  'risk', 'controls', 'governance',
];
/**
 * Above the owner's target band. They want analyst / senior analyst / specialist / lead / supervisor
 * at most (stated 2026-08-18), so a managerial grade in the title is a miss no matter how well the
 * rest of the posting scores. `normalizeTitle` already strips `senior`, so "Senior Manager" -> manager.
 */
const OVER_BAND = ['manager', 'director', 'vp', 'vice president', 'head of', 'chief'];
function overBand(title: string): boolean {
  const t = normalizeTitle(title);
  return OVER_BAND.some((p) => t.includes(p));
}

/** Strict: the title names an ops/BA role outright. */
function onTargetRole(title: string): boolean {
  const t = normalizeTitle(title);
  return ON_TARGET_ROLES.some((p) => t.includes(p));
}
/** Adjudicated: role names PLUS the approved banking functions. Reported alongside the strict share,
 *  because the function list is broad ('risk' matches a lot) and one number alone would flatter. */
function onTarget(title: string): boolean {
  if (onTargetRole(title)) return true;
  const t = normalizeTitle(title);
  return ON_TARGET_FUNCTIONS.some((p) => t.includes(p));
}

function jobFrom(s: StoredJob): Job {
  // Same reconstruction the kit does from stored fields (src/kit/kit.ts:113): only title, location and
  // description feed the engine; id/company/url/ats/posted_at do not affect scoring.
  return {
    id: '', company: '', title: s.title, location: s.location ?? '', url: '',
    description: s.description_text ?? '', posted_at: null, ats: 'greenhouse', raw: null,
  };
}

const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : '-');

/**
 * Scores one job, optionally SIMULATING `scope: 'title'` on every role_type term (the code change
 * proposed in the audit, not yet in the engine). Done by scoring the job twice with the REAL engine —
 * once whole, once with the description stripped — and taking role_type from the title-only pass.
 * No engine logic is duplicated here. Answers "how much of the fix needs code, not config?": role
 * names leak through descriptions ("partner with business analysts"), which config alone cannot stop.
 */
function scoreWith(s: StoredJob, cfg: ScoringConfig, titleScopedRole: boolean) {
  const full = scoreJob(jobFrom(s), cfg);
  if (!titleScopedRole) return full;
  const titleOnly = scoreJob({ ...jobFrom(s), description: '' }, cfg);
  const breakdown = { ...full.breakdown, role_type: titleOnly.breakdown.role_type };
  const score = Math.round(CATEGORIES.reduce((acc, c) => acc + breakdown[c].points, 0));
  // Gates are unchanged (they read location/text): no track ⇒ Skip regardless of score.
  const verdict: Verdict = !full.best.track
    ? 'Skip'
    : score >= cfg.thresholds.apply
      ? 'Apply'
      : score >= cfg.thresholds.stretch
        ? 'Stretch-worth-it'
        : 'Skip';
  return { ...full, score, breakdown, best: { ...full.best, verdict, adjusted_score: score } };
}

function main(): void {
  const jobs = loadJobs(arg('jobs'));
  const base = loadBaseConfig(arg('base'));
  const patch = JSON.parse(readFileSync(arg('patch'), 'utf8')) as ConfigPatch;
  const cand = applyPatch(base, patch);
  const titleScoped = process.argv.includes('--title-scope-role');

  const matrix = new Map<string, number>();
  const gained: Array<{ title: string; before: number; after: number }> = [];
  const lost: Array<{ title: string; before: number; after: number }> = [];
  const catSum = { before: {} as Record<Category, number>, after: {} as Record<Category, number> };
  for (const c of CATEGORIES) { catSum.before[c] = 0; catSum.after[c] = 0; }
  let beforeApply = 0, afterApply = 0, beforeOn = 0, afterOn = 0, scoreDrop = 0;
  let beforeRole = 0, afterRole = 0, beforeOver = 0, afterOver = 0;

  for (const s of jobs) {
    // Re-score under BOTH configs: the stored verdict came from an older config version, so scoring a
    // fresh baseline isolates the effect of the PATCH instead of mixing in past calibration drift.
    const b = scoreJob(jobFrom(s), base);
    const a = scoreWith(s, cand, titleScoped);
    const cell = `${b.best.verdict}->${a.best.verdict}`;
    matrix.set(cell, (matrix.get(cell) ?? 0) + 1);
    for (const c of CATEGORIES) {
      catSum.before[c] += b.breakdown[c].points;
      catSum.after[c] += a.breakdown[c].points;
    }
    scoreDrop += b.score - a.score;
    const on = onTarget(s.title);
    const onRole = onTargetRole(s.title);
    const over = overBand(s.title);
    if (b.best.verdict === 'Apply') { beforeApply++; if (on) beforeOn++; if (onRole) beforeRole++; if (over) beforeOver++; }
    if (a.best.verdict === 'Apply') { afterApply++; if (on) afterOn++; if (onRole) afterRole++; if (over) afterOver++; }
    if (b.best.verdict !== 'Apply' && a.best.verdict === 'Apply') gained.push({ title: s.title, before: b.score, after: a.score });
    if (b.best.verdict === 'Apply' && a.best.verdict !== 'Apply') lost.push({ title: s.title, before: b.score, after: a.score });
  }

  const n = jobs.length || 1;
  console.log(`\nsample: ${jobs.length} stored jobs | base config v${base.version ?? '?'} | candidate thresholds apply>=${cand.thresholds.apply} stretch>=${cand.thresholds.stretch}`);
  if (titleScoped) console.log("MODE: simulating scope:'title' on role_type (needs the src/scoring.ts change)");
  console.log(`mean score: ${(scoreDrop / n).toFixed(1)} points lower under the candidate\n`);

  console.log('verdict matrix (base -> candidate):');
  for (const from of VERDICTS) {
    const cells = VERDICTS.map((to) => `${to}:${matrix.get(`${from}->${to}`) ?? 0}`).join('  ');
    console.log(`  ${from.padEnd(17)} ${cells}`);
  }

  console.log('\nmean points per category (the point of the change: role_type must stop being a constant):');
  for (const c of CATEGORIES) {
    console.log(`  ${c.padEnd(13)} ${(catSum.before[c] / n).toFixed(1)}/${base.weights[c].weight}  ->  ${(catSum.after[c] / n).toFixed(1)}/${cand.weights[c].weight}`);
  }

  console.log(`\nApply volume: ${beforeApply} -> ${afterApply}`);
  console.log(`on-target, roles + approved functions: ${pct(beforeOn, beforeApply)} -> ${pct(afterOn, afterApply)}`);
  console.log(`on-target, strict role names only:    ${pct(beforeRole, beforeApply)} -> ${pct(afterRole, afterApply)}`);
  console.log(`ABOVE target band (manager/dir/vp):    ${beforeOver} -> ${afterOver}  (${pct(afterOver, afterApply)} of Apply)`);

  const show = (label: string, rows: typeof gained) => {
    console.log(`\n${label} (${rows.length}):`);
    for (const r of rows.slice(0, 15)) {
      console.log(`  ${onTarget(r.title) ? '[on] ' : '[off]'} ${r.before}->${r.after}  ${r.title.slice(0, 88)}`);
    }
    if (rows.length > 15) console.log(`  ... ${rows.length - 15} more`);
  };
  show('GAINED Apply', gained);
  show('LOST Apply', lost);

  // `--emit <path>` writes the candidate as a full config, ready for config['scoring']. It emits the
  // SAME object the numbers above describe (no hand-copying, no drift), normalized and validated by
  // the real loader — so a config that would crash the pipeline never reaches D1.
  const emitAt = process.argv.indexOf('--emit');
  if (emitAt >= 0 && process.argv[emitAt + 1]) {
    const validated = validateScoringConfig(cand);
    writeFileSync(process.argv[emitAt + 1]!, JSON.stringify(validated));
    const scoped = CATEGORIES.reduce((n, c) => n + validated.keywords[c].filter((k) => k.scope === 'title').length, 0);
    console.log(`emitted validated config -> ${process.argv[emitAt + 1]} (v${validated.version ?? '?'}, ${scoped} title-scoped terms)`);
  }
  console.log('');
}

main();

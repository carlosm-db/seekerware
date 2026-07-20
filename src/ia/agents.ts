// Declarative agents (docs/TRD.md §4). Each agent is a {models, temperature,
// instruction, buildPrompt, schema} object run through the generic `runAgent`
// executor; the exported functions build the per-agent state and return the
// parsed result. There is NO monolithic runner — agents fire at different
// lifecycle points (notify / CV build / on-demand). Inviolable domain rules:
// - enricher: ONLY improves survivor texts; never touches verdicts or gates.
// - cv_selector: ONLY selects IDs of approved blocks (enum forced by schema).
// - cv_verifier: temp 0; suggests tweaks, NEVER edits.

import type { Env, Job } from '../types';
import { callGemini, wrapUntrusted, type GeminiResult } from './gemini';
import { profile, domainVocab } from './knowledge';

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** A declarative agent: model tier + how to build its instruction, prompt and JSON schema. */
export interface Agent<S> {
  name: string;
  /** Ordered model fallback chain (primary first). */
  models: string[];
  temperature: number;
  instruction: () => string;
  buildPrompt: (state: S) => string;
  schema: (state: S) => object;
}

/** Generic executor: assemble the call and run it through the Gemini wrapper (forced JSON). */
export function runAgent<T, S>(
  env: Env, agent: Agent<S>, state: S, doFetch: Fetcher = fetch,
): Promise<GeminiResult<T>> {
  return callGemini<T>(env, {
    models: agent.models,
    temperature: agent.temperature,
    instruction: agent.instruction(),
    input: agent.buildPrompt(state),
    responseSchema: agent.schema(state),
  }, doFetch);
}

// ---------- job_analyst ----------

/** Structured understanding of ONE role, produced once at notify and reused by
 * the enricher and the CV agents. This is ANALYSIS of the job, never CV content (§7.1). */
export interface RoleAnalysis {
  must_haves: string[];
  nice_to_haves: string[];
  seniority: string;
  domain_signals: string[];
  positioning_angle: string;
  screening_topics: string[];
}

interface AnalystState {
  job: Job;
}

const jobAnalystAgent: Agent<AnalystState> = {
  name: 'job_analyst',
  models: ['gemini-3.5-flash', 'gemini-3.1-flash-lite'],
  temperature: 0.2,
  instruction: () =>
    'You are the job_analyst. Read a job posting and extract a structured analysis of what the role ' +
    'really wants, judged for ' + profile() + '. Return: the must-have requirements, the nice-to-haves, ' +
    'the seniority level, the domain signals present (families like ' + domainVocab() + '), the single ' +
    'best positioning angle for this candidate, and the likely screening topics. Base everything ONLY ' +
    'on the posting — do not invent. This is ANALYSIS of the job, not CV content.',
  buildPrompt: (s) => `JOB (title: ${s.job.title})\n` + wrapUntrusted(s.job.description.slice(0, 6000)),
  schema: () => ({
    type: 'OBJECT',
    required: ['must_haves', 'nice_to_haves', 'seniority', 'domain_signals', 'positioning_angle', 'screening_topics'],
    properties: {
      must_haves: { type: 'ARRAY', items: { type: 'STRING' }, maxItems: 12 },
      nice_to_haves: { type: 'ARRAY', items: { type: 'STRING' }, maxItems: 12 },
      seniority: { type: 'STRING' },
      domain_signals: { type: 'ARRAY', items: { type: 'STRING' }, maxItems: 12 },
      positioning_angle: { type: 'STRING' },
      screening_topics: { type: 'ARRAY', items: { type: 'STRING' }, maxItems: 12 },
    },
  }),
};

export async function jobAnalyst(
  env: Env, job: Job, doFetch: Fetcher = fetch,
): Promise<GeminiResult<RoleAnalysis>> {
  return runAgent<RoleAnalysis, AnalystState>(env, jobAnalystAgent, { job }, doFetch);
}

/** Compact analysis context injected into downstream agents (empty when absent → old behavior). */
function analysisContext(a: RoleAnalysis | null | undefined): string {
  if (!a) return '';
  return 'ROLE ANALYSIS (from job_analyst):\n' +
    `must-haves: ${a.must_haves.join(', ')}\n` +
    `nice-to-haves: ${a.nice_to_haves.join(', ')}\n` +
    `seniority: ${a.seniority}\n` +
    `positioning angle: ${a.positioning_angle}\n\n`;
}

// ---------- enricher ----------

export interface EnrichedTexts {
  why_it_fits: string;
  gap_to_address: string;
  positioning_lead: string;
}

interface EnrichState {
  job: Job;
  ruleTexts: EnrichedTexts;
  analysis?: RoleAnalysis | null;
}

const enricherAgent: Agent<EnrichState> = {
  name: 'enricher',
  models: ['gemini-3.1-flash-lite', 'gemini-2.5-flash-lite'],
  temperature: 0.4,
  instruction: () =>
    'You are the enricher of a job-discovery engine. Improve the wording of three short ' +
    'texts (English, 1-2 sentences each) about why a job fits the profile of ' + profile() + '. ' +
    'Rely ONLY on the job and the rule-based drafts. Do not invent experience or figures. ' +
    'Do NOT change verdicts or mention scores.',
  buildPrompt: (s) =>
    analysisContext(s.analysis) +
    `RULE-BASED DRAFTS:\n${JSON.stringify(s.ruleTexts)}\n\nJOB (title: ${s.job.title})\n` +
    wrapUntrusted(s.job.description.slice(0, 6000)),
  schema: () => ({
    type: 'OBJECT',
    required: ['why_it_fits', 'gap_to_address', 'positioning_lead'],
    properties: {
      why_it_fits: { type: 'STRING' },
      gap_to_address: { type: 'STRING' },
      positioning_lead: { type: 'STRING' },
    },
  }),
};

export async function enricher(
  env: Env, job: Job, ruleTexts: EnrichedTexts, analysis: RoleAnalysis | null, doFetch: Fetcher = fetch,
): Promise<GeminiResult<EnrichedTexts>> {
  return runAgent<EnrichedTexts, EnrichState>(env, enricherAgent, { job, ruleTexts, analysis }, doFetch);
}

// ---------- cv_selector ----------

export interface CatalogBlock {
  id: string;
  section: string;
  anchor_id: string | null;
  /** Skill category (skills blocks only): technical/methodologies/academic/emerging. */
  skcat: string | null;
  tags: string;
  text: string;
}

export interface Selection {
  summary: string[];
  skills: string[];
  experience: string[];
  projects: string[];
  rationale: string;
}

/** The template's fixed slot budget (read at RUNTIME from the template, never
 * hardcoded — §4): how many summary slots, which skill categories, and how many
 * responsibility slots each active role has. Guides the selector so it fills the
 * REAL slots instead of arbitrary caps. */
export interface SlotBudget {
  summary: number;
  skillCats: string[];
  roles: Array<{ code: string; title: string; slots: number }>;
}

interface SelectState {
  job: Job;
  catalog: CatalogBlock[];
  budget?: SlotBudget;
  analysis?: RoleAnalysis | null;
}

/** Explicit "placeholder -> source" map the selector is told to fill (runtime data, no PII in code). */
function renderBudget(b: SlotBudget): string {
  const lines = ['TEMPLATE SLOTS — fill EXACTLY these; the source of each is noted:'];
  lines.push(`- Summary: ${b.summary} slots (sum_1..sum_${b.summary}) <- from SUMMARY blocks`);
  if (b.skillCats.length) {
    lines.push(`- Skills categories: ${b.skillCats.join(', ')} <- each from SKILLS blocks of that category`);
  }
  if (b.roles.length) {
    lines.push("- Experience (per role — never exceed a role's slots):");
    for (const r of b.roles) {
      lines.push(`    "${r.title}" (${r.code}): ${r.slots} slots <- EXPERIENCE blocks anchored to ${r.code}`);
    }
  }
  return lines.join('\n') + '\n\n';
}

/** The schema restricts each ID to the catalog's block enum: hallucination is impossible by construction. */
const cvSelectorAgent: Agent<SelectState> = {
  name: 'cv_selector',
  models: ['gemini-3.5-flash', 'gemini-3.1-flash-lite'],
  temperature: 0.3,
  instruction: () =>
    'You are the cv_selector for a CV built from a FIXED template whose exact slot budget is given ' +
    'below. Fill the slots that exist — no arbitrary counts. SUMMARY: the strongest, most job-relevant ' +
    "summary blocks, up to the summary-slot count. EXPERIENCE: for EACH role in the budget, its most " +
    "job-relevant responsibilities UP TO that role's slot count — cover every role, never exceed it " +
    '(return IDs; the render places each under its role by anchor). SKILLS: for each category in the ' +
    'budget, the most job-relevant skills. Prioritize blocks that match the job; never pick two ' +
    'phrasings of one achievement; Projects and Education are static → return an empty projects array; ' +
    'select ONLY IDs from the catalog; rationale = 1 sentence on the approach.',
  buildPrompt: (s) => {
    const catalogText = s.catalog
      .map((b) => `${b.id} [${b.section}${b.skcat ? '/' + b.skcat : ''}] tags:${b.tags} :: ${b.text.slice(0, 140)}`)
      .join('\n');
    const budgetText = s.budget ? renderBudget(s.budget) : '';
    return `${analysisContext(s.analysis)}${budgetText}CATALOG:\n${catalogText}\n\nJOB (title: ${s.job.title})\n` + wrapUntrusted(s.job.description.slice(0, 6000));
  },
  schema: (s) => {
    const idsBySection = (sec: string) => s.catalog.filter((b) => b.section === sec).map((b) => b.id);
    const enumOrNull = (ids: string[]) => (ids.length ? { type: 'STRING', enum: ids } : { type: 'STRING' });
    // maxItems follows the real template budget (fallback to the old caps when unknown).
    const sumMax = s.budget && s.budget.summary ? s.budget.summary : 8;
    const expMax = s.budget && s.budget.roles.length ? s.budget.roles.reduce((a, r) => a + r.slots, 0) : 24;
    return {
      type: 'OBJECT',
      required: ['summary', 'skills', 'experience', 'projects', 'rationale'],
      properties: {
        summary: { type: 'ARRAY', items: enumOrNull(idsBySection('summary')), minItems: 1, maxItems: sumMax },
        skills: { type: 'ARRAY', items: enumOrNull(idsBySection('skills')), maxItems: 16 },
        experience: { type: 'ARRAY', items: enumOrNull(idsBySection('experience')), maxItems: expMax },
        // Projects are static in the template (v1) — the selector must not spend picks on them.
        projects: { type: 'ARRAY', items: enumOrNull(idsBySection('projects')), maxItems: 0 },
        rationale: { type: 'STRING' },
      },
    };
  },
};

export async function cvSelector(
  env: Env, job: Job, catalog: CatalogBlock[], budget: SlotBudget | undefined,
  analysis: RoleAnalysis | null, doFetch: Fetcher = fetch,
): Promise<GeminiResult<Selection>> {
  return runAgent<Selection, SelectState>(env, cvSelectorAgent, { job, catalog, budget, analysis }, doFetch);
}

// ---------- cv_verifier ----------

export interface VerifierNotes {
  tweaks: string[];
}

interface VerifyState {
  job: Job;
  renderedBody: string;
  analysis?: RoleAnalysis | null;
}

const cvVerifierAgent: Agent<VerifyState> = {
  name: 'cv_verifier',
  models: ['gemini-3.5-flash', 'gemini-2.5-flash'],
  temperature: 0,
  instruction: () =>
    'You are the cv_verifier (temperature 0). Compare the rendered CV against the job. ' +
    'Return 0-5 SHORT improvement suggestions (reorder, emphasize, visible gap). ' +
    'These are SUGGESTIONS for the owner: do not rewrite the CV or propose literal new text.',
  buildPrompt: (s) =>
    analysisContext(s.analysis) +
    `RENDERED CV:\n${s.renderedBody.slice(0, 5000)}\n\nJOB (title: ${s.job.title})\n` +
    wrapUntrusted(s.job.description.slice(0, 5000)),
  schema: () => ({
    type: 'OBJECT',
    required: ['tweaks'],
    properties: { tweaks: { type: 'ARRAY', items: { type: 'STRING' }, maxItems: 5 } },
  }),
};

export async function cvVerifier(
  env: Env, job: Job, renderedBody: string, analysis: RoleAnalysis | null, doFetch: Fetcher = fetch,
): Promise<GeminiResult<VerifierNotes>> {
  return runAgent<VerifierNotes, VerifyState>(env, cvVerifierAgent, { job, renderedBody, analysis }, doFetch);
}

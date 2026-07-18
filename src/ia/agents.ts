// Declarative agents (docs/TRD.md §4). Inviolable domain rules:
// - enricher: ONLY improves survivor texts; never touches verdicts or gates.
// - cv_selector: ONLY selects IDs of approved blocks (enum forced by schema).
// - cv_verifier: temp 0; suggests tweaks, NEVER edits.

import type { Env, Job } from '../types';
import { callGemini, wrapUntrusted, type GeminiResult } from './gemini';

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

// ---------- enricher ----------

export interface EnrichedTexts {
  why_it_fits: string;
  gap_to_address: string;
  positioning_lead: string;
}

export async function enricher(
  env: Env, job: Job, ruleTexts: EnrichedTexts, doFetch: Fetcher = fetch,
): Promise<GeminiResult<EnrichedTexts>> {
  return callGemini<EnrichedTexts>(env, {
    temperature: 0.4,
    instruction:
      'You are the enricher of a job-discovery engine. Improve the wording of three short ' +
      'texts (English, 1-2 sentences each) about why a job fits the profile of a ' +
      'business analyst/data professional in banking, payments, collections, and compliance transitioning to data. ' +
      'Rely ONLY on the job and the rule-based drafts. Do not invent experience or figures. ' +
      'Do NOT change verdicts or mention scores.',
    input:
      `RULE-BASED DRAFTS:\n${JSON.stringify(ruleTexts)}\n\nJOB (title: ${job.title})\n` +
      wrapUntrusted(job.description.slice(0, 6000)),
    responseSchema: {
      type: 'OBJECT',
      required: ['why_it_fits', 'gap_to_address', 'positioning_lead'],
      properties: {
        why_it_fits: { type: 'STRING' },
        gap_to_address: { type: 'STRING' },
        positioning_lead: { type: 'STRING' },
      },
    },
  }, doFetch);
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

/** The schema restricts each ID to the catalog's block enum: hallucination is impossible by construction. */
export async function cvSelector(
  env: Env, job: Job, catalog: CatalogBlock[], doFetch: Fetcher = fetch,
): Promise<GeminiResult<Selection>> {
  const idsBySection = (s: string) => catalog.filter((b) => b.section === s).map((b) => b.id);
  const enumOrNull = (ids: string[]) => (ids.length ? { type: 'STRING', enum: ids } : { type: 'STRING' });
  const catalogText = catalog
    .map((b) => `${b.id} [${b.section}${b.skcat ? '/' + b.skcat : ''}] tags:${b.tags} :: ${b.text.slice(0, 140)}`)
    .join('\n');
  return callGemini<Selection>(env, {
    temperature: 0.3,
    instruction:
      'You are the cv_selector. Choose the most relevant block IDs for this job, prioritizing what ' +
      'the job calls for. The template has fixed slots the render will fill in your order: pick up to ' +
      '~7 summary bullets; the strongest responsibilities for EACH experience role (group naturally by ' +
      'role — the render places them under the right role); and relevant skills spread across their ' +
      'categories. Never select two phrasings of the same achievement. Projects are static in the ' +
      'template: always return an empty projects array. Select ONLY IDs from the catalog. ' +
      'In rationale, explain the chosen approach in 1 sentence.',
    input: `CATALOG:\n${catalogText}\n\nJOB (title: ${job.title})\n` + wrapUntrusted(job.description.slice(0, 6000)),
    responseSchema: {
      type: 'OBJECT',
      required: ['summary', 'skills', 'experience', 'projects', 'rationale'],
      properties: {
        summary: { type: 'ARRAY', items: enumOrNull(idsBySection('summary')), minItems: 1, maxItems: 8 },
        skills: { type: 'ARRAY', items: enumOrNull(idsBySection('skills')), maxItems: 16 },
        experience: { type: 'ARRAY', items: enumOrNull(idsBySection('experience')), maxItems: 24 },
        // Projects are static in the template (v1) — the selector must not spend picks on them.
        projects: { type: 'ARRAY', items: enumOrNull(idsBySection('projects')), maxItems: 0 },
        rationale: { type: 'STRING' },
      },
    },
  }, doFetch);
}

// ---------- cv_verifier ----------

export interface VerifierNotes {
  tweaks: string[];
}

export async function cvVerifier(
  env: Env, job: Job, renderedBody: string, doFetch: Fetcher = fetch,
): Promise<GeminiResult<VerifierNotes>> {
  return callGemini<VerifierNotes>(env, {
    temperature: 0,
    instruction:
      'You are the cv_verifier (temperature 0). Compare the rendered CV against the job. ' +
      'Return 0-5 SHORT improvement suggestions (reorder, emphasize, visible gap). ' +
      'These are SUGGESTIONS for the owner: do not rewrite the CV or propose literal new text.',
    input: `RENDERED CV:\n${renderedBody.slice(0, 5000)}\n\nJOB (title: ${job.title})\n` +
      wrapUntrusted(job.description.slice(0, 5000)),
    responseSchema: {
      type: 'OBJECT',
      required: ['tweaks'],
      properties: { tweaks: { type: 'ARRAY', items: { type: 'STRING' }, maxItems: 5 } },
    },
  }, doFetch);
}

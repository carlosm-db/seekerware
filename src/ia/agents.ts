// Agentes declarativos (docs/TRD.md §4). Reglas de dominio inquebrantables:
// - enricher: SOLO mejora textos de survivors; jamas toca verdicts ni gates.
// - cv_selector: SOLO selecciona IDs de blocks approved (enum forzado por schema).
// - cv_verifier: temp 0; sugiere tweaks, JAMAS edita.

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
      'Eres el enricher de un motor de descubrimiento de empleo. Mejora la redaccion de tres textos ' +
      'cortos (espanol, 1-2 frases cada uno) sobre por que una vacante encaja con un perfil de ' +
      'business analyst/data en banca, pagos, cobranzas y compliance en transicion a datos. ' +
      'Basate SOLO en la vacante y los borradores rule-based. No inventes experiencia ni cifras. ' +
      'NO cambies veredictos ni menciones puntajes.',
    input:
      `BORRADORES RULE-BASED:\n${JSON.stringify(ruleTexts)}\n\nVACANTE (titulo: ${job.title})\n` +
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
  angle: string | null;
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

/** El schema restringe cada ID al enum de blocks del catalogo: la alucinacion es imposible por construccion. */
export async function cvSelector(
  env: Env, job: Job, catalog: CatalogBlock[], doFetch: Fetcher = fetch,
): Promise<GeminiResult<Selection>> {
  const idsBySection = (s: string) => catalog.filter((b) => b.section === s).map((b) => b.id);
  const enumOrNull = (ids: string[]) => (ids.length ? { type: 'STRING', enum: ids } : { type: 'STRING' });
  const catalogText = catalog
    .map((b) => `${b.id} [${b.section}${b.angle ? '/' + b.angle : ''}] tags:${b.tags} :: ${b.text.slice(0, 140)}`)
    .join('\n');
  return callGemini<Selection>(env, {
    temperature: 0.3,
    instruction:
      'Eres el cv_selector. Elige los IDs de blocks mas relevantes para esta vacante: ' +
      '1 de summary, 4-8 de skills, 4-8 de experience (prioriza el angle que pida la vacante: ' +
      'data/compliance/operations/leadership), 0-2 de projects. Selecciona SOLO IDs del catalogo. ' +
      'En rationale explica en 1 frase el enfoque elegido.',
    input: `CATALOGO:\n${catalogText}\n\nVACANTE (titulo: ${job.title})\n` + wrapUntrusted(job.description.slice(0, 6000)),
    responseSchema: {
      type: 'OBJECT',
      required: ['summary', 'skills', 'experience', 'projects', 'rationale'],
      properties: {
        summary: { type: 'ARRAY', items: enumOrNull(idsBySection('summary')), minItems: 1, maxItems: 1 },
        skills: { type: 'ARRAY', items: enumOrNull(idsBySection('skills')), maxItems: 8 },
        experience: { type: 'ARRAY', items: enumOrNull(idsBySection('experience')), maxItems: 8 },
        projects: { type: 'ARRAY', items: enumOrNull(idsBySection('projects')), maxItems: 2 },
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
      'Eres el cv_verifier (temperatura 0). Compara el CV renderizado contra la vacante. ' +
      'Devuelve 0-5 sugerencias CORTAS de mejora (reordenar, enfatizar, brecha visible). ' +
      'Son SUGERENCIAS para el propietario: no reescribas el CV ni propongas texto nuevo literal.',
    input: `CV RENDERIZADO:\n${renderedBody.slice(0, 5000)}\n\nVACANTE (titulo: ${job.title})\n` +
      wrapUntrusted(job.description.slice(0, 5000)),
    responseSchema: {
      type: 'OBJECT',
      required: ['tweaks'],
      properties: { tweaks: { type: 'ARRAY', items: { type: 'STRING' }, maxItems: 5 } },
    },
  }, doFetch);
}

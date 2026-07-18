// CV factory (docs/TRD.md §6): selection-only + deterministic render.
// The Doc body contains EXCLUSIVELY block text (verifiable by
// diff); the AI selects and suggests, NEVER writes CV content.

import type { Env, Job } from '../types';
import { cvSelector, cvVerifier, type CatalogBlock, type Selection } from './agents';
import { appendDocText, copyTemplate, exportAndArchivePdf, googleAccessToken, replacePlaceholders } from '../gdocs';

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * Private contact profile (D1 config['contact_profile'], never in the repo).
 * The CV template header uses {{phone}} and {{location}}, filled per track.
 * Address fields are stored for step-8 application forms, never shown in the CV.
 */
export interface ContactProfile {
  phone_ca?: string;
  phone_co?: string;
  location_ca?: string;
  location_co?: string;
  address_ca?: string;
  address_co?: string;
}

/** Per-track fill map: canada_coop -> CA values; colombia_perm & contractor_usd -> CO values. */
export function contactPlaceholders(track: string | null, p: ContactProfile): Record<string, string> {
  const ca = track === 'canada_coop';
  return {
    '{{phone}}': (ca ? p.phone_ca : p.phone_co) ?? '',
    '{{location}}': (ca ? p.location_ca : p.location_co) ?? '',
  };
}

export interface FactoryResult {
  ok: boolean;
  contact_missing?: boolean;
  doc_url?: string;
  pdf_file_id?: string;
  cv_id?: number;
  gemini_calls: number;
  error?: string;
}

interface BlockRow {
  id: string;
  section: string;
  anchor_id: string | null;
  angle: string | null;
  tags: string | null;
  text_en: string | null;
  text_es: string | null;
  es_status: string;
  status: string;
}

interface AnchorRow {
  id: string;
  kind: string;
  company: string | null;
  dates: string | null;
  titles: string | null;
}

const SECTION_HEADING: Record<string, { en: string; es: string }> = {
  summary: { en: 'SUMMARY', es: 'RESUMEN PROFESIONAL' },
  skills: { en: 'SKILLS', es: 'HABILIDADES' },
  experience: { en: 'PROFESSIONAL EXPERIENCE', es: 'EXPERIENCIA PROFESIONAL' },
  projects: { en: 'PROJECTS', es: 'PROYECTOS' },
};

export async function generateCv(
  env: Env,
  job: Job & { url_hash: string; track: string | null },
  lang: 'en' | 'es',
  sample: boolean,
  doFetch: Fetcher = fetch,
): Promise<FactoryResult> {
  let geminiCalls = 0;
  try {
    // 1) Catalog: ONLY approved (rule 1). In SAMPLE mode drafts are allowed —
    //    it's the lightweight review mechanism: the owner approves by viewing CVs.
    const statusFilter = sample ? "('draft','review','approved')" : "('approved')";
    const rows = (
      await env.DB.prepare(
        `SELECT id, section, anchor_id, angle, tags, text_en, text_es, es_status, status
         FROM blocks WHERE status IN ${statusFilter}`,
      ).all<BlockRow>()
    ).results;
    const usable = rows.filter((b) => {
      const text = lang === 'es' ? b.text_es : b.text_en;
      if (!text) return false;
      if (lang === 'es' && !sample && b.es_status !== 'approved') return false; // mandatory ES parity
      return true;
    });
    if (usable.length < 8) {
      return { ok: false, gemini_calls: 0, error: `insufficient bank to render ${lang}${sample ? '' : ' (approved)'}: ${usable.length} blocks` };
    }
    const catalog: CatalogBlock[] = usable.map((b) => ({
      id: b.id, section: b.section, anchor_id: b.anchor_id, angle: b.angle,
      tags: b.tags ?? '', text: (lang === 'es' ? b.text_es : b.text_en) ?? '',
    }));

    // 2) Selection (enum of IDs forced by schema)
    const sel = await cvSelector(env, job, catalog, doFetch);
    geminiCalls += sel.calls;
    if (!sel.ok || !sel.data) return { ok: false, gemini_calls: geminiCalls, error: `cv_selector: ${sel.error}` };
    const selection = sel.data;

    // 3) Deterministic render (zero AI): EXACT text from the blocks
    const anchors = new Map(
      ((await env.DB.prepare('SELECT id, kind, company, dates, titles FROM anchors').all<AnchorRow>()).results)
        .map((a) => [a.id, a]),
    );
    const byId = new Map(catalog.map((b) => [b.id, b]));
    const body = renderBody(job, lang, selection, byId, anchors);

    // 4) Verifier (temp 0) over the rendered body
    const ver = await cvVerifier(env, job, body, doFetch);
    geminiCalls += ver.calls;
    const tweaks = ver.ok && ver.data ? ver.data.tweaks : [];

    // 5) Google: copy template -> fill contact placeholders per track ->
    //    body -> CLEAN PDF -> appendix to the Doc
    const token = await googleAccessToken(env, doFetch);
    const today = new Date().toISOString().slice(0, 10);
    const name = `${sample ? 'SAMPLE — ' : ''}CV — ${job.company} — ${job.title.slice(0, 60)} — ${today}`;
    const doc = await copyTemplate(env, token, name, doFetch);
    // Fill {{phone}}/{{location}} from the private contact profile (empty when
    // unset, so no raw {{...}} leaks). address is forms-only (step 8), not here.
    const contactRow = await env.DB.prepare("SELECT value FROM config WHERE key = 'contact_profile'").first<{ value: string }>();
    let contactMissing = false;
    let profile: ContactProfile = {};
    try { profile = contactRow ? (JSON.parse(contactRow.value) as ContactProfile) : {}; } catch { /* invalid json */ }
    if (!contactRow) contactMissing = true;
    await replacePlaceholders(token, doc.id, contactPlaceholders(job.track, profile), doFetch);
    await appendDocText(token, doc.id, body, doFetch);
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '').slice(0, 12);
    const pdfId = await exportAndArchivePdf(env, token, doc.id, `${stamp} — ${job.company} — generated.pdf`, doFetch);
    const appendix = [
      '\n\n────────────────────────────────',
      lang === 'es' ? 'SUGGESTED TWEAKS (delete before sending)' : 'SUGGESTED TWEAKS (delete before sending)',
      `Selection: ${selection.rationale}`,
      ...tweaks.map((t) => `• ${t}`),
    ].join('\n');
    await appendDocText(token, doc.id, appendix, doFetch);

    // 6) Persistence
    const nowIso = new Date().toISOString();
    const cvRow = await env.DB.prepare(
      `INSERT INTO cvs (url_hash, doc_id, doc_url, lang, pdf_file_id, blocks_used, verifier_notes, rationale, sample, pending, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,0,?) RETURNING id`,
    ).bind(
      job.url_hash, doc.id, doc.url, lang, pdfId,
      JSON.stringify({ summary: selection.summary, skills: selection.skills, experience: selection.experience, projects: selection.projects }),
      JSON.stringify(tweaks), selection.rationale, sample ? 1 : 0, nowIso,
    ).first<{ id: number }>();
    await env.DB.prepare('UPDATE jobs SET cv_doc_url = ?, cv_pdf_key = ?, cv_pending = 0 WHERE url_hash = ?')
      .bind(doc.url, pdfId, job.url_hash).run();

    return { ok: true, contact_missing: contactMissing, doc_url: doc.url, pdf_file_id: pdfId, cv_id: cvRow?.id, gemini_calls: geminiCalls };
  } catch (err) {
    return { ok: false, gemini_calls: geminiCalls, error: err instanceof Error ? err.message : 'factory error' };
  }
}

function renderBody(
  job: { track: string | null },
  lang: 'en' | 'es',
  sel: Selection,
  byId: Map<string, CatalogBlock>,
  anchors: Map<string, { company: string | null; dates: string | null; titles: string | null }>,
): string {
  const text = (id: string) => byId.get(id)?.text ?? '';
  const lines: string[] = ['\n'];

  const displayTitle = (anchorId: string): string => {
    const a = anchors.get(anchorId);
    if (!a?.titles) return anchorId;
    try {
      const t = JSON.parse(a.titles) as Record<string, string>;
      const key = job.track === 'colombia_perm' ? 'market_colombia'
        : job.track === 'contractor_usd' ? 'contractor' : 'market_canada';
      return t[key] || t.market_canada || t.internal || anchorId;
    } catch { return anchorId; }
  };

  lines.push(SECTION_HEADING.summary![lang], '');
  for (const id of sel.summary) lines.push(text(id));

  lines.push('', SECTION_HEADING.skills![lang], '');
  for (const id of sel.skills) lines.push(`• ${text(id)}`);

  lines.push('', SECTION_HEADING.experience![lang], '');
  const expByAnchor = new Map<string, string[]>();
  for (const id of sel.experience) {
    const anchorId = byId.get(id)?.anchor_id ?? '';
    if (!expByAnchor.has(anchorId)) expByAnchor.set(anchorId, []);
    expByAnchor.get(anchorId)!.push(id);
  }
  for (const [anchorId, ids] of expByAnchor) {
    const a = anchors.get(anchorId);
    lines.push(`${displayTitle(anchorId)}${a?.company ? ` — ${a.company}` : ''}${a?.dates ? ` (${a.dates})` : ''}`);
    for (const id of ids) lines.push(`• ${text(id)}`);
    lines.push('');
  }

  if (sel.projects.length) {
    lines.push(SECTION_HEADING.projects![lang], '');
    for (const id of sel.projects) lines.push(`• ${text(id)}`);
  }
  return lines.join('\n');
}

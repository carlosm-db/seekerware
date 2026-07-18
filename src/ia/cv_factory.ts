// CV factory (docs/TRD.md §6): selection-only, template-driven fill.
// The owner's template is the fixed skeleton; the factory fills its named
// {{...}} tokens with EXACT approved-block text. The AI selects IDs and
// suggests tweaks, NEVER writes CV content.

import type { Env, Job } from '../types';
import { cvSelector, cvVerifier, type CatalogBlock, type Selection } from './agents';
import { appendDocText, copyTemplate, exportAndArchivePdf, googleAccessToken, readPlaceholders, replacePlaceholders } from '../gdocs';

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * Private contact profile (D1 config['contact_profile'], never in the repo).
 * The CV template header uses {{phone}} and {{location}}, filled per track.
 * The structured address objects are stored for step-8 application forms only,
 * never shown in the CV.
 */
export interface AddressCA {
  country?: string;
  province?: string;
  city?: string;
  address?: string;
  zip?: string;
}
export interface AddressCO {
  country?: string;
  department?: string;
  municipality?: string;
  neighbourhood?: string;
  address?: string;
  detail?: string;
  zip?: string;
}
export interface ContactProfile {
  phone_ca?: string;
  phone_co?: string;
  location_ca?: string;
  location_co?: string;
  address_ca?: AddressCA;
  address_co?: AddressCO;
}

/** Per-track fill map: canada_coop -> CA values; colombia_perm & contractor_usd -> CO values. */
export function contactPlaceholders(track: string | null, p: ContactProfile): Record<string, string> {
  const ca = track === 'canada_coop';
  return {
    '{{phone}}': (ca ? p.phone_ca : p.phone_co) ?? '',
    '{{location}}': (ca ? p.location_ca : p.location_co) ?? '',
  };
}

export interface FillReport {
  /** Token names that received non-empty block/contact text. */
  filled: string[];
  /** Recognized tokens resolved to '' (no content available for the slot). */
  blanked: string[];
  /** Tokens the factory does not understand (typo'd names) — resolved to ''. */
  unrecognized: string[];
  /** Selected block ids that ended up in NO slot (template lacks tokens). */
  unplaced_blocks: string[];
}

export interface FactoryResult {
  ok: boolean;
  contact_missing?: boolean;
  doc_url?: string;
  pdf_file_id?: string;
  cv_id?: number;
  gemini_calls: number;
  fill?: FillReport;
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

    // 3) Catalog lookup + valid role codes (experience anchor ids)
    const byId = new Map(catalog.map((b) => [b.id, b]));
    const roleCodes = ((await env.DB.prepare('SELECT id FROM anchors').all<{ id: string }>()).results).map((a) => a.id);

    // 4) Verifier (temp 0) over the selected content
    const ver = await cvVerifier(env, job, verifierText(selection, byId), doFetch);
    geminiCalls += ver.calls;
    const tweaks = ver.ok && ver.data ? ver.data.tweaks : [];

    // 5) Google: copy template -> read its {{...}} tokens -> fill every slot
    //    (contact per track + summary + skills-by-category + responsibilities
    //    per role) with EXACT block text -> CLEAN PDF -> tweaks appendix.
    const token = await googleAccessToken(env, doFetch);
    const today = new Date().toISOString().slice(0, 10);
    const name = `${sample ? 'SAMPLE — ' : ''}CV — ${job.company} — ${job.title.slice(0, 60)} — ${today}`;
    const doc = await copyTemplate(env, token, name, doFetch);

    // Private contact profile (empty when unset -> slot resolves to '', never a
    // raw {{...}}). Structured address is forms-only (step 8), not in the CV.
    const contactRow = await env.DB.prepare("SELECT value FROM config WHERE key = 'contact_profile'").first<{ value: string }>();
    let contactMissing = false;
    let profile: ContactProfile = {};
    try { profile = contactRow ? (JSON.parse(contactRow.value) as ContactProfile) : {}; } catch { /* invalid json */ }
    if (!contactRow) contactMissing = true;

    const docTokens = await readPlaceholders(token, doc.id, doFetch);
    const fill = buildSlotMap(docTokens, selection, byId, roleCodes, contactPlaceholders(job.track, profile));
    await replacePlaceholders(token, doc.id, fill.map, doFetch);

    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '').slice(0, 12);
    const pdfId = await exportAndArchivePdf(env, token, doc.id, `${stamp} — ${job.company} — generated.pdf`, doFetch);
    const appendix = [
      '\n\n────────────────────────────────',
      'SUGGESTED TWEAKS (delete before sending)',
      `Selection: ${selection.rationale}`,
      ...tweaks.map((t) => `• ${t}`),
    ].join('\n');
    await appendDocText(token, doc.id, appendix, doFetch);

    // 6) Persistence
    const nowIso = new Date().toISOString();
    const fillReport: FillReport = {
      filled: fill.filled, blanked: fill.blanked,
      unrecognized: fill.unrecognized, unplaced_blocks: fill.unplaced_blocks,
    };
    const cvRow = await env.DB.prepare(
      `INSERT INTO cvs (url_hash, doc_id, doc_url, lang, pdf_file_id, blocks_used, verifier_notes, rationale, sample, pending, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,0,?) RETURNING id`,
    ).bind(
      job.url_hash, doc.id, doc.url, lang, pdfId,
      // Truthful audit trail: what was selected vs what actually landed in a slot.
      JSON.stringify({
        selected: { summary: selection.summary, skills: selection.skills, experience: selection.experience, projects: selection.projects },
        placed: fill.used_block_ids,
        tokens: fillReport,
      }),
      JSON.stringify(tweaks), selection.rationale, sample ? 1 : 0, nowIso,
    ).first<{ id: number }>();
    // SAMPLE builds must never clear a queued REAL CV or stamp sample artifacts
    // on the job row (2026-07-18 audit).
    if (!sample) {
      await env.DB.prepare('UPDATE jobs SET cv_doc_url = ?, cv_pdf_key = ?, cv_pending = 0 WHERE url_hash = ?')
        .bind(doc.url, pdfId, job.url_hash).run();
    }

    return { ok: true, contact_missing: contactMissing, doc_url: doc.url, pdf_file_id: pdfId, cv_id: cvRow?.id, gemini_calls: geminiCalls, fill: fillReport };
  } catch (err) {
    return { ok: false, gemini_calls: geminiCalls, error: err instanceof Error ? err.message : 'factory error' };
  }
}

/** Parses the skcat:<category> tag from a block's tags; '' when absent. */
function skcatOf(tags: string): string {
  for (const t of tags.split(/[\s,]+/)) if (t.startsWith('skcat:')) return t.slice(6);
  return '';
}

export interface SlotFill extends FillReport {
  /** RAW token literal (exactly as typed in the Doc) -> replacement text. */
  map: Record<string, string>;
  /** Block ids actually placed into some slot. */
  used_block_ids: string[];
}

/**
 * Deterministic slot fill (zero AI): maps every {{...}} token PRESENT in the
 * template to selected block text, keyed by the token's RAW literal so padded
 * hand-typed tokens ('{{ phone }}') are still replaced. Recognized names:
 *   - phone / location   -> contact map (per track)
 *   - sum_N              -> Nth selected summary block
 *   - skills_<cat>       -> selected skills tagged skcat:<cat>, joined
 *   - <CODE>R<N>         -> Nth selected responsibility for role <CODE>
 * `selection` order is preserved within each role/category. Slots with no
 * matching content, and any UNRECOGNIZED token, resolve to '' so a raw {{...}}
 * never leaks into a CV — and everything is reported (filled/blanked/
 * unrecognized/unplaced) instead of failing silently.
 */
export function buildSlotMap(
  tokens: Array<{ name: string; raw: string }>,
  selection: Selection,
  byId: Map<string, CatalogBlock>,
  roleCodes: string[],
  contact: Record<string, string>,
): SlotFill {
  const text = (id: string | undefined) => (id ? byId.get(id)?.text ?? '' : '');

  const expByRole = new Map<string, string[]>();
  for (const id of selection.experience) {
    const code = byId.get(id)?.anchor_id ?? '';
    const arr = expByRole.get(code) ?? [];
    arr.push(id);
    expByRole.set(code, arr);
  }
  const skillsByCat = new Map<string, Array<{ id: string; text: string }>>();
  for (const id of selection.skills) {
    const cat = skcatOf(byId.get(id)?.tags ?? '');
    if (!cat) continue;
    const arr = skillsByCat.get(cat) ?? [];
    arr.push({ id, text: text(id) });
    skillsByCat.set(cat, arr);
  }

  const map: Record<string, string> = {};
  const filled: string[] = [];
  const blanked: string[] = [];
  const unrecognized: string[] = [];
  const used = new Set<string>();
  const place = (raw: string, name: string, value: string, blockId?: string) => {
    map[raw] = value;
    if (value) {
      filled.push(name);
      if (blockId) used.add(blockId);
    } else blanked.push(name);
  };

  for (const { name, raw } of tokens) {
    const canonical = `{{${name}}}`;
    if (canonical in contact) { place(raw, name, contact[canonical]!); continue; }
    let m = /^sum_(\d+)$/.exec(name);
    if (m) {
      const id = selection.summary[Number(m[1]) - 1];
      place(raw, name, text(id), id);
      continue;
    }
    m = /^skills_(.+)$/.exec(name);
    if (m) {
      const items = skillsByCat.get(m[1]!) ?? [];
      map[raw] = items.map((i) => i.text).join(', ');
      if (map[raw]) {
        filled.push(name);
        for (const i of items) used.add(i.id);
      } else blanked.push(name);
      continue;
    }
    m = /^(.+)R(\d+)$/.exec(name);
    if (m && roleCodes.includes(m[1]!)) {
      const id = (expByRole.get(m[1]!) ?? [])[Number(m[2]) - 1];
      place(raw, name, text(id), id);
      continue;
    }
    map[raw] = '';
    unrecognized.push(name);
  }

  const selected = [...selection.summary, ...selection.skills, ...selection.experience];
  const unplaced_blocks = selected.filter((id) => !used.has(id));
  return { map, filled, blanked, unrecognized, unplaced_blocks, used_block_ids: [...used] };
}

/** Plain-text view of the selection for the verifier (labels help it reason). */
function verifierText(selection: Selection, byId: Map<string, CatalogBlock>): string {
  const t = (id: string) => byId.get(id)?.text ?? '';
  return [
    'SUMMARY', ...selection.summary.map(t),
    '', 'SKILLS', ...selection.skills.map(t),
    '', 'EXPERIENCE', ...selection.experience.map(t),
  ].join('\n');
}

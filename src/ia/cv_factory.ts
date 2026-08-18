// CV factory (docs/TRD.md §6): selection-only, template-driven fill.
// The owner's template is the fixed skeleton; the factory fills its named
// {{...}} tokens with EXACT approved-block text. The AI selects IDs and
// suggests tweaks, NEVER writes CV content.

import type { Env, Job } from '../types';
import { cvSelector, cvVerifier, type CatalogBlock, type RoleAnalysis, type Selection, type SlotBudget } from './agents';
import { copyTemplate, exportAndArchivePdf, googleAccessToken, readPlaceholders, replacePlaceholders } from '../gdocs';

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

/**
 * Per-path fill map: any `canada_*` route -> CA values; colombia_perm (and any legacy track) -> CO.
 * Matched by PREFIX, not by id: an equality test against a single id silently shipped Colombian phone
 * and address on every Canadian route that was not spelled exactly `canada_coop` (2026-08-18).
 */
export function contactPlaceholders(track: string | null, p: ContactProfile): Record<string, string> {
  const ca = !!track && track.startsWith('canada');
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
  skcat: string | null;
  tags: string | null;
  text_en: string | null;
  text_es: string | null;
  es_status: string;
  status: string;
}

/** Bogotá/COT timestamp for CV file names, e.g. "2026-07-20 1435 COT". */
function cotStamp(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date());
  const g = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}${g('minute')} COT`;
}

export async function generateCv(
  env: Env,
  job: Job & { url_hash: string; track: string | null },
  lang: 'en' | 'es',
  sample: boolean,
  doFetch: Fetcher = fetch,
  onProgress?: (step: string, detail?: string) => void | Promise<void>,
): Promise<FactoryResult> {
  let geminiCalls = 0;
  try {
    // 1) Catalog: ONLY approved (rule 1). In SAMPLE mode drafts are allowed —
    //    it's the lightweight review mechanism: the owner approves by viewing CVs.
    const statusFilter = sample ? "('draft','review','approved')" : "('approved')";
    const rows = (
      await env.DB.prepare(
        `SELECT id, section, anchor_id, skcat, tags, text_en, text_es, es_status, status
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
      return { ok: false, gemini_calls: 0, error: `insufficient Blocks Bank to render ${lang}${sample ? '' : ' (approved)'}: ${usable.length} blocks` };
    }
    const catalog: CatalogBlock[] = usable.map((b) => ({
      id: b.id, section: b.section, anchor_id: b.anchor_id, skcat: b.skcat,
      tags: b.tags ?? '', text: (lang === 'es' ? b.text_es : b.text_en) ?? '',
    }));

    const byId = new Map(catalog.map((b) => [b.id, b]));

    // 2) Slot budget FIRST: read the template's {{...}} tokens + active roles so
    //    the selector fills the REAL slots (not arbitrary caps). Reading the
    //    template directly (not a copy) means a failed selection leaves no orphan
    //    copy; the copy shares these exact tokens, so this same read also drives
    //    the fill below — no extra subrequest vs before.
    if (!env.CV_TEMPLATE_DOC_ID) return { ok: false, gemini_calls: 0, error: 'CV_TEMPLATE_DOC_ID not configured' };
    await onProgress?.('Read template + Blocks Bank');
    const token = await googleAccessToken(env, doFetch);
    const roles = (await env.DB.prepare(
      "SELECT id, title FROM anchors WHERE kind = 'role' AND status = 'active'",
    ).all<{ id: string; title: string | null }>()).results;
    const roleCodes = roles.map((r) => r.id);
    const docTokens = await readPlaceholders(token, env.CV_TEMPLATE_DOC_ID, doFetch);
    const budget = buildSlotBudget(docTokens, roles);
    // Reuse job_analyst's role analysis stored at notify (null for older jobs → agents use the raw job).
    const raRow = await env.DB.prepare('SELECT role_analysis FROM jobs WHERE url_hash = ?')
      .bind(job.url_hash).first<{ role_analysis: string | null }>();
    let analysis: RoleAnalysis | null = null;
    try { analysis = raRow?.role_analysis ? (JSON.parse(raRow.role_analysis) as RoleAnalysis) : null; } catch { analysis = null; }

    // 3) Selection (enum of IDs forced by schema), guided by the slot budget + role analysis
    await onProgress?.('Select blocks (AI)');
    const sel = await cvSelector(env, job, catalog, budget, analysis, doFetch);
    geminiCalls += sel.calls;
    if (!sel.ok || !sel.data) return { ok: false, gemini_calls: geminiCalls, error: `cv_selector: ${sel.error}` };
    const selection = sel.data;

    // 4) Verifier (temp 0) over the selected content
    await onProgress?.('Verify the CV (AI)');
    const ver = await cvVerifier(env, job, verifierText(selection, byId), analysis, doFetch);
    geminiCalls += ver.calls;
    const tweaks = ver.ok && ver.data ? ver.data.tweaks : [];

    // 5) Google: copy the template -> fill every slot (contact per track + summary
    //    + skills-by-category + responsibilities per role) with EXACT block text
    //    -> CLEAN PDF -> tweaks appendix. docTokens (read above) == the copy's tokens.
    await onProgress?.('Create Doc + fill');
    const stamp = cotStamp(); // Bogotá/COT time in the file name (Doc + PDF share it)
    const name = `${sample ? 'SAMPLE — ' : ''}CV — ${job.company} — ${job.title.slice(0, 60)} — ${stamp}`;
    const doc = await copyTemplate(env, token, name, doFetch);

    // Private contact profile (empty when unset -> slot resolves to '', never a
    // raw {{...}}). Structured address is forms-only (step 8), not in the CV.
    const contactRow = await env.DB.prepare("SELECT value FROM config WHERE key = 'contact_profile'").first<{ value: string }>();
    let contactMissing = false;
    let profile: ContactProfile = {};
    try { profile = contactRow ? (JSON.parse(contactRow.value) as ContactProfile) : {}; } catch { /* invalid json */ }
    if (!contactRow) contactMissing = true;

    const fill = buildSlotMap(docTokens, selection, byId, roleCodes, contactPlaceholders(job.track, profile));
    await replacePlaceholders(token, doc.id, fill.map, doFetch);

    await onProgress?.('Export PDF + archive');
    const pdfId = await exportAndArchivePdf(env, token, doc.id, `${stamp} — ${job.company} — generated.pdf`, doFetch);
    // The Doc stays CLEAN — the verifier tweaks + selection rationale live only in
    // the cvs table / console (/cvs), never appended into the CV (they contaminated it).

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
    const cat = byId.get(id)?.skcat ?? '';
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

/**
 * Derive the template's slot budget from its {{...}} tokens + the active roles:
 * how many sum_N slots, which skills_<cat> categories, and how many <CODE>R<N>
 * slots each active role has. Runtime-only — the template is the source of truth;
 * nothing about the owner's CV structure is hardcoded (§4). Token parsing mirrors
 * template-check.ts (sum_N / skills_<cat> / <CODE>R<N>).
 */
export function buildSlotBudget(
  tokens: Array<{ name: string }>,
  roles: Array<{ id: string; title: string | null }>,
): SlotBudget {
  const names = tokens.map((t) => t.name);
  const summary = names.filter((n) => /^sum_\d+$/.test(n)).length;
  const skillCats = names
    .map((n) => /^skills_(.+)$/.exec(n))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => m[1]!);
  const roleTitle = new Map(roles.map((r) => [r.id, r.title ?? r.id]));
  const roleSlots = new Map<string, number>();
  for (const n of names) {
    const m = /^(.+)R(\d+)$/.exec(n);
    if (m && roleTitle.has(m[1]!)) roleSlots.set(m[1]!, (roleSlots.get(m[1]!) ?? 0) + 1);
  }
  const rolesOut = roles
    .filter((r) => roleSlots.has(r.id))
    .map((r) => ({ code: r.id, title: roleTitle.get(r.id)!, slots: roleSlots.get(r.id)! }));
  return { summary, skillCats, roles: rolesOut };
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

// Google Docs/Drive as the OWNER's Google account (docs/TRD.md §6): a stored OAuth
// refresh token -> short-lived access token -> REST APIs with fetch. A service
// account has NO Drive storage quota (files it creates fail "quota exceeded"), and
// a personal Gmail has no Shared Drives / domain-wide delegation — so we act AS the
// owner, and every file is owned by them and uses their quota. No SDKs (Workers).

import type { Env } from './types';

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** OAuth access token for the owner's account (valid ~1h). Exchanges the stored
 * refresh token; files created are owned by the owner and use their Drive quota. */
export async function googleAccessToken(env: Env, doFetch: Fetcher = fetch): Promise<string> {
  const id = env.GOOGLE_OAUTH_CLIENT_ID;
  const secret = env.GOOGLE_OAUTH_CLIENT_SECRET;
  const refresh = env.GOOGLE_OAUTH_REFRESH_TOKEN;
  if (!id || !secret || !refresh) throw new Error('GOOGLE_OAUTH_* secrets not configured');
  const res = await doFetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token', client_id: id, client_secret: secret, refresh_token: refresh,
    }).toString(),
  });
  if (!res.ok) throw new Error(`google token: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) throw new Error('google token: no access_token in response');
  return body.access_token;
}

async function gapi(
  token: string, doFetch: Fetcher, url: string, init: RequestInit = {},
): Promise<Response> {
  const res = await doFetch(url, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`google api ${url.slice(0, 60)}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res;
}

/** Copies the template to the shared folder with the given name; returns {id, url}. */
export async function copyTemplate(
  env: Env, token: string, name: string, doFetch: Fetcher = fetch,
): Promise<{ id: string; url: string }> {
  if (!env.CV_TEMPLATE_DOC_ID) throw new Error('CV_TEMPLATE_DOC_ID not configured');
  if (!env.DRIVE_FOLDER_ID) throw new Error('DRIVE_FOLDER_ID not configured');
  // Doc lands in archive/ alongside the exported PDF (owner: "todo a archive").
  const archiveId = await ensureArchiveFolder(env, token, doFetch);
  const res = await gapi(token, doFetch,
    `https://www.googleapis.com/drive/v3/files/${env.CV_TEMPLATE_DOC_ID}/copy?supportsAllDrives=true`,
    { method: 'POST', body: JSON.stringify({ name, parents: [archiveId] }) },
  );
  const body = (await res.json()) as { id: string };
  return { id: body.id, url: `https://docs.google.com/document/d/${body.id}/edit` };
}

/**
 * Fills template placeholders (e.g. {{phone}}, {{location}}) via one
 * replaceAllText request per entry. Values with no match are simply no-ops;
 * always call with every placeholder (empty string when unset) so no raw
 * {{...}} token ever leaks into a CV.
 */
export async function replacePlaceholders(
  token: string, docId: string, map: Record<string, string>, doFetch: Fetcher = fetch,
): Promise<void> {
  const requests = Object.entries(map).map(([find, replace]) => ({
    replaceAllText: { containsText: { text: find, matchCase: true }, replaceText: replace },
  }));
  if (requests.length === 0) return;
  await gapi(token, doFetch, `https://docs.googleapis.com/v1/documents/${docId}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({ requests }),
  });
}

interface DocEl {
  paragraph?: { elements?: Array<{ textRun?: { content?: string } }> };
  table?: { tableRows?: Array<{ tableCells?: Array<{ content?: DocEl[] }> }> };
}

function collectDocText(content: DocEl[] | undefined, out: { s: string }): void {
  for (const el of content ?? []) {
    for (const pe of el.paragraph?.elements ?? []) out.s += pe.textRun?.content ?? '';
    for (const row of el.table?.tableRows ?? []) {
      for (const cell of row.tableCells ?? []) collectDocText(cell.content, out);
    }
  }
}

export interface DocToken {
  /** Trimmed inner name, e.g. 'phone', 'sum_1', 'BNS1R1'. */
  name: string;
  /** EXACT literal as typed in the Doc, e.g. '{{ phone }}' — replaceAllText must target this. */
  raw: string;
}

/**
 * Reads the Doc and returns every {{...}} token present, as {name, raw} pairs
 * deduplicated by raw literal. Keeping the RAW form is what lets a hand-typed
 * '{{ phone }}' (padded) still be replaced — replaceAllText matches literals.
 * All body text (including table cells) is concatenated first, so a token
 * split across text runs is still detected.
 */
export async function readPlaceholders(
  token: string, docId: string, doFetch: Fetcher = fetch,
): Promise<DocToken[]> {
  const res = await gapi(token, doFetch, `https://docs.googleapis.com/v1/documents/${docId}?fields=body`);
  const doc = (await res.json()) as { body?: { content?: DocEl[] } };
  const out = { s: '' };
  collectDocText(doc.body?.content, out);
  const byRaw = new Map<string, DocToken>();
  for (const m of out.s.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
    if (!byRaw.has(m[0])) byRaw.set(m[0], { name: m[1]!.trim(), raw: m[0] });
  }
  return [...byRaw.values()];
}

/** Inserts plain text at the end of the Doc (index 1 = freshly copied/empty document: we insert at the start of the body). */
export async function appendDocText(
  token: string, docId: string, text: string, doFetch: Fetcher = fetch,
): Promise<void> {
  await gapi(token, doFetch, `https://docs.googleapis.com/v1/documents/${docId}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({
      requests: [{ insertText: { endOfSegmentLocation: { segmentId: '' }, text } }],
    }),
  });
}

/** Exports the Doc to PDF and archives it in the archive/ subfolder (immutable by convention). */
export async function exportAndArchivePdf(
  env: Env, token: string, docId: string, pdfName: string, doFetch: Fetcher = fetch,
): Promise<string> {
  const pdfRes = await gapi(token, doFetch,
    `https://www.googleapis.com/drive/v3/files/${docId}/export?mimeType=application/pdf`);
  const pdfBytes = await pdfRes.arrayBuffer();

  const archiveId = await ensureArchiveFolder(env, token, doFetch);
  const metadata = JSON.stringify({ name: pdfName, parents: [archiveId], mimeType: 'application/pdf' });
  const boundary = 'seekerware' + crypto.randomUUID();
  const head = `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\ncontent-type: application/pdf\r\n\r\n`;
  const tail = `\r\n--${boundary}--`;
  const body = new Blob([head, pdfBytes, tail]);

  const up = await doFetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true',
    { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/related; boundary=${boundary}` }, body },
  );
  if (!up.ok) throw new Error(`pdf upload: HTTP ${up.status} ${(await up.text()).slice(0, 200)}`);
  const uploaded = (await up.json()) as { id: string };
  return uploaded.id;
}

let archiveFolderCache: string | null = null;

async function ensureArchiveFolder(env: Env, token: string, doFetch: Fetcher): Promise<string> {
  if (!env.DRIVE_FOLDER_ID) throw new Error('DRIVE_FOLDER_ID not configured');
  if (archiveFolderCache) return archiveFolderCache;
  const q = encodeURIComponent(`name = 'archive' and '${env.DRIVE_FOLDER_ID}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
  const res = await gapi(token, doFetch, `https://www.googleapis.com/drive/v3/files?q=${q}&supportsAllDrives=true&includeItemsFromAllDrives=true`);
  const body = (await res.json()) as { files: Array<{ id: string }> };
  if (body.files.length > 0) {
    archiveFolderCache = body.files[0]!.id;
    return archiveFolderCache;
  }
  const created = await gapi(token, doFetch, 'https://www.googleapis.com/drive/v3/files?supportsAllDrives=true', {
    method: 'POST',
    body: JSON.stringify({ name: 'archive', parents: [env.DRIVE_FOLDER_ID], mimeType: 'application/vnd.google-apps.folder' }),
  });
  archiveFolderCache = ((await created.json()) as { id: string }).id;
  return archiveFolderCache;
}

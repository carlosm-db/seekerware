// Diagnostic probe (audit 2026-08-10-latam-roster-mechanism.md §8/§9.3): can a GitHub-hosted
// runner reach the Colombian boards' SSR pages? Decides where the elempleo/Magneto connectors
// poll from (Actions vs fallback runner). Plain Node 22 (global fetch), no deps; ONE fetch per
// page (single-shot, polite). Writes docs/audits/2026-08-10-actions-ip-probe.md.

import { writeFileSync } from 'node:fs';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

async function get(url) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'es-CO,es;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
    });
    const body = await res.text();
    return { url, status: res.status, bytes: body.length, ms: Date.now() - started, body };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { url, status: 0, bytes: 0, ms: Date.now() - started, body: '', error };
  }
}

const hasJobPosting = (html) => /ld\+json/i.test(html) && html.includes('"JobPosting"');

let ip = 'unknown';
try {
  ip = (await (await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(10000) })).text()).trim();
} catch {}

const rows = [];
const note = (name, r, extra = '') =>
  rows.push(`| ${name} | ${r.status}${r.error ? ` (${r.error})` : ''} | ${r.bytes} | ${r.ms} | ${extra} |`);

const eList = await get('https://www.elempleo.com/co/ofertas-empleo/trabajo-epm');
note('elempleo list (trabajo-epm)', eList, `${(eList.body.match(/href="\/co\/ofertas-trabajo\//g) ?? []).length} offer links`);
const eHref = eList.body.match(/href="(\/co\/ofertas-trabajo\/[^"]+)"/)?.[1];
if (eHref) {
  const eDet = await get(`https://www.elempleo.com${eHref}`);
  note('elempleo detail', eDet, `JobPosting ld+json: ${hasJobPosting(eDet.body) ? 'YES' : 'NO'}`);
} else {
  note('elempleo detail', { status: 0, bytes: 0, ms: 0, error: 'no offer link found on list page' });
}

const mList = await get('https://www.magneto365.com/co/empresas/grupo-exito/empleos');
note('magneto list (grupo-exito)', mList, `${(mList.body.match(/href="https:\/\/www\.magneto365\.com\/co\/empleos\//g) ?? []).length} offer links`);
const mHref = mList.body.match(/href="(https:\/\/www\.magneto365\.com\/co\/empleos\/[^"]+)"/)?.[1];
if (mHref) {
  const mDet = await get(mHref);
  note('magneto detail', mDet, `JobPosting ld+json: ${hasJobPosting(mDet.body) ? 'YES' : 'NO'}`);
} else {
  note('magneto detail', { status: 0, bytes: 0, ms: 0, error: 'no offer link found on list page' });
}

note('computrabajo home (reference)', await get('https://co.computrabajo.com/'));

const md = `# Actions-IP reachability probe — Colombian boards

Run ${new Date().toISOString()} from a GitHub-hosted runner (egress IP ${ip}).
Companion to 2026-08-10-latam-roster-mechanism.md §8/§9.3 — decides runner placement for the
elempleo/Magneto connectors. One fetch per page.

| page | HTTP | bytes | ms | signal |
|---|---|---|---|---|
${rows.join('\n')}

Reading: 200 + offer links + JobPosting=YES on both rows of a source ⇒ the Actions poller can
host that connector directly. A 403/0 row ⇒ that source needs the fallback runner (owner PC /
self-hosted) per §8. Computrabajo is reference-only (expected 403 from datacenter IPs).
`;

writeFileSync('docs/audits/2026-08-10-actions-ip-probe.md', md);
console.log(md);

// Check template (2026-07-18 role-lifecycle audit): pure diff between the
// bank's content and the CV template Doc's {{...}} tokens. Both breach
// directions of the bank↔template contract fail silently at render time —
// this surfaces every mismatch BEFORE it costs a CV.

export interface DocTokenLite {
  name: string;
  raw: string;
}

export interface BankShape {
  /** Active roles (kind='role') with their bullet counts. */
  roles: Array<{ id: string; bullets: number; approved: number }>;
  /** Items per skill category (all four keys present, 0 allowed). */
  skillCats: Record<string, number>;
  summaryCount: number;
}

export interface Finding {
  level: 'error' | 'warn' | 'ok';
  text: string;
}

const CONTACT = new Set(['phone', 'location']);

/** Diffs template tokens against the bank. Deterministic, DB/network-free. */
export function checkTemplate(tokens: DocTokenLite[], bank: BankShape): Finding[] {
  const out: Finding[] = [];
  const names = tokens.map((t) => t.name);
  const roleIds = bank.roles.map((r) => r.id);

  // 1) Contact slots
  for (const c of CONTACT) {
    if (!names.includes(c)) out.push({ level: 'warn', text: `no {{${c}}} token — the CV header will not carry your ${c}` });
  }

  // 2) Padded / non-canonical raw forms (work, but worth tidying)
  for (const t of tokens) {
    if (t.raw !== `{{${t.name}}}`) {
      out.push({ level: 'warn', text: `token "${t.raw}" has extra spaces — it works, but consider retyping it as {{${t.name}}}` });
    }
  }

  // 3) Summary slots vs bank
  const sumSlots = names
    .map((n) => /^sum_(\d+)$/.exec(n))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => Number(m[1]));
  if (sumSlots.length === 0) out.push({ level: 'warn', text: 'no {{sum_N}} tokens — the CV will have no AI-picked summary bullets' });
  const maxSum = Math.max(0, ...sumSlots);
  if (maxSum > bank.summaryCount) {
    out.push({ level: 'error', text: `template has ${maxSum} summary slots but the bank only has ${bank.summaryCount} summary lines — the extra slots will render blank` });
  }

  // 4) Skill category tokens
  const catTokens = names
    .map((n) => /^skills_(.+)$/.exec(n))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => m[1]!);
  for (const cat of catTokens) {
    if (!(cat in bank.skillCats)) {
      out.push({ level: 'error', text: `{{skills_${cat}}} names an unknown category — valid: ${Object.keys(bank.skillCats).join(', ')}` });
    } else if (bank.skillCats[cat] === 0) {
      out.push({ level: 'warn', text: `{{skills_${cat}}} exists but the bank has no ${cat} skills — the line will render blank` });
    }
  }
  for (const [cat, n] of Object.entries(bank.skillCats)) {
    if (n > 0 && !catTokens.includes(cat)) {
      out.push({ level: 'warn', text: `the bank has ${n} ${cat} skills but the template has no {{skills_${cat}}} line — they can never appear` });
    }
  }

  // 5) Role slots vs bank (both directions)
  const roleSlotNames = new Set<string>();
  for (const r of bank.roles) {
    const re = new RegExp(`^${r.id}R(\\d+)$`);
    const slots = names.filter((n) => re.test(n));
    for (const s of slots) roleSlotNames.add(s);
    if (r.bullets > 0 && slots.length === 0) {
      out.push({ level: 'error', text: `role ${r.id} has ${r.bullets} bullets but the template has NO {{${r.id}R…}} tokens — its content can never appear in a CV` });
    }
    if (slots.length > r.bullets) {
      out.push({ level: 'warn', text: `role ${r.id}: ${slots.length} template slots but only ${r.bullets} bullets in the bank — some lines will render blank` });
    } else if (slots.length > 0 && r.approved < slots.length) {
      out.push({ level: 'warn', text: `role ${r.id}: ${slots.length} slots but only ${r.approved} APPROVED bullets — real CVs fill from approved content only` });
    }
  }

  // 6) Role-shaped tokens pointing at no active role (incl. the greedy-parse trap)
  for (const n of names) {
    if (CONTACT.has(n) || /^sum_\d+$/.test(n) || /^skills_.+$/.test(n) || roleSlotNames.has(n)) continue;
    const m = /^(.+)R(\d+)$/.exec(n);
    if (m) {
      out.push({ level: 'error', text: `{{${n}}} looks like a role slot for "${m[1]}", but no active role has that code — the token will render blank` });
    } else {
      out.push({ level: 'error', text: `{{${n}}} is not a token the CV factory understands — it will render blank` });
    }
  }

  if (out.length === 0) out.push({ level: 'ok', text: 'template and bank match — every token resolves and every role has its slots' });
  return out;
}

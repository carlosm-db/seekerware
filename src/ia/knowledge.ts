// Domain knowledge injected into agent instructions (docs/TRD.md §4; the
// CONVENTIONS shared-vocabulary rule). This is the ONE place the agents' domain
// context lives, so instructions stay thin and consistent across agents.
// PRIVACY (CLAUDE.md §4/§7.6): professional POSITIONING only — no name, contact,
// or any private owner data ever goes here (it would be sent to the API).

/** The owner's professional positioning: the kind of roles a job is judged against. */
export function profile(): string {
  return 'a business analyst/data professional in banking, payments, collections, and compliance transitioning to data';
}

/** The two search paths and what each targets (matches the scoring config tracks). */
export function tracks(): string {
  return [
    'canada_coop — roles in Canada (co-op / new-grad / skilled)',
    'colombia_perm — roles in Colombia / LATAM or globally-open remote',
  ].join('; ');
}

/** Shared domain vocabulary — the same term families as the config keywords and block tags. */
export function domainVocab(): string {
  return 'payments, reconciliation, collections, banking, compliance, fintech, fraud, SQL, Power BI, Excel, Python';
}

/** Governance reminder for every agent (domain rules §7.1/§7.8): select/suggest, never write. */
export function governance(): string {
  return 'You SELECT or SUGGEST only. You NEVER write the CV content or the form answers that get submitted; the owner reviews, approves, and submits everything.';
}

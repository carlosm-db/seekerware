// Role (anchor) lifecycle helpers (2026-07-18 role-lifecycle audit): pure,
// DB-free validation so it can be unit-tested. A role code is the canonical
// anchors.id AND the {{<CODE>R<N>}} placeholder prefix in the CV template, so
// its shape must keep the token grammar unambiguous.

/** Valid: starts with a letter, uppercase alphanumeric, 2-8 chars total. */
const CODE_SHAPE = /^[A-Z][A-Z0-9]{1,7}$/;

/**
 * Returns an error message, or null when the code is safe.
 * Guards (each prevents a verified silent-failure mode):
 * - shape: uppercase alphanumeric, letter first, 2-8 chars;
 * - must not END in R<digits> (its own bullets' tokens would be ambiguous);
 * - must not equal <existing>R<digits> (it would shadow that role's slots);
 * - no existing code may equal <candidate>R<digits> (this role's slots would
 *   shadow that existing role);
 * - unique (case-insensitive).
 */
export function validateRoleCode(codeRaw: string, existing: string[]): string | null {
  const code = codeRaw.trim();
  if (!CODE_SHAPE.test(code)) {
    return 'code must be 2-8 uppercase letters/digits starting with a letter (e.g. BNS1, DLAB1)';
  }
  if (/R\d+$/.test(code)) {
    return 'code cannot end in R followed by digits — that is the bullet-token grammar ({{CODE}}R1)';
  }
  for (const ex of existing) {
    if (ex.toUpperCase() === code.toUpperCase()) return `code ${ex} already exists`;
    if (new RegExp(`^${ex}R\\d+$`).test(code)) {
      return `code collides with ${ex}'s bullet tokens ({{${ex}R…}})`;
    }
    if (new RegExp(`^${code}R\\d+$`).test(ex)) {
      return `existing code ${ex} would collide with this code's bullet tokens ({{${code}R…}})`;
    }
  }
  return null;
}

/** Token names in the template that belong to a role code (e.g. BNS1R1, BNS1R2). */
export function tokensOfRole(code: string, tokenNames: string[]): string[] {
  const re = new RegExp(`^${code}R\\d+$`);
  return tokenNames.filter((n) => re.test(n));
}

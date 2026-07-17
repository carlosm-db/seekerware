// Acceso a D1 (docs/DATABASE.md). Unica puerta al store: statements preparados, nunca SQL interpolado.

import type { Company, Env } from './types';

interface CompanyRow {
  id: number;
  name: string;
  ats: Company['ats'];
  token: string;
  active: number;
}

export async function getActiveCompanies(env: Env): Promise<Company[]> {
  const { results } = await env.DB.prepare(
    'SELECT id, name, ats, token, active FROM companies WHERE active = 1 ORDER BY id',
  ).all<CompanyRow>();
  return results.map((r) => ({ ...r, active: r.active === 1 }));
}

/** Conteos por tabla — prueba de vida de la migration y el binding (ruta /api/health). */
export async function counts(env: Env): Promise<Record<string, number>> {
  const tables = ['companies', 'jobs', 'anchors', 'blocks', 'config'] as const;
  const out: Record<string, number> = {};
  for (const t of tables) {
    const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<{ n: number }>();
    out[t] = row?.n ?? 0;
  }
  return out;
}

// Carga y validacion de la configuracion de scoring desde la tabla `config`.
// Una lectura por invocacion; error claro si el seed no se ha aplicado.

import type { Env } from './types';
import { CATEGORIES, type ScoringConfig } from './scoring';

export async function loadScoringConfig(env: Env): Promise<ScoringConfig> {
  const row = await env.DB.prepare('SELECT value FROM config WHERE key = ?')
    .bind('scoring')
    .first<{ value: string }>();
  if (!row) {
    throw new Error("config 'scoring' no existe en D1 — aplicar el seed (seeds/seed_config.sql)");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.value);
  } catch {
    throw new Error("config 'scoring' no es JSON valido");
  }
  return validate(parsed);
}

export function validateScoringConfig(raw: unknown): ScoringConfig {
  return validate(raw);
}

function validate(raw: unknown): ScoringConfig {
  const c = raw as ScoringConfig;
  if (!c || typeof c !== 'object') throw new Error("config 'scoring': objeto esperado");
  for (const cat of CATEGORIES) {
    if (!c.weights?.[cat] || typeof c.weights[cat].weight !== 'number' || typeof c.weights[cat].saturation !== 'number') {
      throw new Error(`config 'scoring': falta weights.${cat} {weight, saturation}`);
    }
    if (!Array.isArray(c.keywords?.[cat])) {
      throw new Error(`config 'scoring': falta keywords.${cat}[]`);
    }
  }
  const totalWeight = CATEGORIES.reduce((acc, cat) => acc + c.weights[cat].weight, 0);
  if (Math.round(totalWeight) !== 100) {
    throw new Error(`config 'scoring': los pesos deben sumar 100 (suman ${totalWeight})`);
  }
  if (typeof c.title_multiplier !== 'number' || c.title_multiplier < 1) {
    throw new Error("config 'scoring': title_multiplier >= 1 requerido");
  }
  if (typeof c.thresholds?.apply !== 'number' || typeof c.thresholds?.stretch !== 'number' ||
      c.thresholds.apply <= c.thresholds.stretch) {
    throw new Error("config 'scoring': thresholds.apply > thresholds.stretch requerido");
  }
  if (!Array.isArray(c.tracks) || c.tracks.length === 0) {
    throw new Error("config 'scoring': tracks[] vacio");
  }
  for (const t of c.tracks) {
    if (!t.id || !Array.isArray(t.gates)) throw new Error("config 'scoring': track sin id o gates");
    for (const g of t.gates) {
      if (!g.id || (g.type !== 'hard' && g.type !== 'penalty')) {
        throw new Error(`config 'scoring': gate invalido en track ${t.id}`);
      }
    }
  }
  return c;
}

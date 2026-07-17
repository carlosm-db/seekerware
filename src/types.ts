// Tipos canonicos del glosario (docs/CONVENTIONS.md §1).

export type Ats = 'greenhouse' | 'lever' | 'ashby';

export type Verdict = 'Apply' | 'Stretch-worth-it' | 'Skip';

/** Empresa a vigilar (fila de la tabla `companies`). */
export interface Company {
  id: number;
  name: string;
  ats: Ats;
  token: string;
  active: boolean;
}

/** Job normalizado que devuelve todo connector. */
export interface Job {
  /** ID externo del job en el ATS. */
  id: string;
  company: string;
  title: string;
  location: string;
  url: string;
  description: string;
  /** ISO 8601, o null si el feed no trae fecha confiable. */
  posted_at: string | null;
  ats: Ats;
  raw: unknown;
}

/** Bindings y secretos del worker. */
export interface Env {
  DB: D1Database;
  /** Worker secret: protege fetch() completo hasta el login por cookie (paso 4). */
  API_TOKEN?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
}

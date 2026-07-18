// Signed-cookie login (TRD §8). No domain -> no Access; the worker is its own gatekeeper.

import type { Context, Next } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { Env } from '../types';

const COOKIE = 'sw_session';
const MAX_AGE_S = 30 * 24 * 3600;

export interface ConsoleEnv extends Env {
  LOGIN_PASSWORD_HASH?: string;
  SESSION_SECRET?: string;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacHex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyPassword(env: ConsoleEnv, password: string): Promise<boolean> {
  if (!env.LOGIN_PASSWORD_HASH) return false;
  return timingSafeEqual(await sha256Hex(password), env.LOGIN_PASSWORD_HASH.toLowerCase());
}

export async function createSession(env: ConsoleEnv): Promise<string> {
  const exp = Date.now() + MAX_AGE_S * 1000;
  const nonce = crypto.randomUUID();
  const payload = `${exp}.${nonce}`;
  const sig = await hmacHex(env.SESSION_SECRET ?? '', payload);
  return `${payload}.${sig}`;
}

export async function validSession(env: ConsoleEnv, token: string | undefined): Promise<boolean> {
  if (!token || !env.SESSION_SECRET) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [exp, nonce, sig] = parts as [string, string, string];
  if (Number(exp) < Date.now()) return false;
  return timingSafeEqual(await hmacHex(env.SESSION_SECRET, `${exp}.${nonce}`), sig);
}

export function setSessionCookie(c: Context, token: string): void {
  setCookie(c, COOKIE, token, {
    httpOnly: true, secure: true, sameSite: 'Lax', maxAge: MAX_AGE_S, path: '/',
  });
}

/** Global middleware: valid cookie OR Bearer API_TOKEN (scripts/curl); /login is the only open door. */
export function authMiddleware() {
  return async (c: Context<{ Bindings: ConsoleEnv }>, next: Next) => {
    if (c.req.path === '/login') return next();
    const bearerOk =
      !!c.env.API_TOKEN && c.req.header('authorization') === `Bearer ${c.env.API_TOKEN}`;
    const cookieOk = await validSession(c.env, getCookie(c, COOKIE));
    if (!bearerOk && !cookieOk) {
      if (c.req.path.startsWith('/api/')) return c.json({ error: 'unauthorized' }, 401);
      return c.redirect('/login');
    }
    // Minimal CSRF: mutations same-origin only
    if (c.req.method !== 'GET' && !bearerOk) {
      const origin = c.req.header('origin');
      if (origin && new URL(origin).host !== new URL(c.req.url).host) {
        return c.text('csrf', 403);
      }
    }
    return next();
  };
}

import { randomBytes, scrypt as _scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { sign, verify } from 'hono/jwt';
import { createMiddleware } from 'hono/factory';
import { HttpError } from './errors.js';

const scrypt = promisify(_scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, saltB64, keyB64] = stored.split('$');
  if (algo !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length);
  return timingSafeEqual(expected, actual);
}

export type AuthUser = { id: string; orgId: string; role: 'owner' | 'partner'; name: string };
export type AppEnv = { Variables: { user: AuthUser } };

const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;

export function jwtSecret(): string {
  const s = process.env.JWT_SECRET;
  if (s) return s;
  if (process.env.NODE_ENV === 'production') throw new Error('JWT_SECRET must be set in production');
  return 'dev-only-secret-change-me';
}

export function issueToken(u: AuthUser): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return sign({ sub: u.id, org: u.orgId, role: u.role, name: u.name, iat: now, exp: now + TOKEN_TTL_SECONDS }, jwtSecret(), 'HS256');
}

export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw new HttpError(401, 'Not signed in');
  try {
    const p = await verify(token, jwtSecret(), 'HS256');
    c.set('user', { id: String(p.sub), orgId: String(p.org), role: p.role as AuthUser['role'], name: String(p.name ?? '') });
  } catch {
    throw new HttpError(401, 'Session expired, please sign in again');
  }
  await next();
});

export const requireOwner = createMiddleware<AppEnv>(async (c, next) => {
  if (c.get('user').role !== 'owner') throw new HttpError(403, 'Only the owner can do this');
  await next();
});

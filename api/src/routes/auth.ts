import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { DB } from '../db/index.js';
import { orgs, users } from '../db/schema.js';
import { hashPassword, issueToken, requireAuth, requireOwner, verifyPassword, type AppEnv } from '../lib/auth.js';
import { HttpError, notFound } from '../lib/errors.js';
import { v } from '../lib/validate.js';
import { normaliseMobile, zId, zMoney, zTime } from '../lib/util.js';

const publicUser = (u: typeof users.$inferSelect) => ({ id: u.id, name: u.name, email: u.email, mobile: u.mobile, role: u.role, active: u.active });

export function authRoutes(db: DB) {
  const r = new Hono<AppEnv>();

  /** Create an organisation + owner. Open only for the very first org unless ALLOW_SIGNUP=true. */
  r.post('/signup', v('json', z.object({
    orgName: z.string().trim().min(1), name: z.string().trim().min(1),
    email: z.email().transform((e) => e.toLowerCase()), password: z.string().min(8),
  })), async (c) => {
    const body = c.req.valid('json');
    const [{ n }] = await db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(orgs);
    if (n > 0 && process.env.ALLOW_SIGNUP !== 'true') throw new HttpError(403, 'Sign-up is closed. Ask the owner to add you.');
    const [exists] = await db.select({ id: users.id }).from(users).where(eq(users.email, body.email));
    if (exists) throw new HttpError(409, 'Email already registered');
    const result = await db.transaction(async (tx) => {
      const [org] = await tx.insert(orgs).values({ name: body.orgName, settings: { currency: 'INR' } }).returning();
      const [u] = await tx.insert(users).values({ orgId: org.id, name: body.name, email: body.email, passwordHash: await hashPassword(body.password), role: 'owner' }).returning();
      return { org, u };
    });
    const token = await issueToken({ id: result.u.id, orgId: result.org.id, role: 'owner', name: result.u.name });
    return c.json({ token, user: publicUser(result.u), org: { id: result.org.id, name: result.org.name } }, 201);
  });

  r.get('/status', async (c) => {
    const [{ n }] = await db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(orgs);
    return c.json({ needsSetup: n === 0, signupOpen: n === 0 || process.env.ALLOW_SIGNUP === 'true' });
  });

  r.post('/login', v('json', z.object({ email: z.string().trim().toLowerCase(), password: z.string() })), async (c) => {
    const { email, password } = c.req.valid('json');
    const [u] = await db.select().from(users).where(eq(users.email, email));
    if (!u || !u.active || !u.passwordHash || !(await verifyPassword(password, u.passwordHash))) throw new HttpError(401, 'Wrong email or password');
    const [org] = await db.select().from(orgs).where(eq(orgs.id, u.orgId));
    const token = await issueToken({ id: u.id, orgId: u.orgId, role: u.role, name: u.name });
    return c.json({ token, user: publicUser(u), org: { id: org.id, name: org.name } });
  });

  r.get('/me', requireAuth, async (c) => {
    const me = c.get('user');
    const [u] = await db.select().from(users).where(eq(users.id, me.id));
    if (!u || !u.active) throw new HttpError(401, 'Account disabled');
    const [org] = await db.select().from(orgs).where(eq(orgs.id, u.orgId));
    return c.json({ user: publicUser(u), org: { id: org.id, name: org.name, settings: org.settings } });
  });

  r.post('/password', requireAuth, v('json', z.object({ currentPassword: z.string(), newPassword: z.string().min(8) })), async (c) => {
    const me = c.get('user');
    const { currentPassword, newPassword } = c.req.valid('json');
    const [u] = await db.select().from(users).where(eq(users.id, me.id));
    if (!u || !u.passwordHash || !(await verifyPassword(currentPassword, u.passwordHash))) throw new HttpError(401, 'Current password is wrong');
    await db.update(users).set({ passwordHash: await hashPassword(newPassword) }).where(eq(users.id, me.id));
    return c.json({ ok: true });
  });

  return r;
}

/** Owner manages partners who can use the app. */
export function userRoutes(db: DB) {
  const r = new Hono<AppEnv>();
  r.use(requireOwner);

  r.get('/', async (c) => {
    const list = await db.select().from(users).where(eq(users.orgId, c.get('user').orgId)).orderBy(asc(users.name));
    return c.json(list.map(publicUser));
  });

  r.post('/', v('json', z.object({
    // Email and password are optional for now: users are listed by name + mobile; sign-in comes later.
    name: z.string().trim().min(1), email: z.email().transform((e) => e.toLowerCase()).optional(),
    mobile: z.string().trim().min(8).transform((m) => normaliseMobile(m)).optional(), password: z.string().min(8).optional(),
    role: z.enum(['owner', 'partner']).default('partner'),
  }).refine((b) => !b.password || b.email, { message: 'An email is needed to sign in with a password', path: ['email'] })), async (c) => {
    const { password, ...body } = c.req.valid('json');
    if (body.email) {
      const [exists] = await db.select({ id: users.id }).from(users).where(eq(users.email, body.email));
      if (exists) throw new HttpError(409, 'Email already registered');
    }
    const [u] = await db.insert(users).values({ ...body, orgId: c.get('user').orgId, passwordHash: password ? await hashPassword(password) : null }).returning();
    return c.json(publicUser(u), 201);
  });

  r.patch('/:id', v('param', z.object({ id: zId })), v('json', z.object({
    name: z.string().trim().min(1).optional(), mobile: z.string().nullable().optional(),
    role: z.enum(['owner', 'partner']).optional(), active: z.boolean().optional(), password: z.string().min(8).optional(),
  })), async (c) => {
    const me = c.get('user');
    const { id } = c.req.valid('param');
    const { password, ...rest } = c.req.valid('json');
    if (id === me.id && (rest.active === false || rest.role === 'partner')) throw new HttpError(422, "You can't demote or disable yourself");
    const [u] = await db.update(users).set({ ...rest, ...(password ? { passwordHash: await hashPassword(password) } : {}) })
      .where(and(eq(users.id, id), eq(users.orgId, me.orgId))).returning();
    if (!u) throw notFound('User');
    return c.json(publicUser(u));
  });

  return r;
}

export function settingsRoutes(db: DB) {
  const r = new Hono<AppEnv>();
  r.get('/', async (c) => {
    const [org] = await db.select().from(orgs).where(eq(orgs.id, c.get('user').orgId));
    return c.json({ name: org.name, settings: org.settings });
  });
  r.patch('/', requireOwner, v('json', z.object({
    name: z.string().trim().min(1).optional(),
    settings: z.object({
      upiId: z.string().optional(), reminderTemplate: z.string().optional(), currency: z.string().optional(),
      standardSlots: z.array(z.object({ name: z.string().trim().min(1), startTime: zTime, endTime: zTime })
        .refine((s) => s.startTime < s.endTime, { message: 'End time must be after start time' })).min(1).max(12).optional(),
      eventPrices: z.object({ halfDay: zMoney.nullable(), fullDay: zMoney.nullable(), tournamentPerMatch: zMoney.nullable() }).partial().optional(),
    }).optional(),
  })), async (c) => {
    const orgId = c.get('user').orgId;
    const body = c.req.valid('json');
    const [org] = await db.select().from(orgs).where(eq(orgs.id, orgId));
    const [updated] = await db.update(orgs).set({
      ...(body.name ? { name: body.name } : {}),
      ...(body.settings ? { settings: { ...org.settings, ...body.settings } } : {}),
    }).where(eq(orgs.id, orgId)).returning();
    return c.json({ name: updated.name, settings: updated.settings });
  });
  return r;
}

import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { DB } from '../db/index.js';
import { paymentAccounts, payments } from '../db/schema.js';
import { requireOwner, type AppEnv } from '../lib/auth.js';
import { HttpError, notFound } from '../lib/errors.js';
import { v } from '../lib/validate.js';
import { zId } from '../lib/util.js';

const MAX_QR_BYTES = 1_500_000;
const zQr = z.string().regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/, 'QR must be a PNG, JPEG or WebP image')
  .refine((s) => s.length * 0.75 <= MAX_QR_BYTES, 'QR image is too large (max 1.5 MB)');

const body = z.object({
  name: z.string().trim().min(1),
  upiId: z.string().trim().nullable().optional(),
  holderName: z.string().trim().nullable().optional(),
  details: z.string().nullable().optional(),
  qrImage: zQr.nullable().optional(),        // null removes it
  isDefault: z.boolean().optional(),
  active: z.boolean().optional(),
});

type Account = typeof paymentAccounts.$inferSelect;
/** Public path of an account's QR image (no login needed, so WhatsApp recipients can open it). */
export const qrPath = (id: string) => `/api/v1/public/qr/${id}`;
const view = ({ qrImage, ...a }: Account) => ({ ...a, hasQr: !!qrImage, qrUrl: qrImage ? qrPath(a.id) : null });

/** The account reminders use when none is chosen: the default, else the first active one. */
export async function defaultAccount(db: DB, orgId: string): Promise<Account | undefined> {
  const [a] = await db.select().from(paymentAccounts)
    .where(and(eq(paymentAccounts.orgId, orgId), eq(paymentAccounts.active, true)))
    .orderBy(desc(paymentAccounts.isDefault), asc(paymentAccounts.createdAt)).limit(1);
  return a;
}

export function accountRoutes(db: DB) {
  const r = new Hono<AppEnv>();

  r.get('/', async (c) => {
    const rows = await db.select().from(paymentAccounts).where(eq(paymentAccounts.orgId, c.get('user').orgId))
      .orderBy(desc(paymentAccounts.isDefault), asc(paymentAccounts.name));
    return c.json(rows.map(view));
  });

  async function clearDefault(orgId: string) {
    await db.update(paymentAccounts).set({ isDefault: false }).where(eq(paymentAccounts.orgId, orgId));
  }

  r.post('/', requireOwner, v('json', body), async (c) => {
    const orgId = c.get('user').orgId;
    const b = c.req.valid('json');
    const [{ n }] = await db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(paymentAccounts).where(eq(paymentAccounts.orgId, orgId));
    const isDefault = b.isDefault ?? n === 0;
    if (isDefault) await clearDefault(orgId);
    const [row] = await db.insert(paymentAccounts).values({ ...b, isDefault, orgId }).returning();
    return c.json(view(row), 201);
  });

  r.patch('/:id', requireOwner, v('param', z.object({ id: zId })), v('json', body.partial()), async (c) => {
    const orgId = c.get('user').orgId;
    const b = c.req.valid('json');
    if (b.isDefault) await clearDefault(orgId);
    const [row] = await db.update(paymentAccounts).set(b).where(and(eq(paymentAccounts.id, c.req.valid('param').id), eq(paymentAccounts.orgId, orgId))).returning();
    if (!row) throw notFound('Payment account');
    return c.json(view(row));
  });

  /** Delete if unused; an account with payments recorded against it is archived instead. */
  r.delete('/:id', requireOwner, v('param', z.object({ id: zId })), async (c) => {
    const orgId = c.get('user').orgId;
    const { id } = c.req.valid('param');
    const [{ n }] = await db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(payments).where(eq(payments.accountId, id));
    if (n > 0) {
      const [row] = await db.update(paymentAccounts).set({ active: false, isDefault: false }).where(and(eq(paymentAccounts.id, id), eq(paymentAccounts.orgId, orgId))).returning();
      if (!row) throw notFound('Payment account');
      return c.json({ archived: true });
    }
    const [row] = await db.delete(paymentAccounts).where(and(eq(paymentAccounts.id, id), eq(paymentAccounts.orgId, orgId))).returning({ id: paymentAccounts.id });
    if (!row) throw notFound('Payment account');
    return c.json({ deleted: true });
  });

  return r;
}

/** Unauthenticated: serves a QR image by account id so the link in a WhatsApp reminder opens for the payer. */
export function publicRoutes(db: DB) {
  const r = new Hono<AppEnv>();
  r.get('/qr/:id', v('param', z.object({ id: zId })), async (c) => {
    const [a] = await db.select({ qr: paymentAccounts.qrImage }).from(paymentAccounts).where(eq(paymentAccounts.id, c.req.valid('param').id));
    const m = a?.qr?.match(/^data:(image\/[a-z]+);base64,(.+)$/);
    if (!m) throw new HttpError(404, 'No QR code');
    c.header('content-type', m[1]);
    c.header('cache-control', 'public, max-age=300');
    return c.body(new Uint8Array(Buffer.from(m[2], 'base64')));
  });
  return r;
}

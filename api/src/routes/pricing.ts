import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import type { DB } from '../db/index.js';
import { BOOKED_BY, BOOKING_KINDS, EVENT_TYPES, grounds, priceRules, slotTemplates, teams } from '../db/schema.js';
import type { AppEnv } from '../lib/auth.js';
import { HttpError, notFound } from '../lib/errors.js';
import { v } from '../lib/validate.js';
import { zId, zMoney } from '../lib/util.js';
import { quotePrice } from '../services/pricing.js';

const ruleBody = z.object({
  teamId: zId.nullable().optional(),
  groundId: zId.nullable().optional(),
  slotTemplateId: zId.nullable().optional(),
  price: zMoney,
  notes: z.string().nullable().optional(),
});

export function pricingRoutes(db: DB) {
  const r = new Hono<AppEnv>();

  /** Suggested per-team price for a booking form. */
  r.get('/quote', v('query', z.object({
    groundId: zId, slotTemplateId: zId.optional(), teamId: zId.optional(),
    kind: z.enum(BOOKING_KINDS).optional(), bookedBy: z.enum(BOOKED_BY).optional(), eventType: z.enum(EVENT_TYPES).optional(), matchCount: z.coerce.number().int().min(1).max(500).optional(),
  })), async (c) =>
    c.json(await quotePrice(db, c.get('user').orgId, c.req.valid('query'))));

  r.get('/rules', async (c) => {
    const orgId = c.get('user').orgId;
    const rows = await db.select({ r: priceRules, teamName: teams.name, teamKind: teams.kind, groundName: grounds.name, slotName: slotTemplates.name })
      .from(priceRules)
      .leftJoin(teams, eq(teams.id, priceRules.teamId))
      .leftJoin(grounds, eq(grounds.id, priceRules.groundId))
      .leftJoin(slotTemplates, eq(slotTemplates.id, priceRules.slotTemplateId))
      .where(eq(priceRules.orgId, orgId));
    return c.json(rows.map(({ r, ...names }) => ({ ...r, ...names })));
  });

  async function check(orgId: string, b: z.infer<typeof ruleBody>) {
    if (!b.teamId && !b.groundId && !b.slotTemplateId) throw new HttpError(422, 'A rule needs at least a team, ground or slot — use the ground default price otherwise');
    if (b.teamId && !(await db.select().from(teams).where(and(eq(teams.id, b.teamId), eq(teams.orgId, orgId)))).length) throw notFound('Team');
    if (b.groundId && !(await db.select().from(grounds).where(and(eq(grounds.id, b.groundId), eq(grounds.orgId, orgId)))).length) throw notFound('Ground');
    if (b.slotTemplateId) {
      const [s] = await db.select().from(slotTemplates).where(and(eq(slotTemplates.id, b.slotTemplateId), eq(slotTemplates.orgId, orgId)));
      if (!s) throw notFound('Slot');
      b.groundId = s.groundId; // a slot implies its ground
    }
  }

  r.post('/rules', v('json', ruleBody), async (c) => {
    const orgId = c.get('user').orgId;
    const body = c.req.valid('json');
    await check(orgId, body);
    const [row] = await db.insert(priceRules).values({ ...body, orgId }).returning();
    return c.json(row, 201);
  });

  r.patch('/rules/:id', v('param', z.object({ id: zId })), v('json', ruleBody), async (c) => {
    const orgId = c.get('user').orgId;
    const body = c.req.valid('json');
    await check(orgId, body);
    const [row] = await db.update(priceRules).set(body).where(and(eq(priceRules.id, c.req.valid('param').id), eq(priceRules.orgId, orgId))).returning();
    if (!row) throw notFound('Price rule');
    return c.json(row);
  });

  r.delete('/rules/:id', v('param', z.object({ id: zId })), async (c) => {
    await db.delete(priceRules).where(and(eq(priceRules.id, c.req.valid('param').id), eq(priceRules.orgId, c.get('user').orgId)));
    return c.body(null, 204);
  });

  return r;
}

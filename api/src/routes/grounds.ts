import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { DB } from '../db/index.js';
import { bookings, cities, grounds, slotTemplates } from '../db/schema.js';
import type { AppEnv } from '../lib/auth.js';
import { HttpError, notFound } from '../lib/errors.js';
import { v } from '../lib/validate.js';
import { zId, zMoney, zTime } from '../lib/util.js';

const slotBase = z.object({
  name: z.string().trim().min(1),
  startTime: zTime, endTime: zTime,
  defaultPrice: zMoney.nullable().optional(),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).optional(),
  sortOrder: z.number().int().optional(),
  active: z.boolean().optional(),
});
const slotBody = slotBase.refine((s) => s.startTime < s.endTime, { message: 'End time must be after start time', path: ['endTime'] });

export function cityRoutes(db: DB) {
  const r = new Hono<AppEnv>();
  r.get('/', async (c) => c.json(await db.select().from(cities).where(eq(cities.orgId, c.get('user').orgId)).orderBy(asc(cities.name))));
  r.post('/', v('json', z.object({ name: z.string().trim().min(1) })), async (c) => {
    const orgId = c.get('user').orgId;
    const [row] = await db.insert(cities).values({ orgId, name: c.req.valid('json').name }).onConflictDoNothing().returning();
    if (!row) throw new HttpError(409, 'City already exists');
    return c.json(row, 201);
  });
  r.patch('/:id', v('param', z.object({ id: zId })), v('json', z.object({ name: z.string().trim().min(1) })), async (c) => {
    const [row] = await db.update(cities).set(c.req.valid('json'))
      .where(and(eq(cities.id, c.req.valid('param').id), eq(cities.orgId, c.get('user').orgId))).returning();
    if (!row) throw notFound('City');
    return c.json(row);
  });
  r.delete('/:id', v('param', z.object({ id: zId })), async (c) => {
    const { id } = c.req.valid('param');
    const orgId = c.get('user').orgId;
    const [{ n }] = await db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(grounds).where(eq(grounds.cityId, id));
    if (n > 0) throw new HttpError(409, 'City has grounds; move or remove them first');
    await db.delete(cities).where(and(eq(cities.id, id), eq(cities.orgId, orgId)));
    return c.body(null, 204);
  });
  return r;
}

export function groundRoutes(db: DB) {
  const r = new Hono<AppEnv>();

  async function withSlots(orgId: string, where = eq(grounds.orgId, orgId)) {
    const gs = await db.select({ g: grounds, cityName: cities.name }).from(grounds)
      .innerJoin(cities, eq(cities.id, grounds.cityId)).where(where).orderBy(asc(cities.name), asc(grounds.name));
    const slots = await db.select().from(slotTemplates).where(eq(slotTemplates.orgId, orgId))
      .orderBy(asc(slotTemplates.sortOrder), asc(slotTemplates.startTime));
    return gs.map(({ g, cityName }) => ({ ...g, cityName, slots: slots.filter((s) => s.groundId === g.id) }));
  }

  r.get('/', async (c) => c.json(await withSlots(c.get('user').orgId)));

  r.get('/:id', v('param', z.object({ id: zId })), async (c) => {
    const orgId = c.get('user').orgId;
    const [g] = await withSlots(orgId, and(eq(grounds.orgId, orgId), eq(grounds.id, c.req.valid('param').id))!);
    if (!g) throw notFound('Ground');
    return c.json(g);
  });

  /** Create a ground. Accepts cityId or a cityName (created if new). Slots may be included. */
  r.post('/', v('json', z.object({
    name: z.string().trim().min(1),
    cityId: zId.optional(), cityName: z.string().trim().min(1).optional(),
    defaultPrice: zMoney.nullable().optional(), address: z.string().optional(), notes: z.string().optional(),
    slots: z.array(slotBody).optional(),
  }).refine((b) => b.cityId || b.cityName, { message: 'cityId or cityName is required', path: ['cityId'] })), async (c) => {
    const orgId = c.get('user').orgId;
    const { slots, cityName, ...body } = c.req.valid('json');
    const ground = await db.transaction(async (tx) => {
      let cityId = body.cityId;
      if (!cityId) {
        await tx.insert(cities).values({ orgId, name: cityName! }).onConflictDoNothing();
        [{ id: cityId }] = await tx.select({ id: cities.id }).from(cities).where(and(eq(cities.orgId, orgId), eq(cities.name, cityName!)));
      } else {
        const [city] = await tx.select().from(cities).where(and(eq(cities.id, cityId), eq(cities.orgId, orgId)));
        if (!city) throw notFound('City');
      }
      const [g] = await tx.insert(grounds).values({ ...body, cityId, orgId }).returning();
      if (slots?.length) await tx.insert(slotTemplates).values(slots.map((s, i) => ({ sortOrder: i, ...s, orgId, groundId: g.id })));
      return g;
    });
    const [full] = await withSlots(orgId, and(eq(grounds.orgId, orgId), eq(grounds.id, ground.id))!);
    return c.json(full, 201);
  });

  r.patch('/:id', v('param', z.object({ id: zId })), v('json', z.object({
    name: z.string().trim().min(1).optional(), cityId: zId.optional(), defaultPrice: zMoney.nullable().optional(),
    address: z.string().nullable().optional(), notes: z.string().nullable().optional(), active: z.boolean().optional(),
  })), async (c) => {
    const orgId = c.get('user').orgId;
    const body = c.req.valid('json');
    if (body.cityId) {
      const [city] = await db.select().from(cities).where(and(eq(cities.id, body.cityId), eq(cities.orgId, orgId)));
      if (!city) throw notFound('City');
    }
    const [g] = await db.update(grounds).set(body).where(and(eq(grounds.id, c.req.valid('param').id), eq(grounds.orgId, orgId))).returning();
    if (!g) throw notFound('Ground');
    return c.json(g);
  });

  /** Grounds with bookings are archived (active=false) rather than deleted. */
  r.delete('/:id', v('param', z.object({ id: zId })), async (c) => {
    const orgId = c.get('user').orgId;
    const { id } = c.req.valid('param');
    const [{ n }] = await db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(bookings).where(eq(bookings.groundId, id));
    if (n > 0) {
      await db.update(grounds).set({ active: false }).where(and(eq(grounds.id, id), eq(grounds.orgId, orgId)));
      return c.json({ archived: true });
    }
    await db.delete(grounds).where(and(eq(grounds.id, id), eq(grounds.orgId, orgId)));
    return c.json({ deleted: true });
  });

  // ---- slot templates ----
  r.post('/:id/slots', v('param', z.object({ id: zId })), v('json', slotBody), async (c) => {
    const orgId = c.get('user').orgId;
    const { id } = c.req.valid('param');
    const [g] = await db.select({ id: grounds.id }).from(grounds).where(and(eq(grounds.id, id), eq(grounds.orgId, orgId)));
    if (!g) throw notFound('Ground');
    const [s] = await db.insert(slotTemplates).values({ ...c.req.valid('json'), orgId, groundId: id }).returning();
    return c.json(s, 201);
  });

  r.patch('/slots/:slotId', v('param', z.object({ slotId: zId })), v('json', slotBase.partial()), async (c) => {
    const orgId = c.get('user').orgId;
    const body = c.req.valid('json');
    const [cur] = await db.select().from(slotTemplates).where(and(eq(slotTemplates.id, c.req.valid('param').slotId), eq(slotTemplates.orgId, orgId)));
    if (!cur) throw notFound('Slot');
    if ((body.startTime ?? cur.startTime) >= (body.endTime ?? cur.endTime)) throw new HttpError(422, 'End time must be after start time');
    const [s] = await db.update(slotTemplates).set(body).where(eq(slotTemplates.id, cur.id)).returning();
    return c.json(s);
  });

  r.delete('/slots/:slotId', v('param', z.object({ slotId: zId })), async (c) => {
    await db.delete(slotTemplates).where(and(eq(slotTemplates.id, c.req.valid('param').slotId), eq(slotTemplates.orgId, c.get('user').orgId)));
    return c.body(null, 204);
  });

  return r;
}

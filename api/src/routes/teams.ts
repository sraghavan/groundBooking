import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import type { DB } from '../db/index.js';
import { TEAM_KINDS, bookingParties, contacts, priceRules, reminders, teams } from '../db/schema.js';
import type { AppEnv } from '../lib/auth.js';
import { HttpError, notFound } from '../lib/errors.js';
import { v } from '../lib/validate.js';
import { nameKey, normaliseMobile, zId, zMoney } from '../lib/util.js';
import { loadBookings } from '../services/bookings.js';
import { activePoc, sameNameTeams } from '../services/teams.js';

const contactBody = z.object({
  name: z.string().trim().min(1),
  mobile: z.string().trim().min(8).transform((m) => normaliseMobile(m)),
  isPrimary: z.boolean().optional(),
  active: z.boolean().optional(),           // false = former POC
});

const rateFields = {
  defaultRate: zMoney.nullable().optional(),   // promoter: per match
  rateHalfDay: zMoney.nullable().optional(),
  rateFullDay: zMoney.nullable().optional(),
};

export function teamRoutes(db: DB) {
  const r = new Hono<AppEnv>();

  /** Update the active POC's mobile, add a POC if there is none, or retire it when cleared. */
  async function setMainMobile(t: typeof teams.$inferSelect, raw: string | null) {
    const cs = await db.select().from(contacts).where(eq(contacts.teamId, t.id));
    const poc = activePoc(cs);
    if (!raw) {
      if (poc) await db.update(contacts).set({ active: false, isPrimary: false }).where(eq(contacts.id, poc.contactId));
      return;
    }
    const mobile = normaliseMobile(raw);
    if (poc) await db.update(contacts).set({ mobile }).where(eq(contacts.id, poc.contactId));
    else await db.insert(contacts).values({ orgId: t.orgId, teamId: t.id, name: t.name, mobile, isPrimary: true });
  }

  /** List / search teams (used by the booking screen's team picker). */
  r.get('/', v('query', z.object({
    q: z.string().optional(), includeInactive: z.enum(['true', 'false']).optional(),
    kind: z.enum(['team', 'promoter', 'all']).default('team'),   // promoters are listed separately
  })), async (c) => {
    const orgId = c.get('user').orgId;
    const { q, includeInactive, kind } = c.req.valid('query');
    const conds = [eq(teams.orgId, orgId)];
    if (kind !== 'all') conds.push(eq(teams.kind, kind));
    if (includeInactive !== 'true') conds.push(eq(teams.active, true));
    if (q?.trim()) {
      const digits = q.replace(/\D/g, '');
      conds.push(or(
        ilike(teams.name, `%${q.trim()}%`), ilike(teams.nameKey, `%${nameKey(q)}%`),
        sql`exists (select 1 from ${contacts} ct where ct.team_id = ${teams.id} and (ct.name ilike ${'%' + q.trim() + '%'}${digits.length >= 4 ? sql` or ct.mobile like ${'%' + digits + '%'}` : sql``}))`,
      )!);
    }
    const list = await db.select({
      t: teams,
      bookingCount: sql<number>`(select count(*) from ${bookingParties} bp where bp.team_id = "teams"."id")`.mapWith(Number),
    }).from(teams).where(and(...conds)).orderBy(asc(teams.name)).limit(q ? 30 : 5000);
    const ids = list.map((x) => x.t.id);
    const cs = ids.length ? await db.select().from(contacts).where(inArray(contacts.teamId, ids)) : [];
    return c.json(list.map(({ t, bookingCount }) => {
      const mine = cs.filter((x) => x.teamId === t.id);
      return {
        ...t, bookingCount, poc: activePoc(mine),
        contacts: mine.sort((a, b) => Number(b.active) - Number(a.active) || Number(b.isPrimary) - Number(a.isPrimary)),
      };
    }));
  });

  r.get('/:id', v('param', z.object({ id: zId })), async (c) => {
    const orgId = c.get('user').orgId;
    const { id } = c.req.valid('param');
    const [t] = await db.select().from(teams).where(and(eq(teams.id, id), eq(teams.orgId, orgId)));
    if (!t) throw notFound('Team');
    const cs = await db.select().from(contacts).where(eq(contacts.teamId, id)).orderBy(asc(contacts.name));
    const bks = await loadBookings(db, orgId, { teamId: id, includeCancelled: true });
    const mine = bks.flatMap((b) => b.parties.filter((p) => p.teamId === id));
    return c.json({
      ...t, contacts: cs, poc: activePoc(cs), bookings: bks.reverse(),
      totals: { billed: mine.reduce((s, p) => s + p.amountDue, 0), paid: mine.reduce((s, p) => s + p.paid, 0), balance: mine.reduce((s, p) => s + p.balance, 0) },
    });
  });

  /** Create a team. Names may repeat (different teams, different POCs); pass allowDuplicateName after showing the user the existing ones. */
  r.post('/', v('json', z.object({
    name: z.string().trim().min(1), notes: z.string().optional(), contacts: z.array(contactBody).optional(), allowDuplicateName: z.boolean().optional(),
    kind: z.enum(TEAM_KINDS).optional(), ...rateFields,
  })), async (c) => {
    const orgId = c.get('user').orgId;
    const { contacts: cs, allowDuplicateName, ...body } = c.req.valid('json');
    const key = nameKey(body.name);
    if (!allowDuplicateName) {
      const existing = await sameNameTeams(db, orgId, body.name);
      if (existing.length) throw new HttpError(409, `A team called "${existing[0].name}" already exists`, { code: 'team_name_exists', teamName: body.name, teams: existing });
    }
    const t = await db.transaction(async (tx) => {
      const [t] = await tx.insert(teams).values({ ...body, orgId, nameKey: key }).returning();
      if (cs?.length) await tx.insert(contacts).values(cs.map((x, i) => ({ ...x, isPrimary: x.isPrimary ?? i === 0, orgId, teamId: t.id })));
      return t;
    });
    return c.json(t, 201);
  });

  r.patch('/:id', v('param', z.object({ id: zId })), v('json', z.object({
    name: z.string().trim().min(1).optional(), notes: z.string().nullable().optional(), active: z.boolean().optional(),
    kind: z.enum(TEAM_KINDS).optional(), ...rateFields,
    mobile: z.string().trim().nullable().optional(),   // sets the main contact's mobile (used by the Promoters table)
  })), async (c) => {
    const orgId = c.get('user').orgId;
    const { id } = c.req.valid('param');
    const { mobile, ...body } = c.req.valid('json');
    const patch: Partial<typeof teams.$inferInsert> = { ...body };
    if (body.name) patch.nameKey = nameKey(body.name); // other teams may share the name
    if (mobile && mobile.replace(/\D/g, '').length < 8) throw new HttpError(422, 'Enter a valid mobile number');
    const where = and(eq(teams.id, id), eq(teams.orgId, orgId));
    const [t] = Object.keys(patch).length
      ? await db.update(teams).set(patch).where(where).returning()
      : await db.select().from(teams).where(where);
    if (!t) throw notFound('Team');
    if (mobile !== undefined) await setMainMobile(t, mobile);
    return c.json(t);
  });

  /** Merge a duplicate team into another: moves bookings, contacts, price rules and reminder history. */
  r.post('/:id/merge', v('param', z.object({ id: zId })), v('json', z.object({ intoTeamId: zId })), async (c) => {
    const orgId = c.get('user').orgId;
    const { id } = c.req.valid('param');
    const { intoTeamId } = c.req.valid('json');
    if (id === intoTeamId) throw new HttpError(422, 'Cannot merge a team into itself');
    const both = await db.select({ id: teams.id }).from(teams).where(and(eq(teams.orgId, orgId), inArray(teams.id, [id, intoTeamId])));
    if (both.length !== 2) throw notFound('Team');
    await db.transaction(async (tx) => {
      await tx.update(bookingParties).set({ teamId: intoTeamId }).where(eq(bookingParties.teamId, id));
      await tx.update(contacts).set({ teamId: intoTeamId, isPrimary: false }).where(eq(contacts.teamId, id));
      await tx.update(priceRules).set({ teamId: intoTeamId }).where(eq(priceRules.teamId, id));
      await tx.update(reminders).set({ teamId: intoTeamId }).where(eq(reminders.teamId, id));
      await tx.delete(teams).where(eq(teams.id, id));
    });
    return c.json({ mergedInto: intoTeamId });
  });

  r.delete('/:id', v('param', z.object({ id: zId })), async (c) => {
    const orgId = c.get('user').orgId;
    const { id } = c.req.valid('param');
    const [{ n }] = await db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(bookingParties).where(eq(bookingParties.teamId, id));
    if (n > 0) {
      await db.update(teams).set({ active: false }).where(and(eq(teams.id, id), eq(teams.orgId, orgId)));
      return c.json({ archived: true });
    }
    await db.delete(teams).where(and(eq(teams.id, id), eq(teams.orgId, orgId)));
    return c.json({ deleted: true });
  });

  // ---- contacts (POCs) ----
  async function clearPrimary(teamId: string) {
    await db.update(contacts).set({ isPrimary: false }).where(eq(contacts.teamId, teamId));
  }

  r.post('/:id/contacts', v('param', z.object({ id: zId })), v('json', contactBody), async (c) => {
    const orgId = c.get('user').orgId;
    const { id } = c.req.valid('param');
    const [t] = await db.select({ id: teams.id }).from(teams).where(and(eq(teams.id, id), eq(teams.orgId, orgId)));
    if (!t) throw notFound('Team');
    const body = c.req.valid('json');
    const [{ n }] = await db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(contacts).where(eq(contacts.teamId, id));
    const isPrimary = body.isPrimary ?? n === 0;
    if (isPrimary) await clearPrimary(id);
    const [row] = await db.insert(contacts).values({ ...body, isPrimary, orgId, teamId: id }).returning();
    return c.json(row, 201);
  });

  r.patch('/contacts/:cid', v('param', z.object({ cid: zId })), v('json', contactBody.partial()), async (c) => {
    const orgId = c.get('user').orgId;
    const body = c.req.valid('json');
    const [cur] = await db.select().from(contacts).where(and(eq(contacts.id, c.req.valid('param').cid), eq(contacts.orgId, orgId)));
    if (!cur) throw notFound('Contact');
    if (body.isPrimary) await clearPrimary(cur.teamId);
    const [row] = await db.update(contacts).set(body).where(eq(contacts.id, cur.id)).returning();
    return c.json(row);
  });

  r.delete('/contacts/:cid', v('param', z.object({ cid: zId })), async (c) => {
    await db.delete(contacts).where(and(eq(contacts.id, c.req.valid('param').cid), eq(contacts.orgId, c.get('user').orgId)));
    return c.body(null, 204);
  });

  return r;
}

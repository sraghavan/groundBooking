import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DB } from '../db/index.js';
import { BOOKED_BY, BOOKING_KINDS, BOOKING_STATUSES, EVENT_TYPES, PAYMENT_METHODS, bookingParties, bookings, grounds, paymentAccounts, payments, slotTemplates, teams } from '../db/schema.js';
import type { AppEnv } from '../lib/auth.js';
import { HttpError, notFound } from '../lib/errors.js';
import { v } from '../lib/validate.js';
import { today, zDate, zId, zMoney, zTime } from '../lib/util.js';
import { findClashes, loadBookings } from '../services/bookings.js';
import { quotePrice } from '../services/pricing.js';
import { resolveTeam } from '../services/teams.js';

const partyInput = z.object({
  id: zId.optional(),                       // existing party (on update)
  side: z.enum(['A', 'B', 'client']),
  teamId: zId.optional(),
  teamName: z.string().trim().min(1).optional(),
  newTeam: z.boolean().optional(),          // create a new team even if one with this name exists
  contact: z.object({ name: z.string().trim(), mobile: z.string().trim() }).optional(), // first POC for a new team
  amountDue: zMoney.optional(),             // omitted → default price is applied
  notes: z.string().nullable().optional(),
}).refine((p) => p.teamId || p.teamName, { message: 'teamId or teamName is required' });

const bookingFields = {
  groundId: zId,
  slotTemplateId: zId.nullable().optional(),
  date: zDate,
  startTime: zTime,
  endTime: zTime,
  kind: z.enum(BOOKING_KINDS).default('match'),
  bookedBy: z.enum(BOOKED_BY).default('direct'),
  eventType: z.enum(EVENT_TYPES).nullable().optional(),
  matchCount: z.number().int().min(1).max(500).nullable().optional(),
  title: z.string().trim().nullable().optional(),
  status: z.enum(BOOKING_STATUSES).optional(),
  notes: z.string().nullable().optional(),
};

const createBody = z.object({
  ...bookingFields,
  parties: z.array(partyInput).max(20).default([]),
  allowOverlap: z.boolean().optional(),
});

const updateBody = z.object({
  ...Object.fromEntries(Object.entries(bookingFields).map(([k, s]) => [k, (s as z.ZodType).optional()])) as {
    [K in keyof typeof bookingFields]: z.ZodOptional<(typeof bookingFields)[K]>
  },
  parties: z.array(partyInput).max(20).optional(),
  allowOverlap: z.boolean().optional(),
});

type PartyInput = z.infer<typeof partyInput>;

type Kind = (typeof BOOKING_KINDS)[number];
type BookedBy = (typeof BOOKED_BY)[number];

function checkParties(kind: Kind, bookedBy: BookedBy, parties: PartyInput[]) {
  if (bookedBy === 'promoter') {
    if (parties.length > 1 || parties.some((p) => p.side !== 'client')) throw new HttpError(422, 'A promoter booking has one promoter (side "client")');
    if (parties.some((p) => !p.teamId)) throw new HttpError(422, 'Choose a promoter from the list (add new promoters in Admin → Promoters)');
  } else if (kind === 'match') {
    if (parties.some((p) => p.side === 'client')) throw new HttpError(422, 'Match teams must be side A or B');
    if (parties.filter((p) => p.side === 'A').length > 1 || parties.filter((p) => p.side === 'B').length > 1) throw new HttpError(422, 'A match has at most one team per side');
  } else if (parties.some((p) => p.side !== 'client')) {
    throw new HttpError(422, 'Event parties must use side "client"');
  }
}

/** Event fields only apply to events; tournaments need a match count. */
function normaliseEvent<T extends { kind?: Kind; eventType?: string | null; matchCount?: number | null }>(b: T): T {
  if (b.kind && b.kind !== 'event') return { ...b, eventType: null, matchCount: null };
  if (b.eventType && b.eventType !== 'tournament') return { ...b, matchCount: null };
  if (b.eventType === 'tournament' && !b.matchCount) return { ...b, matchCount: 1 };
  return b;
}

export function bookingRoutes(db: DB) {
  const r = new Hono<AppEnv>();

  async function getOne(orgId: string, id: string) {
    const [b] = await loadBookings(db, orgId, { ids: [id], includeCancelled: true });
    if (!b) throw notFound('Booking');
    return b;
  }

  async function checkGroundSlot(orgId: string, groundId: string, slotTemplateId?: string | null) {
    const [g] = await db.select({ id: grounds.id }).from(grounds).where(and(eq(grounds.id, groundId), eq(grounds.orgId, orgId)));
    if (!g) throw notFound('Ground');
    if (slotTemplateId) {
      const [s] = await db.select({ id: slotTemplates.id }).from(slotTemplates).where(and(eq(slotTemplates.id, slotTemplateId), eq(slotTemplates.groundId, groundId)));
      if (!s) throw new HttpError(422, 'Slot does not belong to this ground');
    }
  }

  /** Promoter bookings must name a promoter; promoters can't be put on a match as a team. */
  async function checkTeamKinds(orgId: string, bookedBy: BookedBy, parties: PartyInput[]) {
    const ids = parties.map((p) => p.teamId).filter(Boolean) as string[];
    if (!ids.length) return;
    const rows = await db.select({ id: teams.id, kind: teams.kind, name: teams.name }).from(teams).where(and(eq(teams.orgId, orgId), inArray(teams.id, ids)));
    for (const t of rows) {
      if (bookedBy === 'promoter' && t.kind !== 'promoter') throw new HttpError(422, `${t.name} is not a promoter`);
      if (bookedBy !== 'promoter' && t.kind === 'promoter') throw new HttpError(422, `${t.name} is a promoter: choose "Promoter" as who booked it`);
    }
  }

  async function assertNoClash(orgId: string, b: { groundId: string; date: string; startTime: string; endTime: string; excludeId?: string }, allow?: boolean) {
    if (allow) return;
    const clashes = await findClashes(db, orgId, b);
    if (clashes.length) {
      const when = clashes.map((x) => `${x.startTime}–${x.endTime}`).join(', ');
      throw new HttpError(409, `This ground is already booked ${when} on ${b.date}`, { clashes });
    }
  }

  r.get('/', v('query', z.object({
    from: zDate.optional(), to: zDate.optional(), groundId: zId.optional(), cityId: zId.optional(), teamId: zId.optional(),
    includeCancelled: z.enum(['true', 'false']).optional(),
  })), async (c) => {
    const q = c.req.valid('query');
    return c.json(await loadBookings(db, c.get('user').orgId, { ...q, includeCancelled: q.includeCancelled === 'true' }));
  });

  r.get('/:id', v('param', z.object({ id: zId })), async (c) => {
    const orgId = c.get('user').orgId;
    const b = await getOne(orgId, c.req.valid('param').id);
    const pays = b.parties.length
      ? await db.select().from(payments).where(inArray(payments.bookingPartyId, b.parties.map((p) => p.id))).orderBy(payments.paidOn)
      : [];
    return c.json({ ...b, payments: pays });
  });

  r.post('/', v('json', createBody), async (c) => {
    const user = c.get('user');
    const { parties, allowOverlap, ...raw } = c.req.valid('json');
    const body = normaliseEvent(raw);
    if (body.startTime >= body.endTime) throw new HttpError(422, 'End time must be after start time');
    checkParties(body.kind, body.bookedBy, parties);
    await checkTeamKinds(user.orgId, body.bookedBy, parties);
    await checkGroundSlot(user.orgId, body.groundId, body.slotTemplateId);
    await assertNoClash(user.orgId, body, allowOverlap);

    const createdTeams: string[] = [];
    const id = await db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as DB;
      const [b] = await tx.insert(bookings).values({ ...body, orgId: user.orgId, createdBy: user.id }).returning({ id: bookings.id });
      const seen = new Set<string>();
      for (const p of parties) {
        const team = await resolveTeam(tx, user.orgId, p);
        if (seen.has(team.id)) throw new HttpError(422, 'The same team is on this booking twice');
        seen.add(team.id);
        if (team.created) createdTeams.push(team.id);
        const amountDue = p.amountDue ?? (await quotePrice(tx, user.orgId, { ...body, teamId: team.id })).price;
        await tx.insert(bookingParties).values({ orgId: user.orgId, bookingId: b.id, teamId: team.id, side: p.side, amountDue, notes: p.notes });
      }
      return b.id;
    });
    return c.json({ ...(await getOne(user.orgId, id)), createdTeams }, 201);
  });

  /**
   * Group booking for a promoter: many slots (any grounds/dates) in one go.
   * All-or-nothing: if any slot is already taken, nothing is booked and the
   * clashes are returned so the screen can mark them.
   */
  r.post('/bulk', v('json', z.object({
    teamId: zId,
    amountDue: zMoney.optional(),            // per slot; omitted → promoter's rate (or default pricing)
    notes: z.string().nullable().optional(),
    items: z.array(z.object({
      groundId: zId, slotTemplateId: zId, date: zDate,
      allowOverlap: z.boolean().optional(),  // explicit double-book for this slot
    })).min(1).max(200),
  })), async (c) => {
    const user = c.get('user');
    const { teamId, amountDue, notes, items } = c.req.valid('json');
    await checkTeamKinds(user.orgId, 'promoter', [{ side: 'client', teamId }]);
    const [promoter] = await db.select({ id: teams.id }).from(teams).where(and(eq(teams.id, teamId), eq(teams.orgId, user.orgId), eq(teams.kind, 'promoter')));
    if (!promoter) throw new HttpError(422, 'Choose a promoter');

    const slotIds = [...new Set(items.map((i) => i.slotTemplateId))];
    const slots = await db.select().from(slotTemplates).where(and(eq(slotTemplates.orgId, user.orgId), inArray(slotTemplates.id, slotIds)));
    const slotById = new Map(slots.map((sl) => [sl.id, sl]));
    const seen = new Set<string>();
    const planned = items.map((i) => {
      const sl = slotById.get(i.slotTemplateId);
      if (!sl || sl.groundId !== i.groundId) throw new HttpError(422, 'A chosen slot does not belong to its ground');
      const k = `${i.groundId}|${i.date}|${i.slotTemplateId}`;
      if (seen.has(k)) throw new HttpError(422, 'The same slot is chosen twice');
      seen.add(k);
      return { ...i, startTime: sl.startTime, endTime: sl.endTime };
    });

    // A slot clashes if it overlaps an existing booking, or another slot in this
    // same request (e.g. Morning 8–12 and Late morning 10–2 on one day). A pair
    // is accepted once either slot of it is marked allowOverlap.
    const clashes: { groundId: string; slotTemplateId: string; date: string; reason: 'booked' | 'chosen' }[] = [];
    for (const p of planned) {
      if (p.allowOverlap) continue;
      const pick = { groundId: p.groundId, slotTemplateId: p.slotTemplateId, date: p.date };
      if ((await findClashes(db, user.orgId, p)).length) clashes.push({ ...pick, reason: 'booked' });
      else if (planned.some((o) => o !== p && !o.allowOverlap && o.groundId === p.groundId && o.date === p.date && o.startTime < p.endTime && p.startTime < o.endTime)) clashes.push({ ...pick, reason: 'chosen' });
    }
    if (clashes.length) throw new HttpError(409, `${clashes.length} of the chosen slots overlap${clashes.length === 1 ? 's' : ''} another booking. Remove ${clashes.length === 1 ? 'it' : 'them'}, or double-book on purpose.`, { clashes });

    const ids = await db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as DB;
      const out: string[] = [];
      for (const p of planned) {
        const { allowOverlap: _ignored, ...row } = p;
        const [b] = await tx.insert(bookings).values({ ...row, kind: 'match', bookedBy: 'promoter', notes: notes ?? null, orgId: user.orgId, createdBy: user.id }).returning({ id: bookings.id });
        const price = amountDue ?? (await quotePrice(tx, user.orgId, { ...row, kind: 'match', bookedBy: 'promoter', teamId })).price;
        await tx.insert(bookingParties).values({ orgId: user.orgId, bookingId: b.id, teamId, side: 'client', amountDue: price });
        out.push(b.id);
      }
      return out;
    });
    const created = await loadBookings(db, user.orgId, { ids });
    return c.json({ count: created.length, totalDue: created.reduce((t, b) => t + b.totalDue, 0), bookings: created }, 201);
  });

  r.patch('/:id', v('param', z.object({ id: zId })), v('json', updateBody), async (c) => {
    const user = c.get('user');
    const { id } = c.req.valid('param');
    const { parties, allowOverlap, ...rawPatch } = c.req.valid('json');
    const cur = await getOne(user.orgId, id);
    const next = normaliseEvent({ ...cur, ...Object.fromEntries(Object.entries(rawPatch).filter(([, x]) => x !== undefined)) } as typeof cur);
    const patch = { ...rawPatch, eventType: next.eventType, matchCount: next.matchCount };
    if (next.startTime >= next.endTime) throw new HttpError(422, 'End time must be after start time');
    await checkGroundSlot(user.orgId, next.groundId, next.slotTemplateId);
    if (next.status !== 'cancelled') {
      await assertNoClash(user.orgId, { groundId: next.groundId, date: next.date, startTime: next.startTime, endTime: next.endTime, excludeId: id }, allowOverlap);
    }
    if (parties) {
      checkParties(next.kind, next.bookedBy, parties);
      await checkTeamKinds(user.orgId, next.bookedBy, parties);
    } else if (((patch.kind && patch.kind !== cur.kind) || (patch.bookedBy && patch.bookedBy !== cur.bookedBy)) && cur.parties.length) {
      throw new HttpError(422, 'Send the updated teams when changing the booking type');
    }

    const createdTeams: string[] = [];
    await db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as DB;
      await tx.update(bookings).set({ ...patch, updatedAt: new Date() }).where(eq(bookings.id, id));
      if (!parties) return;

      const existing = new Map(cur.parties.map((p) => [p.id, p]));
      const keep = new Set(parties.filter((p) => p.id).map((p) => p.id!));
      for (const p of cur.parties) {
        if (keep.has(p.id)) continue;
        if (p.paid > 0) throw new HttpError(409, `${p.teamName} has payments on this booking; remove those payments before removing the team`);
        await tx.delete(bookingParties).where(eq(bookingParties.id, p.id));
      }
      const seen = new Set<string>();
      for (const p of parties) {
        const team = await resolveTeam(tx, user.orgId, p);
        if (seen.has(team.id)) throw new HttpError(422, 'The same team is on this booking twice');
        seen.add(team.id);
        if (team.created) createdTeams.push(team.id);
        const old = p.id ? existing.get(p.id) : undefined;
        if (p.id && !old) throw notFound('Booking team');
        if (old) {
          if (old.teamId !== team.id && old.paid > 0) throw new HttpError(409, `${old.teamName} has payments; can't swap the team`);
          await tx.update(bookingParties).set({
            teamId: team.id, side: p.side, notes: p.notes ?? old.notes,
            amountDue: p.amountDue ?? (old.teamId === team.id ? old.amountDue
              : (await quotePrice(tx, user.orgId, { ...next, teamId: team.id })).price),
          }).where(eq(bookingParties.id, old.id));
        } else {
          const amountDue = p.amountDue ?? (await quotePrice(tx, user.orgId, { ...next, teamId: team.id })).price;
          await tx.insert(bookingParties).values({ orgId: user.orgId, bookingId: id, teamId: team.id, side: p.side, amountDue, notes: p.notes });
        }
      }
    });
    return c.json({ ...(await getOne(user.orgId, id)), createdTeams });
  });

  /** Hard delete only when nothing has been paid; otherwise cancel instead. */
  r.delete('/:id', v('param', z.object({ id: zId })), async (c) => {
    const orgId = c.get('user').orgId;
    const b = await getOne(orgId, c.req.valid('param').id);
    if (b.totalPaid > 0) throw new HttpError(409, 'This booking has payments — cancel it instead of deleting');
    await db.delete(bookings).where(eq(bookings.id, b.id));
    return c.body(null, 204);
  });

  // ---- payments ----
  const paymentBody = z.object({
    bookingPartyId: zId,
    amount: z.number().int().positive(),
    paidOn: zDate.optional(),
    method: z.enum(PAYMENT_METHODS).default('upi'),
    accountId: zId.nullable().optional(),     // which account received it
    reference: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
  });

  r.post('/:id/payments', v('param', z.object({ id: zId })), v('json', paymentBody), async (c) => {
    const user = c.get('user');
    const b = await getOne(user.orgId, c.req.valid('param').id);
    const body = c.req.valid('json');
    if (!b.parties.some((p) => p.id === body.bookingPartyId)) throw new HttpError(422, 'That team is not on this booking');
    await checkAccount(user.orgId, body.accountId);
    const [row] = await db.insert(payments).values({ ...body, paidOn: body.paidOn ?? today(), orgId: user.orgId, createdBy: user.id }).returning();
    return c.json(row, 201);
  });

  async function checkAccount(orgId: string, accountId?: string | null) {
    if (!accountId) return;
    const [a] = await db.select({ id: paymentAccounts.id }).from(paymentAccounts).where(and(eq(paymentAccounts.id, accountId), eq(paymentAccounts.orgId, orgId)));
    if (!a) throw notFound('Payment account');
  }

  r.patch('/payments/:pid', v('param', z.object({ pid: zId })), v('json', paymentBody.omit({ bookingPartyId: true }).partial()), async (c) => {
    await checkAccount(c.get('user').orgId, c.req.valid('json').accountId);
    const [row] = await db.update(payments).set(c.req.valid('json'))
      .where(and(eq(payments.id, c.req.valid('param').pid), eq(payments.orgId, c.get('user').orgId))).returning();
    if (!row) throw notFound('Payment');
    return c.json(row);
  });

  r.delete('/payments/:pid', v('param', z.object({ pid: zId })), async (c) => {
    await db.delete(payments).where(and(eq(payments.id, c.req.valid('param').pid), eq(payments.orgId, c.get('user').orgId)));
    return c.body(null, 204);
  });

  /** Recent payments across all bookings (for a "payments received" list). */
  r.get('/payments/list', v('query', z.object({ from: zDate.optional(), to: zDate.optional() })), async (c) => {
    const q = c.req.valid('query');
    const conds = [eq(payments.orgId, c.get('user').orgId)];
    if (q.from) conds.push(sql`${payments.paidOn} >= ${q.from}`);
    if (q.to) conds.push(sql`${payments.paidOn} <= ${q.to}`);
    return c.json(await db.select().from(payments).where(and(...conds)).orderBy(sql`${payments.paidOn} desc`).limit(500));
  });

  return r;
}

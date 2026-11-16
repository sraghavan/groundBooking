import { and, asc, eq, gte, inArray, lte, ne, sql } from 'drizzle-orm';
import type { DB } from '../db/index.js';
import { bookingParties, bookings, grounds, cities, payments, teams } from '../db/schema.js';
import { pocsFor } from './teams.js';

export type PartyView = {
  id: string; teamId: string; teamName: string; side: 'A' | 'B' | 'client';
  /** Team names aren't unique: the team's active point of contact identifies it. */
  pocName: string | null; pocMobile: string | null;
  amountDue: number; paid: number; balance: number; notes: string | null;
};
export type BookingView = typeof bookings.$inferSelect & {
  groundName: string; cityId: string; cityName: string; parties: PartyView[];
  totalDue: number; totalPaid: number; balance: number;
};

/** Load bookings with their parties, payments and ground/city names. */
export async function loadBookings(db: DB, orgId: string, f: {
  ids?: string[]; from?: string; to?: string; groundId?: string; cityId?: string; teamId?: string; includeCancelled?: boolean;
}): Promise<BookingView[]> {
  const conds = [eq(bookings.orgId, orgId)];
  if (f.ids) conds.push(inArray(bookings.id, f.ids.length ? f.ids : ['00000000-0000-0000-0000-000000000000']));
  if (f.from) conds.push(gte(bookings.date, f.from));
  if (f.to) conds.push(lte(bookings.date, f.to));
  if (f.groundId) conds.push(eq(bookings.groundId, f.groundId));
  if (f.cityId) conds.push(eq(grounds.cityId, f.cityId));
  if (!f.includeCancelled) conds.push(ne(bookings.status, 'cancelled'));
  if (f.teamId) {
    conds.push(sql`exists (select 1 from ${bookingParties} bp where bp.booking_id = ${bookings.id} and bp.team_id = ${f.teamId})`);
  }

  const rows = await db.select({ b: bookings, groundName: grounds.name, cityId: cities.id, cityName: cities.name })
    .from(bookings)
    .innerJoin(grounds, eq(grounds.id, bookings.groundId))
    .innerJoin(cities, eq(cities.id, grounds.cityId))
    .where(and(...conds))
    .orderBy(asc(bookings.date), asc(bookings.startTime));
  if (!rows.length) return [];

  const bookingIds = rows.map((r) => r.b.id);
  const parties = await db.select({
    id: bookingParties.id, bookingId: bookingParties.bookingId, teamId: bookingParties.teamId, teamName: teams.name,
    side: bookingParties.side, amountDue: bookingParties.amountDue, notes: bookingParties.notes,
    paid: sql<number>`coalesce((select sum(${payments.amount}) from ${payments} where ${payments.bookingPartyId} = ${bookingParties.id}), 0)`.mapWith(Number),
  }).from(bookingParties)
    .innerJoin(teams, eq(teams.id, bookingParties.teamId))
    .where(inArray(bookingParties.bookingId, bookingIds));

  const pocs = await pocsFor(db, parties.map((p) => p.teamId));
  const byBooking = new Map<string, PartyView[]>();
  for (const p of parties) {
    const list = byBooking.get(p.bookingId) ?? [];
    const poc = pocs.get(p.teamId);
    list.push({ id: p.id, teamId: p.teamId, teamName: p.teamName, pocName: poc?.name ?? null, pocMobile: poc?.mobile ?? null, side: p.side, amountDue: p.amountDue, paid: p.paid, balance: p.amountDue - p.paid, notes: p.notes });
    byBooking.set(p.bookingId, list);
  }
  const sideOrder = { A: 0, B: 1, client: 2 } as const;
  return rows.map(({ b, groundName, cityId, cityName }) => {
    const ps = (byBooking.get(b.id) ?? []).sort((x, y) => sideOrder[x.side] - sideOrder[y.side]);
    const totalDue = ps.reduce((s, p) => s + p.amountDue, 0);
    const totalPaid = ps.reduce((s, p) => s + p.paid, 0);
    return { ...b, groundName, cityId, cityName, parties: ps, totalDue, totalPaid, balance: totalDue - totalPaid };
  });
}

/** Non-cancelled bookings on the same ground/date whose times overlap. */
export async function findClashes(db: DB, orgId: string, b: { groundId: string; date: string; startTime: string; endTime: string; excludeId?: string }) {
  const conds = [
    eq(bookings.orgId, orgId), eq(bookings.groundId, b.groundId), eq(bookings.date, b.date),
    ne(bookings.status, 'cancelled'),
    sql`${bookings.startTime} < ${b.endTime}`, sql`${b.startTime} < ${bookings.endTime}`,
  ];
  if (b.excludeId) conds.push(ne(bookings.id, b.excludeId));
  return db.select({ id: bookings.id, startTime: bookings.startTime, endTime: bookings.endTime }).from(bookings).where(and(...conds));
}

import { and, eq, gte, lte } from 'drizzle-orm';
import type { DB } from '../db/index.js';
import { bookingParties, bookings, cities, grounds, payments } from '../db/schema.js';
import { loadBookings } from './bookings.js';

export type Period = 'day' | 'week' | 'month' | 'quarter' | 'year' | 'all';
export type GroupBy = 'none' | 'ground' | 'city';

export type ReportRow = {
  period: string;          // bucket label, e.g. '2026-Q4', '2026-11', 'W 2026-11-09'
  groupId: string | null;
  groupName: string;
  bookings: number;        // non-cancelled bookings
  hours: number;           // hours booked
  billed: number;          // total amount due on bookings in range
  collected: number;       // paid against those bookings (any date)
  due: number;             // billed - collected
  received: number;        // cash received during the period (by payment date)
};

/** Bucket a 'YYYY-MM-DD' date. Weeks start on Monday. */
export function bucket(d: string, p: Period): string {
  const [y, m, day] = d.split('-').map(Number);
  switch (p) {
    case 'all': return 'All';
    case 'day': return d;
    case 'month': return `${y}-${String(m).padStart(2, '0')}`;
    case 'quarter': return `${y}-Q${Math.ceil(m / 3)}`;
    case 'year': return String(y);
    case 'week': {
      const dt = new Date(Date.UTC(y, m - 1, day));
      const dow = (dt.getUTCDay() + 6) % 7; // Mon=0
      dt.setUTCDate(dt.getUTCDate() - dow);
      return `W ${dt.toISOString().slice(0, 10)}`;
    }
  }
}

const hoursBetween = (s: string, e: string) => {
  const [sh, sm] = s.split(':').map(Number);
  const [eh, em] = e.split(':').map(Number);
  return Math.max(0, (eh * 60 + em - sh * 60 - sm) / 60);
};

/**
 * Bookings / billed / collected / due are on a booking-date basis; `received`
 * is cash-basis (payments whose paid_on falls in the range). Aggregated in
 * memory: volumes for a ground-booking business are small, and it keeps the
 * logic portable to non-SQL stores.
 */
export async function report(db: DB, orgId: string, q: { from: string; to: string; period: Period; groupBy: GroupBy; groundId?: string; cityId?: string }) {
  const bks = await loadBookings(db, orgId, { from: q.from, to: q.to, groundId: q.groundId, cityId: q.cityId, includeCancelled: true });

  const pConds = [eq(payments.orgId, orgId), gte(payments.paidOn, q.from), lte(payments.paidOn, q.to)];
  if (q.groundId) pConds.push(eq(bookings.groundId, q.groundId));
  if (q.cityId) pConds.push(eq(grounds.cityId, q.cityId));
  const pays = await db.select({ amount: payments.amount, paidOn: payments.paidOn, groundId: grounds.id, groundName: grounds.name, cityId: cities.id, cityName: cities.name })
    .from(payments)
    .innerJoin(bookingParties, eq(bookingParties.id, payments.bookingPartyId))
    .innerJoin(bookings, eq(bookings.id, bookingParties.bookingId))
    .innerJoin(grounds, eq(grounds.id, bookings.groundId))
    .innerJoin(cities, eq(cities.id, grounds.cityId))
    .where(and(...pConds));

  const rows = new Map<string, ReportRow>();
  const group = (x: { groundId: string; groundName: string; cityId: string; cityName: string }) =>
    q.groupBy === 'ground' ? { id: x.groundId, name: x.groundName } : q.groupBy === 'city' ? { id: x.cityId, name: x.cityName } : { id: null, name: 'All grounds' };
  const row = (period: string, g: { id: string | null; name: string }) => {
    const k = `${period}|${g.id}`;
    let r = rows.get(k);
    if (!r) { r = { period, groupId: g.id, groupName: g.name, bookings: 0, hours: 0, billed: 0, collected: 0, due: 0, received: 0 }; rows.set(k, r); }
    return r;
  };

  for (const b of bks) {
    const r = row(bucket(b.date, q.period), group(b));
    if (b.status !== 'cancelled') { r.bookings += 1; r.hours += hoursBetween(b.startTime, b.endTime); }
    r.billed += b.totalDue;
    r.collected += b.totalPaid;
    r.due += b.balance;
  }
  for (const p of pays) row(bucket(p.paidOn, q.period), group(p)).received += p.amount;

  const list = [...rows.values()].sort((a, b) => a.period.localeCompare(b.period) || a.groupName.localeCompare(b.groupName));
  const totals = list.reduce((t, r) => ({
    bookings: t.bookings + r.bookings, hours: t.hours + r.hours, billed: t.billed + r.billed,
    collected: t.collected + r.collected, due: t.due + r.due, received: t.received + r.received,
  }), { bookings: 0, hours: 0, billed: 0, collected: 0, due: 0, received: 0 });
  return { from: q.from, to: q.to, period: q.period, groupBy: q.groupBy, rows: list, totals };
}

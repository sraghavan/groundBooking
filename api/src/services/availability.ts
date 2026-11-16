import { and, asc, eq, inArray } from 'drizzle-orm';
import type { DB } from '../db/index.js';
import { cities, grounds, slotTemplates } from '../db/schema.js';
import { addDays, dayOfWeek, overlaps } from '../lib/util.js';
import { loadBookings, type BookingView } from './bookings.js';

/**
 * free    – nothing booked (green)
 * partial – a match booked with fewer than two teams (amber)
 * full    – a match with both teams, a promoter's slot, or an event (red)
 */
export type SlotState = 'free' | 'partial' | 'full';

export type SlotCell = {
  key: string;
  slotTemplateId: string | null;
  name: string | null;
  /** Actual times: the booking's times when booked (bookings may override the template). */
  startTime: string;
  endTime: string;
  defaultPrice: number | null;
  state: SlotState;
  /** Free slot whose times overlap an existing booking: booking it needs an explicit double-book. */
  overlaps?: { bookingId: string; startTime: string; endTime: string; label: string }[];
  booking: Pick<BookingView, 'id' | 'kind' | 'bookedBy' | 'title' | 'status' | 'startTime' | 'endTime' | 'balance'> & { teams: string[] } | null;
};

export type GroundDay = { date: string; slots: SlotCell[] };
export type GroundAvailability = { groundId: string; groundName: string; cityId: string; cityName: string; days: GroundDay[] };

export function bookingState(b: BookingView): SlotState {
  if (b.kind === 'event' || b.bookedBy === 'promoter') return 'full';
  return b.parties.filter((p) => p.side !== 'client').length >= 2 ? 'full' : 'partial';
}

const summarise = (b: BookingView): NonNullable<SlotCell['booking']> => ({
  id: b.id, kind: b.kind, bookedBy: b.bookedBy, title: b.title, status: b.status, startTime: b.startTime, endTime: b.endTime,
  balance: b.balance, teams: b.parties.map((p) => p.teamName),
});

type Template = typeof slotTemplates.$inferSelect;

/** "Lions vs Tigers", "Rana (promoter)", "Corporate day". */
function describe(b: BookingView): string {
  const names = b.parties.map((p) => p.teamName);
  if (b.kind === 'event') return b.title || names.join(', ') || 'Event';
  if (b.bookedBy === 'promoter') return `${names[0] ?? '?'} (promoter)`;
  return names.length ? names.join(' vs ') + (names.length === 1 ? ' vs ?' : '') : 'Booked';
}

/**
 * Merge a ground's slot templates with that day's bookings. Each booking
 * occupies the templates it overlaps (so an event spanning Morning+Afternoon
 * shows once, covering both). Templates with no overlap remain free.
 */
export function buildDay(date: string, templates: Template[], dayBookings: BookingView[]): SlotCell[] {
  const dow = dayOfWeek(date);
  const active = templates.filter((t) => t.active && t.daysOfWeek.includes(dow));
  const cells: SlotCell[] = [];
  const used = new Set<string>();

  for (const b of dayBookings) {
    // A booking made from a slot covers that slot plus any it fully spans (an event
    // over Morning + Afternoon). Overlapping alternative timings stay bookable.
    // A custom-time booking blocks every slot it overlaps.
    const covered = active.filter((t) => b.slotTemplateId
      ? t.id === b.slotTemplateId || (b.startTime <= t.startTime && t.endTime <= b.endTime)
      : overlaps(t.startTime, t.endTime, b.startTime, b.endTime));
    covered.forEach((t) => used.add(t.id));
    const names = covered.map((t) => t.name);
    cells.push({
      key: `b:${b.id}`,
      slotTemplateId: b.slotTemplateId ?? covered[0]?.id ?? null,
      name: names.length ? names.join(' + ') : null,
      startTime: b.startTime, endTime: b.endTime,
      defaultPrice: null, state: bookingState(b), booking: summarise(b),
    });
  }
  for (const t of active) {
    if (used.has(t.id)) continue;
    const clash = dayBookings.filter((b) => overlaps(t.startTime, t.endTime, b.startTime, b.endTime))
      .map((b) => ({ bookingId: b.id, startTime: b.startTime, endTime: b.endTime, label: describe(b) }));
    cells.push({
      key: `t:${t.id}`, slotTemplateId: t.id, name: t.name, startTime: t.startTime, endTime: t.endTime, defaultPrice: t.defaultPrice, state: 'free', booking: null,
      ...(clash.length ? { overlaps: clash } : {}),
    });
  }
  return cells.sort((a, b) => a.startTime.localeCompare(b.startTime) || a.endTime.localeCompare(b.endTime));
}

export async function availability(db: DB, orgId: string, q: { from: string; days: number; cityId?: string; groundId?: string }): Promise<GroundAvailability[]> {
  const to = addDays(q.from, q.days - 1);
  const gConds = [eq(grounds.orgId, orgId), eq(grounds.active, true)];
  if (q.cityId) gConds.push(eq(grounds.cityId, q.cityId));
  if (q.groundId) gConds.push(eq(grounds.id, q.groundId));
  const gs = await db.select({ id: grounds.id, name: grounds.name, cityId: cities.id, cityName: cities.name })
    .from(grounds).innerJoin(cities, eq(cities.id, grounds.cityId))
    .where(and(...gConds)).orderBy(asc(cities.name), asc(grounds.name));
  if (!gs.length) return [];

  const templates = await db.select().from(slotTemplates)
    .where(inArray(slotTemplates.groundId, gs.map((g) => g.id)))
    .orderBy(asc(slotTemplates.sortOrder), asc(slotTemplates.startTime));
  const bks = await loadBookings(db, orgId, { from: q.from, to, cityId: q.cityId, groundId: q.groundId });

  const dates = Array.from({ length: q.days }, (_, i) => addDays(q.from, i));
  return gs.map((g) => ({
    groundId: g.id, groundName: g.name, cityId: g.cityId, cityName: g.cityName,
    days: dates.map((date) => ({
      date,
      slots: buildDay(date, templates.filter((t) => t.groundId === g.id), bks.filter((b) => b.groundId === g.id && b.date === date)),
    })),
  }));
}

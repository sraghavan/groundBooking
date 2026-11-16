import { and, eq } from 'drizzle-orm';
import type { DB } from '../db/index.js';
import { DEFAULT_STANDARD_SLOTS, grounds, orgs, slotTemplates, type StandardSlot } from '../db/schema.js';

export async function standardSlots(db: DB, orgId: string): Promise<StandardSlot[]> {
  const [org] = await db.select({ s: orgs.settings }).from(orgs).where(eq(orgs.id, orgId));
  return org?.s.standardSlots?.length ? org.s.standardSlots : DEFAULT_STANDARD_SLOTS;
}

/**
 * Give every ground (or the given ones) the standard slots, all days.
 * A ground's existing slot with the same name (or the same times) is updated
 * in place so its bookings stay linked; slots not in the standard set are
 * switched off, not deleted, so past bookings keep their times.
 */
export async function applyStandardSlots(db: DB, orgId: string, opts: { groundIds?: string[]; slots?: StandardSlot[] } = {}) {
  const std = opts.slots ?? (await standardSlots(db, orgId));
  const gs = (await db.select({ id: grounds.id }).from(grounds).where(eq(grounds.orgId, orgId)))
    .filter((g) => !opts.groundIds || opts.groundIds.includes(g.id));
  let added = 0, updated = 0, switchedOff = 0;
  for (const g of gs) {
    const cur = await db.select().from(slotTemplates).where(and(eq(slotTemplates.orgId, orgId), eq(slotTemplates.groundId, g.id)));
    const used = new Set<string>();
    for (const [i, s] of std.entries()) {
      const match = cur.find((t) => !used.has(t.id) && t.name.trim().toLowerCase() === s.name.trim().toLowerCase())
        ?? cur.find((t) => !used.has(t.id) && t.startTime === s.startTime && t.endTime === s.endTime);
      const values = { name: s.name, startTime: s.startTime, endTime: s.endTime, daysOfWeek: [0, 1, 2, 3, 4, 5, 6], sortOrder: i, active: true };
      if (match) { used.add(match.id); await db.update(slotTemplates).set(values).where(eq(slotTemplates.id, match.id)); updated++; }
      else { await db.insert(slotTemplates).values({ ...values, orgId, groundId: g.id }); added++; }
    }
    for (const t of cur) {
      if (used.has(t.id) || !t.active) continue;
      await db.update(slotTemplates).set({ active: false }).where(eq(slotTemplates.id, t.id));
      switchedOff++;
    }
  }
  return { grounds: gs.length, added, updated, switchedOff };
}

import { and, eq, inArray } from 'drizzle-orm';
import type { DB } from '../db/index.js';
import { contacts, teams } from '../db/schema.js';
import { nameKey, normaliseMobile } from '../lib/util.js';
import { HttpError } from '../lib/errors.js';

type Contact = typeof contacts.$inferSelect;
export type Poc = { contactId: string; name: string; mobile: string } | null;

/** A team's active POC: the primary active contact, else the first active one. */
export function activePoc(cs: Contact[]): Poc {
  const live = cs.filter((c) => c.active);
  const c = live.find((x) => x.isPrimary) ?? live.sort((a, b) => +a.createdAt - +b.createdAt)[0];
  return c ? { contactId: c.id, name: c.name, mobile: c.mobile } : null;
}

/** Active POC for each of the given teams. */
export async function pocsFor(db: DB, teamIds: string[]): Promise<Map<string, Poc>> {
  const out = new Map<string, Poc>();
  if (!teamIds.length) return out;
  const cs = await db.select().from(contacts).where(inArray(contacts.teamId, [...new Set(teamIds)]));
  for (const id of teamIds) out.set(id, activePoc(cs.filter((c) => c.teamId === id)));
  return out;
}

/** Teams sharing a name, with their POCs, so the user can tell them apart. */
export async function sameNameTeams(db: DB, orgId: string, name: string) {
  const ts = await db.select({ id: teams.id, name: teams.name }).from(teams).where(and(eq(teams.orgId, orgId), eq(teams.nameKey, nameKey(name))));
  const pocs = await pocsFor(db, ts.map((t) => t.id));
  return ts.map((t) => ({ ...t, poc: pocs.get(t.id) ?? null }));
}

/**
 * Resolve a team reference from a booking.
 *  - teamId → that team.
 *  - teamName with no team of that name → a new team (added to the Teams list),
 *    with its first POC if `contact` is given.
 *  - teamName that matches existing team(s) → 409 listing them (with POCs),
 *    because different teams can share a name. Pass `newTeam: true` to create
 *    another team with the same name, or send the chosen teamId.
 */
export async function resolveTeam(db: DB, orgId: string, ref: {
  teamId?: string; teamName?: string; newTeam?: boolean; contact?: { name: string; mobile: string };
}): Promise<{ id: string; created: boolean }> {
  if (ref.teamId) {
    const [t] = await db.select({ id: teams.id }).from(teams).where(and(eq(teams.id, ref.teamId), eq(teams.orgId, orgId)));
    if (!t) throw new HttpError(404, 'Team not found');
    return { id: t.id, created: false };
  }
  const name = ref.teamName?.trim();
  if (!name) throw new HttpError(422, 'Team id or name is required');
  const key = nameKey(name);
  if (!key) throw new HttpError(422, 'Team name is invalid');
  if (!ref.newTeam) {
    const existing = await sameNameTeams(db, orgId, name);
    if (existing.length) {
      throw new HttpError(409, `${existing.length === 1 ? 'A team' : `${existing.length} teams`} called "${existing[0].name}" already exist${existing.length === 1 ? 's' : ''}. Pick one, or add a new team.`,
        { code: 'team_name_exists', teamName: name, teams: existing });
    }
  }
  const [t] = await db.insert(teams).values({ orgId, name, nameKey: key }).returning({ id: teams.id });
  if (ref.contact?.name.trim() && ref.contact.mobile.trim()) {
    await db.insert(contacts).values({ orgId, teamId: t.id, name: ref.contact.name.trim(), mobile: normaliseMobile(ref.contact.mobile), isPrimary: true });
  }
  return { id: t.id, created: true };
}

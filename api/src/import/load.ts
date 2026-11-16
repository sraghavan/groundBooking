/**
 * Excel import, shared by the CLI (`npm run import`) and the owner's upload screen (POST /import).
 * `prepareImport` parses only; `loadImport` replaces the business's grounds, teams and bookings.
 * Kept: users, settings, payment accounts, promoters (with their rates and contacts).
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { and, eq } from 'drizzle-orm';
import type { DB } from '../db/index.js';
import { bookingParties, bookings, cities, grounds, priceRules, reminders, slotTemplates, teams } from '../db/schema.js';
import { nameKey } from '../lib/util.js';
import { applyStandardSlots } from '../services/slots.js';
import { parseWorkbook, type ImportConfig, type ParsedImport } from './excel.js';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const defaultConfigPath = path.join(repoRoot, 'data/import-config.json');

export function readConfig(p = defaultConfigPath): ImportConfig {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

export type ImportSummary = {
  bookings: number; teams: number; grounds: number; issues: number;
  matches: number; waiting: number; promoter: number; holds: number;
  from: string | null; to: string | null; perGround: { name: string; bookings: number }[]; issueList: string[];
};

/** Parse a workbook (file path or bytes) and map whole-slot promoter holds to promoter bookings. */
export async function prepareImport(source: string | ArrayBuffer, cfg: ImportConfig, today: string): Promise<ParsedImport> {
  const wb = new ExcelJS.Workbook();
  if (typeof source === 'string') await wb.xlsx.readFile(source);
  else await wb.xlsx.load(source);
  const parsed = parseWorkbook(wb, cfg, today);
  const promoterOf = new Map<string, string>(); // team key → promoter name
  for (const p of cfg.promoters ?? []) for (const a of [p.name, ...(p.aliases ?? [])]) promoterOf.set(nameKey(a), p.name);
  for (const b of parsed.bookings) {
    if (b.kind !== 'event' || b.teams.length !== 1 || /\bboth\b/i.test(b.raw)) continue;
    const promoter = promoterOf.get(b.teams[0]);
    if (promoter) { b.kind = 'match'; b.bookedBy = 'promoter'; b.title = null; b.teams = [`promoter:${promoter}`]; }
  }
  return parsed;
}

export function summarise(p: ParsedImport): ImportSummary {
  const matches = p.bookings.filter((b) => b.kind === 'match' && b.bookedBy !== 'promoter');
  const promoter = p.bookings.filter((b) => b.bookedBy === 'promoter').length;
  const dates = p.bookings.map((b) => b.date).sort();
  return {
    bookings: p.bookings.length, teams: new Set(p.bookings.flatMap((b) => b.teams.filter((t) => !t.startsWith('promoter:')))).size,
    grounds: p.grounds.length, issues: p.issues.length,
    matches: matches.filter((b) => b.teams.length === 2).length, waiting: matches.filter((b) => b.teams.length < 2).length,
    promoter, holds: p.bookings.length - matches.length - promoter,
    from: dates[0] ?? null, to: dates.at(-1) ?? null,
    perGround: p.grounds.map((g) => ({ name: g.name, bookings: p.bookings.filter((b) => b.ground === g.name).length })),
    issueList: p.issues.slice(0, 50),
  };
}

/** Wipe and reload grounds, teams and bookings for `orgId`, in one transaction. */
export async function loadImport(db: DB, o: { orgId: string; userId: string; parsed: ParsedImport; cfg: ImportConfig; today: string }) {
  const { orgId, parsed, cfg, today } = o;
  return db.transaction(async (tx) => {
    // Bookings cascade to parties and payments; teams to contacts; grounds to slots.
    await tx.delete(bookings).where(eq(bookings.orgId, orgId));
    await tx.delete(reminders).where(eq(reminders.orgId, orgId));
    await tx.delete(priceRules).where(eq(priceRules.orgId, orgId));
    // Promoters are kept (with their contacts and rates); ordinary teams are rebuilt.
    await tx.delete(teams).where(and(eq(teams.orgId, orgId), eq(teams.kind, 'team')));
    await tx.delete(slotTemplates).where(eq(slotTemplates.orgId, orgId));
    await tx.delete(grounds).where(eq(grounds.orgId, orgId));
    await tx.delete(cities).where(eq(cities.orgId, orgId));

    const [city] = await tx.insert(cities).values({ orgId, name: cfg.city }).returning();
    const slotId = new Map<string, { id: string; start: string; end: string }>(); // `${ground}|${key}`
    const groundId = new Map<string, string>();
    for (const g of parsed.grounds) {
      const [row] = await tx.insert(grounds).values({ orgId, cityId: city.id, name: g.name, notes: 'Imported from Excel. Check slot times and prices.' }).returning();
      groundId.set(g.name, row.id);
      for (const [i, s] of g.slots.entries()) {
        const id = randomUUID();
        await tx.insert(slotTemplates).values({ id, orgId, groundId: row.id, name: s.name, startTime: s.start, endTime: s.end, daysOfWeek: s.daysOfWeek, sortOrder: i, active: s.active });
        slotId.set(`${g.name}|${s.key}`, { id, start: s.start, end: s.end });
      }
    }

    const teamId = new Map<string, string>();
    const usedKeys = new Set(parsed.bookings.flatMap((b) => b.teams));
    const teamRows = [...parsed.teams.entries()].filter(([key]) => usedKeys.has(key)).map(([key, t]) => {
      const id = randomUUID();
      teamId.set(key, id);
      return { id, orgId, name: t.name, nameKey: key, notes: t.variants.length > 1 ? `Spellings in Excel: ${t.variants.join(', ')}` : null };
    });
    for (const chunk of chunks(teamRows, 500)) await tx.insert(teams).values(chunk);
    for (const p of cfg.promoters ?? []) {
      const key = nameKey(p.name);
      let [row] = await tx.select({ id: teams.id }).from(teams).where(and(eq(teams.orgId, orgId), eq(teams.kind, 'promoter'), eq(teams.nameKey, key)));
      if (!row) [row] = await tx.insert(teams).values({ orgId, name: p.name, nameKey: key, kind: 'promoter' }).returning({ id: teams.id });
      teamId.set(`promoter:${p.name}`, row.id);
    }

    const bRows: (typeof bookings.$inferInsert)[] = [];
    const pRows: (typeof bookingParties.$inferInsert)[] = [];
    for (const b of parsed.bookings) {
      const slot = slotId.get(`${b.ground}|${b.slotKey}`)!;
      const id = randomUUID();
      bRows.push({
        id, orgId, groundId: groundId.get(b.ground)!, slotTemplateId: slot.id, date: b.date,
        startTime: slot.start, endTime: slot.end, kind: b.kind, bookedBy: b.bookedBy ?? 'direct', title: b.title,
        status: b.date < today ? 'completed' : 'confirmed',
        notes: `Imported from Excel ${b.ref}: "${b.raw}"`, createdBy: o.userId,
      });
      b.teams.forEach((k, i) => pRows.push({ orgId, bookingId: id, teamId: teamId.get(k)!, side: b.kind !== 'match' || b.bookedBy === 'promoter' ? 'client' : i === 0 ? 'A' : 'B', amountDue: 0 }));
    }
    for (const chunk of chunks(bRows, 500)) await tx.insert(bookings).values(chunk);
    for (const chunk of chunks(pRows, 500)) await tx.insert(bookingParties).values(chunk);
    // Every ground gets the standard slots (all days); other slots are switched off, bookings keep their times.
    const std = await applyStandardSlots(tx as unknown as DB, orgId);
    return { bookings: bRows.length, teams: teamRows.length, grounds: parsed.grounds.length, standardSlots: std };
  });
}

function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

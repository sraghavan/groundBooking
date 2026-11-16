/**
 * Import the legacy Excel workbook into the app database.
 *
 *   npm run import -- "data/EVENTENUERS 2024.xlsx"             # dry run: parse + report only
 *   npm run import -- "data/EVENTENUERS 2024.xlsx" --replace   # wipe grounds/teams/bookings and load the workbook
 *
 * Options: --config <path> (default data/import-config.json), --report <path> (default data/import-report.md)
 * Users and settings are kept. If the database is empty an owner is created from
 * IMPORT_OWNER_EMAIL / IMPORT_OWNER_PASSWORD (dev default: owner@example.com / password123).
 * Stop the API dev server first when using local PGlite (it allows one process at a time).
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { and, eq } from 'drizzle-orm';
import { connect } from '../db/index.js';
import { bookingParties, bookings, cities, grounds, orgs, priceRules, reminders, slotTemplates, teams, users } from '../db/schema.js';
import { hashPassword } from '../lib/auth.js';
import { nameKey, today } from '../lib/util.js';
import { parseWorkbook, type ImportConfig, type ParsedImport } from './excel.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const opt = (n: string, d: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const file = args.find((a, i) => !a.startsWith('--') && !['--config', '--report'].includes(args[i - 1] ?? ''));
if (!file) { console.error('Usage: npm run import -- <workbook.xlsx> [--replace] [--config path] [--report path]'); process.exit(1); }

const resolve = (p: string) => (path.isAbsolute(p) ? p : path.resolve(process.env.INIT_CWD ?? root, p));
const cfg: ImportConfig = JSON.parse(fs.readFileSync(resolve(opt('--config', path.join(root, 'data/import-config.json'))), 'utf8'));
const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(resolve(file));
const t0 = today();
const parsed = parseWorkbook(wb, cfg, t0);

// Whole-slot holds by a promoter (e.g. "rana") become promoter bookings.
const promoterOf = new Map<string, string>(); // team key → promoter name
for (const p of cfg.promoters ?? []) for (const a of [p.name, ...(p.aliases ?? [])]) promoterOf.set(nameKey(a), p.name);
for (const b of parsed.bookings) {
  if (b.kind !== 'event' || b.teams.length !== 1 || /\bboth\b/i.test(b.raw)) continue;
  const promoter = promoterOf.get(b.teams[0]);
  if (promoter) { b.kind = 'promoter'; b.title = null; b.teams = [`promoter:${promoter}`]; }
}

const reportPath = resolve(opt('--report', path.join(root, 'data/import-report.md')));
fs.writeFileSync(reportPath, renderReport(parsed, path.basename(file), t0));
console.log(`Parsed ${parsed.bookings.length} bookings, ${parsed.teams.size} teams, ${parsed.grounds.length} grounds; ${parsed.issues.length} issues.`);
console.log(`Report: ${path.relative(process.cwd(), reportPath)}`);

if (!flag('--replace')) {
  console.log('Dry run. Re-run with --replace to load this into the database (replaces grounds, teams and bookings).');
  process.exit(0);
}

const { db, close } = await connect();
try {
  await db.transaction(async (tx) => {
    // Org + owner
    let [owner] = await tx.select().from(users).where(eq(users.role, 'owner')).limit(1);
    let orgId = owner?.orgId;
    if (!orgId) {
      const email = process.env.IMPORT_OWNER_EMAIL ?? (process.env.NODE_ENV === 'production' ? '' : 'owner@example.com');
      const password = process.env.IMPORT_OWNER_PASSWORD ?? (process.env.NODE_ENV === 'production' ? '' : 'password123');
      if (!email || !password) throw new Error('Empty database: set IMPORT_OWNER_EMAIL and IMPORT_OWNER_PASSWORD');
      const [org] = await tx.insert(orgs).values({ name: cfg.orgName, settings: { currency: 'INR' } }).returning();
      [owner] = await tx.insert(users).values({ orgId: org.id, name: 'Owner', email, passwordHash: await hashPassword(password), role: 'owner' }).returning();
      orgId = org.id;
      console.log(`Created business "${cfg.orgName}" with owner ${email}`);
    } else {
      await tx.update(orgs).set({ name: cfg.orgName }).where(eq(orgs.id, orgId));
    }

    // Wipe business data (bookings cascade to parties and payments; teams to contacts; grounds to slots)
    await tx.delete(bookings).where(eq(bookings.orgId, orgId));
    await tx.delete(reminders).where(eq(reminders.orgId, orgId));
    await tx.delete(priceRules).where(eq(priceRules.orgId, orgId));
    // Promoters are kept (with their contacts and default rates); ordinary teams are rebuilt.
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
        startTime: slot.start, endTime: slot.end, kind: b.kind, title: b.title,
        status: b.date < t0 ? 'completed' : 'confirmed',
        notes: `Imported from Excel ${b.ref}: "${b.raw}"`, createdBy: owner.id,
      });
      b.teams.forEach((k, i) => pRows.push({ orgId, bookingId: id, teamId: teamId.get(k)!, side: b.kind !== 'match' ? 'client' : i === 0 ? 'A' : 'B', amountDue: 0 }));
    }
    for (const chunk of chunks(bRows, 500)) await tx.insert(bookings).values(chunk);
    for (const chunk of chunks(pRows, 500)) await tx.insert(bookingParties).values(chunk);
    console.log(`Imported ${bRows.length} bookings, ${teamRows.length} teams, ${parsed.grounds.length} grounds into "${cfg.orgName}".`);
  });
} finally {
  await close();
}

function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

function renderReport(p: ParsedImport, fileName: string, todayISO: string): string {
  const L: string[] = [`# Import report: ${fileName}`, '', `Generated ${todayISO}. Re-run the import after fixing \`data/import-config.json\` or the workbook.`, ''];
  const years = [...new Set(p.bookings.map((b) => b.date.slice(0, 4)))].sort();
  L.push('## Bookings per ground', '', `| Ground | ${years.join(' | ')} | Total | From | To |`, `|---|${years.map(() => '--:').join('|')}|--:|---|---|`);
  for (const g of p.grounds) {
    const bs = p.bookings.filter((b) => b.ground === g.name);
    const dates = bs.map((b) => b.date).sort();
    L.push(`| ${g.name} | ${years.map((y) => bs.filter((b) => b.date.startsWith(y)).length).join(' | ')} | ${bs.length} | ${dates[0] ?? ''} | ${dates.at(-1) ?? ''} |`);
  }
  const matches = p.bookings.filter((b) => b.kind === 'match');
  const promo = p.bookings.filter((b) => b.kind === 'promoter');
  const promoCount = new Map<string, number>();
  for (const b of promo) promoCount.set(b.teams[0].slice('promoter:'.length), (promoCount.get(b.teams[0].slice('promoter:'.length)) ?? 0) + 1);
  L.push('', `Total ${p.bookings.length}: ${matches.filter((b) => b.teams.length === 2).length} matches with both teams, ${matches.filter((b) => b.teams.length < 2).length} waiting for an opponent ("X vs"), ${promo.length} promoter slots (${[...promoCount].map(([n, c]) => `${n} ${c}`).join(', ') || 'none'}), ${p.bookings.length - matches.length - promo.length} other whole-slot holds (a single name, or "both teams").`, '');

  const dn = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
  L.push('## Slots created (times are placeholders)', '', '| Ground | Slot | Time | Days | Bookings | Last used | Shown on calendar |', '|---|---|---|---|--:|---|---|');
  for (const g of p.grounds) for (const s of g.slots) {
    L.push(`| ${g.name} | ${s.name} | ${s.start}–${s.end} | ${s.daysOfWeek.length === 7 ? 'All' : s.daysOfWeek.map((d) => dn[d]).join(' ')} | ${s.uses} | ${s.lastUsed} | ${s.active ? 'Yes' : 'No (unused in last 120 days)'} |`);
  }

  const top = [...p.teams.values()].sort((a, b) => b.uses - a.uses).slice(0, 25);
  L.push('', `## Teams: ${p.teams.size}`, '', 'Most frequent:', '', top.map((t) => `${t.name} (${t.uses})`).join(', '), '');
  const holders = new Map<string, number>();
  for (const b of p.bookings) if (b.kind === 'event') holders.set(b.title!, (holders.get(b.title!) ?? 0) + 1);
  L.push('### Whole-slot holders (single name in a cell)', '', [...holders.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([n, c]) => `${n} (${c})`).join(', '), '');
  if (p.merged.length) L.push(`### Spellings merged into one team (${p.merged.length})`, '', ...p.merged.slice(0, 60).map((m) => `- ${m.join(' / ')}`), '');

  L.push(`## Issues (${p.issues.length})`, '', ...(p.issues.length ? p.issues.slice(0, 200).map((i) => `- ${i}`) : ['None']));
  return L.join('\n') + '\n';
}

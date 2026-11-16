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
import { eq } from 'drizzle-orm';
import { connect } from '../db/index.js';
import { orgs, users } from '../db/schema.js';
import { hashPassword } from '../lib/auth.js';
import { today } from '../lib/util.js';
import type { ParsedImport } from './excel.js';
import { defaultConfigPath, loadImport, prepareImport, readConfig, repoRoot as root } from './load.js';

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const opt = (n: string, d: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const file = args.find((a, i) => !a.startsWith('--') && !['--config', '--report'].includes(args[i - 1] ?? ''));
if (!file) { console.error('Usage: npm run import -- <workbook.xlsx> [--replace] [--config path] [--report path]'); process.exit(1); }

const resolve = (p: string) => (path.isAbsolute(p) ? p : path.resolve(process.env.INIT_CWD ?? root, p));
const cfg = readConfig(resolve(opt('--config', defaultConfigPath)));
const t0 = today();
const parsed = await prepareImport(resolve(file), cfg, t0);

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
  let [owner] = await db.select().from(users).where(eq(users.role, 'owner')).limit(1);
  if (!owner) {
    const email = process.env.IMPORT_OWNER_EMAIL ?? (process.env.NODE_ENV === 'production' ? '' : 'owner@example.com');
    const password = process.env.IMPORT_OWNER_PASSWORD ?? (process.env.NODE_ENV === 'production' ? '' : 'password123');
    if (!email || !password) throw new Error('Empty database: set IMPORT_OWNER_EMAIL and IMPORT_OWNER_PASSWORD');
    const [org] = await db.insert(orgs).values({ name: cfg.orgName, settings: { currency: 'INR' } }).returning();
    [owner] = await db.insert(users).values({ orgId: org.id, name: 'Owner', email, passwordHash: await hashPassword(password), role: 'owner' }).returning();
    console.log(`Created business "${cfg.orgName}" with owner ${email}`);
  }
  const r = await loadImport(db, { orgId: owner.orgId, userId: owner.id, parsed, cfg, today: t0 });
  console.log(`Standard slots applied to ${r.standardSlots.grounds} grounds (${r.standardSlots.added} added, ${r.standardSlots.switchedOff} switched off).`);
  console.log(`Imported ${r.bookings} bookings, ${r.teams} teams, ${r.grounds} grounds.`);
} finally {
  await close();
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
  const promo = p.bookings.filter((b) => b.bookedBy === 'promoter');
  const matches = p.bookings.filter((b) => b.kind === 'match' && b.bookedBy !== 'promoter');
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

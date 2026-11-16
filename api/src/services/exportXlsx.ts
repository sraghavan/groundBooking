/**
 * Offline Excel workbook of bookings, payments and dues.
 *
 *   Summary      KPIs + by-ground and by-month tables (live formulas over the sheets below)
 *   <Ground>     one calendar per ground: date rows × slot columns, coloured like the app
 *   Bookings     flat, filterable table: one row per team on a booking (with POC + mobile)
 *   Payments     every payment received in the range
 *   Dues         who owes what today, with WhatsApp links
 *   Teams        teams active in the range with their POC and totals
 *
 * Formulas are written with their computed results so phones and previewers
 * that don't recalculate still show the numbers.
 */
import ExcelJS from 'exceljs';
import { and, asc, eq, gte, inArray, lte } from 'drizzle-orm';
import type { DB } from '../db/index.js';
import { bookingParties, bookings, cities, grounds, orgs, paymentAccounts, payments, slotTemplates, teams } from '../db/schema.js';
import { addDays, dayOfWeek, today } from '../lib/util.js';
import { bookingState, type SlotState } from './availability.js';
import { loadBookings, type BookingView } from './bookings.js';
import { teamDues } from './dues.js';
import { pocsFor } from './teams.js';

export type ExportQuery = { from: string; to: string; groundId?: string; cityId?: string };

const FONT = 'Arial';
const C = { pitch: 'FF14532D', paper: 'FFF7F5EE', line: 'FFE4E0D2', muted: 'FF6B7568', full: 'FFFBE7EA', partial: 'FFFDF1DC', free: 'FFE8F6EC', cancelled: 'FFEDEDED' };
const fill = (argb: string): ExcelJS.Fill => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const INR = '"₹"#,##0;-"₹"#,##0;"–"';
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const asDate = (d: string) => new Date(d + 'T00:00:00Z');
const fmtMobile = (m?: string | null) => { const d = (m ?? '').replace(/\D/g, ''); return d.length === 12 && d.startsWith('91') ? `${d.slice(2, 7)} ${d.slice(7)}` : (m ?? ''); };
const fmtD = (d: string) => `${Number(d.slice(8))} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
const safeSheet = (s: string, used: Set<string>) => {
  let n = s.replace(/[:\\/?*[\]]/g, ' ').slice(0, 28).trim() || 'Ground';
  while (used.has(n.toLowerCase())) n = n.slice(0, 26) + ' ' + used.size;
  used.add(n.toLowerCase());
  return n;
};

function headerRow(ws: ExcelJS.Worksheet, row: number, values: string[]) {
  const r = ws.getRow(row);
  r.values = values;
  r.height = 20;
  r.eachCell((c) => { c.font = { name: FONT, bold: true, color: { argb: 'FFFFFFFF' }, size: 10 }; c.fill = fill(C.pitch); c.alignment = { vertical: 'middle', wrapText: true }; });
}
function title(ws: ExcelJS.Worksheet, text: string, sub: string) {
  ws.getCell('A1').value = text;
  ws.getCell('A1').font = { name: FONT, bold: true, size: 14, color: { argb: C.pitch } };
  ws.getCell('A2').value = sub;
  ws.getCell('A2').font = { name: FONT, size: 9, color: { argb: C.muted } };
}
function baseFont(ws: ExcelJS.Worksheet) {
  ws.eachRow((r) => r.eachCell((c) => { if (!c.font?.name) c.font = { ...(c.font ?? {}), name: FONT, size: 10 }; }));
}

/** "Lions CC vs Tigers XI", "Lions CC vs ?" or "Acme (event)". */
const EVENT_LABEL = { half_day: 'Half day', full_day: 'Full day', tournament: 'Tournament' } as const;
function kindLabel(b: BookingView): string {
  const by = b.bookedBy === 'promoter' ? ' · promoter' : '';
  if (b.kind === 'match') return `Match${by}`;
  if (!b.eventType) return `Event${by}`;
  return `Event: ${EVENT_LABEL[b.eventType]}${b.eventType === 'tournament' && b.matchCount ? ` (${b.matchCount} matches)` : ''}${by}`;
}

function bookingLabel(b: BookingView): string {
  const names = b.parties.map((p) => p.teamName).join(', ');
  if (b.kind === 'event') return b.title || (names ? `${names}${b.bookedBy === 'promoter' ? ' (promoter)' : ''}` : 'Event');
  if (b.bookedBy === 'promoter') return `${names || '?'} (promoter)`;
  const a = b.parties.find((p) => p.side === 'A')?.teamName, bb = b.parties.find((p) => p.side === 'B')?.teamName;
  return `${a ?? '?'} vs ${bb ?? '?'}`;
}

export async function buildExport(db: DB, orgId: string, q: ExportQuery): Promise<{ buffer: Buffer; filename: string }> {
  const [org] = await db.select().from(orgs).where(eq(orgs.id, orgId));
  const gConds = [eq(grounds.orgId, orgId)];
  if (q.groundId) gConds.push(eq(grounds.id, q.groundId));
  if (q.cityId) gConds.push(eq(grounds.cityId, q.cityId));
  const gs = await db.select({ id: grounds.id, name: grounds.name, active: grounds.active, cityName: cities.name }).from(grounds)
    .innerJoin(cities, eq(cities.id, grounds.cityId)).where(and(...gConds)).orderBy(asc(cities.name), asc(grounds.name));
  const gIds = gs.map((g) => g.id);
  const tpls = gIds.length ? await db.select().from(slotTemplates).where(inArray(slotTemplates.groundId, gIds)).orderBy(asc(slotTemplates.startTime), asc(slotTemplates.sortOrder)) : [];
  const bks = (await loadBookings(db, orgId, { from: q.from, to: q.to, groundId: q.groundId, cityId: q.cityId, includeCancelled: true }));
  const pays = gIds.length ? await db.select({
    amount: payments.amount, paidOn: payments.paidOn, method: payments.method, reference: payments.reference, accountName: paymentAccounts.name,
    teamId: teams.id, teamName: teams.name, groundName: grounds.name, bookingDate: bookings.date,
  }).from(payments)
    .innerJoin(bookingParties, eq(bookingParties.id, payments.bookingPartyId))
    .innerJoin(bookings, eq(bookings.id, bookingParties.bookingId))
    .innerJoin(grounds, eq(grounds.id, bookings.groundId))
    .innerJoin(teams, eq(teams.id, bookingParties.teamId))
    .leftJoin(paymentAccounts, eq(paymentAccounts.id, payments.accountId))
    .where(and(eq(payments.orgId, orgId), gte(payments.paidOn, q.from), lte(payments.paidOn, q.to), inArray(bookings.groundId, gIds)))
    .orderBy(asc(payments.paidOn)) : [];
  const groundNames = new Set(gs.map((g) => g.name));
  const dues = (await teamDues(db, orgId)).teams.map((t) => {
    const lines = t.lines.filter((l) => groundNames.has(l.groundName));
    return { ...t, lines, balance: lines.reduce((s, l) => s + l.balance, 0) };
  }).filter((t) => t.balance > 0).sort((a, b) => b.balance - a.balance);
  const pocs = await pocsFor(db, [...new Set([...bks.flatMap((b) => b.parties.map((p) => p.teamId)), ...pays.map((p) => p.teamId)])]);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Ground Booking';
  wb.created = new Date();
  const scope = q.groundId ? gs[0]?.name ?? 'Ground' : q.cityId ? `${gs[0]?.cityName ?? 'City'} (all grounds)` : 'All grounds';
  const rangeText = `${fmtD(q.from)} – ${fmtD(q.to)} · ${scope} · generated ${fmtD(today())}`;

  const summary = wb.addWorksheet('Summary', { properties: { tabColor: { argb: C.pitch } } });
  const used = new Set(['summary', 'bookings', 'payments', 'dues', 'teams']);

  // ---------- Calendars ----------
  const days = Math.round((+asDate(q.to) - +asDate(q.from)) / 864e5) + 1;
  const calendars = days <= 400;
  if (calendars) {
    for (const g of gs) {
      const gb = bks.filter((b) => b.groundId === g.id);
      const cols = tpls.filter((t) => t.groundId === g.id && (t.active || gb.some((b) => b.slotTemplateId === t.id)));
      const colOf = (b: BookingView) => (b.slotTemplateId && cols.some((t) => t.id === b.slotTemplateId) ? b.slotTemplateId : 'other');
      const hasOther = gb.some((b) => colOf(b) === 'other');
      const keys = [...cols.map((t) => t.id), ...(hasOther ? ['other'] : [])];
      if (!gb.length && (!g.active || !cols.length)) continue;

      const ws = wb.addWorksheet(safeSheet(g.name, used), { views: [{ state: 'frozen', xSplit: 2, ySplit: 3 }] });
      title(ws, `${g.name} · ${g.cityName}`, `${fmtD(q.from)} – ${fmtD(q.to)}. Red = both teams / whole slot, amber = waiting for an opponent, grey = cancelled. Tap a cell for team contacts.`);
      headerRow(ws, 3, ['Date', 'Day', ...cols.map((t) => `${t.name}\n${t.startTime}–${t.endTime}`), ...(hasOther ? ['Other times'] : [])]);
      ws.getRow(3).height = 30;
      ws.getColumn(1).width = 12; ws.getColumn(2).width = 6;
      keys.forEach((_, i) => { ws.getColumn(3 + i).width = 26; });

      for (let i = 0, d = q.from; d <= q.to; i++, d = addDays(d, 1)) {
        const r = ws.getRow(4 + i);
        const dow = dayOfWeek(d);
        r.getCell(1).value = asDate(d); r.getCell(1).numFmt = 'dd-mmm-yy';
        r.getCell(2).value = DAYS[dow];
        const weekend = dow === 0 || dow === 6;
        for (const c of [1, 2]) {
          r.getCell(c).font = { name: FONT, size: 10, bold: weekend };
          if (weekend) r.getCell(c).fill = fill(C.paper);
          if (d.endsWith('-01')) r.getCell(c).border = { top: { style: 'medium', color: { argb: C.pitch } } };
        }
        const dayB = gb.filter((b) => b.date === d);
        keys.forEach((k, ci) => {
          const cell = r.getCell(3 + ci);
          if (d.endsWith('-01')) cell.border = { top: { style: 'medium', color: { argb: C.pitch } } };
          const here = dayB.filter((b) => colOf(b) === k);
          if (!here.length) return;
          const live = here.filter((b) => b.status !== 'cancelled');
          const state: SlotState | 'cancelled' = live.length ? (live.some((b) => bookingState(b) === 'full') ? 'full' : 'partial') : 'cancelled';
          cell.value = here.map((b) => {
            let s = (k === 'other' ? `${b.startTime}–${b.endTime} ` : '') + bookingLabel(b);
            if (b.status === 'cancelled') s = `CANCELLED: ${s}`;
            if (b.balance > 0 && b.date <= today()) s += ` (₹${b.balance.toLocaleString('en-IN')} due)`;
            return s;
          }).join('\n+ ');
          cell.fill = fill(state === 'full' ? C.full : state === 'partial' ? C.partial : C.cancelled);
          cell.alignment = { wrapText: true, vertical: 'top' };
          cell.font = { name: FONT, size: 10, strike: state === 'cancelled' };
          const note = here.flatMap((b) => b.parties.map((p) => `${p.teamName}: ${p.pocName ? `${p.pocName} ${fmtMobile(p.pocMobile)}` : 'no contact'}`));
          if (note.length) cell.note = note.join('\n');
        });
      }
    }
  }

  // ---------- Bookings (one row per team on a booking) ----------
  const bws = wb.addWorksheet('Bookings', { views: [{ state: 'frozen', ySplit: 1, xSplit: 1 }] });
  const bCols = [
    ['Date', 11], ['Day', 6], ['Month', 9], ['Ground', 14], ['City', 11], ['Slot', 13], ['Start', 7], ['End', 7], ['Type', 14],
    ['Team', 22], ['POC', 16], ['Mobile', 13], ['Opponent', 22], ['Status', 10], ['Amount', 10], ['Paid', 10], ['Balance', 10], ['Bookings', 9], ['Notes', 40],
  ] as const;
  const statusLabel = { confirmed: 'Upcoming', completed: 'Played', partial: 'Part played', cancelled: 'Cancelled' } as const;
  const tplName = new Map(tpls.map((t) => [t.id, t.name]));
  const bRows: unknown[][] = [];
  for (const b of bks) {
    const rows = b.parties.length ? b.parties : [null];
    rows.forEach((p, i) => {
      const opp = b.kind === 'match' ? b.parties.find((x) => x !== p && x.side !== 'client')?.teamName ?? '' : '';
      bRows.push([
        asDate(b.date), DAYS[dayOfWeek(b.date)], b.date.slice(0, 7), b.groundName, b.cityName,
        b.slotTemplateId ? tplName.get(b.slotTemplateId) ?? '' : 'Custom', b.startTime, b.endTime, kindLabel(b),
        p?.teamName ?? '', p?.pocName ?? '', fmtMobile(p?.pocMobile), opp, statusLabel[b.status],
        p?.amountDue ?? 0, p?.paid ?? 0, p?.balance ?? 0, i === 0 && b.status !== 'cancelled' ? 1 : 0, b.notes ?? '',
      ]);
    });
  }
  bws.addTable({
    name: 'Bookings', ref: 'A1', headerRow: true, style: { theme: 'TableStyleLight9', showRowStripes: true },
    columns: bCols.map(([name]) => ({ name, filterButton: true })),
    rows: bRows.length ? bRows : [bCols.map(() => '')],
  });
  bCols.forEach(([, w], i) => { bws.getColumn(i + 1).width = w; });
  bws.getColumn(1).numFmt = 'dd-mmm-yy';
  for (const c of [15, 16, 17]) bws.getColumn(c).numFmt = INR;
  const nB = Math.max(bRows.length, 1) + 1; // last data row

  // ---------- Payments ----------
  const pws = wb.addWorksheet('Payments', { views: [{ state: 'frozen', ySplit: 1 }] });
  const pCols = [['Paid on', 11], ['Month', 9], ['Team', 22], ['POC', 16], ['Mobile', 13], ['Ground', 14], ['Booking date', 12], ['Amount', 10], ['Method', 8], ['Reference', 18], ['Account', 16]] as const;
  const pRows = pays.map((p) => {
    const poc = pocs.get(p.teamId);
    return [asDate(p.paidOn), p.paidOn.slice(0, 7), p.teamName, poc?.name ?? '', fmtMobile(poc?.mobile), p.groundName, asDate(p.bookingDate), p.amount, p.method.toUpperCase(), p.reference ?? '', p.accountName ?? ''];
  });
  pws.addTable({ name: 'Payments', ref: 'A1', headerRow: true, style: { theme: 'TableStyleLight9', showRowStripes: true }, columns: pCols.map(([name]) => ({ name, filterButton: true })), rows: pRows.length ? pRows : [pCols.map(() => '')] });
  pCols.forEach(([, w], i) => { pws.getColumn(i + 1).width = w; });
  pws.getColumn(1).numFmt = 'dd-mmm-yy'; pws.getColumn(7).numFmt = 'dd-mmm-yy'; pws.getColumn(8).numFmt = INR;
  const nP = Math.max(pRows.length, 1) + 1;

  // ---------- Dues ----------
  const dws = wb.addWorksheet('Dues', { views: [{ state: 'frozen', ySplit: 3 }] });
  title(dws, 'Payments due', `As of ${fmtD(today())} · ${scope}. Tap WhatsApp to open a chat with the POC.`);
  headerRow(dws, 3, ['Team', 'POC', 'Mobile', 'WhatsApp', 'Unpaid bookings', 'Oldest unpaid', 'Balance']);
  dues.forEach((t, i) => {
    const poc = t.contacts.find((c) => c.isPrimary) ?? t.contacts[0];
    const r = dws.getRow(4 + i);
    const oldest = t.lines.reduce((m, l) => (l.date < m ? l.date : m), t.lines[0].date);
    r.values = [t.teamName, poc?.name ?? 'No contact', fmtMobile(poc?.mobile), '', t.lines.length, asDate(oldest), t.balance];
    if (poc) r.getCell(4).value = { text: 'WhatsApp', hyperlink: poc.whatsappUrl };
    r.getCell(4).font = { name: FONT, size: 10, color: { argb: 'FF1F9D55' }, underline: true };
    r.getCell(6).numFmt = 'dd-mmm-yy'; r.getCell(7).numFmt = INR;
    if (!poc) r.getCell(2).font = { name: FONT, size: 10, color: { argb: 'FFB45309' } };
  });
  const dTot = dws.getRow(4 + dues.length);
  dTot.getCell(1).value = 'Total';
  dTot.getCell(7).value = { formula: dues.length ? `SUM(G4:G${3 + dues.length})` : '0', result: dues.reduce((s, t) => s + t.balance, 0) };
  dTot.getCell(7).numFmt = INR;
  dTot.eachCell((c) => { c.font = { name: FONT, size: 10, bold: true }; c.border = { top: { style: 'thin' } }; });
  [24, 16, 13, 11, 10, 12, 12].forEach((w, i) => { dws.getColumn(i + 1).width = w; });

  // ---------- Teams ----------
  const tws = wb.addWorksheet('Teams', { views: [{ state: 'frozen', ySplit: 1 }] });
  const tAgg = new Map<string, { name: string; n: number; billed: number; paid: number; balance: number }>();
  for (const b of bks) for (const p of b.parties) {
    const a = tAgg.get(p.teamId) ?? { name: p.teamName, n: 0, billed: 0, paid: 0, balance: 0 };
    if (b.status !== 'cancelled') a.n++;
    a.billed += p.amountDue; a.paid += p.paid; a.balance += p.balance;
    tAgg.set(p.teamId, a);
  }
  const tRows = [...tAgg.entries()].sort((x, y) => y[1].n - x[1].n || x[1].name.localeCompare(y[1].name)).map(([id, a]) => {
    const poc = pocs.get(id);
    return [a.name, poc?.name ?? 'No contact', fmtMobile(poc?.mobile), a.n, a.billed, a.paid, a.balance];
  });
  tws.addTable({ name: 'Teams', ref: 'A1', headerRow: true, style: { theme: 'TableStyleLight9', showRowStripes: true }, columns: ['Team', 'POC', 'Mobile', 'Bookings', 'Billed', 'Paid', 'Balance'].map((name) => ({ name, filterButton: true })), rows: tRows.length ? tRows : [['', '', '', 0, 0, 0, 0]] });
  [24, 16, 13, 10, 11, 11, 11].forEach((w, i) => { tws.getColumn(i + 1).width = w; });
  for (const c of [5, 6, 7]) tws.getColumn(c).numFmt = INR;

  // ---------- Summary (formulas over Bookings / Payments) ----------
  title(summary, `${org?.name ?? 'Bookings'}: bookings report`, rangeText);
  const live = bks.filter((b) => b.status !== 'cancelled');
  const sumOf = (f: (b: BookingView) => number) => bks.reduce((s, b) => s + f(b), 0);
  const BK = (col: string) => `Bookings!$${col}$2:$${col}$${nB}`;
  const kpis: [string, string, number][] = [
    ['Bookings', `SUM(${BK('R')})`, live.length],
    ['Billed', `SUM(${BK('O')})`, sumOf((b) => b.totalDue)],
    ['Collected', `SUM(${BK('P')})`, sumOf((b) => b.totalPaid)],
    ['Balance due', `SUM(${BK('Q')})`, sumOf((b) => b.balance)],
    ['Received in period', `SUM(Payments!$H$2:$H$${nP})`, pays.reduce((s, p) => s + p.amount, 0)],
  ];
  kpis.forEach(([label, formula, result], i) => {
    const l = summary.getCell(4, 1 + i), v = summary.getCell(5, 1 + i);
    l.value = label; l.font = { name: FONT, size: 9, bold: true, color: { argb: C.muted } };
    v.value = { formula, result }; v.font = { name: FONT, size: 16, bold: true, color: { argb: i === 3 && result > 0 ? 'FFB42339' : 'FF1B2A1F' } };
    if (i > 0) v.numFmt = INR;
    for (const c of [l, v]) { c.fill = fill(C.paper); c.border = { left: { style: 'thin', color: { argb: C.line } } }; }
  });

  let row = 8;
  summary.getCell(row, 1).value = 'By ground'; summary.getCell(row, 1).font = { name: FONT, bold: true, size: 12, color: { argb: C.pitch } };
  headerRow(summary, row + 1, ['Ground', 'Bookings', 'Billed', 'Collected', 'Balance due']);
  gs.forEach((g, i) => {
    const r = row + 2 + i, gbk = bks.filter((b) => b.groundId === g.id);
    summary.getCell(r, 1).value = g.name;
    ([['R', gbk.filter((b) => b.status !== 'cancelled').length], ['O', gbk.reduce((s, b) => s + b.totalDue, 0)], ['P', gbk.reduce((s, b) => s + b.totalPaid, 0)], ['Q', gbk.reduce((s, b) => s + b.balance, 0)]] as const)
      .forEach(([col, result], j) => {
        const c = summary.getCell(r, 2 + j);
        c.value = { formula: `SUMIFS(${BK(col)},${BK('D')},$A${r})`, result };
        if (j > 0) c.numFmt = INR;
      });
  });
  row += 2 + gs.length;
  const totR = summary.getRow(row);
  totR.getCell(1).value = 'Total';
  for (let j = 0; j < 4; j++) {
    const col = String.fromCharCode(66 + j);
    totR.getCell(2 + j).value = { formula: gs.length ? `SUM(${col}${row - gs.length}:${col}${row - 1})` : '0', result: Number((kpis[j][2])) };
    if (j > 0) totR.getCell(2 + j).numFmt = INR;
  }
  totR.eachCell((c) => { c.font = { name: FONT, size: 10, bold: true }; c.border = { top: { style: 'thin' } }; });

  // Bookings per month per ground (up to 24 months)
  const months: string[] = [];
  for (let m = q.from.slice(0, 7); m <= q.to.slice(0, 7) && months.length < 24;) {
    months.push(m);
    const [y, mm] = m.split('-').map(Number);
    m = mm === 12 ? `${y + 1}-01` : `${y}-${String(mm + 1).padStart(2, '0')}`;
  }
  if (months.length > 1) {
    row += 3;
    summary.getCell(row, 1).value = 'Bookings per month'; summary.getCell(row, 1).font = { name: FONT, bold: true, size: 12, color: { argb: C.pitch } };
    headerRow(summary, row + 1, ['Ground', ...months]); // 'YYYY-MM' headers double as the SUMIFS key
    gs.forEach((g, i) => {
      const r = row + 2 + i;
      summary.getCell(r, 1).value = g.name;
      months.forEach((m, j) => {
        const colL = summary.getColumn(2 + j).letter;
        summary.getCell(r, 2 + j).value = {
          formula: `SUMIFS(${BK('R')},${BK('D')},$A${r},${BK('C')},${colL}$${row + 1})`,
          result: live.filter((b) => b.groundId === g.id && b.date.startsWith(m)).length,
        };
      });
    });
  }

  row += 3 + gs.length;
  summary.getCell(row, 1).value = 'How to use';
  summary.getCell(row, 1).font = { name: FONT, bold: true, size: 12, color: { argb: C.pitch } };
  [
    calendars ? 'One tab per ground shows the calendar like the old sheet: red = both teams or the whole slot, amber = waiting for an opponent, grey = cancelled. Tap a cell to see each team’s POC and mobile.' : 'Calendars are skipped for ranges over 400 days; pick a shorter range for them.',
    '“Bookings” has one row per team on a booking, with filters on every column. Use it to find a team, a ground, or anything unpaid.',
    '“Dues” lists who owes money today, with a WhatsApp link to each POC.',
    'Team names can repeat, so every list shows the team’s POC and mobile to tell them apart.',
    'The numbers on this tab are formulas over the Bookings and Payments tabs, so they update if you filter or edit rows there.',
  ].forEach((t, i) => { const c = summary.getCell(row + 1 + i, 1); c.value = `• ${t}`; c.font = { name: FONT, size: 10 }; });

  summary.getColumn(1).width = 22;
  for (let i = 2; i <= Math.max(6, months.length + 1); i++) summary.getColumn(i).width = 14;
  summary.views = [{ showGridLines: false }];
  wb.worksheets.forEach(baseFont);
  // Summary first, calendars next, then the data tabs.
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  const slug = (q.groundId ? gs[0]?.name : q.cityId ? gs[0]?.cityName : 'all')?.replace(/[^a-z0-9]+/gi, '-').toLowerCase() ?? 'all';
  return { buffer, filename: `bookings_${slug}_${q.from}_${q.to}.xlsx` };
}

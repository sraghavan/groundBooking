/**
 * Parses the friend's legacy booking workbook (one sheet per ground, a grid of
 * date rows × slot columns with "Team A vs Team B" typed into each cell) into
 * clean records the app can store.
 *
 * Cell conventions found in the workbook:
 *   "A vs B"            → match, two teams (full / red)
 *   "A vs " / " vs B"   → match, one team waiting for an opponent (partial / amber)
 *   "A both teams"      → A has the whole slot (event, full)
 *   "rana"              → a single name with no "vs": that person holds the whole slot (event, full)
 *
 * Dates are either real Excel dates in the date column, or "12 Sat" / 12 style
 * day numbers under month-title rows ("JANUARY", "Sept"). For the latter the
 * month rolls over when the day number resets, and the weekday word is checked.
 */
import type ExcelJS from 'exceljs';
import { addDays, dayOfWeek, nameKey } from '../lib/util.js';

export type SlotDef = { name: string; start: string; end: string };
export type ImportConfig = {
  orgName: string;
  city: string;
  slots: Record<string, SlotDef>;
  grounds: { name: string; sources: { sheet: string; dateCol: string; startYear?: number; columns: Record<string, string> }[] }[];
  /** Whole-slot holds by these names become promoter bookings (aliases = other spellings in the sheet). */
  promoters?: { name: string; aliases?: string[] }[];
};

export type ParsedBooking = {
  ground: string; slotKey: string; date: string;
  kind: 'match' | 'event' | 'promoter'; title: string | null;
  teams: string[];             // team name keys (canonical), 0–2
  ref: string; raw: string;    // e.g. "Royale!B23", original cell text
};
export type ParsedSlot = SlotDef & { key: string; uses: number; lastUsed: string; active: boolean; daysOfWeek: number[] };
export type ParsedImport = {
  grounds: { name: string; slots: ParsedSlot[] }[];
  bookings: ParsedBooking[];
  teams: Map<string, { name: string; uses: number; variants: string[] }>; // by canonical key
  issues: string[];
  merged: string[][];          // groups of name variants merged into one team
};

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const pad = (n: number) => String(n).padStart(2, '0');
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/** Plain text of any ExcelJS cell value (rich text, formulas, hyperlinks). */
export function cellText(v: ExcelJS.CellValue): string {
  if (v == null) return '';
  if (v instanceof Date) return '';
  if (typeof v === 'object') {
    if ('richText' in v) return v.richText.map((r) => r.text).join('');
    if ('text' in v) return String(v.text);
    if ('result' in v) return v.result instanceof Date ? '' : String(v.result ?? '');
    return '';
  }
  return String(v);
}
const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

/** "SEPT" / "February " → 1-12; anything else → null. */
function monthTitle(s: string): number | null {
  const t = clean(s).toLowerCase().replace(/\s*\d{4}$/, '');
  if (!/^[a-z]{3,}$/.test(t)) return null;
  const i = MONTHS.findIndex((m) => m.startsWith(t));
  return i >= 0 ? i + 1 : null;
}

/** Split a cell into its booking meaning. Exported for tests. */
export function parseCell(text: string): { kind: 'match'; teams: string[] } | { kind: 'event'; holder: string; both: boolean } | null {
  let t = clean(text);
  if (!t || /^slot \d/i.test(t) || /^\d+(\.\d+)?$/.test(t)) return null;
  const both = /\bboth(\s+teams?)?\s*$/i.test(t);
  t = t.replace(/\bboth(\s+teams?)?\s*$/i, '').trim();
  const tidy = (s: string) => clean(s).replace(/^[\s.,\-–]+|[\s.,\-–]+$/g, '');
  const parts = t.split(/(?:^|\s)(?:vs|v\/s|versus)\.?(?:\s|$)/i);
  if (parts.length >= 2) {
    const teams = parts.map(tidy).filter(Boolean).slice(0, 2);
    if (!teams.length) return null;
    if (both && teams.length === 1) return { kind: 'event', holder: teams[0], both: true };
    return { kind: 'match', teams };
  }
  const holder = tidy(t);
  return holder ? { kind: 'event', holder, both } : null;
}

/** "msp united" → "MSP United", "micc" → "MICC", "sadhooz" → "Sadhooz". Mixed-case input is kept. */
export function prettyName(s: string): string {
  if (s !== s.toLowerCase()) return s;
  return s.split(' ').map((w) => {
    const acronym = /^(xi|ii|iii)$/.test(w) || /\d/.test(w) && w.length <= 4
      || /^[a-z]{1,5}$/.test(w) && (/^[^aeiou]+$/.test(w) || /cc$/.test(w));
    return acronym ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1);
  }).join(' ');
}
/** Looser than nameKey so "Sparkle"/"sparkles" and "royal king"/"Royal Kings" merge. */
const looseKey = (s: string) => nameKey(s).replace(/\s+/g, '').replace(/s$/, '');

export function parseWorkbook(wb: ExcelJS.Workbook, cfg: ImportConfig, todayISO: string): ParsedImport {
  const issues: string[] = [];
  const raw: (Omit<ParsedBooking, 'teams'> & { names: string[] })[] = [];

  for (const g of cfg.grounds) {
    for (const src of g.sources) {
      const ws = wb.getWorksheet(src.sheet);
      if (!ws) { issues.push(`Sheet "${src.sheet}" not found`); continue; }
      const dateColNo = ws.getColumn(src.dateCol).number;
      let y: number | null = src.startYear ?? null, m: number | null = null, lastDay = 0;

      for (let r = 1; r <= ws.rowCount; r++) {
        const row = ws.getRow(r);
        const a = row.getCell(dateColNo).value;
        const title = monthTitle(cellText(a)) ?? (a == null ? monthTitle(cellText(row.getCell(dateColNo + 1).value)) : null);
        if (title) {
          if (m != null && y != null && title < m) y++;
          m = title; lastDay = 0;
          continue;
        }

        let date: string | null = null;
        if (a instanceof Date) {
          const isHeader = Object.keys(src.columns).some((c) => row.getCell(c).value instanceof Date);
          y = a.getUTCFullYear(); m = a.getUTCMonth() + 1;
          if (isHeader) { lastDay = 0; continue; }
          lastDay = a.getUTCDate();
          date = iso(y, m, lastDay);
        } else {
          const txt = clean(cellText(a));
          const mt = /^(\d{1,2})(?:\.0)?\b\s*([a-z]*)/i.exec(txt);
          if (!mt) continue;
          if (y == null || m == null) { issues.push(`${src.sheet}!${src.dateCol}${r}: day "${txt}" before any month/year`); continue; }
          const d = Number(mt[1]);
          if (d < lastDay) { m++; if (m > 12) { m = 1; y++; } }
          lastDay = d;
          date = iso(y, m, d);
          if (addDays(date, 0) !== date) { issues.push(`${src.sheet}!${src.dateCol}${r}: invalid date ${date}`); continue; }
          const wd = mt[2].toLowerCase().slice(0, 3);
          if (wd && DAYS.includes(wd) && DAYS.indexOf(wd) !== dayOfWeek(date)) {
            issues.push(`${src.sheet}!${src.dateCol}${r}: "${txt}" but ${date} is a ${DAYS[dayOfWeek(date)]}`);
          }
        }

        for (const [col, slotKey] of Object.entries(src.columns)) {
          const text = cellText(row.getCell(col).value);
          const p = parseCell(text);
          if (!p) continue;
          const ref = `${src.sheet.trim()}!${col}${r}`;
          if (p.kind === 'match') raw.push({ ground: g.name, slotKey, date, kind: 'match', title: null, names: p.teams, ref, raw: clean(text) });
          else raw.push({ ground: g.name, slotKey, date, kind: 'event', title: null, names: [p.holder], ref, raw: clean(text) });
        }
      }
    }
  }

  // ---- Teams: group spelling variants, pick a display name -------------------
  const byLoose = new Map<string, Map<string, number>>(); // looseKey → original spelling → count
  for (const b of raw) for (const n of b.names) {
    const lk = looseKey(n);
    if (!lk) continue;
    const m = byLoose.get(lk) ?? new Map();
    m.set(n, (m.get(n) ?? 0) + 1);
    byLoose.set(lk, m);
  }
  const teams = new Map<string, { name: string; uses: number; variants: string[] }>();
  const canonical = new Map<string, string>(); // looseKey → nameKey of display name
  const merged: string[][] = [];
  for (const [lk, spellings] of byLoose) {
    const sorted = [...spellings.entries()].sort((x, y) => y[1] - x[1] || (x[0] === x[0].toLowerCase() ? 1 : -1));
    const name = prettyName(sorted[0][0]);
    const key = nameKey(name);
    canonical.set(lk, key);
    const keys = new Set(sorted.map(([s]) => nameKey(s)));
    if (keys.size > 1) merged.push([...keys]);
    teams.set(key, { name, uses: sorted.reduce((s, [, c]) => s + c, 0), variants: sorted.map(([s]) => s) });
  }

  const bookings: ParsedBooking[] = raw.map(({ names, ...b }) => {
    const keys = names.map((n) => canonical.get(looseKey(n))!).filter(Boolean);
    const display = keys.map((k) => teams.get(k)!.name);
    const both = b.kind === 'event' && /\bboth\b/i.test(b.raw);
    return { ...b, teams: keys, title: b.kind === 'event' ? `${display[0]}${both ? ' (both teams)' : ''}` : null };
  });

  // ---- Slots per ground: which columns are still in use, and on which days ----
  const recentFrom = addDays(todayISO, -120);
  const yearFrom = addDays(todayISO, -365);
  const grounds = cfg.grounds.map((g) => {
    const keys = [...new Set(g.sources.flatMap((s) => Object.values(s.columns)))];
    const slots: ParsedSlot[] = [];
    for (const key of keys) {
      const def = cfg.slots[key];
      if (!def) { issues.push(`Ground ${g.name}: unknown slot key "${key}"`); continue; }
      const uses = bookings.filter((b) => b.ground === g.name && b.slotKey === key);
      if (!uses.length) continue;
      const lastUsed = uses.reduce((mx, b) => (b.date > mx ? b.date : mx), '');
      const recent = uses.filter((b) => b.date >= yearFrom);
      const weekend = recent.filter((b) => [0, 6].includes(dayOfWeek(b.date))).length;
      const share = recent.length >= 8 ? weekend / recent.length : 0.5;
      const daysOfWeek = share >= 0.9 ? [0, 6] : share <= 0.1 ? [1, 2, 3, 4, 5] : [0, 1, 2, 3, 4, 5, 6];
      slots.push({ key, ...def, uses: uses.length, lastUsed, active: lastUsed >= recentFrom, daysOfWeek });
    }
    slots.sort((a, b) => a.start.localeCompare(b.start));
    return { name: g.name, slots };
  });

  return { grounds, bookings, teams, issues, merged };
}

import { z } from 'zod';

export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const zTime = z.string().regex(TIME_RE, 'Use HH:MM (24h)');
export const zDate = z.string().regex(DATE_RE, 'Use YYYY-MM-DD');
export const zMoney = z.number().int().min(0);
export const zId = z.uuid();

/** Normalise a team name for duplicate detection: "  Lions C.C. " -> "lions cc" */
export function nameKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

/** Normalise an Indian mobile number to E.164 (+91XXXXXXXXXX). Other formats are kept if they start with +. */
export function normaliseMobile(raw: string, defaultCountry = '91'): string {
  const digits = raw.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return '+' + digits.slice(1).replace(/\D/g, '');
  const d = digits.replace(/\D/g, '').replace(/^0+/, '');
  if (d.length === 10) return `+${defaultCountry}${d}`;
  if (d.length === 12 && d.startsWith(defaultCountry)) return `+${d}`;
  return `+${d}`;
}

/** Do two [start,end) time ranges overlap? Times are 'HH:MM' and compare lexically. */
export const overlaps = (aStart: string, aEnd: string, bStart: string, bEnd: string) => aStart < bEnd && bStart < aEnd;

/** Day of week (0=Sun) for a 'YYYY-MM-DD' string, independent of server timezone. */
export function dayOfWeek(d: string): number {
  const [y, m, day] = d.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, day)).getUTCDay();
}

export function addDays(d: string, n: number): string {
  const [y, m, day] = d.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, day + n));
  return dt.toISOString().slice(0, 10);
}

/** Today's date in IST (or the given IANA zone). */
export function today(tz = 'Asia/Kolkata'): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

export const formatINR = (n: number) => '₹' + n.toLocaleString('en-IN');

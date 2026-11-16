// Dates are 'YYYY-MM-DD' strings in local (IST) time.
const pad = (n: number) => String(n).padStart(2, '0');
export const toISO = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parseISO = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const todayISO = () => toISO(new Date());
export const addDays = (s: string, n: number) => { const d = parseISO(s); d.setDate(d.getDate() + n); return toISO(d); };

export const fmtDay = (s: string) => parseISO(s).toLocaleDateString('en-IN', { weekday: 'short' });
export const fmtDate = (s: string, opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' }) => parseISO(s).toLocaleDateString('en-IN', opts);
export const fmtLong = (s: string) => parseISO(s).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

/** '07:30' → '7:30a' */
export function fmtTime(t: string) {
  const [h, m] = t.split(':').map(Number);
  const suffix = h >= 12 && h < 24 ? 'p' : 'a';
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh}${m ? ':' + pad(m) : ''}${suffix}`;
}
export const fmtRange = (s: string, e: string) => `${fmtTime(s)}–${fmtTime(e)}`;

export const inr = (n: number) => '₹' + Math.round(n).toLocaleString('en-IN');

export function startOfWeek(s: string) { const d = parseISO(s); const dow = (d.getDay() + 6) % 7; d.setDate(d.getDate() - dow); return toISO(d); }
export function startOfMonth(s: string) { return s.slice(0, 8) + '01'; }
export function startOfQuarter(s: string) { const [y, m] = s.split('-').map(Number); return `${y}-${pad(Math.floor((m - 1) / 3) * 3 + 1)}-01`; }
export function startOfYear(s: string) { return s.slice(0, 4) + '-01-01'; }
export function endOfMonth(s: string) { const d = parseISO(startOfMonth(s)); d.setMonth(d.getMonth() + 1); d.setDate(0); return toISO(d); }

export function timeAgo(iso: string) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

/** '+919876543210' → '98765 43210' (Indian numbers); other numbers unchanged. */
export function fmtMobile(m: string | null | undefined): string {
  if (!m) return '';
  const d = m.replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) return `${d.slice(2, 7)} ${d.slice(7)}`;
  return m;
}
/** "Ravi Kumar · 98765 43210" — how a team's point of contact is shown everywhere. */
export const pocLine = (name?: string | null, mobile?: string | null) =>
  name ? `${name}${mobile ? ` · ${fmtMobile(mobile)}` : ''}` : 'No contact yet';

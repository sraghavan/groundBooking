// Thin typed client for the JSON API (/api/v1). The same API will back the native app later.

const BASE = (import.meta.env.VITE_API_URL ?? '') + '/api/v1';
const TOKEN_KEY = 'gb_token';

export const auth = {
  get token() { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } },
  set(t: string | null) { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } },
};

export class ApiError extends Error {
  constructor(public status: number, message: string, public details?: unknown) { super(message); }
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(BASE + path, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', ...(auth.token ? { authorization: `Bearer ${auth.token}` } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && auth.token) {
    auth.set(null);
    window.location.href = '/login';
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`, data?.details);
  return data as T;
}

export async function downloadFile(path: string, filename: string) {
  const res = await fetch(BASE + path, { headers: auth.token ? { authorization: `Bearer ${auth.token}` } : {} });
  if (!res.ok) throw new ApiError(res.status, 'Download failed');
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  a.click();
  URL.revokeObjectURL(url);
}

// ---------- types ----------
export type Role = 'owner' | 'partner';
export type User = { id: string; name: string; email: string | null; mobile: string | null; role: Role; active: boolean };
export type EventPrices = { halfDay?: number | null; fullDay?: number | null; tournamentPerMatch?: number | null };
export const DEFAULT_TOURNAMENT_PER_MATCH = 15000;
export type StandardSlot = { name: string; startTime: string; endTime: string };
export type OrgSettings = {
  standardSlots?: StandardSlot[]; upiId?: string; reminderTemplate?: string; currency?: string; eventPrices?: EventPrices };
export type Me = { user: User; org: { id: string; name: string; settings: OrgSettings } };

export type City = { id: string; name: string };
export type SlotTemplate = {
  id: string; groundId: string; name: string; startTime: string; endTime: string;
  defaultPrice: number | null; daysOfWeek: number[]; sortOrder: number; active: boolean;
};
export type Ground = {
  id: string; name: string; cityId: string; cityName: string; defaultPrice: number | null;
  address: string | null; notes: string | null; active: boolean; slots: SlotTemplate[];
};

export type Contact = { id: string; teamId: string; name: string; mobile: string; isPrimary: boolean; active: boolean };
/** Team names aren't unique: the active POC (name + mobile) tells same-named teams apart. */
export type Poc = { contactId: string; name: string; mobile: string } | null;
export type TeamKind = 'team' | 'promoter';
export type Team = { id: string; name: string; kind?: TeamKind; defaultRate?: number | null; rateHalfDay?: number | null; rateFullDay?: number | null; notes: string | null; active: boolean; bookingCount: number; contacts: Contact[]; poc: Poc };
export type SameNameTeam = { id: string; name: string; poc: Poc };

export type BookingKind = 'match' | 'event';
/** direct = 2 teams (match) or the client (event); promoter = a promoter holds the slot. */
export type BookedBy = 'direct' | 'promoter';
export type EventType = 'half_day' | 'full_day' | 'tournament';
export const EVENT_LABEL: Record<EventType, string> = { half_day: 'Half day', full_day: 'Full day', tournament: 'Tournament' };
export type BookingStatus = 'confirmed' | 'completed' | 'partial' | 'cancelled';
export type Side = 'A' | 'B' | 'client';
export type Party = { id: string; teamId: string; teamName: string; pocName: string | null; pocMobile: string | null; side: Side; amountDue: number; paid: number; balance: number; notes: string | null };
export type Payment = { id: string; bookingPartyId: string; amount: number; paidOn: string; method: 'upi' | 'cash' | 'bank' | 'other'; accountId: string | null; reference: string | null; notes: string | null };
export type PaymentAccount = {
  id: string; name: string; upiId: string | null; holderName: string | null; details: string | null;
  isDefault: boolean; active: boolean; hasQr: boolean; qrUrl: string | null;
};
export type Booking = {
  id: string; groundId: string; groundName: string; cityId: string; cityName: string; slotTemplateId: string | null;
  date: string; startTime: string; endTime: string; kind: BookingKind; bookedBy: BookedBy; eventType: EventType | null; matchCount: number | null; title: string | null; status: BookingStatus; notes: string | null;
  parties: Party[]; totalDue: number; totalPaid: number; balance: number; payments?: Payment[]; createdTeams?: string[];
};

export type SlotState = 'free' | 'partial' | 'full';
export type SlotCell = {
  key: string; slotTemplateId: string | null; name: string | null; startTime: string; endTime: string; defaultPrice: number | null; state: SlotState;
  /** Free, but its times overlap a booking: booking it needs an explicit double-book. */
  overlaps?: { bookingId: string; startTime: string; endTime: string; label: string }[];
  booking: { id: string; kind: BookingKind; bookedBy: BookedBy; title: string | null; status: BookingStatus; startTime: string; endTime: string; balance: number; teams: string[] } | null;
};
export type GroundAvailability = { groundId: string; groundName: string; cityId: string; cityName: string; days: { date: string; slots: SlotCell[] }[] };

export type DueLine = { bookingId: string; bookingPartyId: string; date: string; groundName: string; startTime: string; endTime: string; status: BookingStatus; amountDue: number; paid: number; balance: number };
export type TeamDue = { teamId: string; teamName: string; teamKind: TeamKind; balance: number; lines: DueLine[]; lastRemindedAt: string | null; contacts: { id: string; name: string; mobile: string; isPrimary: boolean; whatsappUrl: string }[] };

export type PayTo = { accountId: string; name: string; upiId: string | null; qrUrl: string | null };
export type DuesResponse = { total: number; teams: TeamDue[]; payTo: PayTo | null };
export type PriceRule = { id: string; teamKind: TeamKind | null; teamId: string | null; groundId: string | null; slotTemplateId: string | null; price: number; notes: string | null; teamName: string | null; groundName: string | null; slotName: string | null };
export type Quote = { price: number; source: 'rule' | 'slot' | 'ground' | 'none' | 'promoter' | 'event'; note?: string };

export type ReportRow = { period: string; groupId: string | null; groupName: string; bookings: number; hours: number; billed: number; collected: number; due: number; received: number };
export type Report = { from: string; to: string; period: string; groupBy: string; rows: ReportRow[]; totals: Omit<ReportRow, 'period' | 'groupId' | 'groupName'> };

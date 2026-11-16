import { and, desc, eq, inArray } from 'drizzle-orm';
import type { DB } from '../db/index.js';
import { contacts, orgs, paymentAccounts, reminders, teams } from '../db/schema.js';
import { defaultAccount, qrPath } from '../routes/accounts.js';
import { formatINR, today } from '../lib/util.js';
import { loadBookings } from './bookings.js';

export type DueLine = { bookingId: string; bookingPartyId: string; date: string; groundName: string; startTime: string; endTime: string; status: string; amountDue: number; paid: number; balance: number };
export type TeamDue = {
  teamId: string; teamName: string; teamKind: 'team' | 'promoter'; balance: number; lines: DueLine[];
  contacts: { id: string; name: string; mobile: string; isPrimary: boolean; whatsappUrl: string }[];
  lastRemindedAt: string | null;
};

export const DEFAULT_TEMPLATE =
  'Hi {contact}, this is a reminder from {org}. {team} has {amount} pending:\n{details}\n{upi}Thank you!';

const fmtDate = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** Where to pay, as shown in a reminder. qrUrl must be absolute for WhatsApp to link it. */
export type PayTo = { name: string; upiId: string | null; qrUrl: string | null };

export function payToText(p?: PayTo | null): string {
  if (!p) return '';
  const out = [];
  if (p.upiId) out.push(`Pay via UPI: ${p.upiId}${p.name ? ` (${p.name})` : ''}`);
  else if (p.name) out.push(`Pay to: ${p.name}`);
  if (p.qrUrl) out.push(`Scan to pay: ${p.qrUrl}`);
  return out.length ? out.join('\n') + '\n' : '';
}

export function renderReminder(tpl: string, v: { contact: string; team: string; amount: number; lines: DueLine[]; payTo?: PayTo | null; org: string }): string {
  const details = v.lines.map((l) => `• ${fmtDate(l.date)} ${l.groundName} (${l.startTime}–${l.endTime}): ${formatINR(l.balance)}`).join('\n');
  return tpl
    .replaceAll('{contact}', v.contact)
    .replaceAll('{team}', v.team)
    .replaceAll('{amount}', formatINR(v.amount))
    .replaceAll('{details}', details)
    .replaceAll('{org}', v.org)
    .replaceAll('{upi}', payToText(v.payTo));
}

/** wa.me click-to-chat link; opens WhatsApp with the message pre-filled. */
export const whatsappUrl = (mobile: string, text: string) => `https://wa.me/${mobile.replace(/\D/g, '')}?text=${encodeURIComponent(text)}`;

/**
 * Outstanding balances per team. By default only bookings up to today count
 * (future bookings aren't "due" yet). Cancelled bookings count only if a
 * cancellation charge was left on them.
 */
export async function teamDues(db: DB, orgId: string, opts: { upTo?: string; teamId?: string; accountId?: string; baseUrl?: string } = {}): Promise<{ teams: TeamDue[]; payTo: (PayTo & { accountId: string }) | null }> {
  const acct = opts.accountId
    ? (await db.select().from(paymentAccounts).where(and(eq(paymentAccounts.id, opts.accountId), eq(paymentAccounts.orgId, orgId))))[0]
    : await defaultAccount(db, orgId);
  const base = (opts.baseUrl ?? '').replace(/\/+$/, '');
  const payTo = acct ? { accountId: acct.id, name: acct.name, upiId: acct.upiId, qrUrl: acct.qrImage ? base + qrPath(acct.id) : null } : null;
  return { teams: await duesList(db, orgId, opts, payTo), payTo };
}

async function duesList(db: DB, orgId: string, opts: { upTo?: string; teamId?: string }, payTo: PayTo | null): Promise<TeamDue[]> {
  const upTo = opts.upTo ?? today();
  const bks = await loadBookings(db, orgId, { to: upTo, teamId: opts.teamId, includeCancelled: true });
  const byTeam = new Map<string, TeamDue>();
  for (const b of bks) {
    for (const p of b.parties) {
      if (p.balance <= 0 || (opts.teamId && p.teamId !== opts.teamId)) continue;
      const t = byTeam.get(p.teamId) ?? { teamId: p.teamId, teamName: p.teamName, teamKind: 'team' as const, balance: 0, lines: [], contacts: [], lastRemindedAt: null };
      t.balance += p.balance;
      t.lines.push({ bookingId: b.id, bookingPartyId: p.id, date: b.date, groundName: b.groundName, startTime: b.startTime, endTime: b.endTime, status: b.status, amountDue: p.amountDue, paid: p.paid, balance: p.balance });
      byTeam.set(p.teamId, t);
    }
  }
  const list = [...byTeam.values()];
  if (!list.length) return [];

  const teamIds = list.map((t) => t.teamId);
  const [org] = await db.select().from(orgs).where(eq(orgs.id, orgId));
  const settings = org?.settings ?? {};
  const kinds = new Map((await db.select({ id: teams.id, kind: teams.kind }).from(teams).where(inArray(teams.id, teamIds))).map((t) => [t.id, t.kind]));
  const cs = await db.select().from(contacts).where(and(eq(contacts.orgId, orgId), inArray(contacts.teamId, teamIds)));
  const rs = await db.select({ teamId: reminders.teamId, at: reminders.createdAt }).from(reminders)
    .where(and(eq(reminders.orgId, orgId), inArray(reminders.teamId, teamIds))).orderBy(desc(reminders.createdAt));

  for (const t of list) {
    const last = rs.find((r) => r.teamId === t.teamId);
    t.teamKind = kinds.get(t.teamId) ?? 'team';
    t.lastRemindedAt = last ? last.at.toISOString() : null;
    t.contacts = cs.filter((c) => c.teamId === t.teamId && c.active)
      .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary))
      .map((c) => ({
        id: c.id, name: c.name, mobile: c.mobile, isPrimary: c.isPrimary,
        whatsappUrl: whatsappUrl(c.mobile, renderReminder(settings.reminderTemplate || DEFAULT_TEMPLATE, {
          contact: c.name.split(' ')[0], team: t.teamName, amount: t.balance, lines: t.lines, payTo, org: org?.name ?? '',
        })),
      }));
  }
  return list.sort((a, b) => b.balance - a.balance);
}

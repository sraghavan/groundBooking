import { and, eq } from 'drizzle-orm';
import type { DB } from '../db/index.js';
import { DEFAULT_EVENT_PRICES, grounds, orgs, priceRules, slotTemplates, teams, type EVENT_TYPES } from '../db/schema.js';

export type PriceSource = 'rule' | 'slot' | 'ground' | 'none' | 'promoter' | 'event';
export type Quote = { price: number; source: PriceSource; ruleId?: string; note?: string };
export type QuoteQuery = {
  teamId?: string | null; groundId: string; slotTemplateId?: string | null;
  kind?: 'match' | 'event'; bookedBy?: 'direct' | 'promoter'; eventType?: (typeof EVENT_TYPES)[number] | null; matchCount?: number | null;
};

type Rule = { id: string; teamId: string | null; groundId: string | null; slotTemplateId: string | null; price: number; createdAt: Date };

/**
 * Pick the most specific matching rule. A rule matches when each of its
 * non-null fields equals the request (null = "any"). A team-specific deal
 * beats any generic rate, so weights are team 4, slot 2, ground 1; ties go to
 * the newest rule.
 */
export function pickRule(rules: Rule[], q: { teamId?: string | null; groundId?: string | null; slotTemplateId?: string | null }): Rule | undefined {
  let best: Rule | undefined;
  let bestScore = -1;
  for (const r of rules) {
    if (r.teamId && r.teamId !== q.teamId) continue;
    if (r.groundId && r.groundId !== q.groundId) continue;
    if (r.slotTemplateId && r.slotTemplateId !== q.slotTemplateId) continue;
    const score = (r.teamId ? 4 : 0) + (r.slotTemplateId ? 2 : 0) + (r.groundId ? 1 : 0);
    if (score > bestScore || (score === bestScore && best && r.createdAt > best.createdAt)) {
      best = r;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Default per-team price for a booking. Resolution order:
 *   matching price rule (team/ground/slot, most specific wins)
 *   → slot template default → ground default → 0
 * The UI pre-fills this and the user may override it on the booking.
 */
export async function quotePrice(db: DB, orgId: string, q: QuoteQuery): Promise<Quote> {
  if (q.bookedBy === 'promoter') {
    const own = await promoterRate(db, orgId, q);
    if (own) return own;
  }
  if (q.kind === 'event' && q.eventType) {
    const ev = await eventQuote(db, orgId, q.eventType, q.matchCount);
    if (ev) return ev;
  }
  if (q.bookedBy === 'promoter') {
    const base = await teamQuote(db, orgId, { ...q, teamId: null });
    return { ...base, price: base.price * 2, note: 'Two teams’ price (no promoter rate set)' };
  }
  return teamQuote(db, orgId, q);
}

/** Event defaults from Settings → event prices. Tournament = per-match price × matches. */
async function eventQuote(db: DB, orgId: string, type: (typeof EVENT_TYPES)[number], matchCount?: number | null): Promise<Quote | null> {
  const [org] = await db.select({ s: orgs.settings }).from(orgs).where(eq(orgs.id, orgId));
  const p = { ...DEFAULT_EVENT_PRICES, ...org?.s.eventPrices };
  if (type === 'tournament') {
    if (p.tournamentPerMatch == null) return null;
    const n = Math.max(1, matchCount ?? 1);
    return { price: p.tournamentPerMatch * n, source: 'event', note: `${n} × ₹${p.tournamentPerMatch.toLocaleString('en-IN')} per match` };
  }
  const price = type === 'half_day' ? p.halfDay : p.fullDay;
  return price == null ? null : { price, source: 'event' };
}

/**
 * A promoter's standard rate, the same at every ground: per match (a whole slot),
 * half day, or full day. Tournaments use the event per-match price.
 * Returns null when the promoter has no rate for this, so the event default or
 * two teams' price applies instead.
 */
async function promoterRate(db: DB, orgId: string, q: QuoteQuery): Promise<Quote | null> {
  if (!q.teamId) return null;
  const [t] = await db.select({ match: teams.defaultRate, half: teams.rateHalfDay, full: teams.rateFullDay })
    .from(teams).where(and(eq(teams.id, q.teamId), eq(teams.orgId, orgId)));
  if (!t) return null;
  const rate = q.kind === 'event'
    ? q.eventType === 'half_day' ? t.half : q.eventType === 'full_day' ? t.full : null
    : t.match;
  return rate == null ? null : { price: rate, source: 'promoter' };
}

async function teamQuote(db: DB, orgId: string, q: QuoteQuery): Promise<Quote> {
  const rules = await db.select().from(priceRules).where(eq(priceRules.orgId, orgId));
  const rule = pickRule(rules, q);
  if (rule) return { price: rule.price, source: 'rule', ruleId: rule.id };

  if (q.slotTemplateId) {
    const [slot] = await db.select({ p: slotTemplates.defaultPrice }).from(slotTemplates)
      .where(and(eq(slotTemplates.id, q.slotTemplateId), eq(slotTemplates.orgId, orgId)));
    if (slot?.p != null) return { price: slot.p, source: 'slot' };
  }
  const [g] = await db.select({ p: grounds.defaultPrice }).from(grounds)
    .where(and(eq(grounds.id, q.groundId), eq(grounds.orgId, orgId)));
  if (g?.p != null) return { price: g.p, source: 'ground' };
  return { price: 0, source: 'none' };
}

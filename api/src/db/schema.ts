/**
 * Data model. Every business table carries `org_id` so the app can become a
 * multi-tenant platform (other booking agents) without a data migration.
 *
 * Money is stored as whole rupees (integer). Dates are 'YYYY-MM-DD' strings and
 * times are 'HH:MM' strings in the org's local time (IST) — no timezone maths.
 */
import { sql } from 'drizzle-orm';
import {
  pgTable, uuid, text, integer, boolean, timestamp, date, jsonb, uniqueIndex, index,
} from 'drizzle-orm/pg-core';

const id = () => uuid('id').primaryKey().defaultRandom();
const orgId = () => uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' });
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

/** Default event prices (whole ground). Tournament is charged per match played. */
export type EventPrices = { halfDay?: number | null; fullDay?: number | null; tournamentPerMatch?: number | null };
export const DEFAULT_EVENT_PRICES: Required<EventPrices> = { halfDay: null, fullDay: null, tournamentPerMatch: 15000 };

/** Standard slot timings used by every ground (editable in Admin → Grounds). */
export type StandardSlot = { name: string; startTime: string; endTime: string };
export const DEFAULT_STANDARD_SLOTS: StandardSlot[] = [
  { name: 'Morning', startTime: '08:00', endTime: '12:00' },
  { name: 'Late morning', startTime: '10:00', endTime: '14:00' },
  { name: 'Second', startTime: '12:00', endTime: '16:00' },
  { name: 'Day-night', startTime: '16:00', endTime: '20:00' },
  { name: 'Evening', startTime: '18:00', endTime: '22:00' },
  { name: 'Night', startTime: '20:00', endTime: '24:00' },
];

export type OrgSettings = {
  standardSlots?: StandardSlot[];
  currency?: string;          // 'INR'
  upiId?: string;             // legacy: moved to payment_accounts (migration 0002)
  reminderTemplate?: string;  // supports {contact} {team} {amount} {details} {upi} {org}
  eventPrices?: EventPrices;
};

export const orgs = pgTable('orgs', {
  id: id(),
  name: text('name').notNull(),
  settings: jsonb('settings').$type<OrgSettings>().notNull().default({}),
  createdAt: createdAt(),
});

export const users = pgTable('users', {
  id: id(),
  orgId: orgId(),
  name: text('name').notNull(),
  email: text('email'),                     // null until logins are set up for this user
  mobile: text('mobile'),
  passwordHash: text('password_hash'),      // null = can't sign in yet
  role: text('role', { enum: ['owner', 'partner'] }).notNull().default('partner'),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('users_email_uq').on(t.email)]);

export const cities = pgTable('cities', {
  id: id(),
  orgId: orgId(),
  name: text('name').notNull(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('cities_org_name_uq').on(t.orgId, t.name)]);

export const grounds = pgTable('grounds', {
  id: id(),
  orgId: orgId(),
  cityId: uuid('city_id').notNull().references(() => cities.id),
  name: text('name').notNull(),
  defaultPrice: integer('default_price'),   // per team, fallback when no slot/rule price
  address: text('address'),
  notes: text('notes'),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
}, (t) => [index('grounds_org_idx').on(t.orgId)]);

/** Default slots offered at a ground. Bookings copy and may override the times. */
export const slotTemplates = pgTable('slot_templates', {
  id: id(),
  orgId: orgId(),
  groundId: uuid('ground_id').notNull().references(() => grounds.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),             // e.g. "Morning"
  startTime: text('start_time').notNull(),  // 'HH:MM'
  endTime: text('end_time').notNull(),
  defaultPrice: integer('default_price'),   // per team
  daysOfWeek: integer('days_of_week').array().notNull().default(sql`'{0,1,2,3,4,5,6}'`), // 0=Sun
  sortOrder: integer('sort_order').notNull().default(0),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
}, (t) => [index('slot_templates_ground_idx').on(t.groundId)]);

/**
 * 'team' plays matches. 'promoter' (e.g. Rana) takes a whole slot at their own
 * discounted rate and fills it themselves. Promoters reuse teams so contacts,
 * dues, payments and reminders work the same way.
 */
export const TEAM_KINDS = ['team', 'promoter'] as const;

export const teams = pgTable('teams', {
  id: id(),
  orgId: orgId(),
  name: text('name').notNull(),
  nameKey: text('name_key').notNull(),      // normalised name, for search and duplicate warnings
  kind: text('kind', { enum: TEAM_KINDS }).notNull().default('team'),
  // Promoter standard rates, the same at every ground:
  defaultRate: integer('default_rate'),     // per match (a whole slot)
  rateHalfDay: integer('rate_half_day'),    // half-day event
  rateFullDay: integer('rate_full_day'),    // full-day event
  notes: text('notes'),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
}, (t) => [index('teams_org_key_idx').on(t.orgId, t.nameKey)]);  // NOT unique: different teams can share a name

/**
 * Team points of contact. Team names are not unique, so a team is identified by
 * its name plus its active POC: the primary active contact (else the first active).
 */
export const contacts = pgTable('contacts', {
  id: id(),
  orgId: orgId(),
  teamId: uuid('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  mobile: text('mobile').notNull(),         // E.164, e.g. +919876543210
  isPrimary: boolean('is_primary').notNull().default(false),
  active: boolean('active').notNull().default(true), // false = former POC, kept for history
  createdAt: createdAt(),
}, (t) => [index('contacts_team_idx').on(t.teamId)]);

/**
 * Per-team price defaults. Any of team/ground/slot may be null (= "any").
 * The most specific matching rule wins; see services/pricing.ts.
 */
export const priceRules = pgTable('price_rules', {
  id: id(),
  orgId: orgId(),
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }),
  groundId: uuid('ground_id').references(() => grounds.id, { onDelete: 'cascade' }),
  slotTemplateId: uuid('slot_template_id').references(() => slotTemplates.id, { onDelete: 'cascade' }),
  price: integer('price').notNull(),
  notes: text('notes'),
  createdAt: createdAt(),
});

/** What the booking is: a match, or an event (half/full day or tournament). */
export const BOOKING_KINDS = ['match', 'event'] as const;
/** Who holds it. direct: 2 teams (match) or the client (event) · promoter: a promoter holds the whole slot. */
export const BOOKED_BY = ['direct', 'promoter'] as const;
export const EVENT_TYPES = ['half_day', 'full_day', 'tournament'] as const;
/** confirmed → upcoming; completed → played in full; partial → not completed (reduced charge); cancelled */
export const BOOKING_STATUSES = ['confirmed', 'completed', 'partial', 'cancelled'] as const;

export const bookings = pgTable('bookings', {
  id: id(),
  orgId: orgId(),
  groundId: uuid('ground_id').notNull().references(() => grounds.id),
  slotTemplateId: uuid('slot_template_id').references(() => slotTemplates.id, { onDelete: 'set null' }),
  date: date('date', { mode: 'string' }).notNull(),
  startTime: text('start_time').notNull(),
  endTime: text('end_time').notNull(),
  kind: text('kind', { enum: BOOKING_KINDS }).notNull().default('match'),
  bookedBy: text('booked_by', { enum: BOOKED_BY }).notNull().default('direct'),
  eventType: text('event_type', { enum: EVENT_TYPES }),   // events only; null on imported/older events
  matchCount: integer('match_count'),                     // tournaments: number of matches (priced per match)
  title: text('title'),
  status: text('status', { enum: BOOKING_STATUSES }).notNull().default('confirmed'),
  notes: text('notes'),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('bookings_org_date_idx').on(t.orgId, t.date), index('bookings_ground_date_idx').on(t.groundId, t.date)]);

/** A team on a booking, with what that team owes for it. */
export const bookingParties = pgTable('booking_parties', {
  id: id(),
  orgId: orgId(),
  bookingId: uuid('booking_id').notNull().references(() => bookings.id, { onDelete: 'cascade' }),
  teamId: uuid('team_id').notNull().references(() => teams.id),
  side: text('side', { enum: ['A', 'B', 'client'] }).notNull(),
  amountDue: integer('amount_due').notNull().default(0),
  notes: text('notes'),
  createdAt: createdAt(),
}, (t) => [index('booking_parties_booking_idx').on(t.bookingId), index('booking_parties_team_idx').on(t.teamId)]);

export const PAYMENT_METHODS = ['upi', 'cash', 'bank', 'other'] as const;

/** Accounts that receive payments (several UPI IDs / banks). The QR is sent in reminders. */
export const paymentAccounts = pgTable('payment_accounts', {
  id: id(),
  orgId: orgId(),
  name: text('name').notNull(),             // e.g. "Rahul HDFC"
  upiId: text('upi_id'),
  holderName: text('holder_name'),
  details: text('details'),                 // bank account / IFSC etc., free text
  qrImage: text('qr_image'),                // data: URL of the UPI QR image
  isDefault: boolean('is_default').notNull().default(false),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
}, (t) => [index('payment_accounts_org_idx').on(t.orgId)]);

export const payments = pgTable('payments', {
  id: id(),
  orgId: orgId(),
  bookingPartyId: uuid('booking_party_id').notNull().references(() => bookingParties.id, { onDelete: 'cascade' }),
  amount: integer('amount').notNull(),
  paidOn: date('paid_on', { mode: 'string' }).notNull(),
  method: text('method', { enum: PAYMENT_METHODS }).notNull().default('upi'),
  accountId: uuid('account_id').references(() => paymentAccounts.id, { onDelete: 'set null' }),
  reference: text('reference'),
  notes: text('notes'),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
}, (t) => [index('payments_party_idx').on(t.bookingPartyId), index('payments_org_paid_idx').on(t.orgId, t.paidOn)]);

export const reminders = pgTable('reminders', {
  id: id(),
  orgId: orgId(),
  teamId: uuid('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
  contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
  amount: integer('amount').notNull(),
  channel: text('channel').notNull().default('whatsapp_link'),
  sentBy: uuid('sent_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
});

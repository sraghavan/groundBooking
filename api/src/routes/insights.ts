import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import type { DB } from '../db/index.js';
import { contacts, reminders, teams } from '../db/schema.js';
import type { AppEnv } from '../lib/auth.js';
import { HttpError, notFound } from '../lib/errors.js';
import { v } from '../lib/validate.js';
import { today, zDate, zId } from '../lib/util.js';
import { availability } from '../services/availability.js';
import { teamDues } from '../services/dues.js';
import { report } from '../services/reports.js';
import { buildExport } from '../services/exportXlsx.js';

export function availabilityRoutes(db: DB) {
  const r = new Hono<AppEnv>();
  /** Grounds × days × slots with free/partial/full state. */
  r.get('/', v('query', z.object({
    from: zDate.optional(), days: z.coerce.number().int().min(1).max(31).default(1),
    cityId: zId.optional(), groundId: zId.optional(),
  })), async (c) => {
    const q = c.req.valid('query');
    return c.json(await availability(db, c.get('user').orgId, { ...q, from: q.from ?? today() }));
  });
  return r;
}

/** Origin for links in messages: PUBLIC_URL if set, else the origin the app was opened on. */
function publicBaseUrl(req: Request): string {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL;
  const origin = req.headers.get('origin');
  if (origin) return origin;
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  const proto = req.headers.get('x-forwarded-proto') ?? new URL(req.url).protocol.replace(':', '');
  return host ? `${proto}://${host}` : '';
}

export function duesRoutes(db: DB) {
  const r = new Hono<AppEnv>();

  r.get('/', v('query', z.object({ upTo: zDate.optional(), teamId: zId.optional(), accountId: zId.optional() })), async (c) => {
    const { teams: list, payTo } = await teamDues(db, c.get('user').orgId, { ...c.req.valid('query'), baseUrl: publicBaseUrl(c.req.raw) });
    return c.json({ total: list.reduce((s, t) => s + t.balance, 0), teams: list, payTo });
  });

  /** Record that a reminder was sent (the app opens the WhatsApp link itself). */
  r.post('/reminders', v('json', z.object({ teamId: zId, contactId: zId.optional(), amount: z.number().int().min(0) })), async (c) => {
    const user = c.get('user');
    const body = c.req.valid('json');
    const [t] = await db.select({ id: teams.id }).from(teams).where(and(eq(teams.id, body.teamId), eq(teams.orgId, user.orgId)));
    if (!t) throw notFound('Team');
    if (body.contactId) {
      const [ct] = await db.select({ id: contacts.id }).from(contacts).where(and(eq(contacts.id, body.contactId), eq(contacts.teamId, body.teamId)));
      if (!ct) throw new HttpError(422, 'Contact is not on this team');
    }
    const [row] = await db.insert(reminders).values({ ...body, orgId: user.orgId, sentBy: user.id }).returning();
    return c.json(row, 201);
  });

  return r;
}

const reportQuery = z.object({
  from: zDate, to: zDate,
  period: z.enum(['day', 'week', 'month', 'quarter', 'year', 'all']).default('all'),
  groupBy: z.enum(['none', 'ground', 'city']).default('none'),
  groundId: zId.optional(), cityId: zId.optional(),
}).refine((q) => q.from <= q.to, { message: '"from" must be on or before "to"', path: ['from'] });

export function reportRoutes(db: DB) {
  const r = new Hono<AppEnv>();
  r.get('/', v('query', reportQuery), async (c) => c.json(await report(db, c.get('user').orgId, c.req.valid('query'))));

  r.get('/csv', v('query', reportQuery), async (c) => {
    const rep = await report(db, c.get('user').orgId, c.req.valid('query'));
    const header = ['Period', 'Group', 'Bookings', 'Hours', 'Billed', 'Collected', 'Due', 'Received in period'];
    const esc = (s: string | number) => `"${String(s).replaceAll('"', '""')}"`;
    const lines = [header, ...rep.rows.map((x) => [x.period, x.groupName, x.bookings, x.hours, x.billed, x.collected, x.due, x.received])]
      .map((row) => row.map(esc).join(','));
    c.header('content-type', 'text/csv; charset=utf-8');
    c.header('content-disposition', `attachment; filename="report_${rep.from}_${rep.to}.csv"`);
    return c.body(lines.join('\n'));
  });
  return r;
}

/** Excel workbook for offline viewing: GET /export/xlsx?from&to&groundId&cityId */
export function exportRoutes(db: DB) {
  const r = new Hono<AppEnv>();
  r.get('/xlsx', v('query', z.object({ from: zDate, to: zDate, groundId: zId.optional(), cityId: zId.optional() })
    .refine((q) => q.from <= q.to, { message: '"from" must be on or before "to"', path: ['from'] })), async (c) => {
    const { buffer, filename } = await buildExport(db, c.get('user').orgId, c.req.valid('query'));
    c.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    c.header('content-disposition', `attachment; filename="${filename}"`);
    return c.body(new Uint8Array(buffer));
  });
  return r;
}

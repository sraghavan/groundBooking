import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import type { DB } from './db/index.js';
import { requireAuth, type AppEnv } from './lib/auth.js';
import { HttpError } from './lib/errors.js';
import { authRoutes, settingsRoutes, userRoutes } from './routes/auth.js';
import { cityRoutes, groundRoutes } from './routes/grounds.js';
import { teamRoutes } from './routes/teams.js';
import { pricingRoutes } from './routes/pricing.js';
import { bookingRoutes } from './routes/bookings.js';
import { accountRoutes, publicRoutes } from './routes/accounts.js';
import { availabilityRoutes, duesRoutes, exportRoutes, reportRoutes } from './routes/insights.js';
import { importRoutes } from './routes/import.js';

/** Builds the JSON API. All routes live under /api/v1. */
export function createApi(db: DB, opts: { log?: boolean } = {}) {
  const api = new Hono<AppEnv>();
  if (opts.log) api.use(logger());
  api.use(cors({ origin: (o) => o ?? '*', allowHeaders: ['authorization', 'content-type'], allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'] }));

  api.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message, details: err.details }, err.status);
    console.error(err);
    return c.json({ error: 'Something went wrong' }, 500);
  });
  api.notFound((c) => c.json({ error: 'Not found' }, 404));

  api.get('/health', (c) => c.json({ ok: true }));
  api.route('/auth', authRoutes(db));
  api.route('/public', publicRoutes(db));

  const secured = new Hono<AppEnv>();
  secured.use(requireAuth);
  secured.route('/users', userRoutes(db));
  secured.route('/settings', settingsRoutes(db));
  secured.route('/cities', cityRoutes(db));
  secured.route('/grounds', groundRoutes(db));
  secured.route('/teams', teamRoutes(db));
  secured.route('/pricing', pricingRoutes(db));
  secured.route('/accounts', accountRoutes(db));
  secured.route('/bookings', bookingRoutes(db));
  secured.route('/availability', availabilityRoutes(db));
  secured.route('/dues', duesRoutes(db));
  secured.route('/reports', reportRoutes(db));
  secured.route('/export', exportRoutes(db));
  secured.route('/import', importRoutes(db));
  api.route('/', secured);

  return new Hono().route('/api/v1', api);
}

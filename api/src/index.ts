import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { connect } from './db/index.js';
import { createApi } from './app.js';
import { jwtSecret } from './lib/auth.js';
import { ensureOwner } from './services/owner.js';

jwtSecret(); // fail at start-up, not at first sign-in, if JWT_SECRET is missing in production

const { db } = await connect();

// Optional: create the business + owner login on start-up (e.g. on Railway, where the DB is private).
// Only creates what's missing; never resets an existing password.
if (process.env.OWNER_EMAIL && process.env.OWNER_PASSWORD) {
  try {
    console.log(await ensureOwner(db, {
      email: process.env.OWNER_EMAIL, password: process.env.OWNER_PASSWORD, orgName: process.env.ORG_NAME ?? 'My grounds', rename: !!process.env.ORG_NAME,
    }));
  } catch (err) { console.error('Owner set-up skipped:', (err as Error).message); }
}

const app = createApi(db, { log: true });

// In production the API also serves the built web app (single Railway service).
const here = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.resolve(here, '../../web/dist');
if (existsSync(webDist)) {
  const root = path.relative(process.cwd(), webDist);
  app.use('/*', serveStatic({ root }));
  const indexHtml = readFileSync(path.join(webDist, 'index.html'), 'utf8');
  app.get('*', (c) => c.html(indexHtml)); // SPA fallback
}

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, () => {
  const base = process.env.PUBLIC_URL?.replace(/\/$/, '') ?? `http://localhost:${port}`;
  console.log(`Listening on port ${port} · app ${base} · API ${base}/api/v1`);
});

import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { connect } from './db/index.js';
import { createApi } from './app.js';
import { jwtSecret } from './lib/auth.js';

jwtSecret(); // fail at start-up, not at first sign-in, if JWT_SECRET is missing in production

const { db } = await connect();
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

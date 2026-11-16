import { Hono } from 'hono';
import type { DB } from '../db/index.js';
import { requireOwner, type AppEnv } from '../lib/auth.js';
import { HttpError } from '../lib/errors.js';
import { today } from '../lib/util.js';
import { loadImport, prepareImport, readConfig, summarise } from '../import/load.js';

const MAX_BYTES = 10 * 1024 * 1024;

/**
 * Owner uploads the Excel workbook as the raw request body.
 *   POST /import            → check only: what would be loaded
 *   POST /import?replace=1  → wipe grounds, teams and bookings, then load the workbook
 */
export function importRoutes(db: DB) {
  const r = new Hono<AppEnv>();
  r.post('/', requireOwner, async (c) => {
    const buf = await c.req.arrayBuffer();
    if (!buf.byteLength) throw new HttpError(422, 'Choose an Excel file (.xlsx)');
    if (buf.byteLength > MAX_BYTES) throw new HttpError(422, 'File is larger than 10 MB');
    const t0 = today();
    const cfg = readConfig();
    let parsed;
    try {
      parsed = await prepareImport(buf, cfg, t0);
    } catch {
      throw new HttpError(422, "Couldn't read this file. Upload the bookings workbook as an .xlsx file.");
    }
    const summary = summarise(parsed);
    if (!summary.grounds) throw new HttpError(422, 'No ground sheets found in this file. Is it the bookings workbook?');
    if (c.req.query('replace') !== '1') return c.json({ loaded: false, summary });
    const me = c.get('user');
    const result = await loadImport(db, { orgId: me.orgId, userId: me.id, parsed, cfg, today: t0 });
    return c.json({ loaded: true, summary, result });
  });
  return r;
}

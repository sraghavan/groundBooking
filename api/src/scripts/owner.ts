/**
 * Create (or reset) an owner login, and name the business. Local PGlite by default,
 * or any Postgres when DATABASE_URL is set.
 *
 *   OWNER_PASSWORD='…' npm run owner -w api -- admin@admin.com "Eventeneurs"
 *
 * On Railway the same thing happens at start-up from OWNER_EMAIL / OWNER_PASSWORD / ORG_NAME.
 */
import { connect } from '../db/index.js';
import { ensureOwner } from '../services/owner.js';

const [email, orgName, name] = process.argv.slice(2);
if (!email || !orgName) {
  console.error('Usage: OWNER_PASSWORD=… npm run owner -w api -- <email> <business name> [person name]');
  process.exit(1);
}

const { db, close } = await connect();
try {
  console.log(await ensureOwner(db, { email, orgName, name, password: process.env.OWNER_PASSWORD ?? '', rename: true, resetPassword: true }));
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await close();
}

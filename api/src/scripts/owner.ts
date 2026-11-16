/**
 * Create (or reset) an owner login, and name the business. Works on any database:
 * local PGlite by default, or Railway when DATABASE_URL is set.
 *
 *   DATABASE_URL='postgresql://…' OWNER_PASSWORD='…' npm run owner -w api -- admin@admin.com "Eventeneurs"
 *
 * - No business yet: creates it with that name, and the owner.
 * - One business already: renames it, and adds the owner (or, if the email exists,
 *   makes it an owner and resets its password).
 */
import { eq } from 'drizzle-orm';
import { connect } from '../db/index.js';
import { orgs, users } from '../db/schema.js';
import { hashPassword } from '../lib/auth.js';

const [emailArg, orgName, nameArg] = process.argv.slice(2);
const email = emailArg?.trim().toLowerCase();
const password = process.env.OWNER_PASSWORD ?? '';
if (!email || !orgName) {
  console.error('Usage: OWNER_PASSWORD=… npm run owner -w api -- <email> <business name> [person name]');
  process.exit(1);
}
if (password.length < 8) { console.error('OWNER_PASSWORD must be at least 8 characters'); process.exit(1); }

const { db, close } = await connect();
try {
  const all = await db.select().from(orgs);
  if (all.length > 1) throw new Error(`Found ${all.length} businesses; expected one. Nothing changed.`);
  const passwordHash = await hashPassword(password);
  await db.transaction(async (tx) => {
    let org = all[0];
    if (org) [org] = await tx.update(orgs).set({ name: orgName }).where(eq(orgs.id, org.id)).returning();
    else [org] = await tx.insert(orgs).values({ name: orgName, settings: { currency: 'INR' } }).returning();

    const [existing] = await tx.select().from(users).where(eq(users.email, email));
    if (existing) {
      await tx.update(users).set({ role: 'owner', active: true, passwordHash, orgId: org.id }).where(eq(users.id, existing.id));
      console.log(`Updated ${email}: owner of "${org.name}", password reset.`);
    } else {
      await tx.insert(users).values({ orgId: org.id, name: nameArg ?? 'Admin', email, passwordHash, role: 'owner' });
      console.log(`Created ${email}: owner of "${org.name}".`);
    }
  });
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await close();
}

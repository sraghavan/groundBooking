import { eq } from 'drizzle-orm';
import type { DB } from '../db/index.js';
import { orgs, users } from '../db/schema.js';
import { hashPassword } from '../lib/auth.js';

/**
 * Make sure the business exists and `email` is an owner of it.
 * - No business yet: creates it with `orgName`.
 * - One business: uses it (renamed to `orgName` when `rename`).
 * - Email exists: made owner; password reset only when `resetPassword`.
 */
export async function ensureOwner(db: DB, o: {
  email: string; password: string; orgName: string; name?: string; rename?: boolean; resetPassword?: boolean;
}): Promise<string> {
  const email = o.email.trim().toLowerCase();
  if (o.password.length < 8) throw new Error('Owner password must be at least 8 characters');
  const all = await db.select().from(orgs);
  if (all.length > 1) throw new Error(`Found ${all.length} businesses; expected one. Nothing changed.`);
  return db.transaction(async (tx) => {
    let org = all[0];
    if (!org) [org] = await tx.insert(orgs).values({ name: o.orgName, settings: { currency: 'INR' } }).returning();
    else if (o.rename && org.name !== o.orgName) [org] = await tx.update(orgs).set({ name: o.orgName }).where(eq(orgs.id, org.id)).returning();

    const [existing] = await tx.select().from(users).where(eq(users.email, email));
    if (existing) {
      if (!o.resetPassword && existing.role === 'owner' && existing.active) return `${email} already owner of "${org.name}"`;
      await tx.update(users).set({
        role: 'owner', active: true, orgId: org.id,
        ...(o.resetPassword ? { passwordHash: await hashPassword(o.password) } : {}),
      }).where(eq(users.id, existing.id));
      return `Updated ${email}: owner of "${org.name}"${o.resetPassword ? ', password reset' : ''}`;
    }
    await tx.insert(users).values({ orgId: org.id, name: o.name ?? 'Admin', email, passwordHash: await hashPassword(o.password), role: 'owner' });
    return `Created ${email}: owner of "${org.name}"`;
  });
}

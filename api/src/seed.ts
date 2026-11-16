/**
 * Demo data for local development: `npm run seed -w api`
 * Sign in with owner@example.com / password123
 */
import { connect } from './db/index.js';
import { createApi } from './app.js';
import { addDays, today } from './lib/util.js';

const { db, close } = await connect();
const app = createApi(db);
let token = '';
async function call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await app.request(`/api/v1${path}`, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json)}`);
  return json as T;
}

const status = await call<{ needsSetup: boolean }>('GET', '/auth/status');
if (!status.needsSetup) {
  console.log('Database already has data; skipping seed. Delete api/.pglite to start fresh.');
  await close();
  process.exit(0);
}

token = (await call('POST', '/auth/signup', { orgName: 'Chennai Cricket Grounds', name: 'Owner', email: 'owner@example.com', password: 'password123' })).token;
await call('POST', '/accounts', { name: 'Main HDFC', upiId: 'groundbooking@okhdfcbank', isDefault: true });
await call('POST', '/accounts', { name: 'Partner PhonePe', upiId: 'partner@ybl' });
await call('POST', '/users', { name: 'Partner One', email: 'partner@example.com', password: 'password123' });

const std = [
  { name: 'Morning', startTime: '06:30', endTime: '10:30', defaultPrice: 3500 },
  { name: 'Midday', startTime: '11:00', endTime: '15:00', defaultPrice: 3000 },
  { name: 'Evening', startTime: '15:30', endTime: '19:30', defaultPrice: 4000 },
];
const grounds = [
  await call('POST', '/grounds', { name: 'Marina Oval', cityName: 'Chennai', defaultPrice: 3000, slots: std }),
  await call('POST', '/grounds', { name: 'Guindy Turf', cityName: 'Chennai', defaultPrice: 2500, slots: std.slice(0, 2) }),
  await call('POST', '/grounds', { name: 'Whitefield CC', cityName: 'Bengaluru', defaultPrice: 4000, slots: [
    { name: 'Morning', startTime: '07:00', endTime: '11:00', defaultPrice: 4500 },
    { name: 'Afternoon', startTime: '12:00', endTime: '16:00', defaultPrice: 4000, daysOfWeek: [0, 6] },
  ] }),
];

const teamNames = ['Lions CC', 'Tigers XI', 'Royal Strikers', 'Chepauk Warriors', 'Bay Blasters', 'Spartans', 'Night Owls', 'Super Kings Club'];
const people = ['Ravi Kumar', 'Arjun S', 'Karthik R', 'Vikram N', 'Suresh P', 'Manoj K', 'Rahul D', 'Pradeep V'];
const teams = [];
for (const [i, name] of teamNames.entries()) {
  teams.push(await call('POST', '/teams', { name, contacts: i === 6 ? [] : [{ name: people[i], mobile: `98${String(40000000 + i * 1234567).slice(0, 8)}` }] }));
}
await call('POST', '/pricing/rules', { teamId: teams[0].id, price: 3000, notes: 'Regular team discount' });

const t0 = today();
let n = 0;
for (let d = -14; d <= 7; d++) {
  const date = addDays(t0, d);
  for (const g of grounds) {
    for (const s of g.slots) {
      n++;
      if (n % 3 === 0) continue; // leave some free
      const a = teams[n % teams.length], b = teams[(n * 3 + 1) % teams.length];
      const solo = n % 7 === 0;
      const bk = await call('POST', '/bookings', {
        groundId: g.id, slotTemplateId: s.id, date, startTime: s.startTime, endTime: s.endTime,
        status: d < 0 ? 'completed' : 'confirmed',
        parties: solo || a.id === b.id ? [{ side: 'A', teamId: a.id }] : [{ side: 'A', teamId: a.id }, { side: 'B', teamId: b.id }],
      }).catch(() => null);
      if (!bk || d >= 0) continue;
      for (const p of bk.parties) {
        if (n % 5 === 0) continue;                                      // unpaid
        const amount = n % 4 === 0 ? Math.round(p.amountDue / 2) : p.amountDue; // part / full
        await call('POST', `/bookings/${bk.id}/payments`, { bookingPartyId: p.id, amount, paidOn: date, method: n % 2 ? 'upi' : 'cash' });
      }
    }
  }
}
const rana = await call('POST', '/teams', { name: 'Rana', kind: 'promoter', defaultRate: 6000, contacts: [{ name: 'Rana', mobile: '9810000001' }] });
await call('POST', '/teams', { name: 'Ravinder', kind: 'promoter', defaultRate: 6500, contacts: [{ name: 'Ravinder', mobile: '9810000002' }] });
for (const d of [1, 2, 3]) {
  const s = grounds[1].slots[0];
  await call('POST', '/bookings', { groundId: grounds[1].id, slotTemplateId: s.id, date: addDays(t0, d), startTime: s.startTime, endTime: s.endTime, kind: 'promoter', parties: [{ side: 'client', teamId: rana.id }] }).catch(() => null);
}
await call('POST', '/bookings', { groundId: grounds[0].id, kind: 'event', eventType: 'full_day', title: 'Corporate T10 Day', date: addDays(t0, 9), startTime: '06:30', endTime: '15:00', parties: [{ side: 'client', teamName: 'Acme Technologies', amountDue: 18000 }] });

console.log('Seeded. Sign in with owner@example.com / password123');
await close();

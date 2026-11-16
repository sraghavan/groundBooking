import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from './db/index.js';
import { createApi } from './app.js';
import ExcelJS from 'exceljs';
import { addDays, today } from './lib/util.js';

let app: ReturnType<typeof createApi>;
let close: () => Promise<void>;
let token = '';

async function call(method: string, path: string, body?: unknown, expect?: number) {
  const res = await app.request(`/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (expect !== undefined) assert.equal(res.status, expect, `${method} ${path} → ${res.status} ${text}`);
  return json;
}

before(async () => {
  const conn = await connect({ pglitePath: 'memory', databaseUrl: '' });
  close = conn.close;
  app = createApi(conn.db);
});
after(() => close());

const d0 = addDays(today(), -1); // yesterday: counts as "due"

test('full booking flow', async () => {
  // Setup & auth
  const signup = await call('POST', '/auth/signup', { orgName: 'Cricket Co', name: 'Owner', email: 'o@x.com', password: 'password1' }, 201);
  token = signup.token;
  await call('POST', '/auth/signup', { orgName: 'Other', name: 'X', email: 'x@x.com', password: 'password1' }, 403);
  await call('POST', '/accounts', { name: 'Main', upiId: 'grounds@upi' }, 201);

  // Ground with slots, city created on the fly
  const g = await call('POST', '/grounds', {
    name: 'Green Park', cityName: 'Chennai', defaultPrice: 3000,
    slots: [
      { name: 'Morning', startTime: '07:00', endTime: '11:00', defaultPrice: 4000 },
      { name: 'Afternoon', startTime: '12:00', endTime: '16:00' },
    ],
  }, 201);
  assert.equal(g.slots.length, 2);
  const [morning, afternoon] = g.slots;

  // Team-specific pricing beats slot default
  const lions = await call('POST', '/teams', { name: 'Lions CC', contacts: [{ name: 'Ravi Kumar', mobile: '98765 43210' }] }, 201);
  // Same name is allowed for a different team, but only after the user has seen the existing one(s)
  const dupe = await call('POST', '/teams', { name: 'lions c.c.' }, 409);
  assert.equal(dupe.details.teams[0].poc.name, 'Ravi Kumar');
  const lions2 = await call('POST', '/teams', { name: 'Lions CC', allowDuplicateName: true, contacts: [{ name: 'Arun', mobile: '9000000001' }] }, 201);
  const found = await call('GET', '/teams?q=lions', undefined, 200);
  assert.deepEqual(found.map((t: any) => t.poc?.mobile).sort(), ['+919000000001', '+919876543210']);
  assert.equal((await call('GET', '/teams?q=90000', undefined, 200))[0].id, lions2.id); // search by mobile
  await call('POST', '/pricing/rules', { teamId: lions.id, groundId: g.id, price: 3500 }, 201);
  assert.deepEqual((await call('GET', `/pricing/quote?groundId=${g.id}&slotTemplateId=${morning.id}&teamId=${lions.id}`, undefined, 200)).price, 3500);
  assert.equal((await call('GET', `/pricing/quote?groundId=${g.id}&slotTemplateId=${morning.id}`, undefined, 200)).price, 4000);
  assert.equal((await call('GET', `/pricing/quote?groundId=${g.id}&slotTemplateId=${afternoon.id}`, undefined, 200)).price, 3000);

  // Booking with one existing team + one new team (auto-created), custom times
  const b = await call('POST', '/bookings', {
    groundId: g.id, slotTemplateId: morning.id, date: d0, startTime: '07:30', endTime: '11:30',
    parties: [{ side: 'A', teamId: lions.id }, { side: 'B', teamName: 'Tigers XI', amountDue: 3800, contact: { name: 'Vik', mobile: '9111111111' } }],
  }, 201);
  assert.equal(b.createdTeams.length, 1);
  assert.deepEqual(b.parties.map((p: any) => [p.teamName, p.pocName, p.pocMobile]), [['Lions CC', 'Ravi Kumar', '+919876543210'], ['Tigers XI', 'Vik', '+919111111111']]);
  assert.deepEqual(b.parties.map((p: any) => p.amountDue), [3500, 3800]);

  // Clash detection (overlaps 07:30–11:30)
  await call('POST', '/bookings', { groundId: g.id, date: d0, startTime: '11:00', endTime: '13:00' }, 409);

  // One-team booking on the afternoon slot → partial
  const soloBody = { groundId: g.id, slotTemplateId: afternoon.id, date: d0, startTime: '12:00', endTime: '16:00' };
  const amb = await call('POST', '/bookings', { ...soloBody, parties: [{ side: 'A', teamName: 'tigers xi' }] }, 409); // name exists: must choose
  assert.equal(amb.details.code, 'team_name_exists');
  const solo = await call('POST', '/bookings', { ...soloBody, parties: [{ side: 'A', teamId: amb.details.teams[0].id }] }, 201);
  assert.equal(solo.createdTeams.length, 0);

  const av = await call('GET', `/availability?from=${d0}&days=2`, undefined, 200);
  const day = av[0].days[0].slots;
  assert.deepEqual(day.map((s: any) => [s.startTime, s.state]), [['07:30', 'full'], ['12:00', 'partial']]);
  assert.ok(av[0].days[1].slots.every((s: any) => s.state === 'free'));

  // Event spanning both slots on another day
  const d1 = addDays(d0, -1);
  await call('POST', '/bookings', { groundId: g.id, kind: 'event', title: 'Corporate day', date: d1, startTime: '07:00', endTime: '16:00', parties: [{ side: 'client', teamName: 'Acme Corp', amountDue: 20000 }] }, 201);
  const av2 = await call('GET', `/availability?from=${d1}&days=1`, undefined, 200);
  assert.equal(av2[0].days[0].slots.length, 1);
  assert.equal(av2[0].days[0].slots[0].name, 'Morning + Afternoon');

  // Payments: Lions pays part
  const lionsParty = b.parties.find((p: any) => p.teamId === lions.id);
  await call('POST', `/bookings/${b.id}/payments`, { bookingPartyId: lionsParty.id, amount: 1500, paidOn: d0, method: 'cash' }, 201);

  // Dues + WhatsApp links
  const dues = await call('GET', '/dues', undefined, 200);
  const lionsDue = dues.teams.find((t: any) => t.teamId === lions.id);
  assert.equal(lionsDue.balance, 2000);
  assert.equal(lionsDue.contacts[0].mobile, '+919876543210');
  assert.match(lionsDue.contacts[0].whatsappUrl, /^https:\/\/wa\.me\/919876543210\?text=/);
  assert.match(decodeURIComponent(lionsDue.contacts[0].whatsappUrl), /grounds@upi/);
  await call('POST', '/dues/reminders', { teamId: lions.id, contactId: lionsDue.contacts[0].id, amount: 2000 }, 201);

  // Partial match: reduce what's owed; cancel the solo booking with no charge
  await call('PATCH', `/bookings/${b.id}`, { status: 'partial', parties: [
    { id: lionsParty.id, side: 'A', teamId: lions.id, amountDue: 2500 },
    { id: b.parties[1].id, side: 'B', teamId: b.parties[1].teamId, amountDue: 2500 },
  ] }, 200);
  await call('PATCH', `/bookings/${solo.id}`, { status: 'cancelled', parties: [{ id: solo.parties[0].id, side: 'A', teamId: solo.parties[0].teamId, amountDue: 0 }] }, 200);
  // Removing a team that has paid is blocked
  await call('PATCH', `/bookings/${b.id}`, { parties: [{ id: b.parties[1].id, side: 'B', teamId: b.parties[1].teamId }] }, 409);

  // Reports
  const rep = await call('GET', `/reports?from=${d1}&to=${d0}&groupBy=city&period=all`, undefined, 200);
  assert.equal(rep.totals.bookings, 2);         // cancelled excluded
  assert.equal(rep.totals.billed, 25000);       // 2500 + 2500 + 20000 + 0
  assert.equal(rep.totals.received, 1500);
  assert.equal(rep.totals.due, 23500);
  assert.equal(rep.rows[0].groupName, 'Chennai');

  // Excel export: same totals as the report, POC shown with each team
  const xres = await app.request(`/api/v1/export/xlsx?from=${rep.from}&to=${rep.to}`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(xres.status, 200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await xres.arrayBuffer());
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['Summary', 'Green Park', 'Bookings', 'Payments', 'Dues', 'Teams']);
  const kpi = (col: number) => (wb.getWorksheet('Summary')!.getCell(5, col).value as { result: number }).result;
  assert.deepEqual([kpi(2), kpi(3), kpi(4), kpi(5)], [rep.totals.billed, rep.totals.collected, rep.totals.due, rep.totals.received]);
  const bRows = wb.getWorksheet('Bookings')!.getSheetValues().slice(2) as unknown[][];
  assert.ok(bRows.some((r) => r[10] === 'Lions CC' && r[11] === 'Ravi Kumar' && r[12] === '98765 43210'));

  // Partners
  await call('POST', '/users', { name: 'Partner', email: 'p@x.com', password: 'password1' }, 201);
  const login = await call('POST', '/auth/login', { email: 'P@x.com', password: 'password1' }, 200);
  token = login.token;
  await call('GET', '/users', undefined, 403);
  await call('GET', '/teams', undefined, 200);
});

// 1x1 PNG
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test('promoters, event pricing and payment accounts', async () => {
  token = (await call('POST', '/auth/login', { email: 'o@x.com', password: 'password1' }, 200)).token;
  const g = await call('POST', '/grounds', {
    name: 'Promo Park', cityName: 'Chennai',
    slots: [{ name: 'Morning', startTime: '07:00', endTime: '11:00', defaultPrice: 4000 }, { name: 'Night', startTime: '20:00', endTime: '24:00', defaultPrice: 5000 }],
  }, 201);
  const [morning, night] = g.slots;
  const d = addDays(today(), -3);

  // Promoters are teams of kind "promoter", listed separately from teams
  const rana = await call('POST', '/teams', { name: 'Rana', kind: 'promoter', defaultRate: 6500, contacts: [{ name: 'Rana', mobile: '9811111111' }] }, 201);
  assert.ok(!(await call('GET', '/teams', undefined, 200)).some((t: any) => t.id === rana.id));
  assert.equal((await call('GET', '/teams?kind=promoter', undefined, 200))[0].defaultRate, 6500);
  await call('POST', '/pricing/rules', { teamId: rana.id, slotTemplateId: night.id, price: 8000 }, 201);

  // Promoter quote: own rule > own default rate > 2 × team price
  const q = (extra: string) => call('GET', `/pricing/quote?groundId=${g.id}&kind=promoter&${extra}`, undefined, 200);
  assert.equal((await q(`teamId=${rana.id}&slotTemplateId=${night.id}`)).price, 8000);
  assert.equal((await q(`teamId=${rana.id}&slotTemplateId=${morning.id}`)).price, 6500);
  assert.equal((await q(`slotTemplateId=${morning.id}`)).price, 8000);

  const pb = await call('POST', '/bookings', { groundId: g.id, slotTemplateId: morning.id, date: d, startTime: '07:00', endTime: '11:00', kind: 'promoter', parties: [{ side: 'client', teamId: rana.id }] }, 201);
  assert.equal(pb.parties[0].amountDue, 6500);
  const av = await call('GET', `/availability?from=${d}&days=1&groundId=${g.id}`, undefined, 200);
  assert.equal(av[0].days[0].slots[0].state, 'full');
  // A promoter isn't a match team, and a promoter booking needs a promoter
  await call('POST', '/bookings', { groundId: g.id, slotTemplateId: night.id, date: d, startTime: '20:00', endTime: '24:00', parties: [{ side: 'A', teamId: rana.id }] }, 422);
  await call('POST', '/bookings', { groundId: g.id, slotTemplateId: night.id, date: d, startTime: '20:00', endTime: '24:00', kind: 'promoter', parties: [{ side: 'client', teamName: 'Someone' }] }, 422);

  // Event defaults: tournament ₹15,000 per match out of the box; half/full day set in settings
  const tq = await call('GET', `/pricing/quote?groundId=${g.id}&kind=event&eventType=tournament&matchCount=3`, undefined, 200);
  assert.equal(tq.price, 45000);
  await call('PATCH', '/settings', { settings: { eventPrices: { halfDay: 12000, fullDay: 22000 } } }, 200);
  assert.equal((await call('GET', `/pricing/quote?groundId=${g.id}&kind=event&eventType=full_day`, undefined, 200)).price, 22000);
  const ev = await call('POST', '/bookings', {
    groundId: g.id, kind: 'event', eventType: 'tournament', matchCount: 2, title: 'Office cup', date: addDays(d, -1), startTime: '07:00', endTime: '24:00',
    parties: [{ side: 'client', teamName: 'Office League' }],
  }, 201);
  assert.deepEqual([ev.eventType, ev.matchCount, ev.parties[0].amountDue], ['tournament', 2, 30000]);
  // Switching a booking to a match clears the event fields
  const sw = await call('PATCH', `/bookings/${ev.id}`, { kind: 'match', parties: [{ id: ev.parties[0].id, side: 'A', teamId: ev.parties[0].teamId }] }, 200);
  assert.deepEqual([sw.eventType, sw.matchCount], [null, null]);

  // Payment accounts with a QR; payments record the receiving account
  const acct = await call('POST', '/accounts', { name: 'Rana HDFC', upiId: 'rana@hdfc', qrImage: PNG }, 201);
  assert.equal(acct.hasQr, true);
  assert.equal(acct.qrImage, undefined); // image isn't sent in lists
  await call('POST', '/accounts', { name: 'Bad', qrImage: 'data:text/html;base64,AAAA' }, 422);
  await call('POST', `/bookings/${pb.id}/payments`, { bookingPartyId: pb.parties[0].id, amount: 2500, accountId: acct.id }, 201);
  const full = await call('GET', `/bookings/${pb.id}`, undefined, 200);
  assert.equal(full.payments[0].accountId, acct.id);

  // Reminder for the chosen account includes its UPI ID and a public QR link
  const dues = await call('GET', `/dues?accountId=${acct.id}`, undefined, 200);
  assert.equal(dues.payTo.name, 'Rana HDFC');
  const rd = dues.teams.find((t: any) => t.teamId === rana.id);
  assert.equal(rd.teamKind, 'promoter');
  assert.equal(rd.balance, 4000);
  const msg = decodeURIComponent(rd.contacts[0].whatsappUrl);
  assert.match(msg, /rana@hdfc/);
  assert.match(msg, new RegExp(`/api/v1/public/qr/${acct.id}`));
  const img = await app.request(`/api/v1/public/qr/${acct.id}`); // no login
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');

  // An account with payments is archived, not deleted
  assert.deepEqual(await call('DELETE', `/accounts/${acct.id}`, undefined, 200), { archived: true });
});

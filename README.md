# Ground Booking

Booking, payments and reminders for cricket grounds. It's a mobile-first web app that can be installed on a phone's home screen (PWA), built on a JSON API that a native app can reuse later.

```
api/   Node + Hono JSON API, Postgres via Drizzle (PGlite locally)
web/   React + Vite + Tailwind PWA
```

## Run locally

Node 22 or later. No database install needed: locally the API uses PGlite, an embedded Postgres stored in `api/.pglite`.

```bash
npm install
npm run seed       # demo data — sign in as owner@example.com / password123
npm run dev:api    # http://localhost:8787/api/v1
npm run dev:web    # http://localhost:5173 (proxies /api to the API)
npm test           # end-to-end API test on an in-memory DB
```

### Load the existing Excel workbook

```bash
npm run import -- "data/EVENTENUERS 2024.xlsx"            # dry run → data/import-report.md
npm run import -- "data/EVENTENUERS 2024.xlsx" --replace  # replace grounds, teams and bookings with the workbook
```

Stop `dev:api` first: local PGlite allows only one process at a time. `data/import-config.json` maps each sheet's columns to slots (names and times). Fix it and re-run as often as needed; users and settings are kept. Cells are read as: `A vs B` = match, `A vs` = waiting for an opponent, a single name or `X both teams` = whole slot held by that person.

To start fresh, delete `api/.pglite`. On first launch with an empty database, the login screen becomes "create your business".

## Deploy (Railway)

1. Add a **Postgres** service and a service from this repo.
2. Set variables: `DATABASE_URL` (reference the Postgres one), `JWT_SECRET` (a long random string), `NODE_ENV=production`, `PUBLIC_URL` (the app's https URL, used in QR links in reminders).
3. Build: `npm install && npm run build`. Start: `npm start`.

One service serves both the API (`/api/v1`) and the web app. Migrations run automatically on start.

## Data model

```
Org ─┬─ City ── Ground ── SlotTemplate   (default name/times/price/days)
     ├─ Team (kind: team | promoter, promoter default rate) ── Contact (POC: name, mobile)
     ├─ PriceRule (team? ground? slot? → price)   most specific wins
     ├─ Booking (ground, date, start/end, match|promoter|event, event type, matches, status)
     │    └─ BookingParty (team, side A/B/client, amountDue)
     │         └─ Payment (amount, date, method, account, ref)
     ├─ PaymentAccount (name, UPI ID, QR image, default)
     ├─ Reminder (log of WhatsApp reminders)
     └─ User (owner | partner)
```

- **Times are flexible.** Slots are templates; a booking copies a slot's times and can change them, and the calendar shows the booking's actual times. An event can span several slots.
- **Pricing is per team.** The default comes from the most specific price rule (team + slot, team + ground, team, slot, ground), then the slot price, then the ground default. It's pre-filled on the booking and can be changed.
- **Booking types.** A slot is booked by *2 teams* (a match), a *promoter* (Rana, Ravinder… hold the whole slot at their own rate), or an *event*: half day, full day, or tournament (priced per match, default ₹15,000).
- **Promoter rates.** Promoter's rule for that ground/slot, then their default rate, then two teams' price. Set in More → Promoters.
- **Event prices.** Half day / full day / tournament per match, in More → Prices.
- **Payment accounts.** Several UPI IDs / banks, each with a QR image. A payment records which account received it; reminders use the chosen account's UPI ID and a public QR link (`/api/v1/public/qr/:id`), and on phones the QR image itself can be shared. Set `PUBLIC_URL` in production so links use the right domain.
- **Status:** `confirmed`, `completed`, `partial` (not completed; reduce the amounts), or `cancelled` (frees the slot; any amount left on it counts as a cancellation charge).
- **Slot colours:** free (green), a match with fewer than two teams (amber), full or event (red).
- **Multi-tenant ready:** every row carries `org_id`. Set `ALLOW_SIGNUP=true` to let new businesses sign up.

## API (all under `/api/v1`, bearer token)

| Area | Endpoints |
|---|---|
| Auth | `GET /auth/status`, `POST /auth/signup`, `POST /auth/login`, `GET /auth/me`, `POST /auth/password` |
| Users (owner) | `GET/POST /users`, `PATCH /users/:id` |
| Settings | `GET/PATCH /settings` (name, UPI ID, reminder template) |
| Cities | `GET/POST /cities`, `PATCH/DELETE /cities/:id` |
| Grounds | `GET/POST /grounds`, `GET/PATCH/DELETE /grounds/:id`, `POST /grounds/:id/slots`, `PATCH/DELETE /grounds/slots/:slotId` |
| Teams | `GET /teams?q=&kind=team\|promoter\|all`, `POST /teams`, `GET/PATCH/DELETE /teams/:id`, `POST /teams/:id/merge`, `POST /teams/:id/contacts`, `PATCH/DELETE /teams/contacts/:cid` |
| Pricing | `GET /pricing/quote?groundId&slotTemplateId&teamId&kind&eventType&matchCount`, `GET/POST /pricing/rules`, `PATCH/DELETE /pricing/rules/:id` |
| Bookings | `GET /bookings?from&to&groundId&cityId&teamId`, `POST /bookings`, `GET/PATCH/DELETE /bookings/:id`, `POST /bookings/:id/payments`, `PATCH/DELETE /bookings/payments/:pid` |
| Availability | `GET /availability?from&days&cityId&groundId` |
| Accounts | `GET /accounts`, `POST /accounts`, `PATCH/DELETE /accounts/:id` (owner), public `GET /public/qr/:id` |
| Dues | `GET /dues?upTo&teamId&accountId` (includes wa.me links), `POST /dues/reminders` |
| Export | `GET /export/xlsx?from&to&groundId&cityId`: Excel workbook (Summary, a calendar per ground, Bookings, Payments, Dues, Teams) |
| Reports | `GET /reports?from&to&period=day\|week\|month\|quarter\|year\|all&groupBy=none\|ground\|city&groundId&cityId`, `GET /reports/csv` |

When creating or updating a booking, each party takes a `teamId` or a `teamName`. **Team names are not unique**: a name that matches no team creates one (optionally with `contact: {name, mobile}`); a name that matches existing team(s) returns `409` with `details.teams` (each with its POC) so the user can pick one, or send `newTeam: true` to add another team with that name. Teams are always shown with their active POC and mobile. If `amountDue` is left out, the default price is used. An overlapping booking returns `409` unless `allowOverlap: true`.

## Roadmap

- Google Sheets sync (one-way export of bookings, payments and dues to a Sheet)
- WhatsApp Business Cloud API for automatic reminders (currently click-to-send `wa.me` links)
- Native app wrapper (Capacitor) using the same API
- Platform: sign-up for other booking businesses, per-org billing, ground-owner leases and payouts

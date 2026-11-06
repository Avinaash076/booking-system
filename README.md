# Slotbook

A full-stack TypeScript scheduling app: React + Vite, Express 5, Luxon, and PostgreSQL 15+. Built from an empty repository, without a starter template.

## Run

Install Docker Desktop and start its engine, then:

```sh
git clone https://github.com/Avinaash076/booking-system.git
cd booking-system
docker compose up --build
```

Open **http://localhost:3000**. Startup applies versioned migrations and seeds `demo`, with a 30-minute discovery call and a 60-minute workshop (four seats). Demo login at `/host`: **demo / demo-password-change-me**. Seed hours: Mon-Fri, 09:00-17:00 Asia/Kolkata, five-minute buffers, four-hour notice, 30-day horizon. The first offered start is 09:15 because the buffer must fit inside availability.

If port 5432 is occupied, set `POSTGRES_PORT=5433` in `.env` before running Compose. Change `APP_URL` if using a different browser origin. `DEMO_PASSWORD` changes the password only on the first seed of a new database. Keep your existing database volume; changing the environment does not reset an existing account.

### Develop without a containerized app

Requires Node 22.12+ and a Postgres 15+ database:

```sh
cp .env.example .env
docker compose up -d db
npm ci
npm run dev
```

On PowerShell, use `Copy-Item .env.example .env` and `npm.cmd` if script execution policy blocks `npm`. Update `DATABASE_URL` if you changed the DB port. Migrations/seeding also run during `npm run dev`; `npm run db:setup` is available separately. `npm run build` performs TypeScript checking, builds React, and compiles the server. `npm start` serves the production output when `NODE_ENV=production`.

## 60-second UI tour

1. Visit `/demo/discovery`, switch the time zone, and pick a day and time. Slots are shown for the next 30 days.
2. A five-minute hold starts. Enter your name/email and confirm. Save the private `/manage/{token}` URL.
3. Use that link to reschedule or cancel with a reason. A full destination leaves the original booking intact.
4. Visit `/demo/workshop` to try shared capacity.
5. Sign in at `/host`. Set your time zone, create an event, add multiple weekly windows, or add a date override. Empty override hours mean a day off.
6. Review upcoming bookings, cancel with a reason, and inspect the durable notification sink.

## Tests

One command using disposable real Postgres, with no local Node installation:

```sh
docker compose --profile test run --build --rm tests
```

Or run locally with a **dedicated disposable test database**. Do not point tests at production: they apply migrations, seed demo data, create fixtures, and remove their own fixtures.

```sh
# Create slotbook_test using your database administrator first.
TEST_DATABASE_URL=postgres://slotbook:slotbook@localhost:5432/slotbook_test npm test
```

PowerShell:

```powershell
$env:TEST_DATABASE_URL='postgres://slotbook:slotbook@localhost:5432/slotbook_test'
npm.cmd test
```

`npm run test:unit` runs the five pure slot tests without Postgres. `npm test` deliberately fails if `TEST_DATABASE_URL` is absent. CI builds and runs all tests against Postgres 16.

**Verified on November 6, 2026:** 14/14 tests passed against a separate real Postgres 17 cluster and Node 22.20.0. Tests include 40 concurrent one-on-one holds (one success), 40 group holds (three successes), same-key concurrency, cross-event overlap, buffer conflicts, expiry, delayed lock acquisition, confirm/cancel retries, atomic failed reschedules, competing reschedules, host settings/authentication, date overrides, and DST transitions. Production build passes. These are correctness tests, not a throughput benchmark. Browser verification was blocked by the computer-use environment. Docker Compose itself was not executed because Docker's engine was unavailable; its configuration was validated with `docker compose config`.

## API

JSON bodies and responses. Times are offset-bearing ISO 8601 strings; responses use UTC instants. Slots align to 15-minute local clock boundaries; event duration is real elapsed minutes. Query ranges are half-open `[from,to)` and must be positive and at most 31 days. `tz` must be an IANA zone. Client renders returned instants in the selected zone.

| Method | Path                                                           | Body / behavior                                                                                              |
| ------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| GET    | `/api/hosts/{host}/events/{slug}/slots?from=...&to=...&tz=...` | `{event, slots:[{start,end,remaining}], timezone}`                                                           |
| POST   | `/api/holds`                                                   | `{host,slug,start}`; required `Idempotency-Key` (8-200 chars); returns 201 `{id,status,start,end,expiresAt}` |
| POST   | `/api/holds/{id}/confirm`                                      | `{name,email}`; returns `{token,status}`                                                                     |
| GET    | `/api/bookings/{token}`                                        | Private booking view                                                                                         |
| POST   | `/api/bookings/{token}/reschedule`                             | `{start}`; atomic move, `{status}`                                                                           |
| POST   | `/api/bookings/{token}/cancel`                                 | `{reason}`; `{status}`                                                                                       |
| POST   | `/api/login`                                                   | `{handle,password}`; sets HttpOnly SameSite=Strict session cookie                                            |
| POST   | `/api/logout`                                                  | Invalidates session                                                                                          |
| GET    | `/api/host`                                                    | Authenticated host, events, schedule, upcoming bookings, last 30 notifications                               |
| PUT    | `/api/host/settings`                                           | `{timezone}`                                                                                                 |
| POST   | `/api/host/events`                                             | `{name,slug,duration,capacity,buffer_before,buffer_after,notice_minutes,horizon_days}`                       |
| PUT    | `/api/host/availability`                                       | `{weekly:[{weekday:1,windows:[{start:540,end:1020}]}]}`; replaces all weekly windows                         |
| PUT    | `/api/host/overrides/{YYYY-MM-DD}`                             | `{windows:[]}` for day off, or minute windows; replaces that date's hours                                    |
| DELETE | `/api/host/overrides/{YYYY-MM-DD}`                             | Revert to weekly hours                                                                                       |
| POST   | `/api/host/bookings/{id}/cancel`                               | `{reason}`; authenticated owner only                                                                         |
| GET    | `/health`                                                      | Checks database connectivity                                                                                 |

Weekdays use ISO numbering (Monday=1, Sunday=7); wall-clock minutes range 0-1440. Windows must not overlap and cannot span midnight. End 1440 is accepted through the API; the time-input UI supports up to 23:59. Duration 15-120, capacity 1-100, buffers 0-30, notice 0-43200 minutes, horizon 1-365 days. Event types are create-only in this core.

Errors: `{error:string}` with 400 validation, 401 authentication, 403 origin, 404 missing resource, 409 conflict/full slot, 410 expired hold, 429 login throttle, or 500 unexpected failure. Retry uncertain holds with the **same key and exact payload**. Reusing a key with different input returns 409. A replay returns its original hold, including cancelled/expired status; a fresh user intent requires a new key. Confirm and cancel retries do not emit duplicate notifications. Hold IDs and manage tokens are private capabilities: don't share them.

## Correctness and architecture

```mermaid
flowchart LR
  UI[React guest and host pages] --> API[Express JSON API]
  API --> TX[Begin transaction]
  TX --> KEY[Hold only: lock idempotency key]
  KEY --> LOCK[Lock host row FOR UPDATE]
  LOCK --> CHECK[Read DB clock / expire holds / validate schedule and capacity]
  CHECK --> WRITE[Write booking and notification sink]
  WRITE --> COMMIT[Commit]
  COMMIT --> PG[(Postgres)]
```

All booking changes and host schedule edits lock the same host row in a database transaction. Availability reads take that lock too, producing a coherent snapshot. Separate hosts proceed independently. The single-host lock deliberately favors a simple proof of correctness over per-host throughput. The database clock is read **after** the lock, avoiding transaction-start timestamp expiry bugs. All writers must use this protocol; arbitrary direct SQL writers could bypass the invariant. Do not grant untrusted users table write access.

Capacity counts confirmed bookings and held bookings with `expires_at > database clock`. Expiry is also materialized lazily during host operations; no background worker is needed to free capacity. A failed transaction may roll back that status update, but the expiry predicate still excludes the hold. Buffers are stored with each reservation. Any overlapping different event or differently aligned session blocks the host. Exact same-event start/end may share seats up to capacity. Intervals are half-open, so touching busy endpoints are allowed. Held reservations keep their promised instants if the host later changes availability or zone; only new holds and reschedules validate the new schedule.

Slots are generated by scanning real UTC minutes across each host-local date and merging open intervals, then taking local quarter-hour starts whose duration and buffers fit. Spring-forward missing times never exist; fall-back times appear twice with different offsets. For example, New York on March 14, 2027: a 01:45 EST start is 06:45Z and a 30-minute session ends at 03:15 EDT, 07:15Z. On November 7, 2027, the two 01:30 starts are 05:30Z and 06:30Z. Notification records commit with confirm/reschedule/cancel, so a crash cannot leave a committed booking without its event.

Primary references: [Postgres row locking](https://www.postgresql.org/docs/17/explicit-locking.html) and [Luxon API](https://moment.github.io/luxon/api-docs/index.html).

## Optional work included and known gaps

Included: GitHub Actions CI, structured request logs with UUID request IDs, a DB-backed health endpoint, keyboard-native forms/controls, and a notification sink viewer. This is partial observability, not the complete optional metrics extension; no accessibility audit or browser end-to-end suite has been run.

Not included: live deployment, real email, calendar sync/invites, reminders, webhooks, waitlist, round-robin, load benchmark, public hold abuse protection, production account recovery, or notification delivery worker. The login throttle is per-process only. Before public deployment, add shared rate limiting/anti-abuse controls and proper account management, set a strong password **before first seed**, configure HTTPS and `APP_URL`, restrict DB networking/roles, add backup/restore and retention policies, and verify the guest flow in a browser. Do not publish the demo credentials for a production account.

## Next steps / submission

1. Run the app and follow the UI tour. Check the CI result on GitHub after pushing.
2. Review [the eight-page report](docs/REPORT.pdf), [AI_LOG.md](AI_LOG.md), and the known gaps above. Update any personal narrative in the report before submission.
3. For a live demo, deploy the Dockerfile to your chosen Node container host and provide a Postgres 15+ `DATABASE_URL`, an HTTPS `APP_URL`, `PORT`, and a strong initial `DEMO_PASSWORD`. The app migrates/seeds on startup. Do not expose port 5432 publicly. Managed databases may require provider-specific TLS settings in the connection string.
4. Run production browser checks (guest confirm, private manage, reschedule/cancel, host login, mobile layout), then add the resulting live URL to this README/report if deployed.
5. Submit the GitHub URL and `docs/REPORT.pdf` yourself to the recruiter. No messages are sent by this project.

The repository is configured with the supplied GitHub remote. If automatic push is unavailable, run `git push -u origin main` from this folder after authenticating with GitHub. Keep the individual commits; do not squash the implementation history.

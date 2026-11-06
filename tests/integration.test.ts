import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { app, apiErrors } from "../server/app.js";
import { pool } from "../server/db.js";
import { setup, hashPassword } from "../server/setup.js";
import type { Server } from "node:http";

// Never silently pass or touch the normal database when test configuration is absent.
if (!process.env.TEST_DATABASE_URL)
  throw new Error(
    "Set TEST_DATABASE_URL to a dedicated disposable Postgres database. Integration tests must run against real Postgres.",
  );
// pool was constructed at import time; replace its connection target before first use.
pool.options.connectionString = process.env.TEST_DATABASE_URL;
let server: Server, base: string, hostId: string, start: string, next: string;
const fixture = "test-" + randomUUID().slice(0, 8);
async function request(
  path: string,
  body?: unknown,
  key?: string,
  cookie?: string,
  method?: string,
) {
  const response = await fetch(base + path, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: {
      "Content-Type": "application/json",
      ...(key ? { "Idempotency-Key": key } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: response.status,
    data: await response.json(),
    cookie: response.headers.get("set-cookie")?.split(";")[0],
  };
}
before(async () => {
  await setup();
  hostId = randomUUID();
  await pool.query("INSERT INTO hosts VALUES ($1,$2,$3,$4,$5)", [
    hostId,
    fixture,
    "Test Host",
    "UTC",
    hashPassword("fixture-password"),
  ]);
  for (const [slug, capacity] of [
    ["solo", 1],
    ["group", 3],
    ["other", 1],
  ] as const)
    await pool.query("INSERT INTO events VALUES ($1,$2,$3,$4,30,$5,5,5,0,30)", [
      randomUUID(),
      hostId,
      slug,
      slug,
      capacity,
    ]);
  for (let day = 1; day <= 7; day++)
    await pool.query(
      "INSERT INTO weekly_windows(host_id,weekday,start_minute,end_minute) VALUES ($1,$2,0,1440)",
      [hostId, day],
    );
  start = new Date(
    Math.ceil((Date.now() + 86400000) / 900000) * 900000,
  ).toISOString();
  next = new Date(Date.parse(start) + 3600000).toISOString();
  app.use(apiErrors);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(async () => {
  if (hostId)
    await pool.query("DELETE FROM sessions WHERE host_id=$1", [hostId]);
  if (hostId) {
    await pool.query(
      "DELETE FROM notifications WHERE booking_id IN (SELECT id FROM bookings WHERE host_id=$1)",
      [hostId],
    );
    await pool.query(
      "DELETE FROM idempotency_keys WHERE booking_id IN (SELECT id FROM bookings WHERE host_id=$1)",
      [hostId],
    );
    await pool.query("DELETE FROM bookings WHERE host_id=$1", [hostId]);
    await pool.query("DELETE FROM weekly_windows WHERE host_id=$1", [hostId]);
    await pool.query("DELETE FROM date_overrides WHERE host_id=$1", [hostId]);
    await pool.query("DELETE FROM events WHERE host_id=$1", [hostId]);
    await pool.query("DELETE FROM hosts WHERE id=$1", [hostId]);
  }
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  await pool.end();
});
async function reset() {
  await pool.query("UPDATE bookings SET status='cancelled' WHERE host_id=$1", [
    hostId,
  ]);
}
const hold = (slug = "solo", at = start, key = randomUUID()) =>
  request("/api/holds", { host: fixture, slug, start: at }, key);
test("40 simultaneous holds: exactly one winner; group capacity has exactly three winners", async () => {
  for (const [slug, count] of [
    ["solo", 1],
    ["group", 3],
  ] as const) {
    await reset();
    const results = await Promise.all(
      Array.from({ length: 40 }, () => hold(slug)),
    );
    assert.equal(results.filter((r) => r.status === 201).length, count);
    assert.equal(results.filter((r) => r.status === 409).length, 40 - count);
  }
});
test("same key retries return one hold; changed payload conflicts", async () => {
  await reset();
  const key = randomUUID();
  const rs = await Promise.all(
    Array.from({ length: 15 }, () => hold("solo", start, key)),
  );
  assert.ok(rs.every((r) => r.status === 201));
  assert.equal(new Set(rs.map((r) => r.data.id)).size, 1);
  assert.equal((await hold("solo", next, key)).status, 409);
});
test("overlapping event types and adjacent buffer conflicts cannot double-book host", async () => {
  await reset();
  assert.equal((await hold()).status, 201);
  assert.equal((await hold("other")).status, 409);
  assert.equal(
    (await hold("other", new Date(Date.parse(start) + 1800000).toISOString()))
      .status,
    409,
  );
  assert.equal(
    (await hold("other", new Date(Date.parse(start) + 2700000).toISOString()))
      .status,
    201,
  );
});
test("expired hold cannot confirm and immediately releases capacity without a worker", async () => {
  await reset();
  const h = await hold();
  await pool.query(
    "UPDATE bookings SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [h.data.id],
  );
  assert.equal(
    (
      await request(`/api/holds/${h.data.id}/confirm`, {
        name: "Guest",
        email: "guest@example.com",
      })
    ).status,
    410,
  );
  assert.equal((await hold()).status, 201);
});
test("confirm retries emit once; failed reschedule preserves old slot; cancel releases it", async () => {
  await reset();
  const h = await hold();
  const details = { name: "Guest", email: "guest@example.com" };
  const cs = await Promise.all(
    Array.from({ length: 8 }, () =>
      request(`/api/holds/${h.data.id}/confirm`, details),
    ),
  );
  assert.ok(cs.every((r) => r.status === 200));
  assert.equal(new Set(cs.map((r) => r.data.token)).size, 1);
  const token = cs[0].data.token;
  assert.equal(
    Number(
      (
        await pool.query(
          "SELECT count(*) FROM notifications WHERE booking_id=$1",
          [h.data.id],
        )
      ).rows[0].count,
    ),
    1,
  );
  const occupied = await hold("other", next);
  assert.equal(occupied.status, 201);
  assert.equal(
    (await request(`/api/bookings/${token}/reschedule`, { start: next }))
      .status,
    409,
  );
  assert.equal((await request(`/api/bookings/${token}`)).data.start_at, start);
  const replacement = new Date(Date.parse(start) + 7200000).toISOString();
  assert.equal(
    (await request(`/api/bookings/${token}/reschedule`, { start: replacement }))
      .status,
    200,
  );
  assert.equal((await hold("other", start)).status, 201);
  const cancellations = await Promise.all(
    Array.from({ length: 5 }, () =>
      request(`/api/bookings/${token}/cancel`, { reason: "Plans changed" }),
    ),
  );
  assert.ok(cancellations.every((r) => r.status === 200));
  assert.equal(
    Number(
      (
        await pool.query(
          "SELECT count(*) FROM notifications WHERE booking_id=$1",
          [h.data.id],
        )
      ).rows[0].count,
    ),
    3,
  );
  assert.equal((await hold("other", replacement)).status, 201);
});
test("two reschedules racing for the same destination have one winner", async () => {
  await reset();
  const tokens = [];
  for (const at of [start, next]) {
    const h = await hold("solo", at);
    const c = await request(`/api/holds/${h.data.id}/confirm`, {
      name: "Guest",
      email: "guest@example.com",
    });
    tokens.push(c.data.token);
  }
  const dest = new Date(Date.parse(start) + 10800000).toISOString();
  const r = await Promise.all(
    tokens.map((t) =>
      request(`/api/bookings/${t}/reschedule`, { start: dest }),
    ),
  );
  assert.deepEqual(r.map((v) => v.status).sort(), [200, 409]);
});
test("invalid input, host authentication and hostile origins are rejected", async () => {
  assert.equal((await request("/api/host")).status, 401);
  assert.equal(
    (
      await request(
        "/api/holds",
        { host: fixture, slug: "solo", start: "not-a-date" },
        randomUUID(),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await request(
        `/api/hosts/${fixture}/events/solo/slots?from=${encodeURIComponent(start)}&to=${encodeURIComponent(next)}&tz=Bad/Zone`,
      )
    ).status,
    400,
  );
  const r = await fetch(base + "/api/login", {
    method: "POST",
    headers: {
      Origin: "https://evil.example",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ handle: "demo", password: "x" }),
  });
  assert.equal(r.status, 403);
});
test("host login, event creation, weekly windows, overrides, time zone and cancellation", async () => {
  await reset();
  const login = await request("/api/login", {
    handle: fixture,
    password: "fixture-password",
  });
  assert.equal(login.status, 200);
  assert.ok(login.cookie);
  const cookie = login.cookie!;
  const settings = await request("/api/host", undefined, undefined, cookie);
  assert.equal(settings.status, 200);
  assert.equal(
    (
      await request(
        "/api/host/events",
        {
          name: "New event",
          slug: "new-event",
          duration: 45,
          capacity: 2,
          buffer_before: 0,
          buffer_after: 0,
          notice_minutes: 0,
          horizon_days: 30,
        },
        undefined,
        cookie,
      )
    ).status,
    201,
  );
  assert.equal(
    (
      await request(
        "/api/host/availability",
        {
          weekly: [
            {
              weekday: 1,
              windows: [
                { start: 540, end: 720 },
                { start: 780, end: 1020 },
              ],
            },
          ],
        },
        undefined,
        cookie,
        "PUT",
      )
    ).status,
    200,
  );
  const day = start.slice(0, 10);
  assert.equal(
    (
      await request(
        `/api/host/overrides/${day}`,
        { windows: [] },
        undefined,
        cookie,
        "PUT",
      )
    ).status,
    200,
  );
  assert.equal((await hold()).status, 409);
  const range = new URLSearchParams({ from: start, to: next, tz: "UTC" });
  assert.equal(
    (await request(`/api/hosts/${fixture}/events/solo/slots?${range}`)).data
      .slots.length,
    0,
  );
  assert.equal(
    (
      await request(
        `/api/host/overrides/${day}`,
        { windows: [{ start: 0, end: 1440 }] },
        undefined,
        cookie,
        "PUT",
      )
    ).status,
    200,
  );
  const h = await hold();
  assert.equal(h.status, 201);
  const c = await request(`/api/holds/${h.data.id}/confirm`, {
    name: "Host test",
    email: "test@example.com",
  });
  assert.equal(c.status, 200);
  assert.equal(
    (
      await request(
        `/api/host/bookings/${h.data.id}/cancel`,
        { reason: "Host unavailable" },
        undefined,
        cookie,
      )
    ).status,
    200,
  );
  assert.equal(
    (await request(`/api/bookings/${c.data.token}`)).data.cancel_reason,
    "Host unavailable",
  );
  assert.equal(
    (
      await request(
        "/api/host/settings",
        { timezone: "Asia/Kolkata" },
        undefined,
        cookie,
        "PUT",
      )
    ).status,
    200,
  );
  assert.equal(
    (await request("/api/host", undefined, undefined, cookie)).data.host
      .timezone,
    "Asia/Kolkata",
  );
  assert.equal(
    (await request("/api/logout", {}, undefined, cookie)).status,
    200,
  );
  assert.equal(
    (await request("/api/host", undefined, undefined, cookie)).status,
    401,
  );
});
test("hold waiting behind a database lock uses time after the lock is acquired", async () => {
  // Restore fixture after the settings test.
  await pool.query("UPDATE hosts SET timezone='UTC' WHERE id=$1", [hostId]);
  await reset();
  const h = await hold();
  assert.equal(h.status, 201);
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT id FROM hosts WHERE id=$1 FOR UPDATE", [hostId]);
    await db.query(
      "UPDATE bookings SET expires_at=clock_timestamp()+interval '100 milliseconds' WHERE id=$1",
      [h.data.id],
    );
    const confirmation = request(`/api/holds/${h.data.id}/confirm`, {
      name: "Late",
      email: "late@example.com",
    });
    await db.query("SELECT pg_sleep(0.2)");
    await db.query("COMMIT");
    assert.equal((await confirmation).status, 410);
  } finally {
    await db.query("ROLLBACK");
    db.release();
  }
});

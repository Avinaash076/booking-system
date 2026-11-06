import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import {
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { DateTime, IANAZone } from "luxon";
import { z } from "zod";
import { pool, transaction, HttpError } from "./db.js";
import {
  changeBooking,
  confirm,
  createHold,
  loadSchedule,
  lockHost,
  manageView,
  slotsFor,
} from "./booking.js";

const zone = z
  .string()
  .refine((v) => IANAZone.isValidZone(v), "Use a valid IANA time zone");
const instant = z.iso.datetime({ offset: true });
const handle = z.string().regex(/^[a-z0-9-]{1,80}$/);
const window = z
  .object({
    start: z.number().int().min(0).max(1439),
    end: z.number().int().min(1).max(1440),
  })
  .refine((w) => w.start < w.end, "End must follow start");
const windows = z
  .array(window)
  .max(12)
  .refine((ws) => {
    const sorted = [...ws].sort((a, b) => a.start - b.start);
    return sorted.every((w, i) => !i || sorted[i - 1].end <= w.start);
  }, "Availability windows must not overlap");
const eventInput = z.object({
  name: z.string().trim().min(1).max(100),
  slug: handle,
  duration: z.number().int().min(15).max(120),
  capacity: z.number().int().min(1).max(100),
  buffer_before: z.number().int().min(0).max(30),
  buffer_after: z.number().int().min(0).max(30),
  notice_minutes: z.number().int().min(0).max(43200),
  horizon_days: z.number().int().min(1).max(365),
});
const digest = (v: string) => createHash("sha256").update(v).digest("hex");
async function hostAuth(req: Request) {
  const raw = req.headers.cookie
    ?.split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith("session="))
    ?.slice(8);
  if (!raw) throw new HttpError(401, "Please sign in");
  const row = (
    await pool.query(
      "SELECT h.id,h.handle,h.name,h.timezone FROM sessions s JOIN hosts h ON h.id=s.host_id WHERE s.token_hash=$1 AND s.expires_at>clock_timestamp()",
      [digest(raw)],
    )
  ).rows[0];
  if (!row) throw new HttpError(401, "Please sign in");
  return row;
}
export const app = express();
app.disable("x-powered-by");
app.use((req, res, next) => {
  const id = randomUUID();
  res.setHeader("X-Request-ID", id);
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.path.startsWith("/api")) res.setHeader("Cache-Control", "no-store");
  const began = Date.now();
  res.on("finish", () =>
    console.log(
      JSON.stringify({
        requestId: id,
        method: req.method,
        route: req.route?.path ?? "other",
        status: res.statusCode,
        ms: Date.now() - began,
      }),
    ),
  );
  next();
});
app.use(express.json({ limit: "32kb" }));
app.use("/api", (req, res, next) => {
  if (
    !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
    req.headers.origin &&
    req.headers.origin !== (process.env.APP_URL ?? "http://localhost:3000")
  )
    return next(new HttpError(403, "Origin not allowed"));
  next();
});
// Small per-process login throttle; booking correctness never depends on it.
const attempts = new Map<string, { count: number; until: number }>();
app.post("/api/login", async (req, res) => {
  const ip = req.ip ?? "unknown",
    now = Date.now();
  if (attempts.size > 10000)
    for (const [k, v] of attempts) if (v.until < now) attempts.delete(k);
  const attempt = attempts.get(ip);
  if (attempt && attempt.until > now && attempt.count >= 10)
    throw new HttpError(429, "Too many login attempts; try in 15 minutes");
  attempts.set(ip, {
    count: attempt && attempt.until > now ? attempt.count + 1 : 1,
    until: attempt && attempt.until > now ? attempt.until : now + 900000,
  });
  const input = z
    .object({ handle, password: z.string().min(1).max(200) })
    .parse(req.body);
  const host = (
    await pool.query("SELECT * FROM hosts WHERE handle=$1", [input.handle])
  ).rows[0];
  const [salt, expected] = (host?.password_hash ?? "missing:00").split(":");
  const actual = scryptSync(input.password, salt, 64);
  const stored = Buffer.from(expected, "hex");
  if (
    !host ||
    actual.length !== stored.length ||
    !timingSafeEqual(actual, stored)
  )
    throw new HttpError(401, "Invalid login");
  const token = randomBytes(32).toString("hex");
  await pool.query(
    "INSERT INTO sessions VALUES ($1,$2,clock_timestamp()+interval '12 hours')",
    [digest(token), host.id],
  );
  attempts.delete(ip);
  res.cookie("session", token, {
    httpOnly: true,
    sameSite: "strict",
    secure: (process.env.APP_URL ?? "").startsWith("https:"),
    maxAge: 43200000,
    path: "/",
  });
  res.json({ ok: true });
});
app.post("/api/logout", async (req, res) => {
  const raw = req.headers.cookie
    ?.split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith("session="))
    ?.slice(8);
  if (raw)
    await pool.query("DELETE FROM sessions WHERE token_hash=$1", [digest(raw)]);
  res.clearCookie("session", { path: "/" }).json({ ok: true });
});
app.get("/api/host", async (req, res) => {
  const host = await hostAuth(req);
  const data = await transaction(async (db) => {
    await lockHost(db, host.id);
    const current = (
      await db.query("SELECT id,handle,name,timezone FROM hosts WHERE id=$1", [
        host.id,
      ])
    ).rows[0];
    const schedule = await loadSchedule(db, host.id);
    const events = (
      await db.query("SELECT * FROM events WHERE host_id=$1 ORDER BY name", [
        host.id,
      ])
    ).rows;
    const bookings = (
      await db.query(
        `SELECT b.*,e.name AS event_name FROM bookings b JOIN events e ON e.id=b.event_id WHERE b.host_id=$1 AND b.status='confirmed' AND b.end_at>clock_timestamp() ORDER BY b.start_at`,
        [host.id],
      )
    ).rows;
    const notifications = (
      await db.query(
        "SELECT n.* FROM notifications n JOIN bookings b ON b.id=n.booking_id WHERE b.host_id=$1 ORDER BY n.id DESC LIMIT 30",
        [host.id],
      )
    ).rows;
    return { host: current, schedule, events, bookings, notifications };
  });
  res.json(data);
});
app.put("/api/host/settings", async (req, res) => {
  const host = await hostAuth(req);
  const input = z.object({ timezone: zone }).parse(req.body);
  await transaction(async (db) => {
    await lockHost(db, host.id);
    await db.query("UPDATE hosts SET timezone=$2 WHERE id=$1", [
      host.id,
      input.timezone,
    ]);
  });
  res.json({ ok: true });
});
app.put("/api/host/availability", async (req, res) => {
  const host = await hostAuth(req);
  const input = z
    .object({
      weekly: z
        .array(z.object({ weekday: z.number().int().min(1).max(7), windows }))
        .max(7)
        .refine(
          (ds) => new Set(ds.map((d) => d.weekday)).size === ds.length,
          "Duplicate weekday",
        ),
    })
    .parse(req.body);
  await transaction(async (db) => {
    await lockHost(db, host.id);
    await db.query("DELETE FROM weekly_windows WHERE host_id=$1", [host.id]);
    for (const day of input.weekly)
      for (const w of day.windows)
        await db.query(
          "INSERT INTO weekly_windows(host_id,weekday,start_minute,end_minute) VALUES ($1,$2,$3,$4)",
          [host.id, day.weekday, w.start, w.end],
        );
  });
  res.json({ ok: true });
});
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => DateTime.fromISO(s).isValid, "Invalid date");
app.put("/api/host/overrides/:day", async (req, res) => {
  const host = await hostAuth(req),
    day = date.parse(req.params.day),
    input = z.object({ windows }).parse(req.body);
  await transaction(async (db) => {
    await lockHost(db, host.id);
    await db.query(
      "INSERT INTO date_overrides VALUES ($1,$2,$3) ON CONFLICT(host_id,day) DO UPDATE SET windows=EXCLUDED.windows",
      [host.id, day, JSON.stringify(input.windows)],
    );
  });
  res.json({ ok: true });
});
app.delete("/api/host/overrides/:day", async (req, res) => {
  const host = await hostAuth(req),
    day = date.parse(req.params.day);
  await transaction(async (db) => {
    await lockHost(db, host.id);
    await db.query("DELETE FROM date_overrides WHERE host_id=$1 AND day=$2", [
      host.id,
      day,
    ]);
  });
  res.json({ ok: true });
});
app.post("/api/host/events", async (req, res) => {
  const host = await hostAuth(req),
    e = eventInput.parse(req.body);
  const row = await transaction(async (db) => {
    await lockHost(db, host.id);
    return (
      await db.query(
        "INSERT INTO events VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *",
        [
          randomUUID(),
          host.id,
          e.name,
          e.slug,
          e.duration,
          e.capacity,
          e.buffer_before,
          e.buffer_after,
          e.notice_minutes,
          e.horizon_days,
        ],
      )
    ).rows[0];
  });
  res.status(201).json(row);
});
app.post("/api/host/bookings/:id/cancel", async (req, res) => {
  const host = await hostAuth(req),
    id = z.uuid().parse(req.params.id),
    reason = z.string().trim().min(1).max(500).parse(req.body.reason);
  const b = (
    await pool.query(
      "SELECT manage_token FROM bookings WHERE id=$1 AND host_id=$2",
      [id, host.id],
    )
  ).rows[0];
  if (!b) throw new HttpError(404, "Booking not found");
  res.json(await changeBooking(b.manage_token, "cancel", reason, host.id));
});
app.get("/api/hosts/:host/events/:slug/slots", async (req, res) => {
  const input = z
    .object({ from: instant, to: instant, tz: zone })
    .parse(req.query);
  const from = Date.parse(input.from),
    to = Date.parse(input.to);
  if (to <= from || to - from > 31 * 86400_000)
    throw new HttpError(400, "Request a positive range of at most 31 days");
  res.json({
    ...(await slotsFor(
      handle.parse(req.params.host),
      handle.parse(req.params.slug),
      from,
      to,
    )),
    timezone: input.tz,
  });
});
app.post("/api/holds", async (req, res) => {
  const key = z.string().min(8).max(200).parse(req.get("Idempotency-Key"));
  const input = z
    .object({ host: handle, slug: handle, start: instant })
    .parse(req.body);
  res
    .status(201)
    .json(await createHold(input.host, input.slug, input.start, key));
});
app.post("/api/holds/:id/confirm", async (req, res) => {
  const input = z
    .object({
      name: z.string().trim().min(1).max(120),
      email: z
        .email()
        .max(254)
        .transform((s) => s.toLowerCase()),
    })
    .parse(req.body);
  res.json(
    await confirm(z.uuid().parse(req.params.id), input.name, input.email),
  );
});
const token = z.string().regex(/^[a-f0-9]{64}$/);
app.get("/api/bookings/:token", async (req, res) =>
  res.json(await manageView(token.parse(req.params.token))),
);
app.post("/api/bookings/:token/reschedule", async (req, res) =>
  res.json(
    await changeBooking(
      token.parse(req.params.token),
      "reschedule",
      instant.parse(req.body.start),
    ),
  ),
);
app.post("/api/bookings/:token/cancel", async (req, res) =>
  res.json(
    await changeBooking(
      token.parse(req.params.token),
      "cancel",
      z.string().trim().min(1).max(500).parse(req.body.reason),
    ),
  ),
);
app.get("/health", async (req, res) => {
  await pool.query("SELECT 1");
  res.json({ status: "ok" });
});
export function apiErrors(
  error: any,
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (!req.path.startsWith("/api") && req.path !== "/health")
    return next(error);
  if (error instanceof z.ZodError)
    return void res
      .status(400)
      .json({
        error: error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
      });
  if (error instanceof HttpError)
    return void res.status(error.status).json({ error: error.message });
  if (error.code === "23505")
    return void res
      .status(409)
      .json({ error: "This value already exists (check the event slug)" });
  if (error.type === "entity.parse.failed")
    return void res.status(400).json({ error: "Invalid JSON" });
  console.error(
    JSON.stringify({
      error: error.message,
      requestId: res.getHeader("X-Request-ID"),
    }),
  );
  res
    .status(500)
    .json({ error: "An unexpected error occurred. Please retry." });
}

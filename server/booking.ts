import { randomBytes, randomUUID, createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { HttpError, pool, transaction } from "./db.js";
import {
  generateSlots,
  type EventType,
  type Schedule,
  type Busy,
} from "./slots.js";
export async function loadSchedule(
  db: PoolClient,
  hostId: string,
): Promise<Schedule> {
  const host = (
    await db.query("SELECT timezone FROM hosts WHERE id=$1", [hostId])
  ).rows[0];
  const weekly: Schedule["weekly"] = {},
    overrides: Schedule["overrides"] = {};
  for (const w of (
    await db.query("SELECT * FROM weekly_windows WHERE host_id=$1", [hostId])
  ).rows)
    (weekly[w.weekday] ??= []).push({
      start: w.start_minute,
      end: w.end_minute,
    });
  for (const o of (
    await db.query(
      "SELECT to_char(day,'YYYY-MM-DD') AS day,windows FROM date_overrides WHERE host_id=$1",
      [hostId],
    )
  ).rows)
    overrides[o.day] = o.windows;
  return { timezone: host.timezone, weekly, overrides };
}
export async function clock(db: PoolClient): Promise<number> {
  return +(await db.query("SELECT clock_timestamp() AS now")).rows[0].now;
}
export async function active(
  db: PoolClient,
  hostId: string,
  now: number,
): Promise<Busy[]> {
  return (
    await db.query(
      "SELECT * FROM bookings WHERE host_id=$1 AND (status='confirmed' OR (status='held' AND expires_at>$2))",
      [hostId, new Date(now)],
    )
  ).rows;
}
export async function lockHost(db: PoolClient, hostId: string) {
  await db.query("SELECT id FROM hosts WHERE id=$1 FOR UPDATE", [hostId]);
  // Evaluate expiry AFTER acquiring the lock; transaction-start time can be stale.
  await db.query(
    "UPDATE bookings SET status='expired' WHERE host_id=$1 AND status='held' AND expires_at<=clock_timestamp()",
    [hostId],
  );
}
async function validSlot(
  db: PoolClient,
  event: EventType,
  start: string,
  now: number,
  exclude?: string,
) {
  const t = Date.parse(start);
  const slots = generateSlots(
    event,
    await loadSchedule(db, event.host_id),
    await active(db, event.host_id, now),
    t,
    t + 1,
    now,
    exclude,
  );
  if (!slots.length)
    throw new HttpError(409, "This slot is unavailable. Choose another time.");
}
export async function getEvent(
  db: PoolClient,
  host: string,
  slug: string,
): Promise<EventType & { host_name: string; timezone: string }> {
  const event = (
    await db.query(
      "SELECT e.*,h.name AS host_name,h.timezone FROM events e JOIN hosts h ON h.id=e.host_id WHERE h.handle=$1 AND e.slug=$2",
      [host, slug],
    )
  ).rows[0];
  if (!event) throw new HttpError(404, "Event not found");
  return event;
}
export async function slotsFor(
  host: string,
  slug: string,
  from: number,
  to: number,
) {
  return transaction(async (db) => {
    // A short read snapshot under the same host lock keeps settings and occupancy coherent.
    const initial = await getEvent(db, host, slug);
    await lockHost(db, initial.host_id);
    const event = await getEvent(db, host, slug);
    const now = await clock(db);
    return {
      event,
      slots: generateSlots(
        event,
        await loadSchedule(db, event.host_id),
        await active(db, event.host_id, now),
        from,
        to,
        now,
      ),
    };
  });
}
export async function createHold(
  host: string,
  slug: string,
  start: string,
  key: string,
) {
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([host, slug, new Date(start).toISOString()]))
    .digest("hex");
  return transaction(async (db) => {
    // Serialize a key before host locking, including malicious reuse across different hosts.
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      key,
    ]);
    const event = await getEvent(db, host, slug);
    await lockHost(db, event.host_id);
    const previous = (
      await db.query("SELECT * FROM idempotency_keys WHERE key=$1", [key])
    ).rows[0];
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new HttpError(
          409,
          "Idempotency-Key was already used for another request",
        );
      return holdView(
        (
          await db.query("SELECT * FROM bookings WHERE id=$1", [
            previous.booking_id,
          ])
        ).rows[0],
      );
    }
    const now = await clock(db);
    await validSlot(db, event, start, now);
    const t = Date.parse(start),
      end = t + event.duration * 60_000;
    const row = (
      await db.query(
        `INSERT INTO bookings(id,host_id,event_id,status,start_at,end_at,busy_start,busy_end,expires_at,manage_token)
      VALUES ($1,$2,$3,'held',$4,$5,$6,$7,$8,$9) RETURNING *`,
        [
          randomUUID(),
          event.host_id,
          event.id,
          new Date(t),
          new Date(end),
          new Date(t - event.buffer_before * 60_000),
          new Date(end + event.buffer_after * 60_000),
          new Date(now + 300_000),
          randomBytes(32).toString("hex"),
        ],
      )
    ).rows[0];
    await db.query("INSERT INTO idempotency_keys VALUES ($1,$2,$3)", [
      key,
      fingerprint,
      row.id,
    ]);
    return holdView(row);
  });
}
function holdView(row: any) {
  return {
    id: row.id,
    status: row.status,
    start: row.start_at,
    end: row.end_at,
    expiresAt: row.expires_at,
  };
}
async function notify(db: PoolClient, booking: any, kind: string) {
  await db.query(
    "INSERT INTO notifications(booking_id,kind,payload) VALUES ($1,$2,$3)",
    [
      booking.id,
      kind,
      JSON.stringify({
        start: booking.start_at,
        end: booking.end_at,
        email: booking.guest_email,
        name: booking.guest_name,
        reason: booking.cancel_reason,
      }),
    ],
  );
}
export async function confirm(id: string, name: string, email: string) {
  return transaction(async (db) => {
    const initial = (
      await db.query("SELECT host_id FROM bookings WHERE id=$1", [id])
    ).rows[0];
    if (!initial) throw new HttpError(404, "Hold not found");
    await lockHost(db, initial.host_id);
    const b = (await db.query("SELECT * FROM bookings WHERE id=$1", [id]))
      .rows[0];
    if (b.status === "confirmed") {
      if (b.guest_name !== name || b.guest_email !== email)
        throw new HttpError(
          409,
          "Already confirmed with different guest details",
        );
      return { token: b.manage_token, status: b.status };
    }
    if (b.status !== "held" || +b.expires_at <= (await clock(db)))
      throw new HttpError(
        410,
        "Your hold expired. Please select a slot again.",
      );
    const updated = (
      await db.query(
        "UPDATE bookings SET status='confirmed',guest_name=$2,guest_email=$3 WHERE id=$1 RETURNING *",
        [id, name, email],
      )
    ).rows[0];
    await notify(db, updated, "confirmed");
    return { token: updated.manage_token, status: updated.status };
  });
}
export async function changeBooking(
  token: string,
  action: "cancel" | "reschedule",
  data: string,
  hostId?: string,
) {
  return transaction(async (db) => {
    const initial = (
      await db.query("SELECT host_id FROM bookings WHERE manage_token=$1", [
        token,
      ])
    ).rows[0];
    if (!initial || (hostId && hostId !== initial.host_id))
      throw new HttpError(404, "Booking not found");
    await lockHost(db, initial.host_id);
    const b = (
      await db.query("SELECT * FROM bookings WHERE manage_token=$1", [token])
    ).rows[0];
    if (action === "cancel" && b.status === "cancelled")
      return { status: "cancelled" };
    if (b.status !== "confirmed")
      throw new HttpError(409, "Only confirmed bookings can be changed");
    const now = await clock(db);
    if (+b.start_at <= now)
      throw new HttpError(409, "This booking has already started");
    let updated;
    if (action === "cancel") {
      updated = (
        await db.query(
          "UPDATE bookings SET status='cancelled',cancel_reason=$2 WHERE id=$1 RETURNING *",
          [b.id, data],
        )
      ).rows[0];
    } else {
      if (Date.parse(data) === +b.start_at) return { status: "confirmed" };
      const event = (
        await db.query("SELECT * FROM events WHERE id=$1", [b.event_id])
      ).rows[0];
      await validSlot(db, event, data, now, b.id);
      const t = Date.parse(data),
        end = t + event.duration * 60_000;
      updated = (
        await db.query(
          "UPDATE bookings SET start_at=$2,end_at=$3,busy_start=$4,busy_end=$5 WHERE id=$1 RETURNING *",
          [
            b.id,
            new Date(t),
            new Date(end),
            new Date(t - event.buffer_before * 60_000),
            new Date(end + event.buffer_after * 60_000),
          ],
        )
      ).rows[0];
    }
    await notify(
      db,
      updated,
      action === "cancel" ? "cancelled" : "rescheduled",
    );
    return { status: updated.status };
  });
}
export async function manageView(token: string) {
  const row = (
    await pool.query(
      `SELECT b.status,b.start_at,b.end_at,b.guest_name,b.guest_email,b.cancel_reason,e.name,e.slug,h.handle,h.timezone
    FROM bookings b JOIN events e ON e.id=b.event_id JOIN hosts h ON h.id=b.host_id WHERE b.manage_token=$1 AND b.status IN ('confirmed','cancelled')`,
      [token],
    )
  ).rows[0];
  if (!row) throw new HttpError(404, "Booking not found");
  return row;
}

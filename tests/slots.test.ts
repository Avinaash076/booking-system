import { test } from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import {
  generateSlots,
  remaining,
  type EventType,
  type Schedule,
} from "../server/slots.js";
const event: EventType = {
  id: "event",
  host_id: "host",
  name: "Call",
  slug: "call",
  duration: 30,
  capacity: 1,
  buffer_before: 0,
  buffer_after: 0,
  notice_minutes: 0,
  horizon_days: 365,
};
function slots(
  day: string,
  zone: string,
  windows: { start: number; end: number }[],
  e = event,
) {
  const start = DateTime.fromISO(day, { zone }).startOf("day");
  const schedule: Schedule = {
    timezone: zone,
    weekly: { [start.weekday]: windows },
    overrides: {},
  };
  return generateSlots(
    e,
    schedule,
    [],
    +start,
    +start.plus({ days: 1 }),
    +start - 86400000,
  );
}
test("spring forward skips nonexistent times and keeps elapsed duration", () => {
  const s = slots("2027-03-14", "America/New_York", [{ start: 60, end: 240 }]);
  assert.equal(s.length, 7);
  assert.ok(
    s.every(
      (v) => DateTime.fromISO(v.start).setZone("America/New_York").hour !== 2,
    ),
  );
  assert.ok(
    s.every((v) => Date.parse(v.end) - Date.parse(v.start) === 1800000),
  );
  assert.ok(
    s.some(
      (v) =>
        v.start === "2027-03-14T06:45:00.000Z" &&
        v.end === "2027-03-14T07:15:00.000Z",
    ),
  );
});
test("fall back exposes both 01:30 instants with distinct UTC offsets", () => {
  const s = slots("2027-11-07", "America/New_York", [{ start: 60, end: 180 }]);
  const repeated = s.filter(
    (v) =>
      DateTime.fromISO(v.start)
        .setZone("America/New_York")
        .toFormat("HH:mm") === "01:30",
  );
  assert.equal(repeated.length, 2);
  assert.notEqual(repeated[0].start, repeated[1].start);
});
test("quarter-hour zones, minimum notice, horizon and buffers", () => {
  const s = slots("2027-01-04", "Asia/Kathmandu", [{ start: 540, end: 600 }], {
    ...event,
    buffer_before: 5,
    buffer_after: 5,
  });
  assert.deepEqual(
    s.map((v) =>
      DateTime.fromISO(v.start).setZone("Asia/Kathmandu").toFormat("HH:mm"),
    ),
    ["09:15"],
  );
  const start = Date.parse("2027-01-04T00:00:00Z");
  const schedule: Schedule = {
    timezone: "UTC",
    weekly: { 1: [{ start: 0, end: 1440 }] },
    overrides: {},
  };
  const result = generateSlots(
    { ...event, notice_minutes: 60, horizon_days: 1 },
    schedule,
    [],
    start,
    start + 2 * 86400000,
    start,
  );
  assert.equal(result[0].start, "2027-01-04T01:00:00.000Z");
  assert.ok(result.every((v) => Date.parse(v.start) < start + 86400000));
});
test("day off replaces weekly hours; adjacent windows are continuous", () => {
  const start = Date.parse("2027-01-04T00:00:00Z");
  assert.equal(
    generateSlots(
      event,
      {
        timezone: "UTC",
        weekly: { 1: [{ start: 540, end: 1020 }] },
        overrides: { "2027-01-04": [] },
      },
      [],
      start,
      start + 86400000,
      start,
    ).length,
    0,
  );
  assert.equal(
    slots("2027-01-04", "UTC", [
      { start: 540, end: 555 },
      { start: 555, end: 600 },
    ]).length,
    3,
  );
});
test("group capacity shares exact sessions only; buffers and cross-event conflicts block", () => {
  const start = Date.parse("2027-01-04T09:00:00Z");
  const b = {
    id: "a",
    event_id: "event",
    start_at: new Date(start),
    end_at: new Date(start + 1800000),
    busy_start: new Date(start - 300000),
    busy_end: new Date(start + 2100000),
  };
  assert.equal(remaining({ ...event, capacity: 2 }, start, [b]), 1);
  assert.equal(
    remaining({ ...event, id: "other", capacity: 2 }, start, [b]),
    0,
  );
  assert.equal(remaining(event, start + 1800000, [b]), 0);
  assert.equal(remaining(event, start + 2100000, [b]), 1);
  assert.equal(remaining(event, start, [b], "a"), 1);
});

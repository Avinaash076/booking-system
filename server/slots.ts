import { DateTime } from "luxon";
export type Window = { start: number; end: number };
export type Schedule = {
  timezone: string;
  weekly: Record<number, Window[]>;
  overrides: Record<string, Window[]>;
};
export type EventType = {
  id: string;
  host_id: string;
  name: string;
  slug: string;
  duration: number;
  capacity: number;
  buffer_before: number;
  buffer_after: number;
  notice_minutes: number;
  horizon_days: number;
};
export type Busy = {
  id: string;
  event_id: string;
  start_at: Date;
  end_at: Date;
  busy_start: Date;
  busy_end: Date;
};
export type Slot = { start: string; end: string; remaining: number };
const minute = 60_000;
// Scan actual instants, not guessed local offsets: gaps disappear and folds occur twice.
export function openIntervals(
  schedule: Schedule,
  day: DateTime,
): [number, number][] {
  const windows =
    schedule.overrides[day.toISODate()!] ?? schedule.weekly[day.weekday] ?? [];
  if (!windows.length) return [];
  const result: [number, number][] = [];
  let run: number | undefined;
  const end = day.plus({ days: 1 }).toMillis();
  for (let t = day.toMillis(); t < end; t += minute) {
    const local = DateTime.fromMillis(t, { zone: schedule.timezone });
    const m = local.hour * 60 + local.minute;
    const open = windows.some((w) => m >= w.start && m < w.end);
    if (open && run === undefined) run = t;
    if (!open && run !== undefined) {
      result.push([run, t]);
      run = undefined;
    }
  }
  if (run !== undefined) result.push([run, end]);
  return result;
}
export function remaining(
  event: EventType,
  start: number,
  busy: Busy[],
  exclude?: string,
): number {
  const end = start + event.duration * minute;
  const left = start - event.buffer_before * minute,
    right = end + event.buffer_after * minute;
  let used = 0;
  for (const b of busy) {
    if (b.id === exclude || +b.busy_start >= right || +b.busy_end <= left)
      continue;
    // Only attendees of the exact same group session may overlap.
    if (b.event_id !== event.id || +b.start_at !== start || +b.end_at !== end)
      return 0;
    used++;
  }
  return Math.max(0, event.capacity - used);
}
export function generateSlots(
  event: EventType,
  schedule: Schedule,
  busy: Busy[],
  from: number,
  to: number,
  now: number,
  exclude?: string,
): Slot[] {
  const lower = Math.max(from, now + event.notice_minutes * minute);
  const upper = Math.min(to, now + event.horizon_days * 86400_000);
  if (lower >= upper) return [];
  let day = DateTime.fromMillis(lower, { zone: schedule.timezone }).startOf(
    "day",
  );
  const result: Slot[] = [];
  while (day.toMillis() < upper) {
    for (const [a, b] of openIntervals(schedule, day)) {
      for (
        let t =
          Math.ceil((a + event.buffer_before * minute) / (15 * minute)) *
          15 *
          minute;
        t + (event.duration + event.buffer_after) * minute <= b && t < upper;
        t += 15 * minute
      ) {
        const local = DateTime.fromMillis(t, { zone: schedule.timezone });
        if (t < lower || local.minute % 15 !== 0) continue;
        const free = remaining(event, t, busy, exclude);
        if (free > 0)
          result.push({
            start: new Date(t).toISOString(),
            end: new Date(t + event.duration * minute).toISOString(),
            remaining: free,
          });
      }
    }
    day = day.plus({ days: 1 });
  }
  return result;
}

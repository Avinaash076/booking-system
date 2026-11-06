import { readFile, readdir } from "node:fs/promises";
import { randomUUID, randomBytes, scryptSync } from "node:crypto";
import { fileURLToPath } from "node:url";
import { pool, transaction } from "./db.js";
export function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}
export async function setup() {
  await transaction(async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(7420185)");
    await db.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY)",
    );
    for (const name of (await readdir("migrations"))
      .filter((n) => n.endsWith(".sql"))
      .sort()) {
      if (
        (
          await db.query("SELECT 1 FROM schema_migrations WHERE name=$1", [
            name,
          ])
        ).rowCount
      )
        continue;
      await db.query(await readFile(`migrations/${name}`, "utf8"));
      await db.query("INSERT INTO schema_migrations VALUES ($1)", [name]);
    }
    if ((await db.query("SELECT 1 FROM hosts WHERE handle='demo'")).rowCount)
      return;
    const host = randomUUID();
    await db.query("INSERT INTO hosts VALUES ($1,$2,$3,$4,$5)", [
      host,
      "demo",
      "Alex Morgan",
      "Asia/Kolkata",
      hashPassword(process.env.DEMO_PASSWORD ?? "demo-password-change-me"),
    ]);
    for (const [name, slug, duration, capacity] of [
      ["Discovery call", "discovery", 30, 1],
      ["Group workshop", "workshop", 60, 4],
    ] as const) {
      await db.query(
        "INSERT INTO events VALUES ($1,$2,$3,$4,$5,$6,5,5,240,30)",
        [randomUUID(), host, name, slug, duration, capacity],
      );
    }
    for (let day = 1; day <= 5; day++)
      await db.query(
        "INSERT INTO weekly_windows(host_id,weekday,start_minute,end_minute) VALUES ($1,$2,540,1020)",
        [host, day],
      );
  });
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  setup()
    .then(() => console.log("Migrations applied; demo host ready."))
    .finally(() => pool.end());
}

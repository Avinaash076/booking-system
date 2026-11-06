import "dotenv/config";
import pg, { type PoolClient } from "pg";
export const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ??
    "postgres://slotbook:slotbook@localhost:5432/slotbook",
  max: 30,
});
export async function transaction<T>(
  fn: (db: PoolClient) => Promise<T>,
): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const value = await fn(db);
    await db.query("COMMIT");
    return value;
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    db.release();
  }
}
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

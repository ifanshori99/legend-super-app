// WFC money paths decide on the database clock, read AFTER every row and
// advisory lock is held: a request that waited on a lock must not act on a
// time taken before the wait (slot start, pass expiry, grant expiry).
// Callers keep an optional injected `now` so tests can move time.
import { sql } from "drizzle-orm";

import type { Tx } from "./facility-shared.ts";

/** The injected `now` if given, else the database clock (`clock_timestamp()`). */
export async function wfcNow(tx: Tx, injected?: Date): Promise<Date> {
  if (injected) return injected;
  const result = await tx.execute(sql`SELECT clock_timestamp() AS now`);
  const value = (result.rows[0] as { now: Date | string }).now;
  return value instanceof Date ? value : new Date(value);
}

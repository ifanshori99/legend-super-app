// Cross-connection lock around the shared tenant cash-out approval limit.
//
// The limit is one row for the whole test tenant. The cash-out approval file
// lowers it for a moment (CO-8d) while other files, running in parallel, post
// amounts that only mean something under the default Rp5.000.000. A Postgres
// advisory lock, which works across connections and processes, orders them:
//
//   - a test that needs the default limit holds the SHARED lock for its whole
//     run (many such tests may run together);
//   - the test that changes the limit holds the EXCLUSIVE lock, so it waits for
//     every running test and new tests wait for it.
//
// Deadlock rules: each dedicated connection holds exactly one lock. A file never
// registers both hooks for the same test, so no test holds shared and exclusive
// at once. A wait is capped by lock_timeout (below the vitest hook timeout) so a
// stuck holder fails the hook instead of leaking a late grant.
import { afterEach, beforeEach } from "vitest";
import type { PoolClient } from "pg";
import { owner } from "./cash-bank-world.ts";

/** Fixed advisory-lock key for the shared tenant cash limit. */
export const LIMIT_LOCK_KEY = 7_300_512;
/** Below the 30s hookTimeout in vitest.config.ts. */
const LOCK_WAIT = "25s";

type Mode = "shared" | "exclusive";

async function acquire(mode: Mode): Promise<PoolClient> {
  const client = await owner.connect();
  try {
    await client.query(`SET lock_timeout = '${LOCK_WAIT}'`);
    await client.query(
      mode === "shared"
        ? "SELECT pg_advisory_lock_shared($1)"
        : "SELECT pg_advisory_lock($1)",
      [LIMIT_LOCK_KEY],
    );
    await client.query("RESET lock_timeout");
    return client;
  } catch (error) {
    // Destroying the connection also drops any lock it might hold.
    client.release(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}

async function release(client: PoolClient, mode: Mode): Promise<void> {
  try {
    const res = await client.query<{ released: boolean }>(
      mode === "shared"
        ? "SELECT pg_advisory_unlock_shared($1) AS released"
        : "SELECT pg_advisory_unlock($1) AS released",
      [LIMIT_LOCK_KEY],
    );
    // An unconfirmed unlock destroys the connection, which frees the lock.
    client.release(res.rows[0]?.released ? undefined : new Error("unlock"));
  } catch (error) {
    client.release(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}

function register(mode: Mode): void {
  let held: PoolClient | undefined;
  beforeEach(async () => {
    held = await acquire(mode);
  });
  afterEach(async () => {
    const client = held;
    held = undefined;
    if (client) await release(client, mode);
  });
}

/**
 * Registers hooks that hold the SHARED limit lock during every test of the
 * enclosing describe (or file). Use it where amounts assume the default limit.
 */
export function withLimitSharedLock(): void {
  register("shared");
}

/**
 * Registers hooks that hold the EXCLUSIVE limit lock during every test of the
 * enclosing describe. Use it only around tests that change the tenant limit,
 * and never inside a scope that also has `withLimitSharedLock`.
 */
export function limitExclusiveLock(): void {
  register("exclusive");
}

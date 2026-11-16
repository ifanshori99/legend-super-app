import type { Pool } from "pg";
import { env } from "../config/env";
import { logger } from "../lib/logger";
import { createGrantorPool } from "./role";

/**
 * The payout grantor connection (legend-911): the only way to issue a payout
 * step grant. It is a separate small pool, never the application pool, because
 * a payout transaction holds an application connection while it issues.
 *
 * - `PAYOUT_GRANTOR_DATABASE_URL` set: the `legend_grant_*` login, checked on
 *   every new connection (`createGrantorPool`).
 * - Unset in development or test: a pool on DATABASE_URL (in test, the owner
 *   login STARTER_TEST_DATABASE_URL), and every issue
 *   transaction starts with `SET LOCAL ROLE legend_payout_grantor`
 *   (`fallbackRole`).
 * - Unset anywhere else: no pool; the issuer answers 503
 *   PAYOUT_STEP_GRANT_UNAVAILABLE and no payout money is recorded. Production
 *   never gets here: env validation requires the variable (legend-786te).
 */
export type PayoutGrantorPool = {
  readonly pool: Pool;
  /** True when the caller must run `SET LOCAL ROLE legend_payout_grantor`. */
  readonly fallbackRole: boolean;
};

const POOL_OPTIONS = {
  max: 2,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
  // A grant issue waits on a foreign key lock at worst; bound it so two
  // connections cannot stall every payout step (issueError answers 503).
  lock_timeout: 5000,
  statement_timeout: 10000,
};

let current: PayoutGrantorPool | null | undefined;

function onError(err: unknown) {
  logger.error(
    { err, module: "db-grantor" },
    "An idle payout grantor connection was lost. Check database availability.",
  );
}

/** Lazy: nothing connects until the first grant is issued. */
export function payoutGrantorPool(): PayoutGrantorPool | null {
  if (current !== undefined) return current;
  if (env.PAYOUT_GRANTOR_DATABASE_URL) {
    const pool = createGrantorPool(
      env.PAYOUT_GRANTOR_DATABASE_URL,
      POOL_OPTIONS,
    );
    pool.on("error", onError);
    current = { pool, fallbackRole: false };
  } else if (env.NODE_ENV === "development" || env.NODE_ENV === "test") {
    // The test server's DATABASE_URL is the runtime application login, which
    // cannot become the grantor role: tests give the owner login separately.
    const url =
      (env.NODE_ENV === "test"
        ? process.env.STARTER_TEST_DATABASE_URL
        : undefined) || env.DATABASE_URL;
    const pool = createGrantorPool(url, POOL_OPTIONS, {
      fallbackRole: true,
    });
    pool.on("error", onError);
    current = { pool, fallbackRole: true };
  } else {
    current = null;
  }
  return current;
}

/** Ends the grantor pool if it was ever opened (server.ts shutdown). */
export async function closePayoutGrantorPool() {
  const open = current;
  current = undefined;
  await open?.pool.end().catch(() => {});
}

// Session limits for the migrator (bead legend-jluo).
//
// deploy/single-vm/deploy.sh migrates while the previous api and worker are
// still serving. A migration that needs a strong lock (ALTER TABLE, NO FORCE
// ROW LEVEL SECURITY, ADD FOREIGN KEY) waits behind any long read on that
// table, and every new request then queues behind the waiting lock: the old
// API stalls for as long as the migration waits. lock_timeout bounds that
// wait. drizzle applies all pending files in one transaction, so a lock
// timeout rolls everything back and the deploy stops with nothing applied.
//
// statement_timeout is a separate setting and defaults to off for the
// migrator, so a legitimate long backfill is never cut, even when the role or
// database carries a default statement_timeout.
import type { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { databaseError } from "./connection";

export const DEFAULT_MIGRATION_LOCK_TIMEOUT = "10s";
export const DEFAULT_MIGRATION_STATEMENT_TIMEOUT = "0";

export type MigrationTimeouts = {
  lockTimeout: string;
  statementTimeout: string;
};

// A bad MIGRATION_*_TIMEOUT value: its message is safe to print as is.
export class MigrationSettingError extends Error {}

// "0" (no limit) or a positive whole number with a unit: ms, s or min. A bare
// number would mean milliseconds to PostgreSQL ("10" = 10ms), so it is refused,
// and so is anything above PostgreSQL's limit (2147483647 ms).
const durationPattern = /^(?:0|([1-9]\d{0,9})(ms|s|min))$/;
const unitMs = { ms: 1, s: 1_000, min: 60_000 } as const;
const MAX_TIMEOUT_MS = 2_147_483_647;

function duration(name: string, raw: string | undefined, fallback: string) {
  const value = raw?.trim() || fallback;
  const match = durationPattern.exec(value);
  const ms = match?.[1]
    ? Number(match[1]) * unitMs[match[2] as keyof typeof unitMs]
    : 0;
  if (!match || ms > MAX_TIMEOUT_MS)
    throw new MigrationSettingError(
      `${name} must be 0 or a whole number with ms, s or min, at most 35791min (for example 10s); got "${value}".`,
    );
  return value;
}

export function migrationTimeouts(
  env: Record<string, string | undefined> = process.env,
): MigrationTimeouts {
  return {
    lockTimeout: duration(
      "MIGRATION_LOCK_TIMEOUT",
      env.MIGRATION_LOCK_TIMEOUT,
      DEFAULT_MIGRATION_LOCK_TIMEOUT,
    ),
    statementTimeout: duration(
      "MIGRATION_STATEMENT_TIMEOUT",
      env.MIGRATION_STATEMENT_TIMEOUT,
      DEFAULT_MIGRATION_STATEMENT_TIMEOUT,
    ),
  };
}

// Applies the folder on one checked-out connection, so the session settings
// hold for the migration transaction (a pool could hand drizzle another one).
export async function runMigrations(
  pool: Pool,
  migrationsFolder: string,
  timeouts: MigrationTimeouts,
  options?: { edgeMode?: boolean },
) {
  const client = await pool.connect();
  try {
    // legend.edge_mode lets a migration skip cloud-only constraints on an edge
    // database (0374 modifiers_recipe_fk).
    await client.query(
      `SELECT set_config('lock_timeout', $1, false), set_config('statement_timeout', $2, false), set_config('legend.edge_mode', $3, false)`,
      [
        timeouts.lockTimeout,
        timeouts.statementTimeout,
        options?.edgeMode ? "on" : "off",
      ],
    );
    await migrate(drizzle(client), { migrationsFolder });
  } finally {
    client.release();
  }
}

function errorCode(error: unknown) {
  const err = error as { code?: string; cause?: { code?: string } };
  return err.cause?.code || err.code;
}

export function migrationError(
  error: unknown,
  timeouts: MigrationTimeouts | undefined,
) {
  if (error instanceof MigrationSettingError) return error.message;
  if (!timeouts) return databaseError(error);
  const code = errorCode(error);
  if (code === "55P03")
    return `Migration stopped: a lock was not granted within MIGRATION_LOCK_TIMEOUT (${timeouts.lockTimeout}) because another session holds it (a table lock behind a long query, or a row lock held by a running service). Nothing was applied (all pending migrations roll back together). Retry when traffic is lower, or raise MIGRATION_LOCK_TIMEOUT for this run.`;
  if (code === "57014")
    return `Migration stopped: a statement ran longer than MIGRATION_STATEMENT_TIMEOUT (${timeouts.statementTimeout}) or was cancelled. Nothing was applied (all pending migrations roll back together). Raise or unset MIGRATION_STATEMENT_TIMEOUT for long backfills.`;
  if (code === "40P01")
    return "Migration stopped: PostgreSQL broke a deadlock between the migration and a running service. Nothing was applied (all pending migrations roll back together). Retry the deploy.";
  return databaseError(error);
}

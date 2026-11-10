// Audit retention purge (legend-usyi). Once a day the cloud worker deletes
// audit_logs rows past their 2-year retention through the two SECURITY DEFINER
// functions app.audit_retention_due_tenants() and
// app.purge_audit_retention_batch(). The worker connects as the dedicated
// legend_maint_* login, which holds EXECUTE on those functions and nothing
// else: no table grant, no RLS bypass, no membership in legend_app.
//
// Each batch is one call, so one transaction: the function deletes up to the
// batch size and writes its single summary audit row in that same transaction.
// A tenant that fails is logged and skipped (fail closed per tenant); the
// others still run, and the next daily run retries it. Work past the per-tenant
// batch cap or the run budget waits for the next run.

import { Pool, type PoolConfig } from "pg";

export const AUDIT_RETENTION_QUEUE = "audit-retention-purge";
export const AUDIT_RETENTION_CRON = "30 2 * * *";
export const AUDIT_RETENTION_TZ = "Asia/Jakarta";
export const AUDIT_RETENTION_BATCH = 1000;
export const AUDIT_RETENTION_MAX_BATCHES_PER_TENANT = 200;
export const AUDIT_RETENTION_RUN_BUDGET_MS = 20 * 60_000;
/** pg-boss must not expire a run that is still inside its budget plus one batch. */
const AUDIT_RETENTION_EXPIRE_SECONDS = 25 * 60;

const DUE_TENANTS_SQL = "SELECT app.audit_retention_due_tenants() AS tenant_id";
const PURGE_BATCH_SQL =
  "SELECT app.purge_audit_retention_batch($1, $2) AS deleted";

type Queryable = {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
};

export type AuditRetentionRunResult = {
  /** Tenants that had expired rows at the start of the run. */
  tenants: number;
  deleted: number;
  failedTenants: number;
  /** True when the batch cap or the run budget left expired rows for the next run. */
  truncated: boolean;
};

export async function runAuditRetentionPurge(options: {
  pool: Queryable;
  log?: Pick<Console, "error">;
  clock?: () => number;
  batchSize?: number;
  maxBatchesPerTenant?: number;
  budgetMs?: number;
}): Promise<AuditRetentionRunResult> {
  const { pool } = options;
  const log = options.log ?? console;
  const clock = options.clock ?? Date.now;
  const batchSize = options.batchSize ?? AUDIT_RETENTION_BATCH;
  const maxBatches =
    options.maxBatchesPerTenant ?? AUDIT_RETENTION_MAX_BATCHES_PER_TENANT;
  const budgetMs = options.budgetMs ?? AUDIT_RETENTION_RUN_BUDGET_MS;
  const startedAt = clock();
  const overBudget = () => clock() - startedAt >= budgetMs;

  // A listing failure is not tenant-specific: let it fail the job so pg-boss
  // records it and the next schedule retries.
  const due = await pool.query(DUE_TENANTS_SQL);
  const tenantIds = due.rows.map((row) => String(row.tenant_id));
  const result: AuditRetentionRunResult = {
    tenants: tenantIds.length,
    deleted: 0,
    failedTenants: 0,
    truncated: false,
  };

  for (const tenantId of tenantIds) {
    if (overBudget()) {
      result.truncated = true;
      break;
    }
    try {
      for (let batch = 0; ; batch += 1) {
        if (batch >= maxBatches || overBudget()) {
          result.truncated = true;
          break;
        }
        const purged = await pool.query(PURGE_BATCH_SQL, [tenantId, batchSize]);
        const deleted = Number(purged.rows[0]?.deleted ?? 0);
        result.deleted += deleted;
        if (deleted < batchSize) break;
      }
    } catch (error) {
      result.failedTenants += 1;
      log.error(
        `Audit retention purge failed for tenant ${tenantId}: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    }
  }
  return result;
}

/**
 * Open and release one connection so the pool `verify` guard and the login run
 * once at start: a wrong, placeholder, owner or non-member login fails the
 * worker start instead of waiting for the first 02:30 run.
 */
export async function probeMaintenanceConnection(pool: {
  connect(): Promise<{ release(): void }>;
}): Promise<void> {
  const client = await pool.connect();
  client.release();
}

/** Maintenance login pool: one connection, bounded statements and lock waits. */
export function createMaintenancePool(
  connectionString: string,
  verify: PoolConfig["verify"],
): Pool {
  const pool = new Pool({
    connectionString,
    max: 1,
    statement_timeout: 60_000,
    lock_timeout: 5_000,
    verify,
  });
  pool.on("error", () =>
    console.error("Audit retention maintenance connection error"),
  );
  return pool;
}

type AuditRetentionBoss = {
  createQueue(
    name: string,
    options?: { policy?: string; expireInSeconds?: number },
  ): Promise<void>;
  schedule(
    name: string,
    cron: string,
    data?: object | null,
    options?: { tz?: string },
  ): Promise<void>;
  work(
    name: string,
    handler: (jobs: { data: unknown }[]) => Promise<void>,
  ): Promise<unknown>;
};

/** Call after the boss has started. `exclusive` keeps a slow run from overlapping the next. */
export async function registerAuditRetentionJob(options: {
  boss: AuditRetentionBoss;
  pool: Queryable;
  log?: Pick<Console, "error" | "info">;
}): Promise<void> {
  const { boss, pool } = options;
  const log = options.log ?? console;
  await boss.createQueue(AUDIT_RETENTION_QUEUE, {
    policy: "exclusive",
    expireInSeconds: AUDIT_RETENTION_EXPIRE_SECONDS,
  });
  await boss.schedule(AUDIT_RETENTION_QUEUE, AUDIT_RETENTION_CRON, null, {
    tz: AUDIT_RETENTION_TZ,
  });
  await boss.work(AUDIT_RETENTION_QUEUE, async () => {
    try {
      const result = await runAuditRetentionPurge({ pool, log });
      log.info(
        `Audit retention purge finished ${JSON.stringify({
          tenants: result.tenants,
          deleted: result.deleted,
          failedTenants: result.failedTenants,
          truncated: result.truncated,
        })}`,
      );
      // A failed tenant fails the job so pg-boss records it; a retry is safe
      // (the purge is idempotent and the next run picks up what is left).
      if (result.failedTenants > 0)
        throw new Error(
          `Audit retention purge failed for ${result.failedTenants} tenant(s)`,
        );
    } catch (error) {
      log.error(
        `Audit retention purge job failed: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
      throw error;
    }
  });
}

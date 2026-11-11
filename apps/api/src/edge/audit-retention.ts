// The edge uses the same two maintenance functions and restricted login as
// the cloud worker. No direct DELETE, application-role grant or RLS bypass.
import { verifyMaintenanceConnection } from "../db/role.ts";
import { logger } from "../lib/logger.ts";
import {
  createMaintenancePool,
  probeMaintenanceConnection,
  runAuditRetentionPurge,
  type AuditRetentionRunResult,
} from "../worker/audit-retention.job.ts";
import { resolveMaintenanceDatabaseUrl } from "../worker/production-config.ts";

const DEFAULT_INTERVAL_MS = 24 * 60 * 60_000;

type RetentionPool = {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
  connect(): Promise<{ release(): void }>;
  end(): Promise<void>;
};

export interface EdgeAuditRetentionHandle {
  runOnce(): Promise<AuditRetentionRunResult | null>;
  stop(): Promise<void>;
}

export interface StartEdgeAuditRetentionOptions {
  source: Record<string, string | undefined>;
  onOwnerAlarm?: () => void | Promise<void>;
  /** Test seam; production creates a guarded, single-connection pool. */
  pool?: RetentionPool;
  intervalMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export function resolveEdgeAuditRetentionUrl(
  source: Record<string, string | undefined>,
): string | null {
  // A missing maintenance login disables only housekeeping, never offline
  // sales. A configured but malformed URL is still a boot configuration error.
  if (!source.MAINTENANCE_DATABASE_URL?.trim()) return null;
  return resolveMaintenanceDatabaseUrl({ env: source, cloud: true });
}

function defaultSetTimer(fn: () => void, ms: number): unknown {
  const handle = setTimeout(fn, ms);
  handle.unref();
  return handle;
}

function defaultClearTimer(handle: unknown): void {
  clearTimeout(handle as ReturnType<typeof setTimeout>);
}

/** Error class only: database errors may contain parameters or credentials. */
function errorLabel(error: unknown): string {
  const candidate = error as { code?: unknown; name?: unknown };
  if (typeof candidate?.code === "string") return candidate.code;
  if (typeof candidate?.name === "string") return candidate.name;
  return "Error";
}

/**
 * Probe before starting the audit sweep, then run daily without overlap.
 * A missing local maintenance login skips housekeeping and raises an alarm;
 * it never takes offline POS down. stop() drains the sweep before pool close.
 */
export async function startEdgeAuditRetention(
  options: StartEdgeAuditRetentionOptions,
): Promise<EdgeAuditRetentionHandle | null> {
  const url = resolveEdgeAuditRetentionUrl(options.source);
  if (!url) {
    try {
      logger.error(
        "Edge audit retention skipped without MAINTENANCE_DATABASE_URL; owner action required",
      );
    } catch {
      // Logging must not take offline sales down either.
    }
    try {
      await options.onOwnerAlarm?.();
    } catch (error) {
      try {
        logger.error(
          { code: errorLabel(error) },
          "Edge audit retention owner alarm failed",
        );
      } catch {
        // The runtime's heartbeat repeats the owner alarm while missing.
      }
    }
    return null;
  }
  const pool =
    options.pool ?? createMaintenancePool(url, verifyMaintenanceConnection);
  try {
    await probeMaintenanceConnection(pool);
  } catch {
    await pool.end().catch(() => {});
    throw new Error("Edge audit retention maintenance connection probe failed");
  }

  const setTimer = options.setTimer ?? defaultSetTimer;
  const clearTimer = options.clearTimer ?? defaultClearTimer;
  let stopped = false;
  let timer: unknown = null;
  let inFlight: Promise<AuditRetentionRunResult | null> | null = null;
  let stopping: Promise<void> | null = null;

  function cancelTimer(): void {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  }

  function schedule(): void {
    cancelTimer();
    if (stopped) return;
    timer = setTimer(() => {
      timer = null;
      void runOnce();
    }, options.intervalMs ?? DEFAULT_INTERVAL_MS);
  }

  async function execute(): Promise<AuditRetentionRunResult | null> {
    try {
      const result = await runAuditRetentionPurge({
        pool,
        // The cloud helper's message can include tenant ids and raw errors;
        // discard it and expose only the safe aggregate counts below.
        log: { error: () => {} },
      });
      if (result.failedTenants > 0)
        logger.error(result, "Edge audit retention purge had failed tenants");
      else logger.info(result, "Edge audit retention purge finished");
      return result;
    } catch (error) {
      try {
        logger.error(
          { code: errorLabel(error) },
          "Edge audit retention purge failed",
        );
      } catch {
        // A broken logger must not stop the next scheduled sweep.
      }
      return null;
    } finally {
      schedule();
    }
  }

  function runOnce(): Promise<AuditRetentionRunResult | null> {
    if (inFlight) return inFlight;
    if (stopped) return Promise.resolve(null);
    cancelTimer();
    const promise = execute().finally(() => {
      if (inFlight === promise) inFlight = null;
    });
    inFlight = promise;
    return promise;
  }

  void runOnce();
  return {
    runOnce,
    stop() {
      if (stopping) return stopping;
      stopped = true;
      cancelTimer();
      stopping = (async () => {
        if (inFlight) await inFlight;
        await pool.end();
      })();
      return stopping;
    },
  };
}

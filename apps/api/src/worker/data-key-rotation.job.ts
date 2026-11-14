// Scheduled data-key rotation (bead legend-rg8yl). After an operator raises
// DATA_ENCRYPTION_ACTIVE_KEY_VERSION (docs/deployment.md "Rotasi kunci data"),
// this job re-seals what is still on an older key, once a day, so a rotation no
// longer depends on someone running `pnpm db:rotate-data-key`. The CLI stays for
// --force, --dry-run and a single tenant.
//
// It walks EVERY tenant (suspended and archived included, ids only, no RLS
// table) and calls rotateIntegrationCredentials and rotateAiProviderKeys
// without force: rows already at the active version are skipped, so a run with
// nothing stale changes nothing and the job is safe to repeat. Each call runs
// under a trusted job context with tenant-wide scope, so RLS still applies.
//
// One instance at a time: the run holds a session-level advisory lock
// (pg_try_advisory_lock, pattern of edge/runtime.ts) on a dedicated pooled
// connection. It is not a transaction lock on purpose: that transaction would
// sit idle while the rotations run on other connections, and the app login's
// idle_in_transaction_session_timeout (5 min) would end it and drop the lock.
// Another worker that took the same lock makes this run return `skipped`
// without touching anything. The lock is released in `finally` (unlock, then
// the client goes back to the pool) and also when the connection or process
// dies. The queue is `exclusive` as well, so pg-boss does not overlap two runs
// of one deployment. The CLI (`pnpm db:rotate-data-key`) does NOT take this
// lock; running it alongside the job is safe because each row is rotated under
// FOR UPDATE and a row already on the active version is skipped.
//
// A tenant that fails (a value that will not open, a database error) is
// logged by id and skipped; the others still run and the next day retries it.
// Logs carry counts and tenant ids only: never keys, ciphertext, row contents
// or error messages (a driver error can quote the query parameters).

import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import type { ScopedTenantContext } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { db } from "../db/index.ts";
import type * as schema from "../db/schema/index.ts";
import { rotateAiProviderKeys } from "../services/ai-provider-config.service.ts";
import { rotateIntegrationCredentials } from "../services/platform-integration.service.ts";

type Database = NodePgDatabase<typeof schema> & { $client: Pool };
type Log = Pick<Console, "error" | "info">;

export const DATA_KEY_ROTATION_QUEUE = "data-key-rotation";
/** Lock name, hashed with hashtextextended(name, 0). */
export const DATA_KEY_ROTATION_LOCK_KEY = "data-key-rotation";
/** Daily, 03:15 Asia/Jakarta (after the 02:45 WhatsApp retention job). */
export const DATA_KEY_ROTATION_CRON = "15 3 * * *";
export const DATA_KEY_ROTATION_TZ = "Asia/Jakarta";
/** Longer than a run over all tenants; shorter than a day. */
const DATA_KEY_ROTATION_EXPIRE_SECONDS = 2 * 60 * 60;

export type DataKeyRotationResult = {
  tenants: number;
  aiRotated: number;
  integrationsRotated: number;
  failedTenants: number;
  /** True when another session held the lock and nothing was done. */
  skipped: boolean;
};

function jobContext(tenantId: string): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "job" }),
    { kind: "tenant" },
  );
}

/** Every tenant id, suspended and archived included. */
async function listAllTenantIds(database: Database): Promise<string[]> {
  const result = await database.execute(
    sql`SELECT id FROM public.tenants ORDER BY id`,
  );
  return result.rows.map((row) => String(row.id));
}

export async function runDataKeyRotation(
  options: { database?: Database; log?: Log } = {},
): Promise<DataKeyRotationResult> {
  const database = options.database ?? db;
  const log = options.log ?? console;
  const client = await database.$client.connect();
  // An error on an idle checked-out client must not crash the process; the
  // connection is then destroyed on release instead of reused.
  let broken = false;
  const onError = () => {
    broken = true;
  };
  client.on("error", onError);
  let locked = false;
  try {
    const lock = await client.query<{ ok: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok",
      [DATA_KEY_ROTATION_LOCK_KEY],
    );
    if (lock.rows[0]?.ok !== true) {
      log.info("Data key rotation skipped: another run holds the lock");
      return {
        tenants: 0,
        aiRotated: 0,
        integrationsRotated: 0,
        failedTenants: 0,
        skipped: true,
      };
    }
    locked = true;

    const result: DataKeyRotationResult = {
      tenants: 0,
      aiRotated: 0,
      integrationsRotated: 0,
      failedTenants: 0,
      skipped: false,
    };
    for (const tenantId of await listAllTenantIds(database)) {
      result.tenants += 1;
      let failed = false;
      // Each part has its own transaction; a failure of one still lets the
      // other run (the failed one rolled back whole).
      try {
        const integrations = await rotateIntegrationCredentials(
          jobContext(tenantId),
          { actorUserId: null },
        );
        result.integrationsRotated += integrations.rotated;
        if (integrations.rotated > 0)
          log.info(
            `Data key rotation: tenant ${tenantId} integrations rotated ${integrations.rotated}`,
          );
      } catch {
        failed = true;
        log.error(
          `Data key rotation: integrations failed for tenant ${tenantId} (details withheld)`,
        );
      }
      try {
        const ai = await rotateAiProviderKeys(jobContext(tenantId), {
          actorUserId: null,
        });
        result.aiRotated += ai.rotated;
        if (ai.rotated > 0)
          log.info(
            `Data key rotation: tenant ${tenantId} AI keys rotated ${ai.rotated}`,
          );
      } catch {
        failed = true;
        log.error(
          `Data key rotation: AI keys failed for tenant ${tenantId} (details withheld)`,
        );
      }
      if (failed) result.failedTenants += 1;
    }
    return result;
  } finally {
    try {
      if (locked && !broken)
        await client.query(
          "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
          [DATA_KEY_ROTATION_LOCK_KEY],
        );
    } catch {
      broken = true;
    }
    client.removeListener("error", onError);
    // A destroyed connection drops the session lock with it.
    client.release(broken);
  }
}

type DataKeyRotationBoss = {
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
export async function registerDataKeyRotationJob(options: {
  boss: DataKeyRotationBoss;
  database?: Database;
  log?: Log;
}): Promise<void> {
  const { boss } = options;
  const log = options.log ?? console;
  await boss.createQueue(DATA_KEY_ROTATION_QUEUE, {
    policy: "exclusive",
    expireInSeconds: DATA_KEY_ROTATION_EXPIRE_SECONDS,
  });
  await boss.schedule(DATA_KEY_ROTATION_QUEUE, DATA_KEY_ROTATION_CRON, null, {
    tz: DATA_KEY_ROTATION_TZ,
  });
  await boss.work(DATA_KEY_ROTATION_QUEUE, async () => {
    try {
      const result = await runDataKeyRotation({
        log,
        ...(options.database ? { database: options.database } : {}),
      });
      log.info(`Data key rotation finished ${JSON.stringify(result)}`);
      // A failed tenant fails the job so pg-boss records it; a rerun only
      // touches the rows still stale.
      if (result.failedTenants > 0)
        throw new Error(
          `Data key rotation failed for ${result.failedTenants} tenant(s)`,
        );
    } catch (error) {
      log.error(
        `Data key rotation job failed: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
      throw error;
    }
  });
}

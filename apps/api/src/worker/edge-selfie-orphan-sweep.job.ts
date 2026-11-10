// Edge selfie orphan sweep (bead legend-0wvoz, C6; design
// docs/design/hris-edge-replication.md 6.3). The edge uploads a sealed selfie
// before its attendance event may reach the cloud. When the event never
// arrives (rejected, lost, the log purged), the stored selfie has no
// attendance log pointing at it. Once a day this job deletes such an orphan
// 14 days after the cloud received it: the S3 original and thumbnail, then the
// `core_storage_objects` row. The `edge_received_selfies` receipt stays (the
// table is append-only), so a late retry of the same sealed file gets 200
// without writing anything again.
//
// The storage delete runs first: a failure keeps the object row and counts as
// `failed`, and the next run retries (adapter deletes are idempotent). Each
// object runs in its own tenant transaction under the same advisory lock as
// `linkEdgeSelfie`, with the "no log points at it" check repeated inside, so a
// link racing the sweep either wins (the object stays) or loses cleanly. A
// failing object or tenant is logged and skipped; the others still run. Log
// lines carry counts and tenant ids only, never object ids or keys.
//
// Cross-tenant like the other worker sweeps: tenant ids come from
// app.active_tenant_registry and each tenant runs under a trusted job context
// with tenant-wide scope, so RLS still applies. worker-main.ts registers it.

import { and, asc, eq, gt, lt, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { ObjectStorage } from "@starter/shared/adapters";
import {
  assertTrustedScopedContext,
  outletIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { db } from "../db/index.ts";
import type * as schema from "../db/schema/index.ts";
import { coreStorageObjects } from "../db/schema/core-storage.ts";
import { edgeReceivedSelfies } from "../db/schema/edge-hris.ts";
import { withTenant } from "../db/tenant.ts";

type Database = NodePgDatabase<typeof schema>;

export const EDGE_SELFIE_ORPHAN_SWEEP_QUEUE = "edge-selfie-orphan-sweep";
export const EDGE_SELFIE_ORPHAN_SWEEP_CRON = "15 3 * * *";
export const EDGE_SELFIE_ORPHAN_SWEEP_TZ = "Asia/Jakarta";
export const EDGE_SELFIE_ORPHAN_SWEEP_DAYS = 14;
export const EDGE_SELFIE_ORPHAN_SWEEP_BATCH = 200;
export const EDGE_SELFIE_ORPHAN_SWEEP_MAX_BATCHES_PER_TENANT = 50;
const MS_PER_DAY = 86_400_000;
const EDGE_SELFIE_ORPHAN_SWEEP_EXPIRE_SECONDS = 30 * 60;

export type EdgeSelfieOrphanSweepDeps = {
  storage: Pick<ObjectStorage, "delete">;
  database?: Database;
  log?: Pick<Console, "error">;
  /** Test hook; defaults to the active tenant registry. */
  listTenantIds?: () => Promise<string[]>;
};

export type EdgeSelfieOrphanSweepResult = {
  deleted: number;
  failed: number;
};

async function activeTenantIds(database: Database): Promise<string[]> {
  const result = await database.execute(
    sql`SELECT id FROM app.active_tenant_registry`,
  );
  return result.rows.map((row) => String(row.id));
}

function jobContext(tenantId: string): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "job" }),
    { kind: "tenant" },
  );
}

/** True while an attendance log still points at the object. */
const logPointsAtObject = (tenantId: string, objectId: unknown) =>
  sql`EXISTS (
    SELECT 1 FROM "attendance_logs"
    WHERE "attendance_logs"."tenant_id" = ${tenantId}
      AND "attendance_logs"."photo_key" = ${objectId}::text
  )`;

/** Delete one orphan; returns false when it is no longer an orphan. */
async function sweepOne(
  database: Database,
  context: ScopedTenantContext,
  objectId: string,
  storage: Pick<ObjectStorage, "delete">,
): Promise<boolean> {
  const tenantId = context.tenant.tenantId;
  return withTenant(database, context, async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`attendance-selfie-link:${tenantId}:${objectId}`}, 0))`,
    );
    const [object] = await tx
      .select()
      .from(coreStorageObjects)
      .where(
        and(
          eq(coreStorageObjects.tenantId, tenantId),
          eq(coreStorageObjects.id, objectId),
        ),
      )
      .limit(1);
    if (!object) return false;
    const pointed = await tx.execute(
      sql`SELECT ${logPointsAtObject(tenantId, objectId)} AS pointed`,
    );
    if (pointed.rows[0]?.pointed !== false) return false;

    const lookup = {
      tenantId,
      outletId: outletIdSchema.nullable().parse(object.outletId),
      reference: object.id,
      visibility: "private" as const,
    };
    await storage.delete(context, { ...lookup, key: object.objectKey });
    if (object.thumbnailKey)
      await storage.delete(context, { ...lookup, key: object.thumbnailKey });
    await tx
      .delete(coreStorageObjects)
      .where(
        and(
          eq(coreStorageObjects.tenantId, tenantId),
          eq(coreStorageObjects.id, object.id),
        ),
      );
    return true;
  });
}

/**
 * Sweep the orphans of one tenant. Pages by object id so an object that keeps
 * failing never starves later ones.
 */
async function sweepTenant(
  database: Database,
  context: ScopedTenantContext,
  now: Date,
  deps: Pick<EdgeSelfieOrphanSweepDeps, "storage" | "log">,
): Promise<EdgeSelfieOrphanSweepResult> {
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  const log = deps.log ?? console;
  const result: EdgeSelfieOrphanSweepResult = { deleted: 0, failed: 0 };
  const cutoff = new Date(
    now.getTime() - EDGE_SELFIE_ORPHAN_SWEEP_DAYS * MS_PER_DAY,
  );

  let cursor: string | null = null;
  for (
    let page = 0;
    page < EDGE_SELFIE_ORPHAN_SWEEP_MAX_BATCHES_PER_TENANT;
    page += 1
  ) {
    const lastId: string | null = cursor;
    const rows: { objectId: string }[] = await withTenant(
      database,
      context,
      (tx) =>
        tx
          .select({ objectId: edgeReceivedSelfies.objectId })
          .from(edgeReceivedSelfies)
          .innerJoin(
            coreStorageObjects,
            and(
              eq(coreStorageObjects.tenantId, edgeReceivedSelfies.tenantId),
              eq(coreStorageObjects.id, edgeReceivedSelfies.objectId),
            ),
          )
          .where(
            and(
              eq(edgeReceivedSelfies.tenantId, tenantId),
              eq(edgeReceivedSelfies.state, "stored"),
              lt(edgeReceivedSelfies.receivedAt, cutoff),
              sql`NOT ${logPointsAtObject(
                tenantId,
                sql`"edge_received_selfies"."object_id"`,
              )}`,
              lastId === null
                ? undefined
                : gt(edgeReceivedSelfies.objectId, lastId),
            ),
          )
          .orderBy(asc(edgeReceivedSelfies.objectId))
          .limit(EDGE_SELFIE_ORPHAN_SWEEP_BATCH),
    );
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1]!.objectId;

    for (const row of rows) {
      try {
        if (await sweepOne(database, context, row.objectId, deps.storage))
          result.deleted += 1;
      } catch (error) {
        result.failed += 1;
        log.error(
          `Edge selfie orphan sweep failed for an object of tenant ${tenantId}: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        );
      }
    }
    if (rows.length < EDGE_SELFIE_ORPHAN_SWEEP_BATCH) break;
  }
  return result;
}

/** Sweep the orphan edge selfies of every active tenant. One tenant's failure never stops the others. */
export async function sweepOrphanEdgeSelfies(
  now: Date,
  deps: EdgeSelfieOrphanSweepDeps,
): Promise<EdgeSelfieOrphanSweepResult> {
  const database = deps.database ?? db;
  const log = deps.log ?? console;
  // A listing failure is not tenant-specific: let it fail the job so pg-boss
  // records it and the next schedule retries.
  const tenantIds = await (
    deps.listTenantIds ?? (() => activeTenantIds(database))
  )();
  const total: EdgeSelfieOrphanSweepResult = { deleted: 0, failed: 0 };
  for (const tenantId of tenantIds) {
    try {
      const outcome = await sweepTenant(database, jobContext(tenantId), now, {
        storage: deps.storage,
        log,
      });
      total.deleted += outcome.deleted;
      total.failed += outcome.failed;
    } catch (error) {
      total.failed += 1;
      log.error(
        `Edge selfie orphan sweep failed for tenant ${tenantId}: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    }
  }
  return total;
}

type EdgeSelfieOrphanSweepBoss = {
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
export async function registerEdgeSelfieOrphanSweepJob(options: {
  boss: EdgeSelfieOrphanSweepBoss;
  storage: Pick<ObjectStorage, "delete">;
  database?: Database;
  log?: Pick<Console, "error" | "info">;
}): Promise<void> {
  const { boss, storage } = options;
  const log = options.log ?? console;
  await boss.createQueue(EDGE_SELFIE_ORPHAN_SWEEP_QUEUE, {
    policy: "exclusive",
    expireInSeconds: EDGE_SELFIE_ORPHAN_SWEEP_EXPIRE_SECONDS,
  });
  await boss.schedule(
    EDGE_SELFIE_ORPHAN_SWEEP_QUEUE,
    EDGE_SELFIE_ORPHAN_SWEEP_CRON,
    null,
    { tz: EDGE_SELFIE_ORPHAN_SWEEP_TZ },
  );
  await boss.work(EDGE_SELFIE_ORPHAN_SWEEP_QUEUE, async () => {
    try {
      const result = await sweepOrphanEdgeSelfies(new Date(), {
        storage,
        log,
        ...(options.database ? { database: options.database } : {}),
      });
      log.info(
        `Edge selfie orphan sweep finished ${JSON.stringify({
          deleted: result.deleted,
          failed: result.failed,
        })}`,
      );
      // A failure fails the job so pg-boss records it; a retry is safe (the
      // sweep is idempotent and the next run picks up what is left).
      if (result.failed > 0)
        throw new Error(
          `Edge selfie orphan sweep failed for ${result.failed} item(s)`,
        );
    } catch (error) {
      log.error(
        `Edge selfie orphan sweep job failed: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
      throw error;
    }
  });
}

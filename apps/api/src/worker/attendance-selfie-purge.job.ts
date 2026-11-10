// Attendance selfie purge (PRD v1.7 §6 H attendance_logs.photo_key "dihapus
// sesuai masa simpan"; F25 privasi selfie; bead legend-wh71). Once a day the
// cloud worker deletes the private selfie of every attendance log whose
// business date lies in a closed payroll period of the employee's legal
// entity (run locked or paid; a reversed run is not a close) once the
// retention window after that close has passed. The window
// comes from the outlet's attendance policy, else the tenant default policy,
// else 90 days. A period with no closed payroll run keeps its selfies.
//
// `photo_key` holds the id of the private `core_storage_objects` row (purpose
// selfie, source kind attendance). The purge deletes the original and the
// thumbnail through the object storage adapter, then the row, then nulls
// `photo_key` and stamps `photo_purged_at`, all in one tenant transaction per
// log. The storage delete runs first: a failure after it leaves the log
// pointing at an already deleted object, and the next run retries (adapter
// deletes are idempotent). A log or tenant that fails is logged and skipped
// (fail closed); the others still run. The log line carries counts only, never
// ids or keys.
//
// Cross-tenant like the other worker sweeps: tenant ids come from
// app.active_tenant_registry and each tenant runs under a trusted job context
// with tenant-wide scope, so RLS still applies. worker-main.ts registers it.

import { and, asc, eq, gt, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { ObjectStorage } from "@starter/shared/adapters";
import {
  assertTrustedScopedContext,
  outletIdSchema,
  uuidSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { db } from "../db/index.ts";
import type * as schema from "../db/schema/index.ts";
import {
  attendanceLogs,
  attendancePolicies,
} from "../db/schema/hris-attendance.ts";
import { coreStorageObjects } from "../db/schema/core-storage.ts";
import { payrollRuns } from "../db/schema/payroll.ts";
import { withTenant } from "../db/tenant.ts";
import { selfieRetentionDue } from "../services/hris-attendance-logic.ts";

type Database = NodePgDatabase<typeof schema>;

export const ATTENDANCE_SELFIE_PURGE_QUEUE = "attendance-selfie-purge";
export const ATTENDANCE_SELFIE_PURGE_CRON = "45 2 * * *";
export const ATTENDANCE_SELFIE_PURGE_TZ = "Asia/Jakarta";
export const ATTENDANCE_SELFIE_RETENTION_DEFAULT_DAYS = 90;
export const ATTENDANCE_SELFIE_PURGE_BATCH = 200;
export const ATTENDANCE_SELFIE_PURGE_MAX_BATCHES_PER_TENANT = 50;
const MS_PER_DAY = 86_400_000;
/** Run states in which the payroll period counts as closed. */
const CLOSED_RUN_STATUSES = ["locked", "paid"];
const ATTENDANCE_SELFIE_PURGE_EXPIRE_SECONDS = 30 * 60;

export type AttendanceSelfiePurgeDeps = {
  storage: Pick<ObjectStorage, "delete">;
  database?: Database;
  log?: Pick<Console, "error">;
  /** Test hook; defaults to the active tenant registry. */
  listTenantIds?: () => Promise<string[]>;
};

export type AttendanceSelfiePurgeResult = {
  purged: number;
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

type Candidate = {
  id: string;
  outletId: string;
  photoKey: string;
  closedAt: Date;
};

/**
 * Purge the due selfies of one tenant; returns the counts. Pages by log id so
 * rows that are not due yet (retention not elapsed) never starve later ones.
 */
async function purgeTenant(
  database: Database,
  context: ScopedTenantContext,
  now: Date,
  deps: Pick<AttendanceSelfiePurgeDeps, "storage" | "log">,
): Promise<AttendanceSelfiePurgeResult> {
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  const log = deps.log ?? console;
  const result: AttendanceSelfiePurgeResult = { purged: 0, failed: 0 };

  const policies = await withTenant(database, context, (tx) =>
    tx
      .select({
        outletId: attendancePolicies.outletId,
        policy: attendancePolicies.policy,
      })
      .from(attendancePolicies)
      .where(eq(attendancePolicies.tenantId, tenantId)),
  );
  const tenantDefault = policies.find((row) => row.outletId === null);
  const retentionFor = (outletId: string): number =>
    policies.find((row) => row.outletId === outletId)?.policy
      .selfieRetentionDays ??
    tenantDefault?.policy.selfieRetentionDays ??
    ATTENDANCE_SELFIE_RETENTION_DEFAULT_DAYS;
  // Smallest window in play: the SQL pre-filter only drops rows no policy
  // could make due, the exact per-outlet check follows in code.
  const minRetentionDays = Math.min(
    ATTENDANCE_SELFIE_RETENTION_DEFAULT_DAYS,
    ...policies.map((row) => row.policy.selfieRetentionDays),
  );
  const dueBefore = new Date(now.getTime() - minRetentionDays * MS_PER_DAY);

  // Earliest close time of any closed run of the employee's legal entity whose
  // period covers the log's day. An employee without a legal entity matches no
  // run, so the selfie stays.
  // Drizzle drops table qualifiers inside a select list, and this join repeats
  // column names, so every column is spelled out with its table.
  const closedAt = sql<Date | null>`(
    SELECT min("payroll_runs"."locked_at") FROM "payroll_runs"
    INNER JOIN "employees"
      ON "employees"."tenant_id" = "payroll_runs"."tenant_id"
      AND "employees"."legal_entity_id" = "payroll_runs"."legal_entity_id"
    WHERE "employees"."id" = "attendance_logs"."employee_id"
      AND "payroll_runs"."tenant_id" = "attendance_logs"."tenant_id"
      AND ${inArray(payrollRuns.status, CLOSED_RUN_STATUSES)}
      AND "payroll_runs"."locked_at" IS NOT NULL
      AND "payroll_runs"."period_start" <= "attendance_logs"."business_date"
      AND "payroll_runs"."period_end" >= "attendance_logs"."business_date"
  )`;

  let cursor: string | null = null;
  for (
    let page = 0;
    page < ATTENDANCE_SELFIE_PURGE_MAX_BATCHES_PER_TENANT;
    page += 1
  ) {
    const lastId: string | null = cursor;
    const rows: {
      id: string;
      outletId: string;
      photoKey: string | null;
      closedAt: Date | string | null;
    }[] = await withTenant(database, context, (tx) =>
      tx
        .select({
          id: attendanceLogs.id,
          outletId: attendanceLogs.outletId,
          photoKey: attendanceLogs.photoKey,
          closedAt,
        })
        .from(attendanceLogs)
        .where(
          and(
            eq(attendanceLogs.tenantId, tenantId),
            isNotNull(attendanceLogs.photoKey),
            isNull(attendanceLogs.photoPurgedAt),
            sql`${closedAt} <= ${dueBefore.toISOString()}::timestamptz`,
            lastId === null ? undefined : gt(attendanceLogs.id, lastId),
          ),
        )
        .orderBy(asc(attendanceLogs.id))
        .limit(ATTENDANCE_SELFIE_PURGE_BATCH),
    );
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1]!.id;

    const due: Candidate[] = [];
    for (const row of rows) {
      if (row.photoKey === null || row.closedAt === null) continue;
      const candidate: Candidate = {
        id: row.id,
        outletId: row.outletId,
        photoKey: row.photoKey,
        closedAt: new Date(row.closedAt),
      };
      if (
        selfieRetentionDue(
          candidate.closedAt,
          retentionFor(candidate.outletId),
          now,
        )
      )
        due.push(candidate);
    }

    for (const candidate of due) {
      try {
        await purgeOne(database, context, now, candidate, deps.storage);
        result.purged += 1;
      } catch (error) {
        result.failed += 1;
        log.error(
          `Attendance selfie purge failed for a log of tenant ${tenantId}: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        );
      }
    }
    if (rows.length < ATTENDANCE_SELFIE_PURGE_BATCH) break;
  }
  return result;
}

async function purgeOne(
  database: Database,
  context: ScopedTenantContext,
  now: Date,
  candidate: Candidate,
  storage: Pick<ObjectStorage, "delete">,
): Promise<void> {
  const tenantId = context.tenant.tenantId;
  const objectId = uuidSchema.parse(candidate.photoKey);
  await withTenant(database, context, async (tx) => {
    const [object] = await tx
      .select()
      .from(coreStorageObjects)
      .where(
        and(
          eq(coreStorageObjects.tenantId, tenantId),
          eq(coreStorageObjects.id, objectId),
          eq(coreStorageObjects.sourceKind, "attendance"),
        ),
      )
      .limit(1);
    if (object) {
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
    }
    await tx
      .update(attendanceLogs)
      .set({ photoKey: null, photoPurgedAt: now })
      .where(
        and(
          eq(attendanceLogs.tenantId, tenantId),
          eq(attendanceLogs.id, candidate.id),
          isNull(attendanceLogs.photoPurgedAt),
        ),
      );
  });
}

/** Purge due selfies of every active tenant. One tenant's failure never stops the others. */
export async function purgeAttendanceSelfies(
  now: Date,
  deps: AttendanceSelfiePurgeDeps,
): Promise<{ purged: number; failed: number }> {
  const database = deps.database ?? db;
  const log = deps.log ?? console;
  // A listing failure is not tenant-specific: let it fail the job so pg-boss
  // records it and the next schedule retries.
  const tenantIds = await (
    deps.listTenantIds ?? (() => activeTenantIds(database))
  )();
  const total: AttendanceSelfiePurgeResult = { purged: 0, failed: 0 };
  for (const tenantId of tenantIds) {
    try {
      const outcome = await purgeTenant(database, jobContext(tenantId), now, {
        storage: deps.storage,
        log,
      });
      total.purged += outcome.purged;
      total.failed += outcome.failed;
    } catch (error) {
      total.failed += 1;
      log.error(
        `Attendance selfie purge failed for tenant ${tenantId}: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    }
  }
  return total;
}

type AttendanceSelfiePurgeBoss = {
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
export async function registerAttendanceSelfiePurgeJob(options: {
  boss: AttendanceSelfiePurgeBoss;
  storage: Pick<ObjectStorage, "delete">;
  database?: Database;
  log?: Pick<Console, "error" | "info">;
}): Promise<void> {
  const { boss, storage } = options;
  const log = options.log ?? console;
  await boss.createQueue(ATTENDANCE_SELFIE_PURGE_QUEUE, {
    policy: "exclusive",
    expireInSeconds: ATTENDANCE_SELFIE_PURGE_EXPIRE_SECONDS,
  });
  await boss.schedule(
    ATTENDANCE_SELFIE_PURGE_QUEUE,
    ATTENDANCE_SELFIE_PURGE_CRON,
    null,
    { tz: ATTENDANCE_SELFIE_PURGE_TZ },
  );
  await boss.work(ATTENDANCE_SELFIE_PURGE_QUEUE, async () => {
    try {
      const result = await purgeAttendanceSelfies(new Date(), {
        storage,
        log,
        ...(options.database ? { database: options.database } : {}),
      });
      log.info(
        `Attendance selfie purge finished ${JSON.stringify({
          purged: result.purged,
          failed: result.failed,
        })}`,
      );
      // A failure fails the job so pg-boss records it; a retry is safe (the
      // purge is idempotent and the next run picks up what is left).
      if (result.failed > 0)
        throw new Error(
          `Attendance selfie purge failed for ${result.failed} item(s)`,
        );
    } catch (error) {
      log.error(
        `Attendance selfie purge job failed: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
      throw error;
    }
  });
}

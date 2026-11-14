// Receipt photo orphan sweep (bead legend-9h4qh, M2). A goods receipt photo is
// uploaded first (purpose `receipt`) and linked to the receipt when it is
// saved (`linkStorageObjectSource`, source_kind `goods_receipt`). A photo that
// is never linked (the form was abandoned, the save was rejected) keeps
// `source_id` null forever. Once a day this job deletes such an orphan 24 hours
// after it was uploaded: the `core_storage_objects` row, then the S3 original
// and thumbnail.
//
// An orphan is an unlinked receipt-purpose object whose source kind is
// `goods_receipt` (uploaded through the receiving flow) and that no other table
// references (`goods_receipt_media`, `reimbursements.receipt_upload_ref`). An
// object with a null or any other source kind is never touched: the general
// upload is also used by SOP, checklist and repair-ticket flows that do not
// link the object, so the sweeper cannot tell those from an abandoned form. Each object runs in its own tenant
// transaction that locks the row (`FOR UPDATE`) and repeats the orphan check
// inside, so a link racing the sweep either wins (the object stays) or loses
// cleanly (the link's UPDATE finds no row). The row is deleted and committed
// first, then the S3 original and thumbnail are removed: a leftover blob is
// acceptable, lost data is not. A failed blob delete is logged and counts as
// `failed` (adapter deletes are idempotent, but the row is gone so it is not
// retried). A failing object or tenant is logged and skipped; the others still
// run. Log lines carry counts and tenant ids only, never object
// ids or keys.
//
// Cross-tenant like the other worker sweeps: tenant ids come from
// app.active_tenant_registry and each tenant runs under a trusted job context
// with tenant-wide scope, so RLS still applies. worker-main.ts registers it.

import {
  and,
  asc,
  eq,
  gt,
  isNull,
  lt,
  notExists,
  sql,
  type SQL,
} from "drizzle-orm";
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
import { goodsReceiptMedia } from "../db/schema/inventory-receiving.ts";
import { reimbursements } from "../db/schema/payroll.ts";
import { withTenant } from "../db/tenant.ts";

type Database = NodePgDatabase<typeof schema>;

export const RECEIPT_PHOTO_ORPHAN_SWEEP_QUEUE = "receipt-photo-orphan-sweep";
export const RECEIPT_PHOTO_ORPHAN_SWEEP_CRON = "45 3 * * *";
export const RECEIPT_PHOTO_ORPHAN_SWEEP_TZ = "Asia/Jakarta";
export const RECEIPT_PHOTO_ORPHAN_SWEEP_HOURS = 24;
export const RECEIPT_PHOTO_ORPHAN_SWEEP_BATCH = 200;
export const RECEIPT_PHOTO_ORPHAN_SWEEP_MAX_BATCHES_PER_TENANT = 50;
const MS_PER_HOUR = 3_600_000;
const RECEIPT_PHOTO_ORPHAN_SWEEP_EXPIRE_SECONDS = 30 * 60;
const RECEIPT_PURPOSE = "receipt";
const GOODS_RECEIPT_SOURCE_KIND = "goods_receipt";

export type ReceiptPhotoOrphanSweepDeps = {
  storage: Pick<ObjectStorage, "delete">;
  database?: Database;
  log?: Pick<Console, "error">;
  /** Test hook; defaults to the active tenant registry. */
  listTenantIds?: () => Promise<string[]>;
};

export type ReceiptPhotoOrphanSweepResult = {
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

/** The orphan test shared by candidate selection and the locked re-check. */
function orphanConditions(
  database: Database,
  tenantId: ScopedTenantContext["tenant"]["tenantId"],
  cutoff: Date,
): (SQL | undefined)[] {
  return [
    eq(coreStorageObjects.tenantId, tenantId),
    eq(coreStorageObjects.purpose, RECEIPT_PURPOSE),
    isNull(coreStorageObjects.sourceId),
    eq(coreStorageObjects.sourceKind, GOODS_RECEIPT_SOURCE_KIND),
    lt(coreStorageObjects.createdAt, cutoff),
    notExists(
      database
        .select({ one: sql`1` })
        .from(goodsReceiptMedia)
        .where(
          and(
            eq(goodsReceiptMedia.tenantId, tenantId),
            eq(goodsReceiptMedia.storageObjectId, coreStorageObjects.id),
          ),
        ),
    ),
    notExists(
      database
        .select({ one: sql`1` })
        .from(reimbursements)
        .where(
          and(
            eq(reimbursements.tenantId, tenantId),
            sql`lower(${reimbursements.receiptUploadRef}) = ${coreStorageObjects.id}::text`,
          ),
        ),
    ),
  ];
}

type SweepOneOutcome = "skipped" | "deleted" | "blob_failed";

/**
 * Delete one orphan row (committed first), then its blobs. Returns "skipped"
 * when it is no longer an orphan.
 */
async function sweepOne(
  database: Database,
  context: ScopedTenantContext,
  objectId: string,
  cutoff: Date,
  storage: Pick<ObjectStorage, "delete">,
  log: Pick<Console, "error">,
): Promise<SweepOneOutcome> {
  const tenantId = context.tenant.tenantId;
  const object = await withTenant(database, context, async (tx) => {
    // Row lock: a concurrent link waits for this transaction and then finds
    // no row; if the link committed first, the re-check below skips it.
    const [locked] = await tx
      .select()
      .from(coreStorageObjects)
      .where(
        and(
          ...orphanConditions(database, tenantId, cutoff),
          eq(coreStorageObjects.id, objectId),
        ),
      )
      .limit(1)
      .for("update");
    if (!locked) return null;
    await tx
      .delete(coreStorageObjects)
      .where(
        and(
          eq(coreStorageObjects.tenantId, tenantId),
          eq(coreStorageObjects.id, locked.id),
        ),
      );
    return locked;
  });
  if (!object) return "skipped";

  // The row is gone and committed; a blob that survives is only an orphan blob.
  try {
    const lookup = {
      tenantId,
      outletId: outletIdSchema.nullable().parse(object.outletId),
      reference: object.id,
      visibility: "private" as const,
    };
    await storage.delete(context, { ...lookup, key: object.objectKey });
    if (object.thumbnailKey)
      await storage.delete(context, { ...lookup, key: object.thumbnailKey });
  } catch (error) {
    log.error(
      `Receipt photo orphan sweep could not delete a blob of tenant ${tenantId}: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
    return "blob_failed";
  }
  return "deleted";
}

/**
 * Sweep the orphans of one tenant. Pages by object id so an object that keeps
 * failing never starves later ones.
 */
async function sweepTenant(
  database: Database,
  context: ScopedTenantContext,
  now: Date,
  deps: Pick<ReceiptPhotoOrphanSweepDeps, "storage" | "log">,
): Promise<ReceiptPhotoOrphanSweepResult> {
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  const log = deps.log ?? console;
  const result: ReceiptPhotoOrphanSweepResult = { deleted: 0, failed: 0 };
  const cutoff = new Date(
    now.getTime() - RECEIPT_PHOTO_ORPHAN_SWEEP_HOURS * MS_PER_HOUR,
  );

  let cursor: string | null = null;
  for (
    let page = 0;
    page < RECEIPT_PHOTO_ORPHAN_SWEEP_MAX_BATCHES_PER_TENANT;
    page += 1
  ) {
    const lastId: string | null = cursor;
    const rows: { objectId: string }[] = await withTenant(
      database,
      context,
      (tx) =>
        tx
          .select({ objectId: coreStorageObjects.id })
          .from(coreStorageObjects)
          .where(
            and(
              ...orphanConditions(database, tenantId, cutoff),
              lastId === null ? undefined : gt(coreStorageObjects.id, lastId),
            ),
          )
          .orderBy(asc(coreStorageObjects.id))
          .limit(RECEIPT_PHOTO_ORPHAN_SWEEP_BATCH),
    );
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1]!.objectId;

    for (const row of rows) {
      try {
        const outcome = await sweepOne(
          database,
          context,
          row.objectId,
          cutoff,
          deps.storage,
          log,
        );
        if (outcome === "deleted") result.deleted += 1;
        else if (outcome === "blob_failed") result.failed += 1;
      } catch (error) {
        result.failed += 1;
        log.error(
          `Receipt photo orphan sweep failed for an object of tenant ${tenantId}: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        );
      }
    }
    if (rows.length < RECEIPT_PHOTO_ORPHAN_SWEEP_BATCH) break;
  }
  return result;
}

/** Sweep the unlinked receipt photos of every active tenant. One tenant's failure never stops the others. */
export async function sweepOrphanReceiptPhotos(
  now: Date,
  deps: ReceiptPhotoOrphanSweepDeps,
): Promise<ReceiptPhotoOrphanSweepResult> {
  const database = deps.database ?? db;
  const log = deps.log ?? console;
  // A listing failure is not tenant-specific: let it fail the job so pg-boss
  // records it and the next schedule retries.
  const tenantIds = await (
    deps.listTenantIds ?? (() => activeTenantIds(database))
  )();
  const total: ReceiptPhotoOrphanSweepResult = { deleted: 0, failed: 0 };
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
        `Receipt photo orphan sweep failed for tenant ${tenantId}: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    }
  }
  return total;
}

type ReceiptPhotoOrphanSweepBoss = {
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
export async function registerReceiptPhotoOrphanSweepJob(options: {
  boss: ReceiptPhotoOrphanSweepBoss;
  storage: Pick<ObjectStorage, "delete">;
  database?: Database;
  log?: Pick<Console, "error" | "info">;
}): Promise<void> {
  const { boss, storage } = options;
  const log = options.log ?? console;
  await boss.createQueue(RECEIPT_PHOTO_ORPHAN_SWEEP_QUEUE, {
    policy: "exclusive",
    expireInSeconds: RECEIPT_PHOTO_ORPHAN_SWEEP_EXPIRE_SECONDS,
  });
  await boss.schedule(
    RECEIPT_PHOTO_ORPHAN_SWEEP_QUEUE,
    RECEIPT_PHOTO_ORPHAN_SWEEP_CRON,
    null,
    { tz: RECEIPT_PHOTO_ORPHAN_SWEEP_TZ },
  );
  await boss.work(RECEIPT_PHOTO_ORPHAN_SWEEP_QUEUE, async () => {
    try {
      const result = await sweepOrphanReceiptPhotos(new Date(), {
        storage,
        log,
        ...(options.database ? { database: options.database } : {}),
      });
      log.info(
        `Receipt photo orphan sweep finished ${JSON.stringify({
          deleted: result.deleted,
          failed: result.failed,
        })}`,
      );
      // A failure fails the job so pg-boss records it; a retry is safe (the
      // sweep is idempotent and the next run picks up what is left).
      if (result.failed > 0)
        throw new Error(
          `Receipt photo orphan sweep failed for ${result.failed} item(s)`,
        );
    } catch (error) {
      log.error(
        `Receipt photo orphan sweep job failed: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
      throw error;
    }
  });
}

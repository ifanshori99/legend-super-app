// Waste & spoilage (PRD v1.7 §3 F16 "Waste & Spoilage": "Pencatatan bahan
// atau menu terbuang dengan alasan baku, foto opsional, dan nilai kerugian";
// §6 E `waste_logs`; §16 "Kartu Stok Append-only": waste is a ledger
// movement; bead legend-ugo).
//
// - An ingredient waste takes the quantity (item base unit) out of the
//   location; a menu-portion waste takes the portion's recipe ingredients
//   (INV-02 plan via the recipe source port, legend-db6). Stock leaves FEFO
//   (earliest expiry first) as `waste` ledger rows sourced from the log.
// - No negative-stock bypass: a waste larger than the location holds is a 409.
// - `valueIdr` (the loss) is quantity x the location moving-average cost,
//   rounded once (PRD §16 "nilai kerugian"); the client never sends it.
// - Retries are bound to the request fingerprint (idempotency table); every
//   write is audited and re-evaluates the par alerts of the moved pairs.

import { randomUUID } from "node:crypto";
import {
  and,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  businessDayRange,
  encodeCursor,
  formatDecimal4,
  idr,
  parseDecimal4,
  type Decimal4,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  wasteLogSchema,
  type createWasteLogInputSchema,
  type WasteLog,
  type wasteLogQuerySchema,
} from "@starter/shared/inventory";
import type { z } from "zod";
import { db } from "../db/index.ts";
import { coreStorageObjects } from "../db/schema/core-storage.ts";
import { inventoryItems, stockLocations } from "../db/schema/inventory.ts";
import { wasteLogs } from "../db/schema/inventory-ops.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { linkStorageObjectSource } from "./core-storage.ts";
import { consumeStockFefo } from "./inventory-expiry.service.ts";
import {
  assertOutlet,
  canViewCost,
  claimIdempotency,
  completeIdempotency,
  cursorInstant,
  cursorKeys,
  cursorUuid,
  inventoryRecipeSource,
  loadOutletClock,
  lockLocations,
  recipeConsumptionPlan,
  recordOpsAudit,
  requestFingerprint,
  requireOpsPermission,
  scaledCostToIdr,
  translateInventoryError,
  type CursorPage,
  type Tx,
} from "./inventory-ops.shared.ts";
import { loadInventoryStaff } from "./inventory-staff-read-model.service.ts";
import { evaluateParAlertsInTransaction } from "./inventory-par-alerts.service.ts";

export type CreateWasteLogInput = z.infer<typeof createWasteLogInputSchema>;
export type WasteLogQuery = z.infer<typeof wasteLogQuerySchema>;

const OPERATION = "waste.create";
/** Clock skew tolerated on a reported `occurredAt` (device vs server). */
const FUTURE_SKEW_MS = 5 * 60_000;
const WASTE_AUDIT_FIELDS = [
  "locationId",
  "targetType",
  "targetId",
  "quantity",
  "reason",
  "valueIdr",
  "occurredAt",
] as const;

type WasteRow = typeof wasteLogs.$inferSelect;

function toWasteLog(row: WasteRow): WasteLog {
  return wasteLogSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    locationId: row.locationId,
    targetType: row.targetType,
    targetId: row.targetId,
    quantity: row.quantity,
    reason: row.reason,
    mediaId: row.mediaId,
    valueIdr: row.valueIdr,
    loggedBy: row.loggedBy,
    occurredAt: row.occurredAt.toISOString(),
    note: row.note,
  });
}

/** The loss value is financial data: masked without `inventory.cost.view`. */
function masked(log: WasteLog, withCost: boolean): WasteLog {
  return withCost ? log : { ...log, valueIdr: idr(0) };
}

async function requireLocation(
  tx: Tx,
  outletId: string,
  locationId: string,
): Promise<void> {
  const [row] = await tx
    .select({ id: stockLocations.id })
    .from(stockLocations)
    .where(
      and(
        eq(stockLocations.id, locationId),
        eq(stockLocations.outletId, outletId),
      ),
    );
  if (!row) throw new HttpError(404, "NOT_FOUND", "Stock location not found.");
}

/** Item -> base-unit quantity the waste takes out of the location. */
async function wastePlan(
  tx: Tx,
  context: ScopedTenantContext,
  input: CreateWasteLogInput,
): Promise<Map<string, Decimal4>> {
  if (input.targetType === "inventory_item") {
    const [item] = await tx
      .select({ id: inventoryItems.id })
      .from(inventoryItems)
      .where(eq(inventoryItems.id, input.targetId));
    if (!item)
      throw new HttpError(404, "NOT_FOUND", "Inventory item not found.");
    return new Map([[item.id, input.quantity]]);
  }
  // A wasted menu portion takes its recipe ingredients (INV-02). Without the
  // recipe engine (legend-db6) the port answers null: fail closed.
  const recipe = await inventoryRecipeSource().loadMenuItemRecipe(
    tx,
    context,
    input.targetId,
  );
  if (!recipe)
    throw new HttpError(
      404,
      "RECIPE_NOT_FOUND",
      "This menu item has no recipe to value the waste.",
    );
  return recipeConsumptionPlan(tx, recipe, input.quantity);
}

/**
 * POST waste log. Needs `inventory.waste.record` on the outlet (route and
 * service). The ledger rows post at record time; `occurredAt` is the reported
 * time of the loss (not in the future) kept on the document, so a late report
 * never back-dates the moving average (legend-bsw9).
 */
export async function createWasteLog(
  context: ScopedTenantContext,
  actorUserId: string,
  input: CreateWasteLogInput,
): Promise<WasteLog> {
  assertOutlet(context, input.outletId);
  const now = new Date();
  if (
    input.occurredAt !== undefined &&
    Date.parse(input.occurredAt) > now.getTime() + FUTURE_SKEW_MS
  )
    throw new HttpError(
      422,
      "VALIDATION_ERROR",
      "occurredAt cannot be in the future.",
    );
  const claim = {
    operation: OPERATION,
    key: input.idempotencyKey,
    outletId: input.outletId,
    fingerprint: requestFingerprint(OPERATION, actorUserId, {
      outletId: input.outletId,
      locationId: input.locationId,
      targetType: input.targetType,
      targetId: input.targetId,
      quantity: formatDecimal4(parseDecimal4(input.quantity)),
      reason: input.reason,
      mediaId: input.mediaId ?? null,
      occurredAt:
        input.occurredAt === undefined
          ? null
          : new Date(input.occurredAt).toISOString(),
      note: input.note ?? null,
    }),
  };
  try {
    return await withTenant(db, context, async (tx) => {
      const snapshot = await requireOpsPermission(
        tx,
        context,
        actorUserId,
        "inventory.waste.record",
        input.outletId,
      );
      const withCost = canViewCost(snapshot, input.outletId);
      const replay = await claimIdempotency(tx, context, claim);
      if (replay) {
        const log = wasteLogSchema.parse(replay.replay);
        const staff = await loadInventoryStaff(
          tx,
          context.tenant.tenantId,
          log.outletId,
          [log.loggedBy],
        );
        return masked(
          { ...log, loggedByStaff: staff.get(log.loggedBy) ?? null },
          withCost,
        );
      }

      await requireLocation(tx, input.outletId, input.locationId);
      const id = randomUUID();
      // Waste evidence is a private receipt image uploaded by this actor at
      // this outlet. Another feature's media must never become waste evidence.
      // Linking is atomic with the log and stock movements (legend-d78a).
      if (input.mediaId) {
        const [media] = await tx
          .select({ id: coreStorageObjects.id })
          .from(coreStorageObjects)
          .where(
            and(
              eq(coreStorageObjects.tenantId, context.tenant.tenantId),
              eq(coreStorageObjects.id, input.mediaId),
              eq(coreStorageObjects.outletId, input.outletId),
              eq(coreStorageObjects.purpose, "receipt"),
              eq(coreStorageObjects.sourceKind, "waste_log"),
              eq(coreStorageObjects.ownerUserId, actorUserId),
              isNull(coreStorageObjects.sourceId),
              inArray(coreStorageObjects.contentType, [
                "image/jpeg",
                "image/png",
                "image/webp",
              ]),
            ),
          );
        if (!media)
          throw new HttpError(
            422,
            "WASTE_MEDIA_NOT_FOUND",
            "The waste photo must be your own unattached receipt image of this outlet.",
          );
        await linkStorageObjectSource(tx, {
          tenantId: context.tenant.tenantId,
          objectId: input.mediaId,
          sourceKind: "waste_log",
          sourceId: id,
          actorUserId,
          outletId: input.outletId,
        });
      }
      const plan = await wastePlan(tx, context, input);
      await lockLocations(tx, context.tenant.tenantId, [input.locationId]);
      let scaledCost = 0n;
      for (const itemId of [...plan.keys()].sort()) {
        const consumption = await consumeStockFefo(tx, context, {
          outletId: input.outletId,
          locationId: input.locationId,
          inventoryItemId: itemId,
          quantity: plan.get(itemId)!,
          movementType: "waste",
          sourceType: "waste_log",
          sourceId: id,
          actorUserId,
        });
        scaledCost += consumption.scaledCost;
      }
      const [row] = await tx
        .insert(wasteLogs)
        .values({
          id,
          tenantId: context.tenant.tenantId,
          outletId: input.outletId,
          locationId: input.locationId,
          targetType: input.targetType,
          targetId: input.targetId,
          quantity: input.quantity,
          reason: input.reason,
          mediaId: input.mediaId ?? null,
          valueIdr: idr(scaledCostToIdr(scaledCost)),
          loggedBy: actorUserId,
          occurredAt: input.occurredAt ? new Date(input.occurredAt) : now,
          note: input.note ?? null,
        })
        .returning();
      const log = toWasteLog(row!);
      await recordOpsAudit(tx, context, {
        actorUserId,
        outletId: log.outletId,
        action: "inventory.waste_recorded",
        objectType: "waste_log",
        objectId: log.id,
        before: null,
        after: log,
        safeFields: WASTE_AUDIT_FIELDS,
        reason: log.reason,
      });
      await evaluateParAlertsInTransaction(tx, context, input.outletId, {
        pairs: [...plan.keys()].map((inventoryItemId) => ({
          locationId: input.locationId,
          inventoryItemId,
        })),
      });
      await completeIdempotency(tx, context, claim, log);
      const staff = await loadInventoryStaff(
        tx,
        context.tenant.tenantId,
        log.outletId,
        [log.loggedBy],
      );
      return masked(
        { ...log, loggedByStaff: staff.get(log.loggedBy) ?? null },
        withCost,
      );
    });
  } catch (error) {
    throw translateInventoryError(error);
  }
}

/**
 * GET waste logs of one outlet, newest first. `fromDate`/`toDate` are outlet
 * business dates ([cutoff, next cutoff) in the outlet zone, D-CORE-6) over the
 * reported `occurredAt`. Needs `inventory.stock.view`; the loss value needs
 * `inventory.cost.view` too (masked otherwise).
 */
export async function listWasteLogs(
  context: ScopedTenantContext,
  actorUserId: string,
  query: WasteLogQuery,
): Promise<CursorPage<WasteLog>> {
  assertOutlet(context, query.outletId);
  return withTenant(db, context, async (tx) => {
    const snapshot = await requireOpsPermission(
      tx,
      context,
      actorUserId,
      "inventory.stock.view",
      query.outletId,
    );
    const withCost = canViewCost(snapshot, query.outletId);
    const filters: SQL[] = [eq(wasteLogs.outletId, query.outletId)];
    if (query.locationId)
      filters.push(eq(wasteLogs.locationId, query.locationId));
    if (query.reason) filters.push(eq(wasteLogs.reason, query.reason));
    if (query.fromDate || query.toDate) {
      const clock = await loadOutletClock(tx, query.outletId);
      if (query.fromDate)
        filters.push(
          sql`${wasteLogs.occurredAt} >= ${businessDayRange(query.fromDate, clock).start.toISOString()}::timestamptz`,
        );
      if (query.toDate)
        filters.push(
          sql`${wasteLogs.occurredAt} < ${businessDayRange(query.toDate, clock).end.toISOString()}::timestamptz`,
        );
    }
    const [occurredAt, id] = cursorKeys(query.cursor, 2);
    if (occurredAt !== undefined && id !== undefined) {
      const at = cursorInstant(occurredAt);
      filters.push(
        or(
          lt(wasteLogs.occurredAt, at),
          and(
            eq(wasteLogs.occurredAt, at),
            sql`${wasteLogs.id} < ${cursorUuid(id)}::uuid`,
          ),
        )!,
      );
    }
    const rows = await tx
      .select()
      .from(wasteLogs)
      .where(and(...filters))
      .orderBy(desc(wasteLogs.occurredAt), desc(wasteLogs.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    const staff = await loadInventoryStaff(
      tx,
      context.tenant.tenantId,
      query.outletId,
      page.map((row) => row.loggedBy),
    );
    return {
      data: page.map((row) =>
        masked(
          {
            ...toWasteLog(row),
            loggedByStaff: staff.get(row.loggedBy) ?? null,
          },
          withCost,
        ),
      ),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.occurredAt.toISOString(), last.id])
            : null,
      },
    };
  });
}

// Internal stock transfers between locations of one outlet (PRD v1.7 §3 F16
// "Lokasi Stok ... dengan transfer antarlokasi"; §16 "Kartu Stok Append-only";
// §6 E `transfer_out` / `transfer_in`; bead legend-ugo).
//
// One transfer is atomic: the document, its lines, every `transfer_out` row at
// the source and every `transfer_in` row at the destination commit in one
// tenant transaction, or none of them does. Stock leaves the source FEFO and
// arrives at the source's moving-average cost (PRD §16 "Metode Biaya", cost
// per location), so the destination average re-weights with the real cost.
// A batch keeps its identity across the move: the destination gets (or
// reuses) a batch with the same code, expiry and receipt time, so FEFO and the
// expiry alerts keep working after the transfer. No negative-stock bypass: a
// line larger than the source holds rejects the whole transfer (409).
//
// This replaces the earlier `recordStockTransfer` (inventory.service.ts,
// legend-98t) for the HTTP path: that helper predates the request fingerprint,
// the audit trail and batch-aware FEFO moves.

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
  createUlid,
  encodeCursor,
  formatDecimal4,
  parseDecimal4,
  ulidToUuid,
  CoreError,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  stockTransferSchema,
  type createStockTransferInputSchema,
  type StockBatch,
  type StockTransfer,
  type stockTransferListQuerySchema,
} from "@starter/shared/inventory";
import type { z } from "zod";
import { db } from "../db/index.ts";
import {
  inventoryItems,
  stockBatches,
  stockLocations,
  stockTransferLines,
  stockTransfers,
} from "../db/schema/inventory.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { consumeStockFefo } from "./inventory-expiry.service.ts";
import {
  assertOutlet,
  claimIdempotency,
  completeIdempotency,
  cursorInstant,
  cursorKeys,
  lockLocations,
  recordOpsAudit,
  requestFingerprint,
  requireOpsPermission,
  translateInventoryError,
  type CursorPage,
  type Tx,
} from "./inventory-ops.shared.ts";
import { evaluateParAlertsInTransaction } from "./inventory-par-alerts.service.ts";
import { recordStockMovementInTransaction } from "./inventory.service.ts";

export type CreateStockTransferInput = z.infer<
  typeof createStockTransferInputSchema
>;
export type StockTransferListQuery = z.infer<
  typeof stockTransferListQuerySchema
>;

const OPERATION = "transfer.create";
const TRANSFER_AUDIT_FIELDS = [
  "fromLocationId",
  "toLocationId",
  "lines",
  "occurredAt",
] as const;

type TransferRow = typeof stockTransfers.$inferSelect;
type TransferLineRow = typeof stockTransferLines.$inferSelect;

function toTransfer(
  row: TransferRow,
  lines: readonly TransferLineRow[],
): StockTransfer {
  return stockTransferSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    fromLocationId: row.fromLocationId,
    toLocationId: row.toLocationId,
    lines: [...lines]
      .sort((left, right) =>
        left.inventoryItemId < right.inventoryItemId ? -1 : 1,
      )
      .map((line) => ({
        inventoryItemId: line.inventoryItemId,
        quantity: line.quantity,
      })),
    movedBy: row.movedBy,
    occurredAt: row.occurredAt.toISOString(),
    note: row.note,
  });
}

async function requireLocation(tx: Tx, outletId: string, locationId: string) {
  const [row] = await tx
    .select()
    .from(stockLocations)
    .where(
      and(
        eq(stockLocations.id, locationId),
        eq(stockLocations.outletId, outletId),
      ),
    );
  if (!row) throw new HttpError(404, "NOT_FOUND", "Stock location not found.");
  return row;
}

/**
 * The destination twin of a source batch: same item, code, expiry and receipt
 * time (so `fefoSort` ranks it the same), created on first use.
 */
async function destinationBatch(
  tx: Tx,
  context: ScopedTenantContext,
  source: StockBatch,
  toLocationId: string,
): Promise<string> {
  const [existing] = await tx
    .select({ id: stockBatches.id })
    .from(stockBatches)
    .where(
      and(
        eq(stockBatches.outletId, source.outletId),
        eq(stockBatches.locationId, toLocationId),
        eq(stockBatches.inventoryItemId, source.inventoryItemId),
        eq(stockBatches.batchCode, source.batchCode),
        source.expiresOn === null
          ? isNull(stockBatches.expiresOn)
          : eq(stockBatches.expiresOn, source.expiresOn),
        eq(stockBatches.receivedAt, new Date(source.receivedAt)),
      ),
    )
    .limit(1);
  if (existing) return existing.id;
  const [created] = await tx
    .insert(stockBatches)
    .values({
      tenantId: context.tenant.tenantId,
      outletId: source.outletId,
      locationId: toLocationId,
      inventoryItemId: source.inventoryItemId,
      batchCode: source.batchCode,
      expiresOn: source.expiresOn,
      receivedAt: new Date(source.receivedAt),
    })
    .returning({ id: stockBatches.id });
  return created!.id;
}

/**
 * POST transfer. Needs `inventory.stock.transfer` on the outlet (route and
 * service). Both locations must belong to the outlet (TEN-03); the destination
 * must be active. Retries replay the first transfer when the fingerprint
 * (request + actor) matches and are IDEMPOTENCY_KEY_REUSED otherwise.
 */
export async function createStockTransfer(
  context: ScopedTenantContext,
  actorUserId: string,
  input: CreateStockTransferInput,
): Promise<StockTransfer> {
  assertOutlet(context, input.outletId);
  const lines = [...input.lines].sort((left, right) =>
    left.inventoryItemId < right.inventoryItemId ? -1 : 1,
  );
  const claim = {
    operation: OPERATION,
    key: input.idempotencyKey,
    outletId: input.outletId,
    fingerprint: requestFingerprint(OPERATION, actorUserId, {
      outletId: input.outletId,
      fromLocationId: input.fromLocationId,
      toLocationId: input.toLocationId,
      lines: lines.map((line) => [
        line.inventoryItemId,
        formatDecimal4(parseDecimal4(line.quantity)),
      ]),
      note: input.note ?? null,
    }),
  };
  try {
    return await withTenant(db, context, async (tx) => {
      await requireOpsPermission(
        tx,
        context,
        actorUserId,
        "inventory.stock.transfer",
        input.outletId,
      );
      const replay = await claimIdempotency(tx, context, claim);
      if (replay) return stockTransferSchema.parse(replay.replay);

      await requireLocation(tx, input.outletId, input.fromLocationId);
      const destination = await requireLocation(
        tx,
        input.outletId,
        input.toLocationId,
      );
      if (!destination.isActive)
        throw new HttpError(
          422,
          "VALIDATION_ERROR",
          "The destination location is inactive.",
        );
      const itemIds = lines.map((line) => line.inventoryItemId);
      const items = await tx
        .select({ id: inventoryItems.id })
        .from(inventoryItems)
        .where(inArray(inventoryItems.id, itemIds));
      if (items.length !== new Set(itemIds).size)
        throw new HttpError(404, "NOT_FOUND", "Inventory item not found.");

      const occurredAt = new Date();
      const id = createUlid(occurredAt.getTime());
      // Both locations, ascending, before any balance is read (no deadlock
      // between opposing transfers, legend-98t pre-review :1190).
      await lockLocations(tx, context.tenant.tenantId, [
        input.fromLocationId,
        input.toLocationId,
      ]);
      const [row] = await tx
        .insert(stockTransfers)
        .values({
          id,
          tenantId: context.tenant.tenantId,
          outletId: input.outletId,
          fromLocationId: input.fromLocationId,
          toLocationId: input.toLocationId,
          movedBy: actorUserId,
          idempotencyKey: input.idempotencyKey,
          occurredAt,
          note: input.note ?? null,
        })
        .onConflictDoNothing()
        .returning();
      // The key is already on a transfer written by the legacy helper.
      if (!row)
        throw new CoreError(
          "IDEMPOTENCY_KEY_REUSED",
          "This idempotency key was used for a different request.",
        );
      const lineRows = await tx
        .insert(stockTransferLines)
        .values(
          lines.map((line) => ({
            tenantId: context.tenant.tenantId,
            outletId: input.outletId,
            transferId: id,
            inventoryItemId: line.inventoryItemId,
            quantity: line.quantity,
          })),
        )
        .returning();

      for (const line of lines) {
        const consumption = await consumeStockFefo(tx, context, {
          outletId: input.outletId,
          locationId: input.fromLocationId,
          inventoryItemId: line.inventoryItemId,
          quantity: line.quantity,
          movementType: "transfer_out",
          sourceType: "stock_transfer",
          sourceId: id,
          actorUserId,
        });
        for (const allocation of consumption.allocations) {
          const batchId = allocation.batch
            ? await destinationBatch(
                tx,
                context,
                allocation.batch,
                input.toLocationId,
              )
            : null;
          await recordStockMovementInTransaction(tx, context, {
            outletId: input.outletId,
            locationId: input.toLocationId,
            inventoryItemId: line.inventoryItemId,
            movementType: "transfer_in",
            quantity: allocation.quantity,
            // Cost travels with the stock: the source average (PRD §16).
            unitCostIdr: consumption.unitCostIdr,
            batchId,
            sourceType: "stock_transfer",
            sourceId: id,
            actor: { type: "user", id: actorUserId },
          });
        }
      }
      const transfer = toTransfer(row, lineRows);
      await recordOpsAudit(tx, context, {
        actorUserId,
        outletId: transfer.outletId,
        action: "inventory.transfer_posted",
        objectType: "stock_transfer",
        objectId: transfer.id,
        before: null,
        after: transfer,
        safeFields: TRANSFER_AUDIT_FIELDS,
      });
      await evaluateParAlertsInTransaction(tx, context, input.outletId, {
        pairs: lines.flatMap((line) => [
          {
            locationId: input.fromLocationId,
            inventoryItemId: line.inventoryItemId,
          },
          {
            locationId: input.toLocationId,
            inventoryItemId: line.inventoryItemId,
          },
        ]),
      });
      await completeIdempotency(tx, context, claim, transfer);
      return transfer;
    });
  } catch (error) {
    throw translateInventoryError(error);
  }
}

/**
 * GET transfers of one outlet, newest first; `locationId` matches either side.
 * Needs `inventory.stock.view` on the outlet.
 */
export async function listStockTransfers(
  context: ScopedTenantContext,
  actorUserId: string,
  query: StockTransferListQuery,
): Promise<CursorPage<StockTransfer>> {
  assertOutlet(context, query.outletId);
  return withTenant(db, context, async (tx) => {
    await requireOpsPermission(
      tx,
      context,
      actorUserId,
      "inventory.stock.view",
      query.outletId,
    );
    const filters: SQL[] = [eq(stockTransfers.outletId, query.outletId)];
    if (query.locationId)
      filters.push(
        or(
          eq(stockTransfers.fromLocationId, query.locationId),
          eq(stockTransfers.toLocationId, query.locationId),
        )!,
      );
    const [occurredAt, id] = cursorKeys(query.cursor, 2);
    if (occurredAt !== undefined && id !== undefined) {
      const at = cursorInstant(occurredAt);
      let cursorId: string;
      try {
        cursorId = ulidToUuid(id);
      } catch {
        throw new HttpError(422, "VALIDATION_ERROR", "Check the cursor.");
      }
      filters.push(
        or(
          lt(stockTransfers.occurredAt, at),
          and(
            eq(stockTransfers.occurredAt, at),
            sql`${stockTransfers.id} < ${cursorId}::uuid`,
          ),
        )!,
      );
    }
    const rows = await tx
      .select()
      .from(stockTransfers)
      .where(and(...filters))
      .orderBy(desc(stockTransfers.occurredAt), desc(stockTransfers.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const lines =
      page.length === 0
        ? []
        : await tx
            .select()
            .from(stockTransferLines)
            .where(
              inArray(
                stockTransferLines.transferId,
                page.map((row) => row.id),
              ),
            );
    const last = page.at(-1);
    return {
      data: page.map((row) =>
        toTransfer(
          row,
          lines.filter((line) => line.transferId === row.id),
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

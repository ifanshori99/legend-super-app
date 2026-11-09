// Building blocks of the stock opname service (bead legend-j5x, INV-03; PRD
// v1.7 §3 F16 "Stok Opname", §4 Alur J): row -> contract mappers, the
// approval-binding lines hash, error statuses and the batch read the posting
// uses. None of this is HTTP and none of it opens a transaction.

import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  formatDecimal4,
  idr,
  parseDecimal4,
  type Decimal4,
} from "@starter/shared/core";
import {
  inventoryErrorHttpStatus,
  stockBatchSchema,
  stockCountLineSchema,
  stockCountSchema,
  stockCountSheetLineSchema,
  type InventoryErrorCode,
  type StockCount,
  type StockCountLine,
  type StockCountSheetLine,
} from "@starter/shared/inventory";
import { stockBatches, stockLedger } from "../db/schema/inventory.ts";
import type {
  stockCountLines,
  stockCounts,
} from "../db/schema/inventory-count.ts";
import { HttpError } from "../lib/http-error.ts";
import type { BatchStock } from "./inventory-expiry.service.ts";
import { translateDomainError } from "./domain-error-http.shared.ts";
import type { Tx } from "./inventory-ops.shared.ts";

/** `approval_requests.source_module` of every count approval. */
export const COUNT_APPROVAL_MODULE = "inventory_count";

export type CountRow = typeof stockCounts.$inferSelect;
export type LineRow = typeof stockCountLines.$inferSelect;

/** Statuses that hold the location (one open count per location). */
export const OPEN_COUNT_STATUSES = [
  "draft",
  "counting",
  "pending_approval",
  "approved",
] as const;

// ----------------------------------------------------------------- mappers

export function toStockCount(row: CountRow): StockCount {
  return stockCountSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    locationId: row.locationId,
    type: row.type,
    status: row.status,
    blind: row.blind,
    businessDate: row.businessDate,
    countedBy: row.countedBy,
    approvedBy: row.approvedBy,
    countedAt: row.countedAt?.toISOString() ?? null,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    note: row.note,
  });
}

export function toStockCountLine(row: LineRow): StockCountLine {
  return stockCountLineSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    stockCountId: row.stockCountId,
    inventoryItemId: row.inventoryItemId,
    systemQty: row.systemQty,
    countedQty: row.countedQty,
    varianceIdr: row.varianceIdr,
  });
}

/** Counter view: never carries system quantity, unit cost or variance. */
export function toSheetLine(row: LineRow): StockCountSheetLine {
  return stockCountSheetLineSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    stockCountId: row.stockCountId,
    inventoryItemId: row.inventoryItemId,
    countedQty: row.countedQty,
    countedBy: row.countedBy,
    countedAt: row.countedAt?.toISOString() ?? null,
  });
}

// ------------------------------------------------------------- lines hash

/**
 * sha256 of the canonical JSON of the lines sorted by id, each as
 * `[lineId, countedQty, systemQty, unitCostIdr]` (Decimal4 canonical form).
 * Binds an approval to the exact counted lines it was opened for.
 */
export function countLinesHash(
  lines: readonly Pick<
    LineRow,
    "id" | "countedQty" | "systemQty" | "unitCostIdr"
  >[],
): string {
  const canonical = (value: string | null): string | null =>
    value === null ? null : formatDecimal4(parseDecimal4(value));
  const sorted = [...lines].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
  return createHash("sha256")
    .update(
      JSON.stringify(
        sorted.map((line) => [
          line.id,
          canonical(line.countedQty),
          canonical(line.systemQty),
          canonical(line.unitCostIdr),
        ]),
      ),
    )
    .digest("hex");
}

/** Σ and Σ|·| of the stored line variances in whole rupiah. */
export function sumVariance(varianceIdrs: readonly number[]) {
  let total = 0;
  let gross = 0;
  for (const value of varianceIdrs) {
    total += value;
    gross += Math.abs(value);
  }
  return { total: idr(total), gross: idr(gross) };
}

/** Signed `counted − system` (system = stock at the moment the line was entered). */
export function lineDelta(line: Pick<LineRow, "countedQty" | "systemQty">) {
  return (
    parseDecimal4(line.countedQty ?? "0.0000") - parseDecimal4(line.systemQty)
  );
}

// ------------------------------------------------------------------- costs

/**
 * Reference cost of an item: its latest positive `unit_cost_idr` in the
 * ledger, any location of the tenant. Used when the location has no positive
 * moving-average cost (found stock). Zero when the item never had one.
 */
export async function referenceUnitCost(
  tx: Tx,
  tenantId: CountRow["tenantId"],
  inventoryItemId: string,
): Promise<Decimal4> {
  const [row] = await tx
    .select({ unitCostIdr: stockLedger.unitCostIdr })
    .from(stockLedger)
    .where(
      and(
        eq(stockLedger.tenantId, tenantId),
        eq(stockLedger.inventoryItemId, inventoryItemId),
        sql`${stockLedger.unitCostIdr} > 0`,
      ),
    )
    .orderBy(desc(stockLedger.occurredAt), desc(stockLedger.id))
    .limit(1);
  return row?.unitCostIdr ?? formatDecimal4(0n);
}

// ------------------------------------------------------------------ errors

/** Status from the contract table; the caller's message is built in the service. */
export function countError(
  code: InventoryErrorCode,
  message: string,
): HttpError {
  return new HttpError(inventoryErrorHttpStatus[code], code, message);
}

/** Contract status and safe message per code (see domain-error-http.shared.ts). */
export function translateCountError(error: unknown): unknown {
  return translateDomainError(error);
}

// ------------------------------------------------------------ batch reads

/**
 * Batches of one location + item with a positive ledger remainder (same read
 * as the expiry service's private `loadBatchStock`, which is not exported).
 */
export async function loadBatchRemaining(
  tx: Tx,
  outletId: string,
  locationId: string,
  inventoryItemId: string,
): Promise<BatchStock[]> {
  const rows = await tx
    .select({
      batch: stockBatches,
      remaining: sql<string>`coalesce(sum(${stockLedger.quantity}), 0)::numeric(14,4)::text`,
    })
    .from(stockBatches)
    .leftJoin(
      stockLedger,
      and(
        eq(stockLedger.tenantId, stockBatches.tenantId),
        eq(stockLedger.batchId, stockBatches.id),
      ),
    )
    .where(
      and(
        eq(stockBatches.outletId, outletId),
        eq(stockBatches.locationId, locationId),
        eq(stockBatches.inventoryItemId, inventoryItemId),
      ),
    )
    .groupBy(stockBatches.id)
    .having(sql`coalesce(sum(${stockLedger.quantity}), 0) > 0`);
  return rows.map((row) => ({
    batch: stockBatchSchema.parse({
      id: row.batch.id,
      tenantId: row.batch.tenantId,
      outletId: row.batch.outletId,
      locationId: row.batch.locationId,
      inventoryItemId: row.batch.inventoryItemId,
      batchCode: row.batch.batchCode,
      expiresOn: row.batch.expiresOn,
      receivedAt: row.batch.receivedAt.toISOString(),
    }),
    remaining: formatDecimal4(parseDecimal4(row.remaining)),
  }));
}

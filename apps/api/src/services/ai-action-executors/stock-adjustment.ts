// TL-14 executor: one `adjustment` ledger row per line through the inventory
// ledger (`recordStockMovementInTransaction`, INV-01). The adjustment is
// posted at the location that holds the item (largest balance), else the
// outlet's first active warehouse. A stock-in is valued at that location's
// moving average; with no known cost the request fails instead of guessing.
import { and, asc, desc, eq } from "drizzle-orm";
import { decimal4, parseDecimal4 } from "@starter/shared/core";
import { draftStockAdjustmentInputSchema } from "@starter/shared/ai";
import { stockBalances, stockLocations } from "../../db/schema/index.ts";
import { recordStockMovementInTransaction } from "../inventory.service.ts";
import { holdsToolAccess } from "./access.ts";
import {
  ActionExecutionError,
  type ActionExecutor,
  type ExecutorArgs,
} from "./types.ts";

async function pickLocation(
  { tx, row }: ExecutorArgs,
  outletId: string,
  inventoryItemId: string,
): Promise<{ locationId: string; avgCostIdr: string | null }> {
  const [balance] = await tx
    .select({
      locationId: stockBalances.locationId,
      avgCostIdr: stockBalances.avgCostIdr,
    })
    .from(stockBalances)
    .innerJoin(
      stockLocations,
      and(
        eq(stockLocations.tenantId, stockBalances.tenantId),
        eq(stockLocations.id, stockBalances.locationId),
      ),
    )
    .where(
      and(
        eq(stockBalances.tenantId, row.tenantId),
        eq(stockBalances.outletId, outletId),
        eq(stockBalances.inventoryItemId, inventoryItemId),
        eq(stockLocations.isActive, true),
      ),
    )
    .orderBy(desc(stockBalances.quantity))
    .limit(1);
  if (balance) return balance;
  const [location] = await tx
    .select({ id: stockLocations.id })
    .from(stockLocations)
    .where(
      and(
        eq(stockLocations.tenantId, row.tenantId),
        eq(stockLocations.outletId, outletId),
        eq(stockLocations.type, "warehouse"),
        eq(stockLocations.isActive, true),
      ),
    )
    .orderBy(asc(stockLocations.name), asc(stockLocations.id))
    .limit(1);
  if (!location)
    throw new ActionExecutionError("Outlet belum punya lokasi gudang aktif.");
  return { locationId: location.id, avgCostIdr: null };
}

export const executeStockAdjustment: ActionExecutor = async (args) => {
  const { tx, context, row } = args;
  const payload = draftStockAdjustmentInputSchema.parse(row.payload);
  // Write permission (not just inventory.stock.view), through one role.
  if (!holdsToolAccess(args.access, "TL-14", row.payload))
    throw new ActionExecutionError(
      "Pengaju tidak lagi punya izin mengubah stok di outlet ini.",
    );
  let firstEntryId: string | null = null;
  for (const [index, line] of payload.lines.entries()) {
    const place = await pickLocation(
      args,
      payload.outletId,
      line.inventoryItemId,
    );
    const inbound = parseDecimal4(line.qtyDelta) > 0n;
    if (inbound && place.avgCostIdr === null)
      throw new ActionExecutionError(
        "Biaya satuan barang belum diketahui, penambahan stok tidak bisa diposting.",
      );
    const entry = await recordStockMovementInTransaction(tx, context, {
      outletId: payload.outletId,
      locationId: place.locationId,
      inventoryItemId: line.inventoryItemId,
      movementType: "adjustment",
      quantity: decimal4(line.qtyDelta),
      ...(inbound ? { unitCostIdr: decimal4(place.avgCostIdr!) } : {}),
      sourceType: "stock_count",
      sourceId: row.id,
      idempotencyKey: `ai-action:${row.id}:${index}`,
      actor: { type: "user", id: row.requestedByUserId },
    });
    firstEntryId ??= entry.id;
  }
  return { resultRef: `stock_ledger:${firstEntryId}` };
};

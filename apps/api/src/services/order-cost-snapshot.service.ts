// HPP snapshot per order line (bead legend-u4js6, WS-11; see docs/DECISIONS.md
// "HPP per baris pesanan saat penjualan"). Computes what
// `order_items.cost_snapshot_idr` stores at the moment a line is inserted: the
// theoretical cost of the WHOLE line (quantity x cost per portion), in whole
// rupiah, from `stock_balances.avg_cost_idr` at the outlet's sale location.
//
// NULL means "unknown", never 0: no recipe, inactive or broken recipe, no sale
// location, quantity below 1, or any single ingredient without a balance or
// with a zero average cost (no partial values: a partial cost reads as a false
// margin). The cost is summed at full Decimal4 x Decimal4 scale and rounded
// half up ONCE per line (`scaledCostToIdr`). Reads run in a savepoint and an
// unexpected failure yields all NULL, so the order itself never fails.

import { and, eq, inArray } from "drizzle-orm";
import { parseDecimal4, type ScopedTenantContext } from "@starter/shared/core";
import { stockBalances } from "../db/schema/inventory.ts";
import { outletInventorySettings } from "../db/schema/recipe.ts";
import { logger } from "../lib/logger.ts";
import { scaledCostToIdr, type Tx } from "./inventory-ops.shared.ts";
import type { DeductionMenuLine } from "./recipe-deduction.service.ts";
import { explodeMenuLinesEach } from "./recipe-bom.service.ts";

/**
 * Line cost snapshots aligned with `lines`; `null` = unknown. One set of
 * queries per order, not per line.
 */
export async function computeLineCostSnapshots(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: string,
  lines: readonly DeductionMenuLine[],
): Promise<(number | null)[]> {
  const unknown = lines.map(() => null);
  if (lines.length === 0) return unknown;
  try {
    return await tx.transaction(async (savepoint) =>
      computeInSavepoint(savepoint, context, outletId, lines),
    );
  } catch (error) {
    logger.warn(
      {
        tenantId: context.tenant.tenantId,
        outletId,
        code: errorCodeOf(error),
      },
      "Order line cost snapshot could not be computed; stored as NULL",
    );
    return unknown;
  }
}

async function computeInSavepoint(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: string,
  lines: readonly DeductionMenuLine[],
): Promise<(number | null)[]> {
  const tenantId = context.tenant.tenantId;
  const result: (number | null)[] = lines.map(() => null);

  const [settings] = await tx
    .select({ saleLocationId: outletInventorySettings.saleLocationId })
    .from(outletInventorySettings)
    .where(
      and(
        eq(outletInventorySettings.tenantId, tenantId),
        eq(outletInventorySettings.outletId, outletId),
      ),
    );
  const saleLocationId = settings?.saleLocationId ?? null;
  if (saleLocationId === null) return result;

  // Only sellable lines are exploded; the rest stay NULL.
  const sellableIndexes = lines.flatMap((line, index) =>
    Number.isInteger(line.quantity) && line.quantity >= 1 ? [index] : [],
  );
  if (sellableIndexes.length === 0) return result;
  const outcomes = await explodeMenuLinesEach(
    tx,
    context,
    sellableIndexes.map((index) => lines[index]!),
  );

  const itemIds = [
    ...new Set(
      outcomes.flatMap((outcome) =>
        outcome.ok ? [...outcome.items.keys()] : [],
      ),
    ),
  ];
  if (itemIds.length === 0) return result;
  const balances = await tx
    .select({
      inventoryItemId: stockBalances.inventoryItemId,
      avgCostIdr: stockBalances.avgCostIdr,
    })
    .from(stockBalances)
    .where(
      and(
        eq(stockBalances.tenantId, tenantId),
        eq(stockBalances.outletId, outletId),
        eq(stockBalances.locationId, saleLocationId),
        inArray(stockBalances.inventoryItemId, itemIds),
      ),
    );
  const avgCost = new Map(
    balances.map((row) => [row.inventoryItemId, parseDecimal4(row.avgCostIdr)]),
  );

  outcomes.forEach((outcome, position) => {
    if (!outcome.ok || outcome.items.size === 0) return;
    let scaledCost = 0n;
    for (const [itemId, quantity] of outcome.items) {
      const cost = avgCost.get(itemId);
      if (cost === undefined || cost <= 0n) return;
      scaledCost += parseDecimal4(quantity) * cost;
    }
    result[sellableIndexes[position]!] = scaledCostToIdr(scaledCost);
  });
  return result;
}

/** First string `code` on the error or its `cause` chain (drizzle wraps SQL errors). */
function findCode(error: unknown, depth = 0): string | undefined {
  if (depth > 4 || typeof error !== "object" || error === null)
    return undefined;
  const candidate = error as { code?: unknown; cause?: unknown };
  if (typeof candidate.code === "string") return candidate.code;
  return findCode(candidate.cause, depth + 1);
}

function errorCodeOf(error: unknown): string {
  const raw =
    findCode(error) ?? (error instanceof Error ? error.name : "UNKNOWN");
  return raw.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 100) || "UNKNOWN";
}

// Read-only stock-on-hand vs par for AI tool TL-03 (bead legend-mfyo).
// On hand = sum of `stock_balances.quantity` over the selected outlets'
// locations. Par = per-location `par_levels.par_min`, else the item default
// `inventory_items.par_min` (same rule as inventory-par-alerts). Pairs inside an
// open blind count stay hidden, like every other stock read.
// Status: out (<= 0), critical (below half of par), low (below par), else ok.
import { sql } from "drizzle-orm";
import type { ScopedTenantContext } from "@starter/shared/core";
import { formatDecimal4, parseDecimal4 } from "@starter/shared/core";
import { db } from "../../db";
import { withTenant } from "../../db/tenant";
import { stockBalances } from "../../db/schema";
import { blindCountHiddenFilter } from "../inventory-count.visibility";
import { outletIn } from "./sales";

export type StockStatus = "ok" | "low" | "critical" | "out";

export type StockLevelRow = {
  inventoryItemId: string;
  name: string;
  unit: string;
  onHandQty: string;
  parLevelQty: string | null;
  status: StockStatus;
};

export function stockStatusOf(onHand: bigint, par: bigint | null): StockStatus {
  if (onHand <= 0n) return "out";
  if (par === null || par <= 0n) return "ok";
  if (onHand * 2n < par) return "critical";
  if (onHand < par) return "low";
  return "ok";
}

const escapeLike = (value: string) => value.replace(/[\\%_]/g, "\\$&");

export async function queryStockLevels(
  context: ScopedTenantContext,
  input: {
    outletIds: readonly string[];
    onlyBelowPar: boolean;
    search?: string;
    rowLimit: number;
  },
): Promise<{ rows: StockLevelRow[]; truncated: boolean }> {
  const tenantId = context.tenant.tenantId;
  const searchFilter = input.search
    ? sql`AND ii.name ILIKE ${`%${escapeLike(input.search)}%`}`
    : sql``;
  const belowPar = input.onlyBelowPar
    ? sql`HAVING BOOL_OR(pair.par IS NOT NULL) AND SUM(pair.quantity) < SUM(COALESCE(pair.par, 0))`
    : sql``;
  return withTenant(db, context, async (tx) => {
    const result = await tx.execute(sql`
      SELECT ii.id AS id, ii.name AS name, u.code AS unit,
        SUM(pair.quantity)::text AS on_hand,
        CASE WHEN BOOL_OR(pair.par IS NOT NULL)
          THEN SUM(COALESCE(pair.par, 0))::text END AS par
      FROM (
        SELECT stock_balances.inventory_item_id AS item_id,
          stock_balances.quantity AS quantity,
          COALESCE(pl.par_min, iid.par_min) AS par
        FROM stock_balances
        JOIN inventory_items iid
          ON iid.tenant_id = stock_balances.tenant_id AND iid.id = stock_balances.inventory_item_id
        LEFT JOIN par_levels pl
          ON pl.tenant_id = stock_balances.tenant_id
          AND pl.location_id = stock_balances.location_id
          AND pl.inventory_item_id = stock_balances.inventory_item_id
        WHERE stock_balances.tenant_id = ${tenantId}::uuid
          AND ${outletIn(sql`stock_balances.outlet_id`, input.outletIds)}
          AND ${blindCountHiddenFilter(stockBalances)}
      ) pair
      JOIN inventory_items ii ON ii.tenant_id = ${tenantId}::uuid AND ii.id = pair.item_id
      JOIN uoms u ON u.tenant_id = ii.tenant_id AND u.id = ii.base_uom_id
      WHERE ii.is_active ${searchFilter}
      GROUP BY ii.id, ii.name, u.code
      ${belowPar}
      ORDER BY ii.name, ii.id
      LIMIT ${input.rowLimit + 1}`);
    const rows = result.rows.map((row) => {
      const onHand = parseDecimal4(String(row.on_hand));
      const par = row.par === null ? null : parseDecimal4(String(row.par));
      return {
        inventoryItemId: String(row.id),
        name: String(row.name),
        unit: String(row.unit),
        onHandQty: formatDecimal4(onHand),
        parLevelQty: par === null ? null : formatDecimal4(par),
        status: stockStatusOf(onHand, par),
      };
    });
    return {
      rows: rows.slice(0, input.rowLimit),
      truncated: rows.length > input.rowLimit,
    };
  });
}

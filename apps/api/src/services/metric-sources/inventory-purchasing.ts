// Metric sources of the "inventory-purchasing" family (WS-11 F5, bead
// legend-5wzoc; DECISIONS 2026-11-10 points 1-2).
//
// - cogs, waste_cost, food_cost_pct: ledger metrics, already claimed in
//   `gl.ts`; this family only adds the waste_cost splits below.
// - stock_value, critical_stock_count: point in time at the end of the outlet
//   business day. The live day reads `stock_balances`; a past day replays
//   `stock_ledger` with the shared moving-average rule, so a backfill gives the
//   same figure the books had that evening. Par levels are the current ones
//   (no par history is stored).
// - purchase_total: purchase orders approved on the business day (cancelled
//   and unapproved ones left out), split per supplier. A purchase order is a
//   commitment the ledger does not post (the goods receipt and supplier
//   invoice do), so it reads operational rows (DECISIONS point 1, last rule).
// - supplier_due: open payable items of the outlet that are due on or before
//   the day, net of settlements up to that day, split per supplier. Entity
//   level invoices (no outlet) cannot be stored per outlet and are left out.
//   It is a due-balance by date, not a ledger section, so it reads the
//   accounts payable sub-ledger.
// - waste_cost_pct: derived from waste_cost and net_sales.
// - waste_cost splits (menu item, menu category): `waste_logs` of menu items,
//   by the business day the log was recorded (the ledger posts at record time,
//   not at the reported `occurredAt`). Raw item waste has no menu item; it and
//   any other gap show up in the engine's ledger adjustment row. The total
//   row of the split reader is the operational waste of all targets.
//
// The stock-level helper of Tanya AI tool TL-03 lives here too (moved from
// `ai-metrics/stock.ts`): one definition of "below par" for the tool and the
// critical_stock_count metric.

import { sql, type SQL } from "drizzle-orm";
import type { ScopedTenantContext } from "@starter/shared/core";
import {
  businessDayRange,
  decimal4,
  formatDecimal4,
  idr,
  parseDecimal4,
  type Decimal4,
} from "@starter/shared/core";
import {
  applyStockMovement,
  stockBalanceValueIdr,
} from "@starter/shared/inventory";
import { db } from "../../db";
import { withTenant } from "../../db/tenant";
import { stockBalances } from "../../db/schema";
import { blindCountHiddenFilter } from "../inventory-count.visibility";
import { outletBusinessDayClock } from "../outlet-clock";
import type {
  DailyComputeInput,
  DailyMetricReader,
  DailyMetricValue,
  MetricSourceFamilyModule,
  Tx,
} from "./types";

// ---------------------------------------------------------------- stock levels

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

/** Below par: an item with a par whose on-hand is under the summed par. */
export function belowPar(onHand: bigint, par: bigint | null): boolean {
  return par !== null && onHand < par;
}

const escapeLike = (value: string) => value.replace(/[\\%_]/g, "\\$&");

function outletIn(column: SQL, outletIds: readonly string[]): SQL {
  return sql`${column} IN (${sql.join(
    outletIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  )})`;
}

// Read-only stock-on-hand vs par for AI tool TL-03 (bead legend-mfyo).
// On hand = sum of `stock_balances.quantity` over the selected outlets'
// locations. Par = per-location `par_levels.par_min`, else the item default
// `inventory_items.par_min` (same rule as inventory-par-alerts). Pairs inside an
// open blind count stay hidden, like every other stock read.
// Status: out (<= 0), critical (below half of par), low (below par), else ok.
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
  const belowParFilter = input.onlyBelowPar
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
      ${belowParFilter}
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

// --------------------------------------------------------------------- readers

const ROUNDING_MODE = "half_up" as const;

const idrValue = (value: unknown): DailyMetricValue["value"] => ({
  unit: "idr",
  valueIdr: idr(Number(value ?? 0)),
});

const countValue = (value: number): DailyMetricValue["value"] => ({
  unit: "count",
  value,
});

/** Instant range of one outlet business day (tenant id given, no context). */
async function dayRange(tx: Tx, input: DailyComputeInput) {
  const result = await tx.execute(sql`
    SELECT timezone, business_day_cutoff FROM outlets
     WHERE tenant_id = ${input.tenantId}::uuid AND id = ${input.outletId}::uuid`);
  const row = result.rows[0];
  if (!row) throw new Error("Outlet not found");
  return businessDayRange(
    input.businessDate,
    outletBusinessDayClock({
      timezone: String(row.timezone),
      businessDayCutoff: String(row.business_day_cutoff),
    }),
  );
}

type Position = { quantity: Decimal4; avgCostIdr: Decimal4 };

/** Quantity and moving-average cost per `location:item` at the day end. */
async function positionsAtDayEnd(
  tx: Tx,
  input: DailyComputeInput,
  end: Date,
  live: boolean,
): Promise<Map<string, Position>> {
  const positions = new Map<string, Position>();
  if (live) {
    // The live day: the materialized balances are the ledger folded to now.
    const result = await tx.execute(sql`
      SELECT location_id::text AS location_id, inventory_item_id::text AS item_id,
             quantity::text AS quantity, avg_cost_idr::text AS avg_cost
        FROM stock_balances
       WHERE tenant_id = ${input.tenantId}::uuid AND outlet_id = ${input.outletId}::uuid`);
    for (const row of result.rows)
      positions.set(`${row.location_id}:${row.item_id}`, {
        quantity: decimal4(String(row.quantity)),
        avgCostIdr: decimal4(String(row.avg_cost)),
      });
    return positions;
  }
  // Fold in posting order (posting_seq, legend-5ymew): the order the live
  // balance applied each movement, so a backdated or same-instant posting
  // gives the past day the same average cost as the live read, as the stock
  // rebuild does. occurred_at only bounds which rows belong to the day.
  const result = await tx.execute(sql`
    SELECT location_id::text AS location_id, inventory_item_id::text AS item_id,
           quantity::text AS quantity, unit_cost_idr::text AS unit_cost
      FROM stock_ledger
     WHERE tenant_id = ${input.tenantId}::uuid AND outlet_id = ${input.outletId}::uuid
       AND occurred_at < ${end.toISOString()}::timestamptz
     ORDER BY posting_seq`);
  for (const row of result.rows) {
    const key = `${row.location_id}:${row.item_id}`;
    const current = positions.get(key) ?? {
      quantity: formatDecimal4(0n),
      avgCostIdr: formatDecimal4(0n),
    };
    positions.set(
      key,
      applyStockMovement(
        current,
        {
          quantity: decimal4(String(row.quantity)),
          unitCostIdr: decimal4(String(row.unit_cost)),
        },
        ROUNDING_MODE,
      ),
    );
  }
  return positions;
}

/**
 * `location:item` keys inside a currently open blind count. Only the live day
 * hides them (like every other live stock read); a past day never does, since
 * open counts are not history and a final past value must not move with them.
 */
async function liveBlindPairs(
  tx: Tx,
  input: DailyComputeInput,
): Promise<Set<string>> {
  const result = await tx.execute(sql`
    SELECT DISTINCT sc.location_id::text AS location_id,
           scl.inventory_item_id::text AS item_id
      FROM stock_counts sc
      JOIN stock_count_lines scl
        ON scl.tenant_id = sc.tenant_id AND scl.stock_count_id = sc.id
     WHERE sc.tenant_id = ${input.tenantId}::uuid
       AND sc.outlet_id = ${input.outletId}::uuid
       AND sc.blind
       AND sc.status IN ('draft', 'counting', 'pending_approval', 'approved')`);
  return new Set(result.rows.map((row) => `${row.location_id}:${row.item_id}`));
}

/** Items below par among the positions (blind-count pairs and inactive items skipped). */
async function criticalItemCount(
  tx: Tx,
  input: DailyComputeInput,
  positions: ReadonlyMap<string, Position>,
  live: boolean,
): Promise<number> {
  const hidden = live ? await liveBlindPairs(tx, input) : new Set<string>();
  const result = await tx.execute(sql`
    SELECT ii.id::text AS item_id, ii.is_active AS is_active,
           ii.par_min::text AS item_par, pl.location_id::text AS location_id,
           pl.par_min::text AS location_par
      FROM inventory_items ii
      LEFT JOIN par_levels pl
        ON pl.tenant_id = ii.tenant_id AND pl.inventory_item_id = ii.id
       AND pl.outlet_id = ${input.outletId}::uuid
     WHERE ii.tenant_id = ${input.tenantId}::uuid`);
  const items = new Map<
    string,
    { active: boolean; itemPar: bigint | null; byLocation: Map<string, bigint> }
  >();
  for (const row of result.rows) {
    const itemId = String(row.item_id);
    const entry = items.get(itemId) ?? {
      active: row.is_active === true,
      itemPar:
        row.item_par === null ? null : parseDecimal4(String(row.item_par)),
      byLocation: new Map<string, bigint>(),
    };
    if (row.location_id !== null && row.location_par !== null)
      entry.byLocation.set(
        String(row.location_id),
        parseDecimal4(String(row.location_par)),
      );
    items.set(itemId, entry);
  }

  const totals = new Map<string, { onHand: bigint; par: bigint | null }>();
  for (const [key, position] of positions) {
    if (hidden.has(key)) continue;
    const [locationId, itemId] = key.split(":") as [string, string];
    const item = items.get(itemId);
    if (!item?.active) continue;
    const par = item.byLocation.get(locationId) ?? item.itemPar;
    const total = totals.get(itemId) ?? { onHand: 0n, par: null };
    total.onHand += parseDecimal4(position.quantity);
    if (par !== null) total.par = (total.par ?? 0n) + par;
    totals.set(itemId, total);
  }
  let count = 0;
  for (const total of totals.values())
    if (belowPar(total.onHand, total.par)) count += 1;
  return count;
}

const stockReader: DailyMetricReader = {
  metricCodes: ["stock_value", "critical_stock_count"],
  dimensions: [],
  requiresDailyClose: false,
  async compute(input) {
    const { end } = await dayRange(input.tx, input);
    const live = end.getTime() > input.now.getTime();
    const positions = await positionsAtDayEnd(input.tx, input, end, live);
    let value = 0;
    for (const position of positions.values())
      value += Number(stockBalanceValueIdr(position, ROUNDING_MODE));
    return [
      { metricCode: "stock_value", dimension: null, value: idrValue(value) },
      {
        metricCode: "critical_stock_count",
        dimension: null,
        value: countValue(
          await criticalItemCount(input.tx, input, positions, live),
        ),
      },
    ];
  },
};

/** A total row plus one row per supplier of an idr query (supplier_id, amount). */
function supplierRows(
  metricCode: string,
  rows: readonly Record<string, unknown>[],
): DailyMetricValue[] {
  const total = rows.reduce((sum, row) => sum + Number(row.amount), 0);
  return [
    { metricCode, dimension: null, value: idrValue(total) },
    ...rows.map((row): DailyMetricValue => ({
      metricCode,
      dimension: { key: "supplier", value: String(row.supplier_id) },
      value: idrValue(row.amount),
    })),
  ];
}

const purchaseReader: DailyMetricReader = {
  metricCodes: ["purchase_total"],
  dimensions: ["supplier"],
  requiresDailyClose: false,
  async compute(input) {
    const { start, end } = await dayRange(input.tx, input);
    const result = await input.tx.execute(sql`
      SELECT supplier_id::text AS supplier_id, SUM(total_idr)::text AS amount
        FROM purchase_orders
       WHERE tenant_id = ${input.tenantId}::uuid AND outlet_id = ${input.outletId}::uuid
         AND status IN ('approved', 'sent', 'partially_received', 'received', 'closed')
         AND approved_at >= ${start.toISOString()}::timestamptz
         AND approved_at < ${end.toISOString()}::timestamptz
       GROUP BY supplier_id
       ORDER BY supplier_id`);
    return supplierRows("purchase_total", result.rows);
  },
};

const supplierDueReader: DailyMetricReader = {
  metricCodes: ["supplier_due"],
  dimensions: ["supplier"],
  requiresDailyClose: false,
  async compute(input) {
    const result = await input.tx.execute(sql`
      SELECT supplier_id, SUM(remaining)::text AS amount FROM (
        SELECT oi.counterparty_id::text AS supplier_id,
               oi.original_idr - COALESCE((
                 SELECT SUM(CASE WHEN st.method = 'reversal' THEN -st.amount_idr ELSE st.amount_idr END)
                   FROM accounting_open_item_settlements st
                  WHERE st.tenant_id = oi.tenant_id AND st.kind = oi.kind
                    AND st.open_item_id = oi.id
                    AND st.settled_on <= ${input.businessDate}::date), 0) AS remaining
          FROM accounting_open_items oi
         WHERE oi.tenant_id = ${input.tenantId}::uuid AND oi.kind = 'payable'
           AND oi.outlet_id = ${input.outletId}::uuid
           AND oi.document_date <= ${input.businessDate}::date
           AND oi.due_on <= ${input.businessDate}::date
      ) due
      WHERE remaining > 0
      GROUP BY supplier_id
      ORDER BY supplier_id`);
    return supplierRows("supplier_due", result.rows);
  },
};

const wasteSplitReader: DailyMetricReader = {
  metricCodes: ["waste_cost"],
  dimensions: ["menu_item", "menu_category"],
  requiresDailyClose: false,
  async compute(input) {
    const { start, end } = await dayRange(input.tx, input);
    const range = sql`wl.tenant_id = ${input.tenantId}::uuid AND wl.outlet_id = ${input.outletId}::uuid
      AND wl.created_at >= ${start.toISOString()}::timestamptz
      AND wl.created_at < ${end.toISOString()}::timestamptz`;
    const total = await input.tx.execute(sql`
      SELECT COALESCE(SUM(wl.value_idr), 0)::text AS amount FROM waste_logs wl WHERE ${range}`);
    const perItem = await input.tx.execute(sql`
      SELECT wl.target_id::text AS key, SUM(wl.value_idr)::text AS amount
        FROM waste_logs wl WHERE ${range} AND wl.target_type = 'menu_item'
       GROUP BY wl.target_id ORDER BY wl.target_id`);
    const perCategory = await input.tx.execute(sql`
      SELECT mi.category_id::text AS key, SUM(wl.value_idr)::text AS amount
        FROM waste_logs wl
        JOIN menu_items mi ON mi.tenant_id = wl.tenant_id AND mi.id = wl.target_id
       WHERE ${range} AND wl.target_type = 'menu_item'
       GROUP BY mi.category_id ORDER BY mi.category_id`);
    return [
      {
        metricCode: "waste_cost",
        dimension: null,
        value: idrValue(total.rows[0]?.amount),
      },
      ...perItem.rows.map((row): DailyMetricValue => ({
        metricCode: "waste_cost",
        dimension: { key: "menu_item", value: String(row.key) },
        value: idrValue(row.amount),
      })),
      ...perCategory.rows.map((row): DailyMetricValue => ({
        metricCode: "waste_cost",
        dimension: { key: "menu_category", value: String(row.key) },
        value: idrValue(row.amount),
      })),
    ];
  },
};

export const inventoryPurchasingSources: MetricSourceFamilyModule = {
  family: "inventory-purchasing",
  sources: [
    { kind: "daily", code: "stock_value", reader: stockReader },
    { kind: "daily", code: "critical_stock_count", reader: stockReader },
    { kind: "daily", code: "purchase_total", reader: purchaseReader },
    { kind: "daily", code: "supplier_due", reader: supplierDueReader },
    {
      kind: "derived",
      code: "waste_cost_pct",
      numerator: "waste_cost",
      denominator: "net_sales",
      scale: 100,
    },
  ],
  splits: [
    { code: "waste_cost", dimension: "menu_item", reader: wasteSplitReader },
    {
      code: "waste_cost",
      dimension: "menu_category",
      reader: wasteSplitReader,
    },
  ],
};

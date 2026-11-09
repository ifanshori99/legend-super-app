// Read-only sales aggregates for AI tools TL-01, TL-02 and TL-04 (bead
// legend-mfyo). Definitions (PRD metric registry, `net_sales`):
// - a paid order is an `orders` row with status `completed`, on its business date;
// - gross sales = order subtotal (before discount, tax and service charge);
// - net sales = subtotal - discount - refunds recorded in `pos_order_refunds`;
// - pax = guests of the DISTINCT table sessions behind those orders (a session
//   with several orders counts once);
// - menu revenue = non-voided line totals, cost = `order_items.cost_snapshot_idr`
//   (HPP of the whole line at sale time).
// All queries run inside the caller's `withTenant` transaction and are filtered
// by the explicit outlet list (RLS is the second wall).
import { sql, type SQL } from "drizzle-orm";
import type { ScopedTenantContext } from "@starter/shared/core";
import { db } from "../../db";
import { withTenant } from "../../db/tenant";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type SalesGroupBy = "day" | "outlet" | "channel";

export type SalesRow = {
  key: string;
  label: string;
  netSalesIdr: number;
  grossSalesIdr: number;
  transactionCount: number;
  pax: number;
};

export type SalesTotals = Omit<SalesRow, "key" | "label">;

const num = (value: unknown): number => Number(value ?? 0);

export function outletIn(column: SQL, outletIds: readonly string[]): SQL {
  return sql`${column} IN (${sql.join(
    outletIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  )})`;
}

function paidOrdersWhere(
  tenantId: string,
  outletIds: readonly string[],
  from: string,
  to: string,
): SQL {
  return sql`o.tenant_id = ${tenantId}::uuid
    AND o.status = 'completed'
    AND o.business_date BETWEEN ${from}::date AND ${to}::date
    AND ${outletIn(sql`o.outlet_id`, outletIds)}`;
}

const REFUNDS_JOIN = sql`LEFT JOIN (
    SELECT tenant_id, order_id, SUM(amount_idr) AS amount
    FROM pos_order_refunds GROUP BY tenant_id, order_id
  ) r ON r.tenant_id = o.tenant_id AND r.order_id = o.id`;

function groupExpr(groupBy: SalesGroupBy): { key: SQL; label: SQL } {
  switch (groupBy) {
    case "day":
      return { key: sql`o.business_date::text`, label: sql`o.business_date::text` };
    case "outlet":
      return { key: sql`o.outlet_id::text`, label: sql`ou.name` };
    case "channel":
      return { key: sql`o.channel`, label: sql`o.channel` };
  }
}

export async function querySalesSummary(
  context: ScopedTenantContext,
  input: {
    outletIds: readonly string[];
    from: string;
    to: string;
    groupBy: SalesGroupBy;
    rowLimit: number;
  },
): Promise<{ rows: SalesRow[]; totals: SalesTotals; truncated: boolean }> {
  const tenantId = context.tenant.tenantId;
  const where = paidOrdersWhere(tenantId, input.outletIds, input.from, input.to);
  const { key, label } = groupExpr(input.groupBy);
  return withTenant(db, context, async (tx: Tx) => {
    const grouped = await tx.execute(sql`
      SELECT ${key} AS key, MIN(${label}) AS label,
        COALESCE(SUM(o.subtotal_idr), 0)::bigint AS gross,
        COALESCE(SUM(o.subtotal_idr - o.discount_idr - COALESCE(r.amount, 0)), 0)::bigint AS net,
        COUNT(*)::int AS tx_count
      FROM orders o
      JOIN outlets ou ON ou.tenant_id = o.tenant_id AND ou.id = o.outlet_id
      ${REFUNDS_JOIN}
      WHERE ${where}
      GROUP BY ${key}
      ORDER BY ${key}
      LIMIT ${input.rowLimit + 1}`);
    const paxByKey = await tx.execute(sql`
      SELECT key, COALESCE(SUM(pax), 0)::int AS pax FROM (
        SELECT DISTINCT ${key} AS key, ts.id, ts.pax
        FROM orders o
        JOIN outlets ou ON ou.tenant_id = o.tenant_id AND ou.id = o.outlet_id
        JOIN table_sessions ts ON ts.tenant_id = o.tenant_id AND ts.id = o.table_session_id
        WHERE ${where}
      ) sessions GROUP BY key`);
    const totals = await tx.execute(sql`
      SELECT COALESCE(SUM(o.subtotal_idr), 0)::bigint AS gross,
        COALESCE(SUM(o.subtotal_idr - o.discount_idr - COALESCE(r.amount, 0)), 0)::bigint AS net,
        COUNT(*)::int AS tx_count
      FROM orders o ${REFUNDS_JOIN} WHERE ${where}`);
    const totalPax = await tx.execute(sql`
      SELECT COALESCE(SUM(pax), 0)::int AS pax FROM (
        SELECT DISTINCT ts.id, ts.pax FROM orders o
        JOIN table_sessions ts ON ts.tenant_id = o.tenant_id AND ts.id = o.table_session_id
        WHERE ${where}
      ) sessions`);
    const pax = new Map(
      paxByKey.rows.map((row) => [String(row.key), num(row.pax)]),
    );
    const all = grouped.rows.map((row) => ({
      key: String(row.key),
      label: String(row.label),
      grossSalesIdr: num(row.gross),
      netSalesIdr: num(row.net),
      transactionCount: num(row.tx_count),
      pax: pax.get(String(row.key)) ?? 0,
    }));
    const totalRow = totals.rows[0] ?? {};
    return {
      rows: all.slice(0, input.rowLimit),
      truncated: all.length > input.rowLimit,
      totals: {
        grossSalesIdr: num(totalRow.gross),
        netSalesIdr: num(totalRow.net),
        transactionCount: num(totalRow.tx_count),
        pax: num(totalPax.rows[0]?.pax),
      },
    };
  });
}

export type MenuPerformanceRow = {
  menuItemId: string;
  name: string;
  qtySold: number;
  revenueIdr: number;
  costIdr: number;
};

/** Every menu item with sales in the period (caller sorts and cuts). */
export async function queryMenuPerformance(
  context: ScopedTenantContext,
  input: { outletIds: readonly string[]; from: string; to: string },
): Promise<MenuPerformanceRow[]> {
  const where = paidOrdersWhere(
    context.tenant.tenantId,
    input.outletIds,
    input.from,
    input.to,
  );
  return withTenant(db, context, async (tx: Tx) => {
    const result = await tx.execute(sql`
      SELECT oi.menu_item_id AS id, MIN(COALESCE(mi.name, oi.name)) AS name,
        SUM(oi.quantity)::bigint AS qty,
        SUM(oi.line_total_idr)::bigint AS revenue,
        COALESCE(SUM(oi.cost_snapshot_idr), 0)::bigint AS cost
      FROM order_items oi
      JOIN orders o ON o.tenant_id = oi.tenant_id AND o.id = oi.order_id
      LEFT JOIN menu_items mi ON mi.tenant_id = oi.tenant_id AND mi.id = oi.menu_item_id
      WHERE ${where} AND oi.status <> 'voided'
      GROUP BY oi.menu_item_id`);
    return result.rows.map((row) => ({
      menuItemId: String(row.id),
      name: String(row.name),
      qtySold: num(row.qty),
      revenueIdr: num(row.revenue),
      costIdr: num(row.cost),
    }));
  });
}

export type FoodCostRow = {
  outletId: string;
  foodCostIdr: number;
  netSalesIdr: number;
};

/** Food cost (sum of line cost snapshots) and net sales per outlet. */
export async function queryFoodCost(
  context: ScopedTenantContext,
  input: { outletIds: readonly string[]; from: string; to: string },
): Promise<FoodCostRow[]> {
  const where = paidOrdersWhere(
    context.tenant.tenantId,
    input.outletIds,
    input.from,
    input.to,
  );
  return withTenant(db, context, async (tx: Tx) => {
    const sales = await tx.execute(sql`
      SELECT o.outlet_id::text AS outlet_id,
        COALESCE(SUM(o.subtotal_idr - o.discount_idr - COALESCE(r.amount, 0)), 0)::bigint AS net
      FROM orders o ${REFUNDS_JOIN} WHERE ${where} GROUP BY o.outlet_id`);
    const cost = await tx.execute(sql`
      SELECT o.outlet_id::text AS outlet_id,
        COALESCE(SUM(oi.cost_snapshot_idr), 0)::bigint AS cost
      FROM order_items oi
      JOIN orders o ON o.tenant_id = oi.tenant_id AND o.id = oi.order_id
      WHERE ${where} AND oi.status <> 'voided' GROUP BY o.outlet_id`);
    const net = new Map(sales.rows.map((r) => [String(r.outlet_id), num(r.net)]));
    const costs = new Map(cost.rows.map((r) => [String(r.outlet_id), num(r.cost)]));
    return input.outletIds.map((outletId) => ({
      outletId,
      netSalesIdr: net.get(outletId.toLowerCase()) ?? 0,
      foodCostIdr: costs.get(outletId.toLowerCase()) ?? 0,
    }));
  });
}

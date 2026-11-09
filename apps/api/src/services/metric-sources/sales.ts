// Metric sources of the "sales" family (bead legend-ne81z, WS-11 F1). Owned by
// this family's card: add sources and splits here, never in another file.
//
// - Stored codes (gross_sales, refund_amount, void_amount, transaction_count,
//   menu_sold_qty, sales_target) are computed per outlet-day from completed
//   orders (`orders.status = 'completed'`, `orders.business_date`).
// - Ledger codes (net_sales, discount_amount) keep their GL total (gl.ts); the
//   splits here write operational rows plus a total row (`payment_method`
//   spreads each order net over its captured tenders with `allocateByWeight`), and the engine adds
//   the `__ledger_adjustment__` residual when it reads (never stored here).
// - Net of one order = subtotal - discount - refunds (same definition as the
//   AI helper `ai-metrics/sales.ts`, which imports its SQL from this file).
// - Dimension values are ids or codes, never a person's name.

import { sql, type SQL } from "drizzle-orm";
import { idr } from "@starter/shared/core";
import type { MetricValue } from "@starter/shared/metrics";
import { allocateByWeight, PAYMENT_METHOD_UNASSIGNED } from "./payments-tax";
import type {
  DailyComputeInput,
  DailyMetricReader,
  DailyMetricValue,
  MetricSource,
  MetricSourceFamilyModule,
  MetricSplitSource,
} from "./types";

type DimensionKey = Exclude<DailyMetricValue["dimension"], null>["key"];

const num = (value: unknown): number => Number(value ?? 0);
const money = (value: number): MetricValue => ({
  unit: "idr",
  valueIdr: idr(value),
});
const count = (value: number): MetricValue => ({ unit: "count", value });

// ---- SQL shared with ai-metrics/sales.ts ------------------------------------

export function outletIn(column: SQL, outletIds: readonly string[]): SQL {
  return sql`${column} IN (${sql.join(
    outletIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  )})`;
}

/**
 * Training orders (`pos_orders.is_training`, legend-fr62g) are till practice,
 * not sales: every sales query over `orders o` excludes them. Only
 * `pos_orders` carries the stamp, so the check is NOT EXISTS on it.
 */
export const NOT_TRAINING_SQL = sql`NOT EXISTS (
    SELECT 1 FROM pos_orders tpo
    WHERE tpo.tenant_id = o.tenant_id AND tpo.order_id = o.id
      AND tpo.is_training)`;

/** Paid orders of the tenant over the outlets and business dates. */
export function paidOrdersWhere(
  tenantId: string,
  outletIds: readonly string[],
  from: string,
  to: string,
): SQL {
  return sql`o.tenant_id = ${tenantId}::uuid
    AND o.status = 'completed'
    AND ${NOT_TRAINING_SQL}
    AND o.business_date BETWEEN ${from}::date AND ${to}::date
    AND ${outletIn(sql`o.outlet_id`, outletIds)}`;
}

/** Refund total per order (`pos_order_refunds`), aliased `r`. */
export const REFUNDS_JOIN = sql`LEFT JOIN (
    SELECT tenant_id, order_id, SUM(amount_idr) AS amount
    FROM pos_order_refunds GROUP BY tenant_id, order_id
  ) r ON r.tenant_id = o.tenant_id AND r.order_id = o.id`;

/** Net sales of one order row (aliases `o`, `r`). */
export const ORDER_NET_SQL = sql`(o.subtotal_idr - o.discount_idr - COALESCE(r.amount, 0))`;

// ---- Outlet-day facts --------------------------------------------------------

type OrderFact = {
  id: string;
  channel: string;
  subtotal: number;
  discount: number;
  refund: number;
  net: number;
  hour: string;
  employee: string | null;
  method: string | null;
  /** Captured tender lines (method, amount), in a fixed order. */
  tenders: { method: string; amount: number }[];
  /** Method of the paid payment intent (a QR order without a tender line). */
  intentMethod: string | null;
};
type LineFact = {
  orderId: string;
  menuItemId: string;
  categoryId: string | null;
  quantity: number;
  lineTotal: number;
};

export type SalesDayFacts = {
  orders: OrderFact[];
  lines: LineFact[];
  /** Active promo discount lines: order id, promo key, amount. */
  promos: { orderId: string; promo: string; amount: number }[];
  voids: { employee: string | null; amount: number }[];
  /** Refund tender lines: order id, method, amount. */
  refundLines: { orderId: string; method: string | null; amount: number }[];
  target: number;
};

async function loadFacts(
  input: DailyComputeInput,
  withTarget: boolean,
): Promise<SalesDayFacts> {
  const { tx, tenantId, outletId, businessDate } = input;
  const scope = sql`o.tenant_id = ${tenantId}::uuid AND o.outlet_id = ${outletId}::uuid
    AND o.business_date = ${businessDate}::date
    AND ${NOT_TRAINING_SQL}`;
  const orders = await tx.execute(sql`
    SELECT o.id::text AS id, o.channel, o.subtotal_idr AS subtotal,
      o.discount_idr AS discount, COALESCE(r.amount, 0) AS refund,
      ${ORDER_NET_SQL} AS net,
      LPAD(EXTRACT(HOUR FROM (COALESCE(po.completed_at, o.placed_at)
        AT TIME ZONE ou.timezone))::int::text, 2, '0') AS hour,
      po.cashier_id AS employee,
      (SELECT t.method FROM pos_order_tenders t
        WHERE t.tenant_id = o.tenant_id AND t.order_id = o.id
          AND t.status IN ('authorized', 'captured')
        ORDER BY t.amount_idr DESC, t.id LIMIT 1) AS method,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('method', t.method,
          'amount', t.amount_idr) ORDER BY t.method, t.id)
        FROM pos_order_tenders t
        WHERE t.tenant_id = o.tenant_id AND t.order_id = o.id
          AND t.status = 'captured'), '[]'::jsonb) AS tenders,
      pi.method AS intent_method
    FROM orders o
    JOIN outlets ou ON ou.tenant_id = o.tenant_id AND ou.id = o.outlet_id
    LEFT JOIN pos_orders po ON po.tenant_id = o.tenant_id AND po.order_id = o.id
    LEFT JOIN payment_intents pi ON pi.tenant_id = o.tenant_id
      AND pi.id = o.payment_intent_id
      AND pi.status IN ('paid', 'partially_refunded', 'refunded')
    ${REFUNDS_JOIN}
    WHERE ${scope} AND o.status = 'completed'`);
  const lines = await tx.execute(sql`
    SELECT oi.order_id::text AS order_id, oi.menu_item_id::text AS menu_item_id,
      mi.category_id::text AS category_id, oi.quantity, oi.line_total_idr AS line_total
    FROM order_items oi
    JOIN orders o ON o.tenant_id = oi.tenant_id AND o.id = oi.order_id
    JOIN menu_items mi ON mi.tenant_id = oi.tenant_id AND mi.id = oi.menu_item_id
    WHERE ${scope} AND o.status = 'completed' AND oi.status <> 'voided'`);
  const promos = await tx.execute(sql`
    SELECT d.order_id::text AS order_id, COALESCE(d.promo_code, d.source) AS promo,
      d.amount_idr AS amount
    FROM pos_order_discounts d
    JOIN orders o ON o.tenant_id = d.tenant_id AND o.id = d.order_id
    WHERE ${scope} AND o.status = 'completed' AND d.removed_at IS NULL`);
  const voids = await tx.execute(sql`
    SELECT v.requested_by AS employee, v.amount_idr AS amount
    FROM pos_order_voids v
    JOIN orders o ON o.tenant_id = v.tenant_id AND o.id = v.order_id
    WHERE ${scope}`);
  const refundLines = await tx.execute(sql`
    SELECT rf.order_id::text AS order_id, l.line->>'method' AS method,
      (l.line->>'amountIdr')::bigint AS amount
    FROM pos_order_refunds rf
    JOIN orders o ON o.tenant_id = rf.tenant_id AND o.id = rf.order_id
    CROSS JOIN LATERAL jsonb_array_elements(rf.lines) AS l(line)
    WHERE ${scope} AND o.status = 'completed'`);
  // Only the target reader needs `sales_targets`; the others never touch it.
  const target = withTarget
    ? await tx.execute(sql`
    SELECT COALESCE(SUM(target_idr), 0) AS target FROM sales_targets
    WHERE tenant_id = ${tenantId}::uuid AND outlet_id = ${outletId}::uuid
      AND target_date = ${businessDate}::date`)
    : { rows: [] as Record<string, unknown>[] };
  return {
    orders: orders.rows.map((row) => ({
      id: String(row.id),
      channel: String(row.channel),
      subtotal: num(row.subtotal),
      discount: num(row.discount),
      refund: num(row.refund),
      net: num(row.net),
      hour: String(row.hour),
      employee: row.employee === null ? null : String(row.employee),
      method: row.method === null ? null : String(row.method),
      tenders: (
        (row.tenders ?? []) as { method: unknown; amount: unknown }[]
      ).map((tender) => ({
        method: String(tender.method),
        amount: num(tender.amount),
      })),
      intentMethod:
        typeof row.intent_method === "string" ? row.intent_method : null,
    })),
    lines: lines.rows.map((row) => ({
      orderId: String(row.order_id),
      menuItemId: String(row.menu_item_id),
      categoryId: row.category_id === null ? null : String(row.category_id),
      quantity: num(row.quantity),
      lineTotal: num(row.line_total),
    })),
    promos: promos.rows.map((row) => ({
      orderId: String(row.order_id),
      promo: String(row.promo),
      amount: num(row.amount),
    })),
    voids: voids.rows.map((row) => ({
      employee: row.employee === null ? null : String(row.employee),
      amount: num(row.amount),
    })),
    refundLines: refundLines.rows.map((row) => ({
      orderId: String(row.order_id),
      method: row.method === null ? null : String(row.method),
      amount: num(row.amount),
    })),
    target: num(target.rows[0]?.target),
  };
}

// ---- Aggregation -------------------------------------------------------------

type Entry = { key: string; amount: number };

/** Sum of `amount` per key; rows with a null key are left out of the split. */
function group<T>(
  rows: readonly T[],
  keyOf: (row: T) => string | null,
  amountOf: (row: T) => number,
): Entry[] {
  const sums = new Map<string, number>();
  for (const row of rows) {
    const key = keyOf(row);
    if (key === null || key === "") continue;
    sums.set(
      key.slice(0, 200),
      (sums.get(key.slice(0, 200)) ?? 0) + amountOf(row),
    );
  }
  return [...sums].map(([key, amount]) => ({ key, amount }));
}

/** ISO day of week "1" (Monday) to "7" (Sunday) of a business date. */
function dayOfWeek(date: string): string {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return String(day === 0 ? 7 : day);
}

function rowsOf(
  code: string,
  value: (amount: number) => MetricValue,
  total: number,
  splits: Partial<Record<DimensionKey, Entry[]>>,
): DailyMetricValue[] {
  const out: DailyMetricValue[] = [
    { metricCode: code, dimension: null, value: value(total) },
  ];
  for (const [key, entries] of Object.entries(splits))
    for (const entry of entries ?? [])
      out.push({
        metricCode: code,
        dimension: { key: key as DimensionKey, value: entry.key },
        value: value(entry.amount),
      });
  return out;
}

const sum = (rows: readonly { amount: number }[]) =>
  rows.reduce((acc, row) => acc + row.amount, 0);

/**
 * Net sales of a line: the order net shared by line total (largest remainder),
 * so the lines of one order add up to its net exactly.
 */
function lineNets(facts: SalesDayFacts): (LineFact & { net: number })[] {
  const orderById = new Map(facts.orders.map((order) => [order.id, order]));
  const linesOf = new Map<string, LineFact[]>();
  for (const line of facts.lines)
    linesOf.set(line.orderId, [...(linesOf.get(line.orderId) ?? []), line]);
  const nets = new Map<LineFact, number>();
  for (const [orderId, lines] of linesOf) {
    const order = orderById.get(orderId);
    const parts = allocateByWeight(
      order ? order.net : 0,
      lines.map((line) => Math.max(0, line.lineTotal)),
    );
    lines.forEach((line, at) => nets.set(line, parts[at]!));
  }
  return facts.lines.map((line) => ({ ...line, net: nets.get(line) ?? 0 }));
}

/** Net of each order spread over its captured tenders by amount, per method. */
function netByMethod(orders: readonly OrderFact[]): Entry[] {
  const byMethod = new Map<string, number>();
  for (const order of orders) {
    // The same method on two tenders of one order is one share.
    const merged = new Map<string, number>();
    for (const tender of order.tenders)
      merged.set(
        tender.method,
        (merged.get(tender.method) ?? 0) + tender.amount,
      );
    // Tenders captured at 0 in total carry no weight: same as none.
    const captured = [...merged.values()].reduce((a, b) => a + b, 0);
    if (captured <= 0) {
      merged.clear();
      merged.set(order.intentMethod ?? PAYMENT_METHOD_UNASSIGNED, 1);
    }
    const methods = [...merged.keys()];
    const parts = allocateByWeight(order.net, [...merged.values()]);
    methods.forEach((method, at) =>
      byMethod.set(method, (byMethod.get(method) ?? 0) + parts[at]!),
    );
  }
  return [...byMethod]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, amount]) => ({ key, amount }));
}

/** Pure part of the readers: the rows of one code from the day's facts. */
export function salesRows(
  code: string,
  facts: SalesDayFacts,
  businessDate: string,
): DailyMetricValue[] {
  const { orders } = facts;
  const orderOf = new Map(orders.map((order) => [order.id, order]));
  switch (code) {
    case "net_sales": {
      const lines = lineNets(facts);
      return rowsOf(
        "net_sales",
        money,
        sum(orders.map((o) => ({ amount: o.net }))),
        {
          channel: group(
            orders,
            (o) => o.channel,
            (o) => o.net,
          ),
          hour: group(
            orders,
            (o) => o.hour,
            (o) => o.net,
          ),
          employee: group(
            orders,
            (o) => o.employee,
            (o) => o.net,
          ),
          day_of_week: orders.length
            ? [
                {
                  key: dayOfWeek(businessDate),
                  amount: orders.reduce((acc, o) => acc + o.net, 0),
                },
              ]
            : [],
          menu_item: group(
            lines,
            (l) => l.menuItemId,
            (l) => l.net,
          ),
          menu_category: group(
            lines,
            (l) => l.categoryId,
            (l) => l.net,
          ),
          payment_method: netByMethod(orders),
        },
      );
    }
    case "discount_amount":
      return rowsOf(
        "discount_amount",
        money,
        orders.reduce((acc, o) => acc + o.discount, 0),
        {
          channel: group(
            orders,
            (o) => o.channel,
            (o) => o.discount,
          ),
          employee: group(
            orders,
            (o) => o.employee,
            (o) => o.discount,
          ),
          promo: group(
            facts.promos,
            (p) => p.promo,
            (p) => p.amount,
          ),
        },
      );
    case "gross_sales": {
      const lines = facts.lines;
      return rowsOf(
        "gross_sales",
        money,
        orders.reduce((a, o) => a + o.subtotal, 0),
        {
          channel: group(
            orders,
            (o) => o.channel,
            (o) => o.subtotal,
          ),
          hour: group(
            orders,
            (o) => o.hour,
            (o) => o.subtotal,
          ),
          employee: group(
            orders,
            (o) => o.employee,
            (o) => o.subtotal,
          ),
          menu_category: group(
            lines,
            (l) => l.categoryId,
            (l) => l.lineTotal,
          ),
        },
      );
    }
    case "refund_amount":
      return rowsOf(
        "refund_amount",
        money,
        orders.reduce((a, o) => a + o.refund, 0),
        {
          channel: group(
            orders,
            (o) => o.channel,
            (o) => o.refund,
          ),
          payment_method: group(
            facts.refundLines.filter((l) => orderOf.has(l.orderId)),
            (l) => l.method,
            (l) => l.amount,
          ),
        },
      );
    case "void_amount":
      return rowsOf("void_amount", money, sum(facts.voids), {
        employee: group(
          facts.voids,
          (v) => v.employee,
          (v) => v.amount,
        ),
      });
    case "transaction_count":
      return rowsOf("transaction_count", count, orders.length, {
        channel: group(
          orders,
          (o) => o.channel,
          () => 1,
        ),
        hour: group(
          orders,
          (o) => o.hour,
          () => 1,
        ),
        employee: group(
          orders,
          (o) => o.employee,
          () => 1,
        ),
        payment_method: group(
          orders,
          (o) => o.method,
          () => 1,
        ),
      });
    case "menu_sold_qty": {
      const channelOf = (l: LineFact) => orderOf.get(l.orderId);
      return rowsOf(
        "menu_sold_qty",
        count,
        facts.lines.reduce((a, l) => a + l.quantity, 0),
        {
          menu_item: group(
            facts.lines,
            (l) => l.menuItemId,
            (l) => l.quantity,
          ),
          menu_category: group(
            facts.lines,
            (l) => l.categoryId,
            (l) => l.quantity,
          ),
          hour: group(
            facts.lines,
            (l) => channelOf(l)?.hour ?? null,
            (l) => l.quantity,
          ),
          channel: group(
            facts.lines,
            (l) => channelOf(l)?.channel ?? null,
            (l) => l.quantity,
          ),
          employee: group(
            facts.lines,
            (l) => channelOf(l)?.employee ?? null,
            (l) => l.quantity,
          ),
        },
      );
    }
    case "sales_target":
      return rowsOf("sales_target", money, facts.target, {});
    default:
      throw new Error(`Sales reader has no code "${code}"`);
  }
}

function reader(
  code: string,
  dimensions: readonly DimensionKey[],
  requiresDailyClose = true,
): DailyMetricReader {
  return {
    metricCodes: [code],
    dimensions,
    requiresDailyClose,
    async compute(input) {
      const facts = await loadFacts(input, code === "sales_target");
      return salesRows(code, facts, input.businessDate);
    },
  };
}

const grossSales = reader("gross_sales", [
  "channel",
  "hour",
  "employee",
  "menu_category",
]);
const refundAmount = reader("refund_amount", ["channel", "payment_method"]);
const voidAmount = reader("void_amount", ["employee"]);
const transactionCount = reader("transaction_count", [
  "channel",
  "hour",
  "employee",
  "payment_method",
]);
const menuSoldQty = reader("menu_sold_qty", [
  "menu_item",
  "menu_category",
  "hour",
  "channel",
  "employee",
]);
const salesTarget = reader("sales_target", [], false);

const netSalesSplits = reader("net_sales", [
  "channel",
  "hour",
  "employee",
  "day_of_week",
  "menu_item",
  "menu_category",
  "payment_method",
]);
const discountSplits = reader("discount_amount", [
  "channel",
  "employee",
  "promo",
]);

const daily = (code: string, r: DailyMetricReader): MetricSource => ({
  kind: "daily",
  code,
  reader: r,
});
const derived = (
  code: string,
  numerator: string,
  denominator: string,
  scale: 1 | 100,
): MetricSource => ({ kind: "derived", code, numerator, denominator, scale });

const splitsOf = (code: string, r: DailyMetricReader): MetricSplitSource[] =>
  r.dimensions.map((dimension) => ({ code, dimension, reader: r }));

export const salesSources: MetricSourceFamilyModule = {
  family: "sales",
  sources: [
    daily("gross_sales", grossSales),
    daily("refund_amount", refundAmount),
    daily("void_amount", voidAmount),
    daily("transaction_count", transactionCount),
    daily("menu_sold_qty", menuSoldQty),
    daily("sales_target", salesTarget),
    derived("discount_rate_pct", "discount_amount", "gross_sales", 100),
    derived("refund_rate_pct", "refund_amount", "net_sales", 100),
    derived("void_rate_pct", "void_amount", "net_sales", 100),
    derived("avg_ticket", "net_sales", "transaction_count", 1),
    derived("target_achievement_pct", "net_sales", "sales_target", 100),
  ],
  splits: [
    ...splitsOf("net_sales", netSalesSplits),
    ...splitsOf("discount_amount", discountSplits),
  ],
};

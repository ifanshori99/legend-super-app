// Metric sources of the "payments-tax" family (bead legend-hpc4s, WS-11 F4;
// DECISIONS 2026-11-10 points 1, 2 and 5). Owned by this family's card.
//
// Built here:
// - NOT registered: `net_sales` by `payment_method` (payments.methods). A
//   second `net_sales` reader would clash with the sales card (F1): both would
//   write the `net_sales` total row with their own definition, and the daily
//   job deletes the rows of a reader's codes that it did not write, so two
//   readers would erase each other's splits. `netSalesByMethodReader` and
//   `allocateByWeight` stay here, exported and unregistered, as material for
//   the sales card: completed orders on their business date, net = gross sales
//   minus discount (`orderRevenueSplit`), spread over the captured tenders by
//   amount (largest remainder, BigInt), a QR order on its paid intent method,
//   `unassigned` when neither exists, training orders left out. Until sales
//   owns the `payment_method` dimension of `net_sales`, that split of
//   payments.methods answers `unavailable`.
// - `failed_payment_count`: failed tenders of non-training orders, by method.
// - `cash_variance`: closed shift variance, by cashier id. The ledger books the
//   shift difference (variance plus held cash) on its own; this metric is the
//   count-versus-expected variance of the shift, a figure the ledger does not
//   post, so it reads the shifts directly (point 1, last sentence).
//
// Not built (no source data in the schema, they answer `unavailable`):
// - `gateway_settlement`, `edc_settlement`: no settlement table; the settlement
//   events have no emitter yet (packages/shared/src/payment/settlement-events.ts).
// - `tax_collected`, `service_charge_collected`, `tax_payable`: the ledger
//   posts them (roles tax_payable_pbjt, service_charge), so they must become
//   ledger sources in `metrics-gl-sources.ts` (shared thread request); a
//   balance and a menu-category split need the same shared work.
// - `payment_fee` by payment method: nothing writes `payment_intents.fee_idr`
//   and settlement fees carry no method, so no split is registered.
// - `transaction_count` by payment method: that code belongs to the sales card.

import { sql } from "drizzle-orm";
import { orderRevenueSplit } from "../order-revenue";
import type {
  DailyComputeInput,
  DailyMetricReader,
  DailyMetricValue,
  MetricSourceFamilyModule,
} from "./types";

/** Orders with no captured tender and no paid intent (deposit-only, unpaid). */
export const PAYMENT_METHOD_UNASSIGNED = "unassigned";

const num = (value: unknown): number => Number(value ?? 0);

/**
 * Spreads `amount` over weights with the largest remainder rule so the parts
 * add up to it exactly; ties go to the earlier entry. Pure, deterministic,
 * exact in BigInt, so large amounts and weights lose no rupiah to rounding.
 */
export function allocateByWeight(
  amount: number,
  weights: readonly number[],
): number[] {
  const big = weights.map((weight) => BigInt(weight));
  const total = big.reduce((sum, weight) => sum + weight, 0n);
  if (weights.length === 0 || total <= 0n) return weights.map(() => 0);
  const magnitude = BigInt(Math.abs(amount));
  const parts = big.map((weight) => ({
    floor: (magnitude * weight) / total,
    rest: (magnitude * weight) % total,
  }));
  let left = magnitude - parts.reduce((sum, part) => sum + part.floor, 0n);
  const order = parts
    .map((part, at) => ({ at, rest: part.rest }))
    .sort((a, b) =>
      a.rest === b.rest ? a.at - b.at : a.rest > b.rest ? -1 : 1,
    );
  const result = parts.map((part) => part.floor);
  for (const { at } of order) {
    if (left <= 0n) break;
    result[at]! += 1n;
    left -= 1n;
  }
  const sign = amount < 0 ? -1 : 1;
  return result.map((part) => sign * Number(part));
}

type Tender = { method: string; amount: number };

async function netSalesByMethod(
  input: DailyComputeInput,
): Promise<readonly DailyMetricValue[]> {
  const { tx, tenantId, outletId, businessDate } = input;
  const { rows } = await tx.execute(sql`
    SELECT o.subtotal_idr, o.discount_idr, o.service_charge_idr, o.tax_idr,
           o.rounding_idr, o.total_idr, o.prices_include_tax,
           COALESCE((
             SELECT jsonb_agg(jsonb_build_object('method', t.method, 'amount', t.amount_idr)
                              ORDER BY t.method, t.id)
               FROM pos_order_tenders t
              WHERE t.tenant_id = o.tenant_id AND t.order_id = o.id
                AND t.status = 'captured'), '[]'::jsonb) AS tenders,
           pi.method AS intent_method
      FROM orders o
      LEFT JOIN payment_intents pi
        ON pi.tenant_id = o.tenant_id AND pi.id = o.payment_intent_id
       AND pi.status IN ('paid', 'partially_refunded', 'refunded')
     WHERE o.tenant_id = ${tenantId}::uuid AND o.outlet_id = ${outletId}::uuid
       AND o.business_date = ${businessDate}::date AND o.status = 'completed'
       AND NOT EXISTS (
         SELECT 1 FROM pos_orders po
          WHERE po.tenant_id = o.tenant_id AND po.order_id = o.id
            AND po.is_training)
     ORDER BY o.id`);

  const byMethod = new Map<string, number>();
  let total = 0;
  for (const row of rows) {
    let net: number;
    try {
      const split = orderRevenueSplit({
        subtotalIdr: num(row.subtotal_idr),
        discountIdr: num(row.discount_idr),
        serviceChargeIdr: num(row.service_charge_idr),
        taxIdr: num(row.tax_idr),
        roundingIdr: num(row.rounding_idr),
        totalIdr: num(row.total_idr),
        pricesIncludeTax: row.prices_include_tax === true,
      });
      net = split.grossSalesIdr - split.discountIdr;
    } catch {
      // An order that breaks its own identity has no recorded net figure:
      // leave it to the ledger residual instead of inventing one.
      continue;
    }
    const tenders = (row.tenders as Tender[]).map((tender) => ({
      method: String(tender.method),
      amount: num(tender.amount),
    }));
    const shares: Tender[] =
      tenders.length > 0
        ? tenders
        : [
            {
              method:
                typeof row.intent_method === "string"
                  ? row.intent_method
                  : PAYMENT_METHOD_UNASSIGNED,
              amount: 1,
            },
          ];
    // The same method on two tenders of one order is one share.
    const merged = new Map<string, number>();
    for (const share of shares)
      merged.set(share.method, (merged.get(share.method) ?? 0) + share.amount);
    const methods = [...merged.keys()];
    const parts = allocateByWeight(net, [...merged.values()]);
    methods.forEach((method, at) =>
      byMethod.set(method, (byMethod.get(method) ?? 0) + parts[at]!),
    );
    total += net;
  }

  return [
    {
      metricCode: "net_sales",
      dimension: null,
      value: { unit: "idr", valueIdr: total as never },
    },
    ...[...byMethod.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([method, amount]): DailyMetricValue => ({
        metricCode: "net_sales",
        dimension: { key: "payment_method", value: method },
        value: { unit: "idr", valueIdr: amount as never },
      })),
  ];
}

/** Writes the order-derived net sales by payment method (the split source). */
export const netSalesByMethodReader: DailyMetricReader = {
  metricCodes: ["net_sales"],
  dimensions: ["payment_method"],
  requiresDailyClose: false,
  compute: netSalesByMethod,
};

const failedPaymentsReader: DailyMetricReader = {
  metricCodes: ["failed_payment_count"],
  dimensions: ["payment_method"],
  requiresDailyClose: false,
  async compute({ tx, tenantId, outletId, businessDate }) {
    const { rows } = await tx.execute(sql`
      SELECT t.method, count(*)::int AS n
        FROM pos_order_tenders t
        JOIN orders o ON o.tenant_id = t.tenant_id AND o.id = t.order_id
       WHERE t.tenant_id = ${tenantId}::uuid AND t.outlet_id = ${outletId}::uuid
         AND t.status = 'failed' AND o.business_date = ${businessDate}::date
         AND NOT EXISTS (
           SELECT 1 FROM pos_orders po
            WHERE po.tenant_id = t.tenant_id AND po.order_id = t.order_id
              AND po.is_training)
       GROUP BY t.method ORDER BY t.method`);
    const total = rows.reduce((sum, row) => sum + num(row.n), 0);
    return [
      {
        metricCode: "failed_payment_count",
        dimension: null,
        value: { unit: "count", value: total },
      },
      ...rows.map((row): DailyMetricValue => ({
        metricCode: "failed_payment_count",
        dimension: { key: "payment_method", value: String(row.method) },
        value: { unit: "count", value: num(row.n) },
      })),
    ];
  },
};

const cashVarianceReader: DailyMetricReader = {
  metricCodes: ["cash_variance"],
  dimensions: ["employee"],
  // A cash figure of a closed day: final needs the day close (point of sale).
  requiresDailyClose: true,
  async compute({ tx, tenantId, outletId, businessDate }) {
    const { rows } = await tx.execute(sql`
      SELECT cashier_id, COALESCE(SUM(variance_idr), 0)::bigint AS variance
        FROM pos_shifts
       WHERE tenant_id = ${tenantId}::uuid AND outlet_id = ${outletId}::uuid
         AND business_date = ${businessDate}::date
         AND status = 'closed' AND variance_idr IS NOT NULL
       GROUP BY cashier_id ORDER BY cashier_id`);
    const total = rows.reduce((sum, row) => sum + num(row.variance), 0);
    return [
      {
        metricCode: "cash_variance",
        dimension: null,
        value: { unit: "idr", valueIdr: total as never },
      },
      ...rows.map((row): DailyMetricValue => ({
        metricCode: "cash_variance",
        dimension: { key: "employee", value: String(row.cashier_id) },
        value: { unit: "idr", valueIdr: num(row.variance) as never },
      })),
    ];
  },
};

export const paymentsTaxSources: MetricSourceFamilyModule = {
  family: "payments-tax",
  sources: [
    {
      kind: "daily",
      code: "failed_payment_count",
      reader: failedPaymentsReader,
    },
    { kind: "daily", code: "cash_variance", reader: cashVarianceReader },
    {
      kind: "unavailable",
      code: "gateway_settlement",
      reason: "source_not_built",
    },
    { kind: "unavailable", code: "edc_settlement", reason: "source_not_built" },
    { kind: "unavailable", code: "tax_collected", reason: "source_not_built" },
    {
      kind: "unavailable",
      code: "service_charge_collected",
      reason: "source_not_built",
    },
    { kind: "unavailable", code: "tax_payable", reason: "source_not_built" },
  ],
  splits: [],
};

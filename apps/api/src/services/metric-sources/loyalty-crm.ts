// Metric sources of the "loyalty-crm" family (WS-11 F7, bead legend-20ucm).
// Owned by this family's card: add sources and splits here, never in another
// file. Everything here only reads WS-08 tables; no money or points move.
//
// Built (daily readers, one outlet-day each, total row always written, zero
// when nothing happened):
// - new_customers / returning_customers: members with a `customer_visits` row
//   at the outlet on the business day. A member is new when no visit of the
//   tenant (any outlet) is older than the member's first visit of that day,
//   else returning, so the two add up to the distinct members who visited.
//   Split customer_tier: the member's tier at the end of the business day
//   (last `customer_tier_history` row up to then), `unassigned` without one.
// - review_rating / review_count: `feedback` of kind `rating` created on the
//   business day at the outlet (complaints carry no rating and are left out).
//   The rating average is weighted by review_count across days and outlets; a
//   day without reviews stores 0 with a weight of 0, so it is left out.
// - promo_cost: `promotion_redemptions` still `applied` (a released one gave
//   nothing) redeemed on the business day at the outlet, `discount_idr`
//   summed. Split promo: the promotion id, or the voucher id for a value
//   voucher without a promotion. Note this key is not the POS discount code
//   `discount_amount` splits by.
//
// Not built, answered `unavailable` / `source_not_built`:
// - active_members: a member's status and home outlet have no history, so a
//   past day cannot be answered, and a member without `home_outlet_id` has no
//   outlet. Needs a founder/CTO decision (see the bead comment).
// - points_redeemed: redeem rows of `point_ledger` are written without an
//   outlet or business date (the member app redeems, no till is involved);
//   only `reward_redemptions.fulfilled_outlet_id` names an outlet, at pickup.
//   Which outlet and day own a redeemed point is a decision, not a guess.
//
// Dimension values are ids: tier id, promotion or voucher id.

import { sql } from "drizzle-orm";
import {
  businessDayRange,
  decimal4 as toDecimal4,
  idr,
} from "@starter/shared/core";
import { outletBusinessDayClock } from "../outlet-clock";
import type {
  DailyComputeInput,
  DailyMetricReader,
  DailyMetricValue,
  MetricSource,
  MetricSourceFamilyModule,
} from "./types";

type Window = { start: string; end: string };

async function windowOf(input: DailyComputeInput): Promise<Window> {
  const result = await input.tx.execute(sql`
    SELECT timezone, business_day_cutoff
      FROM outlets
     WHERE tenant_id = ${input.tenantId}::uuid AND id = ${input.outletId}::uuid`);
  const row = result.rows[0];
  if (!row) throw new Error("Outlet not found for the metric reader");
  const clock = outletBusinessDayClock({
    timezone: String(row.timezone),
    businessDayCutoff: String(row.business_day_cutoff),
  });
  const range = businessDayRange(input.businessDate, clock);
  return { start: range.start.toISOString(), end: range.end.toISOString() };
}

const countValue = (value: number): DailyMetricValue["value"] => ({
  unit: "count",
  value,
});

export const TIER_UNASSIGNED = "unassigned";

// ---- customers: new and returning ------------------------------------------

const customerReader: DailyMetricReader = {
  metricCodes: ["new_customers", "returning_customers"],
  dimensions: ["customer_tier"],
  // Visits are written for paid orders: the day is final after the close.
  requiresDailyClose: true,
  async compute(input) {
    const window = await windowOf(input);
    const result = await input.tx.execute(sql`
      SELECT EXISTS (
               SELECT 1 FROM customer_visits e
                WHERE e.tenant_id = ${input.tenantId}::uuid
                  AND e.customer_profile_id = p.profile_id
                  AND e.visited_at < p.first_at
             ) AS had_before,
             tier.to_tier_id::text AS tier
        FROM (
          SELECT customer_profile_id AS profile_id, min(visited_at) AS first_at
            FROM customer_visits
           WHERE tenant_id = ${input.tenantId}::uuid
             AND outlet_id = ${input.outletId}::uuid
             AND visited_at >= ${window.start}::timestamptz
             AND visited_at < ${window.end}::timestamptz
           GROUP BY customer_profile_id
        ) p
        LEFT JOIN LATERAL (
          SELECT h.to_tier_id
            FROM customer_tier_history h
           WHERE h.tenant_id = ${input.tenantId}::uuid
             AND h.customer_profile_id = p.profile_id
             AND h.created_at < ${window.end}::timestamptz
           ORDER BY h.created_at DESC, h.id DESC
           LIMIT 1
        ) tier ON true`);
    const counts = {
      new_customers: new Map<string, number>(),
      returning_customers: new Map<string, number>(),
    };
    for (const row of result.rows) {
      const byTier =
        counts[row.had_before ? "returning_customers" : "new_customers"];
      const tier = row.tier ? String(row.tier) : TIER_UNASSIGNED;
      byTier.set(tier, (byTier.get(tier) ?? 0) + 1);
    }
    return (Object.keys(counts) as (keyof typeof counts)[]).flatMap(
      (metricCode) => {
        const byTier = counts[metricCode];
        const total = [...byTier.values()].reduce((sum, n) => sum + n, 0);
        return [
          { metricCode, dimension: null, value: countValue(total) },
          ...[...byTier.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([tier, n]) => ({
              metricCode,
              dimension: { key: "customer_tier" as const, value: tier },
              value: countValue(n),
            })),
        ];
      },
    );
  },
};

// ---- reviews ---------------------------------------------------------------

const reviewReader: DailyMetricReader = {
  metricCodes: ["review_rating", "review_count"],
  dimensions: [],
  requiresDailyClose: false,
  async compute(input) {
    const window = await windowOf(input);
    const result = await input.tx.execute(sql`
      SELECT count(*) AS n, coalesce(sum(rating), 0) AS total
        FROM feedback
       WHERE tenant_id = ${input.tenantId}::uuid
         AND outlet_id = ${input.outletId}::uuid
         AND kind = 'rating'
         AND created_at >= ${window.start}::timestamptz
         AND created_at < ${window.end}::timestamptz`);
    const n = Number(result.rows[0]?.n ?? 0);
    const total = Number(result.rows[0]?.total ?? 0);
    return [
      {
        metricCode: "review_rating",
        dimension: null,
        value: {
          unit: "decimal",
          value: toDecimal4(n === 0 ? "0.0000" : (total / n).toFixed(4)),
        },
      },
      { metricCode: "review_count", dimension: null, value: countValue(n) },
    ];
  },
};

// ---- promo cost ------------------------------------------------------------

const promoCostReader: DailyMetricReader = {
  metricCodes: ["promo_cost"],
  dimensions: ["promo"],
  requiresDailyClose: true,
  async compute(input) {
    const window = await windowOf(input);
    const result = await input.tx.execute(sql`
      SELECT COALESCE(promotion_id, voucher_id)::text AS dim,
             sum(discount_idr) AS amount
        FROM promotion_redemptions
       WHERE tenant_id = ${input.tenantId}::uuid
         AND outlet_id = ${input.outletId}::uuid
         AND status = 'applied'
         AND redeemed_at >= ${window.start}::timestamptz
         AND redeemed_at < ${window.end}::timestamptz
       GROUP BY 1
       ORDER BY 1`);
    const rows = result.rows.map((row) => ({
      promo: String(row.dim),
      amount: Number(row.amount ?? 0),
    }));
    const money = (value: number): DailyMetricValue["value"] => ({
      unit: "idr",
      valueIdr: idr(value),
    });
    return [
      {
        metricCode: "promo_cost",
        dimension: null,
        value: money(rows.reduce((sum, row) => sum + row.amount, 0)),
      },
      ...rows.map((row) => ({
        metricCode: "promo_cost",
        dimension: { key: "promo" as const, value: row.promo },
        value: money(row.amount),
      })),
    ];
  },
};

// ---- registry --------------------------------------------------------------

/** Volume each stored average is weighted by across days and outlets. */
const WEIGHT_CODES: Readonly<Record<string, string>> = {
  review_rating: "review_count",
};

function dailySources(reader: DailyMetricReader): MetricSource[] {
  return reader.metricCodes.map((code) => ({
    kind: "daily" as const,
    code,
    reader,
    ...(WEIGHT_CODES[code] ? { weightCode: WEIGHT_CODES[code] } : {}),
  }));
}

const unavailable = (code: string): MetricSource => ({
  kind: "unavailable",
  code,
  reason: "source_not_built",
});

export const loyaltyCrmSources: MetricSourceFamilyModule = {
  family: "loyalty-crm",
  sources: [
    ...dailySources(customerReader),
    ...dailySources(reviewReader),
    ...dailySources(promoCostReader),
    unavailable("active_members"),
    unavailable("points_redeemed"),
  ],
  splits: [],
};

// Same-day cumulative minimum-spend facility reward (PRD v1.7 §3.25 "Minimum
// belanja — belanja F&B di atas ambang tertentu pada hari yang sama menerbitkan
// voucher akses"; owner decision Q40; bead legend-e5it).
//
// Q40: for an identified customer, the minimum spend of a facility-access
// reward is the customer's TOTAL spend over all their bills on the same
// business day, not one bill. Anonymous bills keep the per-bill rule (and the
// evaluator never grants an anonymous bill a facility reward anyway). The
// reward is issued once per promotion, customer, outlet and business day.
//
// Decisions (PRD silent, safest reading, see report):
// - "same day" = the outlet's business date, counted per outlet: bills at
//   another outlet do not add up, and the once-per-day rule is per outlet.
//   The facility is at the outlet, and outlet RLS (TEN-03) would hide another
//   outlet's bills and rewards from an outlet-scoped checkout anyway.
// - spend of a bill = the min_spend basis of every non-released promo
//   application, less its refunded part; a voided bill does not count. The
//   basis is the bill value before promo, tax and service charge (owner Q53):
//   `subtotal_idr`, or for an outlet whose prices include tax the
//   `minSpendSubtotalIdr` stored in the application `result`. The refunded
//   part is proportional: floor(basis x (subtotal - refunded) / subtotal).
//
// How: the pure evaluator reads one bill's subtotal, so instead of changing it
// this module rewrites the reward's `min_spend` amount to what is still
// missing today (amount - earlier spend, at least Rp1). A promotion already
// rewarded today gets an unreachable minimum, so it is rejected
// (min_spend_not_met) and never issued twice.
//
// Race safety: redeem takes a transaction advisory lock per (tenant, outlet,
// customer, business date) before reading the earlier spend, so two bills of
// the same customer serialize; the partial unique index
// `facility_rewards_daily_key` is the database backstop. Lock order: after
// the per-order lock and the voucher row, before any promotion row (the
// refund path follows the same order).

import { and, eq, gte, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import type { PromoCustomer, Promotion } from "@starter/shared/crm";
import {
  businessDateOf,
  businessDayRange,
  idr,
  outletIdSchema,
  type BusinessDayClock,
  type Idr,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { facilityRewards, promotionOrderApplications } from "../db/schema";
import { outletBusinessDayClock } from "./outlet-clock";
import type { Tx } from "./permission-resolver";

/** Outlet business date (Q39 cutoff, default 04:00) used for the same-day rule. */
export function promoBusinessDate(at: Date, clock: BusinessDayClock): string {
  return businessDateOf(at, clock);
}

export type BusinessDayWindow = {
  readonly businessDate: string;
  /** Inclusive start instant. */
  readonly start: Date;
  /** Exclusive end instant. */
  readonly end: Date;
};

export function businessDayWindow(
  at: Date,
  clock: BusinessDayClock,
): BusinessDayWindow {
  const businessDate = promoBusinessDate(at, clock);
  return { businessDate, ...businessDayRange(businessDate, clock) };
}

/** A facility-access reward gated by a minimum spend (PRD §3.25). */
export function isSameDayMinSpendReward(
  promotion: Pick<Promotion, "benefit" | "conditions">,
): boolean {
  return (
    promotion.benefit.kind === "facility_entitlement" &&
    promotion.conditions.some((condition) => condition.kind === "min_spend")
  );
}

/**
 * The business date stored on a facility reward: set for a same-day
 * minimum-spend reward (once-per-day key), null otherwise.
 */
export function sameDayRewardDate(
  promotion: Promotion,
  at: Date,
  clock: BusinessDayClock,
): string | null {
  return isSameDayMinSpendReward(promotion)
    ? promoBusinessDate(at, clock)
    : null;
}

/** Serializes one customer's same-day bills at one outlet (transaction). */
export async function lockCustomerDay(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: string,
  customerProfileId: string,
  businessDate: string,
): Promise<void> {
  const key = `promo-minspend:${context.tenant.tenantId}:${outletId}:${customerProfileId}:${businessDate}`;
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
  );
}

/**
 * Spend of one customer at one outlet in a business-day window, over every
 * bill that still stands (voided bills excluded, partial refunds deducted).
 */
export async function sameDaySpendIdr(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    outletId: OutletId;
    customerProfileId: string;
    window: BusinessDayWindow;
    excludeOrderId?: string;
  },
): Promise<Idr> {
  const subtotal = promotionOrderApplications.subtotalIdr;
  const standing = sql`(${subtotal} - ${promotionOrderApplications.refundedSubtotalIdr})`;
  const stored = sql`(${promotionOrderApplications.result} ->> 'minSpendSubtotalIdr')`;
  const [row] = await tx
    .select({
      // No stored basis (older row, exclusive prices): the old formula.
      spend: sql<string>`coalesce(sum(CASE
        WHEN ${stored} IS NULL THEN ${standing}
        WHEN ${subtotal} = 0 THEN 0
        ELSE floor(${stored}::numeric * ${standing} / ${subtotal})
      END), 0)`,
    })
    .from(promotionOrderApplications)
    .where(
      and(
        eq(promotionOrderApplications.tenantId, context.tenant.tenantId),
        eq(promotionOrderApplications.outletId, input.outletId),
        eq(
          promotionOrderApplications.customerProfileId,
          input.customerProfileId,
        ),
        eq(promotionOrderApplications.status, "applied"),
        gte(promotionOrderApplications.redeemedAt, input.window.start),
        lt(promotionOrderApplications.redeemedAt, input.window.end),
        input.excludeOrderId === undefined
          ? undefined
          : ne(promotionOrderApplications.orderId, input.excludeOrderId),
      ),
    );
  return idr(Number(row?.spend ?? 0));
}

/** A min_spend amount no bill can reach: the promotion is rejected. */
const UNREACHABLE_MIN_SPEND = idr(Number.MAX_SAFE_INTEGER);

/**
 * Rewrites a reward's minimum spend for the spend already made today (by
 * other bills), so the evaluator's per-bill check means "today's total".
 * Generic over the rule shape: the refund recheck passes a snapshot rule
 * (conditions + benefit) instead of a full `Promotion` row.
 */
export function withSameDaySpend<
  T extends { conditions: Promotion["conditions"] },
>(promotion: T, earlierSpendIdr: number, rewardedToday: boolean): T {
  return {
    ...promotion,
    conditions: promotion.conditions.map((condition) => {
      if (condition.kind !== "min_spend") return condition;
      if (rewardedToday)
        return { kind: "min_spend", amountIdr: UNREACHABLE_MIN_SPEND };
      return {
        kind: "min_spend",
        amountIdr: idr(Math.max(1, condition.amountIdr - earlierSpendIdr)),
      };
    }),
  };
}

export type SameDayMinSpend = (promotion: Promotion) => Promotion;

const identity: SameDayMinSpend = (promotion) => promotion;

/**
 * Loads the customer's earlier spend today at the outlet and the same-day
 * rewards already issued, and returns a pure transform for the engine's
 * candidate promotions (apply it to every candidate list, including the rows
 * re-read under lock). With `lock`, the per customer/outlet/day advisory lock
 * is taken before reading, so the answer stays true until commit. No member,
 * or no same-day minimum-spend reward among the candidates: identity, no
 * query, no lock.
 */
export async function loadSameDayMinSpend(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    promotions: readonly Promotion[];
    customer: PromoCustomer | null;
    outlet: { id: string; timezone: string; businessDayCutoff: string };
    at: Date;
    lock: boolean;
  },
): Promise<SameDayMinSpend> {
  const customerId = input.customer?.customerProfileId ?? null;
  const targets = input.promotions.filter(isSameDayMinSpendReward);
  if (customerId === null || targets.length === 0) return identity;
  const outletId = outletIdSchema.parse(input.outlet.id);
  const window = businessDayWindow(
    input.at,
    outletBusinessDayClock(input.outlet),
  );
  if (input.lock)
    await lockCustomerDay(
      tx,
      context,
      outletId,
      customerId,
      window.businessDate,
    );
  const earlier = await sameDaySpendIdr(tx, context, {
    outletId,
    customerProfileId: customerId,
    window,
  });
  const rewarded = await tx
    .select({ promotionId: facilityRewards.promotionId })
    .from(facilityRewards)
    .where(
      and(
        eq(facilityRewards.tenantId, context.tenant.tenantId),
        eq(facilityRewards.outletId, outletId),
        eq(facilityRewards.customerProfileId, customerId),
        eq(facilityRewards.businessDate, window.businessDate),
        inArray(
          facilityRewards.promotionId,
          targets.map((promotion) => promotion.id),
        ),
        isNull(facilityRewards.revokedAt),
      ),
    );
  const rewardedIds = new Set(rewarded.map((row) => row.promotionId));
  return (promotion) =>
    isSameDayMinSpendReward(promotion)
      ? withSameDaySpend(promotion, earlier, rewardedIds.has(promotion.id))
      : promotion;
}

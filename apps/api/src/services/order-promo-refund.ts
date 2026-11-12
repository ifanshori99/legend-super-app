// Partial-refund port for order services (bead legend-souz; owner Q41; PRD
// v1.7 §3.10, §3.21). Wraps `recomputeAfterPartialRefund`
// (crm-promo-refund.ts) and closes the gap noted in the promo Q41 review:
//
//   The recompute keeps, per still-applied redemption line, only what the
//   kept goods still earn (founder rule, 9 Nov 2026: the line's pro-rata
//   share by price; Q19: capped by what its promotion gives when re-evaluated
//   in stack order on the kept lines), but only withdrawn promotions give
//   their discount back to `promotions.spent_idr`. The part that belonged to
//   the refunded items ("clamp" below) is no longer given to the guest, so
//   the promotion budget and the ROI cost (sum of
//   `promotion_redemptions.discount_idr`) would still count it.
//
// This wrapper moves each still-applied redemption line to the discount the
// recompute says it keeps (`keptLineDiscounts`), and the `spent_idr` of its
// promotion by the same amount (value vouchers have no promotion row: only
// their line moves). So the budget a promotion gets back is what that
// promotion actually lost, never a share of another promotion's loss. A line
// can also go UP (legend-a0i7: a later return makes it earn more than an
// earlier refund left on it); the raise takes budget again, capped at what the
// promotion still has. The invariant kept is sum(applied line discount_idr) ==
// application.total_discount_idr, except when a raise was cut short by the
// budget (then the lines sum to less; `budgetShortIdr` in the audit); in both
// cases spent_idr still counts every applied line, so a later full void
// (`releasePromotions`) never drives `spent_idr` below zero.
//
// Lock order is the engine's (crm-promo-engine `redeemPromotions` doc): the
// caller holds the order row; then the per-order advisory lock and the
// application row are taken here BEFORE the recompute (both re-entrant in the
// same transaction), and the promotion rows lowered below are already held
// FOR UPDATE by the recompute.
//
// Idempotent: repeating the same refund withdraws nothing and every line
// already carries what it keeps, so the correction is Rp0.

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  assertTrustedScopedContext,
  createUlid,
  idr,
  ulidIdSchema,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import {
  promotionOrderApplications,
  promotionRedemptions,
  promotions,
} from "../db/schema";
import { recordAudit } from "./core-audit";
import { PROMO_AUDIT_SAFE_FIELDS } from "./crm-promo-engine";
import {
  livePromoApplicationOf,
  recomputeAfterPartialRefund,
  recordPartialRefundPayout,
  type PartialRefundInput,
  type PartialRefundResult,
  type PromoPartialRefundPort,
} from "./crm-promo-refund";
import type { Tx } from "./permission-resolver";

const orderIdSchema = ulidIdSchema<"OrderId">();
const CLAMP_AUDIT_FIELDS: readonly string[] = [
  ...PROMO_AUDIT_SAFE_FIELDS,
  "clampedDiscountIdr",
  "raisedDiscountIdr",
  "budgetShortIdr",
];

/** Same key as the engine's per-order lock (crm-promo-engine `lockOrder`). */
async function lockOrder(tx: Tx, tenantId: TenantId, orderId: string) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`promo:${tenantId}:${orderId}`}, 0))`,
  );
}

/**
 * How much of the order discount went with the refunded items (>= 0): what was
 * standing before, minus what was withdrawn, minus what the kept lines keep.
 * While the invariant holds it equals the sum of the per-line cuts that
 * `lowerAppliedDiscount` gives back to the promotion budget.
 */
export function clampedDiscountOf(
  standingBeforeIdr: number,
  result: Extract<PartialRefundResult, { adjusted: true }>,
): number {
  return Math.max(
    0,
    standingBeforeIdr - result.withdrawnDiscountIdr - result.totalDiscountIdr,
  );
}

/**
 * Moves each still-applied redemption line of one order to the discount it
 * keeps, and its promotion's spent_idr by the same amount (legend-a0i7).
 * Lowering gives budget back. Raising (a later return made the line earn more
 * than an earlier refund left on it) takes budget again, at most what the
 * promotion still has (`promotions_budget_check`: spent <= budget): the line
 * is raised only by what spent_idr could take, so spent_idr never drops below
 * the applied lines and a later void never drives it negative. The shortfall
 * is the kept discount the guest still gets that the budget could not count
 * again (another sale took the room in between); it is audited, never an
 * error, so the refund is never locked by another sale.
 */
async function reconcileAppliedDiscount(
  tx: Tx,
  tenantId: TenantId,
  orderId: string,
  kept: Extract<PartialRefundResult, { adjusted: true }>["keptLineDiscounts"],
  now: Date,
): Promise<{ lowered: number; raised: number; budgetShortIdr: number }> {
  const lines = await tx
    .select({
      id: promotionRedemptions.id,
      promotionId: promotionRedemptions.promotionId,
      discountIdr: promotionRedemptions.discountIdr,
    })
    .from(promotionRedemptions)
    .where(
      and(
        eq(promotionRedemptions.tenantId, tenantId),
        eq(promotionRedemptions.orderId, orderId),
        eq(promotionRedemptions.status, "applied"),
      ),
    )
    .orderBy(
      asc(promotionRedemptions.promotionId),
      asc(promotionRedemptions.id),
    )
    .for("update");
  const keptById = new Map(
    kept.map((entry) => [entry.redemptionId, entry.keptDiscountIdr]),
  );
  // Signed change per line: < 0 lowers, > 0 raises. Never below zero (CHECK
  // discount_idr >= 0).
  const deltas = lines.map((line) => {
    const keep = keptById.get(line.id);
    return keep === undefined ? 0 : Math.max(0, keep) - line.discountIdr;
  });
  if (deltas.every((delta) => delta === 0))
    return { lowered: 0, raised: 0, budgetShortIdr: 0 };
  const promotionIds = [
    ...new Set(
      lines
        .filter((_, index) => (deltas[index] ?? 0) !== 0)
        .map((line) => line.promotionId)
        .filter((id): id is string => id !== null),
    ),
  ].sort();
  // Already held by the recompute; re-taken in id order, never out of order.
  const rows =
    promotionIds.length === 0
      ? []
      : await tx
          .select({
            id: promotions.id,
            spentIdr: promotions.spentIdr,
            budgetIdr: promotions.budgetIdr,
          })
          .from(promotions)
          .where(
            and(
              eq(promotions.tenantId, tenantId),
              inArray(promotions.id, promotionIds),
            ),
          )
          .orderBy(asc(promotions.id))
          .for("update");
  // Budget room per promotion after this order's own lowerings (a cut on one
  // line of a promotion frees room for a raise on another line of it).
  const room = new Map<string, number>();
  for (const row of rows) {
    const freed = lines.reduce(
      (sum, line, index) =>
        line.promotionId === row.id
          ? sum + Math.max(0, -(deltas[index] ?? 0))
          : sum,
      0,
    );
    const spentAfterCuts = Math.max(0, row.spentIdr - freed);
    room.set(
      row.id,
      row.budgetIdr === null
        ? Number.MAX_SAFE_INTEGER
        : Math.max(0, row.budgetIdr - spentAfterCuts),
    );
  }
  let lowered = 0;
  let raised = 0;
  let budgetShortIdr = 0;
  // Cuts first, then raises, each in the locked line order.
  const indexes = [...lines.keys()];
  const order = [
    ...indexes.filter((index) => (deltas[index] ?? 0) < 0),
    ...indexes.filter((index) => (deltas[index] ?? 0) > 0),
  ];
  for (const index of order) {
    const line = lines[index];
    const delta = deltas[index] ?? 0;
    if (!line || delta === 0) continue;
    let change = delta;
    if (delta > 0 && line.promotionId !== null) {
      const available = room.get(line.promotionId) ?? 0;
      change = Math.min(delta, available);
      room.set(line.promotionId, available - change);
      budgetShortIdr += delta - change;
      if (change === 0) continue;
    }
    if (change < 0) lowered += -change;
    else raised += change;
    await tx
      .update(promotionRedemptions)
      .set({ discountIdr: idr(line.discountIdr + change) })
      .where(
        and(
          eq(promotionRedemptions.tenantId, tenantId),
          eq(promotionRedemptions.id, line.id),
          eq(promotionRedemptions.status, "applied"),
        ),
      );
    if (line.promotionId !== null)
      await tx
        .update(promotions)
        .set({
          spentIdr:
            change < 0
              ? sql`GREATEST(${promotions.spentIdr} - ${-change}, 0)`
              : sql`${promotions.spentIdr} + ${change}`,
          updatedAt: now,
        })
        .where(
          and(
            eq(promotions.tenantId, tenantId),
            eq(promotions.id, line.promotionId),
          ),
        );
  }
  return { lowered, raised, budgetShortIdr };
}

/**
 * `recomputeAfterPartialRefund` plus the clamp correction above. Inject this
 * (not the bare `promoPartialRefundPort`) into the refund module.
 */
export async function recomputeOrderPromoAfterPartialRefund(
  tx: Tx,
  context: ScopedTenantContext,
  refund: PartialRefundInput,
): Promise<PartialRefundResult> {
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  const orderId = orderIdSchema.parse(refund.orderId);
  await lockOrder(tx, tenantId, orderId);
  const [before] = await tx
    .select({
      status: promotionOrderApplications.status,
      outletId: promotionOrderApplications.outletId,
      totalDiscountIdr: promotionOrderApplications.totalDiscountIdr,
    })
    .from(promotionOrderApplications)
    .where(
      and(
        eq(promotionOrderApplications.tenantId, tenantId),
        eq(promotionOrderApplications.orderId, orderId),
      ),
    )
    .limit(1)
    .for("update");

  const result = await recomputeAfterPartialRefund(tx, context, refund);
  if (!result.adjusted || !before) return result;

  const { lowered, raised, budgetShortIdr } = await reconcileAppliedDiscount(
    tx,
    tenantId,
    orderId,
    result.keptLineDiscounts,
    refund.at,
  );
  if (lowered > 0 || raised > 0 || budgetShortIdr > 0)
    await recordAudit(
      tx,
      context,
      {
        id: createUlid(refund.at.getTime()),
        tenantId,
        outletId: before.outletId,
        actorType: refund.actorUserId === null ? "system" : "user",
        actorId: refund.actorUserId,
        deviceId: null,
        action: "promo_application.clamped",
        objectType: "promo_application",
        objectId: orderId,
        reason: refund.reason.trim(),
        maskedChanges: {
          before: { totalDiscountIdr: before.totalDiscountIdr },
          after: {
            totalDiscountIdr: result.totalDiscountIdr,
            clampedDiscountIdr: lowered,
            raisedDiscountIdr: raised,
            budgetShortIdr,
          },
        },
        ipHash: null,
        sensitiveAccess: false,
        retentionClass: "audit_2y",
        createdAt: refund.at.toISOString(),
      },
      CLAMP_AUDIT_FIELDS,
    );
  return result;
}

// Keep the existing import path while every caller moves to the port.
export { livePromoApplicationOf } from "./crm-promo-refund";

/** Partial-refund port for the refund module (WS-04/WS-05 wiring bead). */
export const orderPromoPartialRefundPort: PromoPartialRefundPort = {
  livePromoApplicationOf,
  recomputeAfterPartialRefund: recomputeOrderPromoAfterPartialRefund,
  recordPartialRefundPayout,
};

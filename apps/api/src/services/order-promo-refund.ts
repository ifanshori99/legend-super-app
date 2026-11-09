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
// This wrapper lowers each still-applied redemption line to the discount the
// recompute says it keeps (`keptLineDiscounts`), and the `spent_idr` of its
// promotion by the same cut (value vouchers have no promotion row: only their
// line is lowered). So the budget a promotion gets back is what that
// promotion actually lost, never a share of another promotion's loss. The
// invariant kept is sum(applied line discount_idr) ==
// application.total_discount_idr, so a later full void (`releasePromotions`)
// gives back exactly what is still counted and never drives `spent_idr` below
// zero.
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
 * Lowers each still-applied redemption line of one order to the discount it
 * keeps (never raises one), and its promotion's spent_idr by the same cut.
 * Returns the total lowered.
 */
async function lowerAppliedDiscount(
  tx: Tx,
  tenantId: TenantId,
  orderId: string,
  kept: Extract<PartialRefundResult, { adjusted: true }>["keptLineDiscounts"],
  now: Date,
): Promise<number> {
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
  // Never lower below zero (CHECK discount_idr >= 0) and never raise a line.
  const cuts = lines.map((line) => {
    const keep = keptById.get(line.id);
    return keep === undefined
      ? 0
      : Math.max(0, line.discountIdr - Math.max(0, keep));
  });
  const lowered = cuts.reduce((sum, cut) => sum + cut, 0);
  if (lowered <= 0) return 0;
  const promotionIds = [
    ...new Set(
      lines
        .filter((_, index) => (cuts[index] ?? 0) > 0)
        .map((line) => line.promotionId)
        .filter((id): id is string => id !== null),
    ),
  ].sort();
  if (promotionIds.length > 0)
    // Already held by the recompute; re-taken in id order, never out of order.
    await tx
      .select({ id: promotions.id })
      .from(promotions)
      .where(
        and(
          eq(promotions.tenantId, tenantId),
          inArray(promotions.id, promotionIds),
        ),
      )
      .orderBy(asc(promotions.id))
      .for("update");
  for (const [index, line] of lines.entries()) {
    const share = cuts[index] ?? 0;
    if (share <= 0) continue;
    await tx
      .update(promotionRedemptions)
      .set({ discountIdr: idr(line.discountIdr - share) })
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
          spentIdr: sql`GREATEST(${promotions.spentIdr} - ${share}, 0)`,
          updatedAt: now,
        })
        .where(
          and(
            eq(promotions.tenantId, tenantId),
            eq(promotions.id, line.promotionId),
          ),
        );
  }
  return lowered;
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

  const lowered = await lowerAppliedDiscount(
    tx,
    tenantId,
    orderId,
    result.keptLineDiscounts,
    refund.at,
  );
  if (lowered > 0)
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

/**
 * The order's promo application unless it is missing or `released` (a void
 * gives the promotion back, so a released row is no longer a live promo).
 */
export async function livePromoApplicationOf(
  tx: Tx,
  context: ScopedTenantContext,
  orderId: string,
): Promise<{ status: string } | null> {
  assertTrustedScopedContext(context);
  const [application] = await tx
    .select({ status: promotionOrderApplications.status })
    .from(promotionOrderApplications)
    .where(
      and(
        eq(promotionOrderApplications.tenantId, context.tenant.tenantId),
        eq(promotionOrderApplications.orderId, orderId),
      ),
    )
    .limit(1);
  return application && application.status !== "released" ? application : null;
}

/** Partial-refund port for the refund module (WS-04/WS-05 wiring bead). */
export const orderPromoPartialRefundPort: PromoPartialRefundPort = {
  recomputeAfterPartialRefund: recomputeOrderPromoAfterPartialRefund,
  recordPartialRefundPayout,
};

// Partial-refund port for order services (bead legend-souz; owner Q41; PRD
// v1.7 §3.10, §3.21). Wraps `recomputeAfterPartialRefund`
// (crm-promo-refund.ts) and closes the gap noted in the promo Q41 review:
//
//   The recompute caps the order's remaining discount at the kept bill value
//   ("clamp"), but only withdrawn promotions give their discount back to
//   `promotions.spent_idr`. When the clamp lowers the order discount, the
//   promotion budget and the ROI cost (sum of `promotion_redemptions.
//   discount_idr`) would still count the discount the guest no longer gets.
//
// This wrapper lowers, by exactly the clamped amount, the still-applied
// redemption lines of the order (pro rata to their discount, largest
// remainder) and the `spent_idr` of their promotions (value vouchers have no
// promotion row: only their line is lowered). The invariant kept is
// sum(applied line discount_idr) == application.total_discount_idr, so a later
// full void (`releasePromotions`) gives back exactly what is still counted and
// never drives `spent_idr` below zero.
//
// Lock order is the engine's (crm-promo-engine `redeemPromotions` doc): the
// caller holds the order row; then the per-order advisory lock and the
// application row are taken here BEFORE the recompute (both re-entrant in the
// same transaction), and the promotion rows lowered below are already held
// FOR UPDATE by the recompute.
//
// Idempotent: repeating the same refund withdraws nothing and the clamp is
// already applied, so the correction is Rp0.

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  allocateIdr,
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
 * How much of the order discount the clamp removed (>= 0): what was standing
 * before, minus what was withdrawn, minus what remains.
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
 * Lowers the still-applied redemption lines of one order (and their
 * promotions' spent_idr) by `amount` in total. Returns the amount lowered.
 */
async function lowerAppliedDiscount(
  tx: Tx,
  tenantId: TenantId,
  orderId: string,
  amount: number,
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
  const standing = lines.reduce((sum, line) => sum + line.discountIdr, 0);
  // Rows from before this wrapper may not keep the invariant: never lower
  // more than the lines still carry (CHECK discount_idr >= 0).
  const lowered = Math.min(amount, standing);
  if (lowered <= 0) return 0;
  const shares = allocateIdr(
    idr(lowered),
    lines.map((line) => line.discountIdr),
  );
  const promotionIds = [
    ...new Set(
      lines
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
    const share = Math.min(shares[index] ?? 0, line.discountIdr);
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

  const clamped = clampedDiscountOf(before.totalDiscountIdr, result);
  if (clamped === 0) return result;
  const lowered = await lowerAppliedDiscount(
    tx,
    tenantId,
    orderId,
    clamped,
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

/** Partial-refund port for the refund module (WS-04/WS-05 wiring bead). */
export const orderPromoPartialRefundPort: PromoPartialRefundPort = {
  recomputeAfterPartialRefund: recomputeOrderPromoAfterPartialRefund,
};

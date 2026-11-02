// Partial refund policy for promotions (PRD v1.7 §3.10 "Diskon, Void &
// Refund", §3.21 "Promo Engine"; owner decision Q41; bead legend-e5it).
//
// Q41: a partial refund that drops a bill below a promotion's condition
// (minimum spend, and likewise the items a "buy X" or bundle needs) withdraws
// that promotion, and the refund is reduced by the discount the bill no longer
// earns. A full void still goes through `releasePromotions`.
//
// The refund module (WS-04/WS-05; no refund service exists in this repo yet)
// calls `recomputeAfterPartialRefund` inside ITS refund transaction, with the
// lines the customer keeps priced exactly as at checkout, BEFORE paying out:
// the payout is `refundDueIdr`. Withdrawal gives back exactly what release
// gives back for that promotion: global use and budget, the customer's use,
// the voucher (back to issued) and the facility reward (revoked; WS-09
// revokes the entitlement from the `promo_application.adjusted` event).
//
// Decisions (PRD silent, safest reading, see report):
// - Only conditions that read the bill content are re-checked (min_spend,
//   item_quantity, bundle); channel, member, time window and validity were
//   true when the order was paid and do not change with a refund.
// - The promotion's CURRENT conditions are used (no rule snapshot is stored
//   at redeem time).
// - A promotion that still applies keeps its recorded discount; spreading it
//   over the refunded items is the refund module's job (pro-rata).
// - A same-day minimum-spend facility reward (Q40) is re-checked against the
//   customer's day total at that outlet with this bill reduced.
// - When the withdrawn discount is larger than the refunded bill value, the
//   payout is Rp0 and `uncoveredIdr` reports the difference (owner question).
//
// Lock order matches redeem/release (legend-9w77): per-order advisory lock,
// voucher row, customer-day advisory lock (Q40), promotion rows by id.

import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  evaluatePromotion,
  promotionApplicationResultSchema,
  type PromoEvaluationInput,
  type PromoLine,
  type PromoRejectionReason,
  type Promotion,
  type PromotionApplicationResult,
} from "@starter/shared/crm";
import {
  assertTrustedScopedContext,
  createUlid,
  idr,
  ulidIdSchema,
  ulidToUuid,
  type Idr,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  facilityRewards,
  promotionCustomerUsage,
  promotionOrderApplications,
  promotionRedemptions,
  promotions,
  vouchers,
} from "../db/schema";
import { maskAuditChanges } from "@starter/shared/audit";
import { HttpError } from "../lib/http-error";
import { recordAudit } from "./core-audit";
import {
  appendPromoEvent,
  PROMO_AUDIT_SAFE_FIELDS,
  requirePromoOutlet,
  toPromotion,
} from "./crm-promo-engine";
import {
  businessDayWindow,
  isSameDayMinSpendReward,
  lockCustomerDay,
  sameDaySpendIdr,
  withSameDaySpend,
} from "./crm-promo-minspend";
import { outletBusinessDayClock } from "./outlet-clock";
import type { Tx } from "./permission-resolver";

const orderIdSchema = ulidIdSchema<"OrderId">();

/** Rejections that mean "the reduced bill no longer earns this promotion". */
const WITHDRAW_REASONS: ReadonlySet<PromoRejectionReason> = new Set([
  "min_spend_not_met",
  "item_mismatch",
  "no_matching_items",
]);
const CONTENT_CONDITIONS = new Set(["min_spend", "item_quantity", "bundle"]);
/** Promo audit fields plus the refund amounts (all money, no PII). */
const REFUND_AUDIT_FIELDS: readonly string[] = [
  ...PROMO_AUDIT_SAFE_FIELDS,
  "refundedSubtotalIdr",
  "withdrawnDiscountIdr",
  "discountIdr",
];

export type PartialRefundInput = {
  readonly orderId: string;
  /**
   * Every line the customer keeps after this refund, server-priced the same
   * way as at checkout (never client prices). Empty = full refund: call
   * `releasePromotions` instead.
   */
  readonly keptLines: readonly PromoLine[];
  /** Refund reason (PRD §3.10 "alasan baku"). */
  readonly reason: string;
  readonly actorUserId: string | null;
  readonly at: Date;
};

export type WithdrawnPromotion = {
  readonly promotionId: string;
  readonly voucherId: string | null;
  readonly discountIdr: Idr;
  readonly reason: PromoRejectionReason;
};

export type PartialRefundResult =
  | {
      /** The order used no promotion (or the caller cannot reach it). */
      readonly adjusted: false;
    }
  | {
      readonly adjusted: true;
      /** Bill value (before promo) refunded by this call. */
      readonly refundedSubtotalIdr: Idr;
      /** Discount the reduced bill no longer earns. */
      readonly withdrawnDiscountIdr: Idr;
      /** Payout before tax/service recomputation: refunded - withdrawn, >= 0. */
      readonly refundDueIdr: Idr;
      /** Withdrawn discount the refunded value does not cover (>= 0). */
      readonly uncoveredIdr: Idr;
      /** The order's promo discount after this refund (tax engine input). */
      readonly totalDiscountIdr: Idr;
      readonly withdrawn: readonly WithdrawnPromotion[];
      readonly voucherIds: readonly string[];
      readonly facilityRewardIds: readonly string[];
    };

/**
 * Port the refund module depends on (wiring bead: the WS-04/WS-05 refund
 * service, not in this repo yet). Fail closed: a refund path that cannot run
 * it must refuse the partial refund rather than pay out the full amount.
 */
export type PromoPartialRefundPort = {
  recomputeAfterPartialRefund(
    tx: Tx,
    context: ScopedTenantContext,
    input: PartialRefundInput,
  ): Promise<PartialRefundResult>;
};

/** Same key as the engine's per-order lock (crm-promo-engine `lockOrder`). */
async function lockOrder(tx: Tx, tenantId: string, orderId: string) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`promo:${tenantId}:${orderId}`}, 0))`,
  );
}

function sumLines(lines: readonly PromoLine[]): number {
  let total = 0;
  for (const line of lines) {
    if (
      !Number.isSafeInteger(line.lineTotalIdr) ||
      line.lineTotalIdr < 0 ||
      !Number.isSafeInteger(line.quantity) ||
      line.quantity <= 0
    )
      throw new HttpError(422, "VALIDATION_ERROR", "Periksa baris pesanan.");
    total += line.lineTotalIdr;
  }
  if (!Number.isSafeInteger(total))
    throw new HttpError(422, "VALIDATION_ERROR", "Jumlah terlalu besar.");
  return total;
}

/**
 * Does the reduced bill still earn `promotion`? Only the bill-content
 * conditions are re-checked (see header); gates such as status, validity,
 * quota and budget are neutralized because the order already consumed them.
 */
function stillEarned(
  promotion: Promotion,
  bill: PromoEvaluationInput,
): PromoRejectionReason | null {
  const neutral: Promotion = {
    ...promotion,
    status: "active",
    startsAt: "1970-01-01T00:00:00.000Z",
    endsAt: null,
    voucherRequired: false,
    quotaTotal: null,
    quotaPerCustomer: null,
    budgetIdr: null,
    spentIdr: idr(0),
    conditions: promotion.conditions.filter((condition) =>
      CONTENT_CONDITIONS.has(condition.kind),
    ),
  };
  const evaluation = evaluatePromotion(neutral, bill);
  if (evaluation.applied) return null;
  return WITHDRAW_REASONS.has(evaluation.reason) ? evaluation.reason : null;
}

/**
 * Recomputes an order's promotions after a partial refund (owner Q41) inside
 * the caller's refund transaction. Idempotent: repeating the same refund
 * (same kept lines) refunds Rp0 more and withdraws nothing more.
 */
export async function recomputeAfterPartialRefund(
  tx: Tx,
  context: ScopedTenantContext,
  refund: PartialRefundInput,
): Promise<PartialRefundResult> {
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  const orderId = orderIdSchema.parse(refund.orderId);
  const reason = refund.reason.trim();
  if (reason.length === 0 || reason.length > 300)
    throw new HttpError(422, "VALIDATION_ERROR", "Alasan refund wajib diisi.");
  if (refund.keptLines.length === 0)
    throw new HttpError(
      422,
      "VALIDATION_ERROR",
      "Refund penuh memakai pembatalan promo, bukan refund sebagian.",
    );
  const keptSubtotal = sumLines(refund.keptLines);
  const now = refund.at;

  await lockOrder(tx, tenantId, orderId);
  const [application] = await tx
    .select()
    .from(promotionOrderApplications)
    .where(
      and(
        eq(promotionOrderApplications.tenantId, tenantId),
        eq(promotionOrderApplications.orderId, orderId),
      ),
    )
    .limit(1)
    .for("update");
  if (!application) return { adjusted: false };
  if (application.status === "released")
    throw new HttpError(
      409,
      "PROMO_APPLICATION_RELEASED",
      "Promo pesanan ini sudah dibatalkan.",
    );
  const standing = application.subtotalIdr - application.refundedSubtotalIdr;
  if (keptSubtotal > standing)
    throw new HttpError(
      422,
      "VALIDATION_ERROR",
      "Sisa tagihan tidak boleh melebihi tagihan sebelum refund.",
    );
  const refundedNow = standing - keptSubtotal;

  const lines = await tx
    .select()
    .from(promotionRedemptions)
    .where(
      and(
        eq(promotionRedemptions.tenantId, tenantId),
        eq(promotionRedemptions.orderId, orderId),
        eq(promotionRedemptions.status, "applied"),
      ),
    )
    .orderBy(asc(promotionRedemptions.promotionId));
  if (application.voucherId !== null)
    await tx
      .select({ id: vouchers.id })
      .from(vouchers)
      .where(
        and(
          eq(vouchers.tenantId, tenantId),
          eq(vouchers.id, application.voucherId),
        ),
      )
      .for("update");
  const promotionIds = [
    ...new Set(
      lines
        .map((line) => line.promotionId)
        .filter((id): id is string => id !== null),
    ),
  ].sort();

  // Rules first without a lock, to know whether the customer-day lock (Q40)
  // is needed before the promotion rows are locked.
  const rulesOf = async (lockRows: boolean) => {
    if (promotionIds.length === 0) return new Map<string, Promotion>();
    const query = tx
      .select()
      .from(promotions)
      .where(
        and(
          eq(promotions.tenantId, tenantId),
          inArray(promotions.id, promotionIds),
        ),
      )
      .orderBy(asc(promotions.id));
    const rows = lockRows ? await query.for("update") : await query;
    return new Map(rows.map((row) => [row.id, toPromotion(row)]));
  };
  const customerId = application.customerProfileId;
  let earlierSpend: number | null = null;
  if (customerId !== null) {
    const unlocked = await rulesOf(false);
    if ([...unlocked.values()].some(isSameDayMinSpendReward)) {
      const outlet = await requirePromoOutlet(
        tx,
        context,
        application.outletId,
      );
      const window = businessDayWindow(
        application.redeemedAt,
        outletBusinessDayClock(outlet),
      );
      await lockCustomerDay(
        tx,
        context,
        application.outletId,
        customerId,
        window.businessDate,
      );
      earlierSpend = await sameDaySpendIdr(tx, context, {
        outletId: application.outletId,
        customerProfileId: customerId,
        window,
        excludeOrderId: orderId,
      });
    }
  }
  const rules = await rulesOf(true);

  const bill: PromoEvaluationInput = {
    at: application.redeemedAt.toISOString(),
    channel: application.channel,
    localDayOfWeek: 0,
    localTime: "00:00",
    subtotalIdr: idr(keptSubtotal),
    lines: [...refund.keptLines],
    customer:
      customerId === null
        ? null
        : { customerProfileId: customerId, tierId: null, isMember: true },
    voucherPromotionId: null,
  };

  const withdrawn: WithdrawnPromotion[] = [];
  for (const line of lines) {
    if (line.promotionId === null) continue; // value voucher: no condition
    const rule = rules.get(line.promotionId);
    if (!rule) continue;
    const promotion =
      earlierSpend !== null && isSameDayMinSpendReward(rule)
        ? withSameDaySpend(rule, earlierSpend, false)
        : rule;
    const failure = stillEarned(promotion, bill);
    if (failure === null) continue;
    withdrawn.push({
      promotionId: line.promotionId,
      voucherId: line.voucherId,
      discountIdr: line.discountIdr,
      reason: failure,
    });

    await tx
      .update(promotions)
      .set({
        usesTotal: sql`${promotions.usesTotal} - 1`,
        spentIdr: sql`${promotions.spentIdr} - ${line.discountIdr}`,
        updatedAt: now,
      })
      .where(
        and(
          eq(promotions.tenantId, tenantId),
          eq(promotions.id, line.promotionId),
        ),
      );
    if (line.customerProfileId !== null)
      await tx
        .update(promotionCustomerUsage)
        .set({ uses: sql`${promotionCustomerUsage.uses} - 1`, updatedAt: now })
        .where(
          and(
            eq(promotionCustomerUsage.tenantId, tenantId),
            eq(promotionCustomerUsage.promotionId, line.promotionId),
            eq(
              promotionCustomerUsage.customerProfileId,
              line.customerProfileId,
            ),
            sql`${promotionCustomerUsage.uses} > 0`,
          ),
        );
    await tx
      .update(promotionRedemptions)
      .set({ status: "released", releasedAt: now })
      .where(
        and(
          eq(promotionRedemptions.tenantId, tenantId),
          eq(promotionRedemptions.id, line.id),
          eq(promotionRedemptions.status, "applied"),
        ),
      );
  }

  const withdrawnIds = withdrawn.map((entry) => entry.promotionId);
  const voucherIds: string[] = [];
  const withdrawnVoucher = withdrawn.find(
    (entry) =>
      entry.voucherId !== null && entry.voucherId === application.voucherId,
  );
  if (withdrawnVoucher?.voucherId) {
    const restored = await tx
      .update(vouchers)
      .set({ status: "issued", redeemedAt: null, redeemedOrderId: null })
      .where(
        and(
          eq(vouchers.tenantId, tenantId),
          eq(vouchers.id, withdrawnVoucher.voucherId),
          eq(vouchers.status, "redeemed"),
          eq(vouchers.redeemedOrderId, orderId),
        ),
      )
      .returning({ id: vouchers.id });
    voucherIds.push(...restored.map((row) => row.id));
  }
  const revoked =
    withdrawnIds.length === 0
      ? []
      : await tx
          .update(facilityRewards)
          .set({ revokedAt: now })
          .where(
            and(
              eq(facilityRewards.tenantId, tenantId),
              eq(facilityRewards.sourceOrderId, orderId),
              inArray(facilityRewards.promotionId, withdrawnIds),
              isNull(facilityRewards.revokedAt),
            ),
          )
          .returning({ id: facilityRewards.id });

  const withdrawnDiscount = withdrawn.reduce(
    (sum, entry) => sum + entry.discountIdr,
    0,
  );
  const totalDiscount = application.totalDiscountIdr - withdrawnDiscount;
  const previous = promotionApplicationResultSchema.parse(application.result);
  const withdrawnReason = new Map(
    withdrawn.map((entry) => [entry.promotionId, entry.reason]),
  );
  const result: PromotionApplicationResult =
    promotionApplicationResultSchema.parse({
      evaluations: previous.evaluations.map((evaluation) => {
        const failure = withdrawnReason.get(evaluation.promotionId);
        return evaluation.applied && failure !== undefined
          ? {
              applied: false,
              promotionId: evaluation.promotionId,
              reason: failure,
            }
          : evaluation;
      }),
      totalDiscountIdr: totalDiscount,
    });
  const refundedTotal = application.subtotalIdr - keptSubtotal;
  await tx
    .update(promotionOrderApplications)
    .set({
      refundedSubtotalIdr: idr(refundedTotal),
      totalDiscountIdr: idr(totalDiscount),
      result,
    })
    .where(
      and(
        eq(promotionOrderApplications.tenantId, tenantId),
        eq(promotionOrderApplications.orderId, orderId),
      ),
    );

  if (withdrawn.length > 0) {
    const payload = {
      orderId,
      outletId: application.outletId,
      reason,
      refundedSubtotalIdr: idr(refundedNow),
      withdrawnDiscountIdr: idr(withdrawnDiscount),
      totalDiscountIdr: idr(totalDiscount),
      withdrawn: withdrawn.map((entry) => ({
        promotionId: entry.promotionId,
        voucherId: entry.voucherId,
        discountIdr: entry.discountIdr,
      })),
      voucherIds,
      facilityRewardIds: revoked.map((row) => row.id),
    };
    await appendPromoEvent(tx, context, "promo_application.adjusted", {
      aggregateId: orderId,
      aggregateUuid: ulidToUuid(orderId),
      outletId: application.outletId,
      actorUserId: refund.actorUserId,
      idempotencyKey: `promo_application.adjusted:${orderId}:${refundedTotal}`,
      now,
      payload,
    });
    await recordAudit(
      tx,
      context,
      {
        id: createUlid(now.getTime()),
        tenantId,
        outletId: application.outletId,
        actorType: refund.actorUserId === null ? "system" : "user",
        actorId: refund.actorUserId,
        deviceId: null,
        action: "promo_application.adjusted",
        objectType: "promo_application",
        objectId: application.orderId,
        reason,
        maskedChanges: {
          before: maskAuditChanges(
            {
              status: "applied",
              totalDiscountIdr: application.totalDiscountIdr,
            },
            REFUND_AUDIT_FIELDS,
          ),
          after: maskAuditChanges(
            { status: "applied", ...payload },
            REFUND_AUDIT_FIELDS,
          ),
        },
        ipHash: null,
        sensitiveAccess: false,
        retentionClass: "audit_2y",
        createdAt: now.toISOString(),
      },
      REFUND_AUDIT_FIELDS,
    );
  }

  return {
    adjusted: true,
    refundedSubtotalIdr: idr(refundedNow),
    withdrawnDiscountIdr: idr(withdrawnDiscount),
    refundDueIdr: idr(Math.max(0, refundedNow - withdrawnDiscount)),
    uncoveredIdr: idr(Math.max(0, withdrawnDiscount - refundedNow)),
    totalDiscountIdr: idr(totalDiscount),
    withdrawn,
    voucherIds,
    facilityRewardIds: revoked.map((row) => row.id),
  };
}

/** Default port: the real recompute (the refund module injects it). */
export const promoPartialRefundPort: PromoPartialRefundPort = {
  recomputeAfterPartialRefund,
};

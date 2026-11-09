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
// - The rules stored on the application row at redeem time are used (owner
//   Q41 snapshot decision), so editing a promotion after the sale never
//   changes what an already-paid bill earned. Rows from before migration 0042
//   have no snapshot and fall back to the current rule.
// - A promotion that still applies keeps its discount on the kept items only:
//   the discount still standing is split pro rata (by price) between the kept
//   and the refunded goods (founder rule, 9 Nov 2026), so refunding an item
//   gives back its price minus its share of the discount. The kept discount
//   is capped at the kept bill value, so the remaining bill can never go
//   negative.
// - Q19 (founder 9 Nov 2026): the kept discount is also capped by what the
//   still-applied promotions give when re-evaluated on the kept lines. So a
//   returned free item (buy 2 coffee, get 1 croissant free, croissant sent
//   back) pays Rp0 instead of a pro-rata share. Value vouchers and rules that
//   no longer exist have nothing to re-evaluate and keep their full discount
//   in that cap. The cap only ever lowers the kept discount.
// - A same-day minimum-spend facility reward (Q40) is re-checked against the
//   customer's day total at that outlet with this bill reduced.
// - The payout is cumulative: what the guest still has paid in
//   (`paid_idr - refunded_paid_idr`) minus what the kept goods cost after the
//   kept discount. `refundDueIdr` is never negative and never exceeds that
//   remaining paid amount, so a repeated refund pays Rp0 more.
// - When the kept goods cost more than the guest still has paid in, the payout
//   is Rp0 and `uncoveredIdr` reports the difference (owner question).
// - An empty `keptLines` (the guest returns everything left) withdraws every
//   applied promotion (reason `no_matching_items`).
//
// Lock order matches redeem/release (legend-9w77 + legend-e5it): per-order
// advisory lock, the application row, the voucher row, the customer-day
// advisory lock (Q40), promotion rows by id, then the customer usage rows.

import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  evaluatePromotion,
  promotionApplicationResultSchema,
  promotionRuleSnapshotSchema,
  type PromoEvaluationInput,
  type PromoLine,
  type PromoRejectionReason,
  type Promotion,
  type PromotionApplicationResult,
} from "@starter/shared/crm";
import {
  allocateIdr,
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
   * way as at checkout (never client prices). Empty = the guest returns
   * everything still standing: every applied promotion is withdrawn. (A void
   * of the whole order still goes through `releasePromotions`.)
   */
  readonly keptLines: readonly PromoLine[];
  /** Refund reason (PRD §3.10 "alasan baku"). */
  readonly reason: string;
  readonly actorUserId: string | null;
  readonly at: Date;
  /**
   * True when the caller records the payout itself later, through
   * `PromoPartialRefundPort.recordPartialRefundPayout` (it may pay less than
   * `refundDueIdr`). Default false: the due is recorded here.
   */
  readonly deferPayout?: boolean;
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
      /**
       * Goods payout before tax/service recomputation: what the guest still
       * has paid in minus the kept goods at their payable price, floored at 0
       * (cumulative across refunds).
       */
      readonly refundDueIdr: Idr;
      /** Kept goods cost the guest has not paid in yet (>= 0). */
      readonly uncoveredIdr: Idr;
      /** The order's promo discount after this refund (tax engine input). */
      readonly totalDiscountIdr: Idr;
      /** Kept goods after the kept discount (what the guest keeps paying for). */
      readonly keptPayableIdr: Idr;
      /** Goods amount still paid in and not refunded, before this refund. */
      readonly remainingPaidIdr: Idr;
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
  /**
   * Records a payout the caller decided on (after `deferPayout: true`) into
   * `refunded_paid_idr`: per-order advisory lock and the application row
   * FOR UPDATE. No application: `{ recordedIdr: 0 }`; released: 409
   * `PROMO_APPLICATION_RELEASED`. Records `min(payoutIdr, remainingPaid)` and
   * returns it.
   */
  recordPartialRefundPayout(
    tx: Tx,
    context: ScopedTenantContext,
    input: { orderId: string; payoutIdr: number; at: Date },
  ): Promise<{ recordedIdr: number }>;
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
 * `recomputedIdr` is what the promotion gives on the reduced bill (Q19);
 * null when the re-check is rejected for a reason that is not a withdrawal
 * (a gate this re-check cannot reproduce): the line then keeps its discount.
 */
function stillEarned(
  promotion: Promotion,
  bill: PromoEvaluationInput,
): { failure: PromoRejectionReason | null; recomputedIdr: number | null } {
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
  if (evaluation.applied)
    return { failure: null, recomputedIdr: evaluation.discountIdr };
  return {
    failure: WITHDRAW_REASONS.has(evaluation.reason) ? evaluation.reason : null,
    recomputedIdr: null,
  };
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
  const returnsAll = refund.keptLines.length === 0;
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

  // Owner Q41 snapshot: recheck against the rules the order redeemed, not the
  // promotion as it is today. Rows from before the snapshot column fall back to
  // the current rule (best effort, documented).
  const parsedSnapshot = application.rulesSnapshot
    ? promotionRuleSnapshotSchema.safeParse(application.rulesSnapshot)
    : null;
  const snapshot = parsedSnapshot?.success ? parsedSnapshot.data : null;
  const withSnapshot = (promotion: Promotion): Promotion => {
    const stored = snapshot?.[promotion.id];
    return stored
      ? {
          ...promotion,
          conditions: stored.conditions,
          benefit: stored.benefit,
        }
      : promotion;
  };

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
    // A refund always changes the customer's same-day total, so it takes the
    // Q40 lock even when this bill itself carries no facility reward: a
    // concurrent checkout of the same customer must not read a stale total.
    const outlet = await requirePromoOutlet(tx, context, application.outletId);
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
    const unlocked = await rulesOf(false);
    const earnsReward = lines.some((line) => {
      if (line.promotionId === null) return false;
      const rule = unlocked.get(line.promotionId);
      return rule !== undefined && isSameDayMinSpendReward(withSnapshot(rule));
    });
    if (earnsReward)
      earlierSpend = await sameDaySpendIdr(tx, context, {
        outletId: application.outletId,
        customerProfileId: customerId,
        window,
        excludeOrderId: orderId,
      });
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
  // Q19: what the kept promotions give on the kept lines (cap on the kept
  // discount).
  let keptCap = 0;
  for (const line of lines) {
    if (line.promotionId === null) {
      keptCap += line.discountIdr; // value voucher: no condition
      continue;
    }
    let failure: PromoRejectionReason | null = "no_matching_items";
    let recomputedIdr: number | null = null;
    if (!returnsAll) {
      const current = rules.get(line.promotionId);
      if (!current) {
        keptCap += line.discountIdr;
        continue;
      }
      const rule = withSnapshot(current);
      const promotion =
        earlierSpend !== null && isSameDayMinSpendReward(rule)
          ? withSameDaySpend(rule, earlierSpend, false)
          : rule;
      ({ failure, recomputedIdr } = stillEarned(promotion, bill));
    }
    if (failure === null) {
      keptCap +=
        recomputedIdr === null
          ? line.discountIdr
          : Math.min(line.discountIdr, recomputedIdr);
      continue;
    }
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
  // Founder rule (9 Nov 2026): the discount still standing after the
  // withdrawals is split pro rata by price between the kept and the refunded
  // goods; the kept part stays (capped at the kept bill value, so the payable
  // is never negative, and at what the kept promotions still give on the kept
  // lines, Q19). The payout is cumulative: what the guest still has
  // paid in minus the kept goods at their payable price.
  const discountAfter = Math.max(
    0,
    application.totalDiscountIdr - withdrawnDiscount,
  );
  let keptDiscount = 0;
  if (keptSubtotal > 0 && discountAfter > 0) {
    // keptSubtotal > 0 and standing >= keptSubtotal, so the weights sum > 0.
    const [keptShare = 0] = allocateIdr(idr(discountAfter), [
      keptSubtotal,
      standing - keptSubtotal,
    ]);
    keptDiscount = Math.min(keptSubtotal, keptShare, keptCap);
  }
  const totalDiscount = keptDiscount;
  const keptPayableIdr = keptSubtotal - keptDiscount;
  const paidIdr =
    application.paidIdr ??
    idr(Math.max(0, application.subtotalIdr - application.totalDiscountIdr));
  const remainingPaidIdr = Math.max(0, paidIdr - application.refundedPaidIdr);
  const refundDueIdr = Math.max(
    0,
    Math.min(remainingPaidIdr, remainingPaidIdr - keptPayableIdr),
  );
  const uncoveredIdr = Math.max(0, keptPayableIdr - remainingPaidIdr);
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
      refundedPaidIdr: idr(
        application.refundedPaidIdr + (refund.deferPayout ? 0 : refundDueIdr),
      ),
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
    refundDueIdr: idr(refundDueIdr),
    uncoveredIdr: idr(uncoveredIdr),
    totalDiscountIdr: idr(totalDiscount),
    keptPayableIdr: idr(keptPayableIdr),
    remainingPaidIdr: idr(remainingPaidIdr),
    withdrawn,
    voucherIds,
    facilityRewardIds: revoked.map((row) => row.id),
  };
}

/**
 * Records a payout decided by the caller (see `deferPayout`). Same lock order
 * as the recompute: per-order advisory lock, then the application row.
 */
export async function recordPartialRefundPayout(
  tx: Tx,
  context: ScopedTenantContext,
  input: { orderId: string; payoutIdr: number; at: Date },
): Promise<{ recordedIdr: number }> {
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  const orderId = orderIdSchema.parse(input.orderId);
  if (!Number.isSafeInteger(input.payoutIdr) || input.payoutIdr < 0)
    throw new HttpError(422, "VALIDATION_ERROR", "Jumlah refund tidak valid.");
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
  if (!application) return { recordedIdr: 0 };
  if (application.status === "released")
    throw new HttpError(
      409,
      "PROMO_APPLICATION_RELEASED",
      "Promo pesanan ini sudah dibatalkan.",
    );
  const paidIdr =
    application.paidIdr ??
    Math.max(0, application.subtotalIdr - application.totalDiscountIdr);
  const remainingPaid = Math.max(0, paidIdr - application.refundedPaidIdr);
  const recordedIdr = Math.min(input.payoutIdr, remainingPaid);
  if (recordedIdr > 0)
    await tx
      .update(promotionOrderApplications)
      .set({
        refundedPaidIdr: idr(application.refundedPaidIdr + recordedIdr),
      })
      .where(
        and(
          eq(promotionOrderApplications.tenantId, tenantId),
          eq(promotionOrderApplications.orderId, orderId),
        ),
      );
  return { recordedIdr };
}

/** Default port: the real recompute (the refund module injects it). */
export const promoPartialRefundPort: PromoPartialRefundPort = {
  recomputeAfterPartialRefund,
  recordPartialRefundPayout,
};

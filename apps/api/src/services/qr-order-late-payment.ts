// Late QRIS payment on a voided QR pay-first order (beads legend-b0au,
// legend-dahl; PRD v1.7 §3.13 "Siklus Pembayaran", PAY-04).
//
// A guest can still pay a code after the unpaid order was voided (the code
// expired or failed and the grace passed; WS-05 accepts a verified settlement
// after `expired` and after `failed` and books it on the order's bill). The
// money is real and verified, but the voided order never revives (stock and
// promotion were released), so the full amount the intent still holds goes
// back through a WS-05 refund REQUEST by the system actor `system:qr`, the same
// way `pos-order-late-payment.ts` returns a late POS QRIS. This file only
// files the request: the APPROVAL stays with WS-05 (`approveRefund`, another
// person with `payment.reconcile`); nothing here pays out money.
// - Idempotent: the WS-05 admin key `qr-late-payment-refund:<intentId>` makes
//   an event replay return the first answer, and the intent row lock plus
//   `refundableBalance` (what is not already reserved) stop a second row.
// - The amount is re-read from the locked intent, never from the event.
//
// A second code of the same order paid after the order was already paid
// (legend-3160: a guest switched bank or method and paid both) lands on the
// bill as `double_payment` unallocated funds. `requestQrDoublePaymentRefund`
// files one system refund request per such fund row, the same request the
// payment admin opens by hand (payment-admin-funds.service.ts), so the money
// is returned instead of waiting in the unallocated list.

import {
  createUlid,
  idr,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type { PaymentStatus } from "@starter/shared/payment";
import type { SystemRefundActor } from "@starter/shared/payment/admin";
import { and, asc, eq, inArray, isNull, ne } from "drizzle-orm";
import {
  paymentIntents,
  paymentLinks,
  paymentRefunds,
  paymentUnallocatedFunds,
} from "../db/schema/index.ts";
import { recordAudit } from "./core-audit.ts";
import type { Tx } from "./menu-internals.ts";
import { idempotentPaymentAdminWrite } from "./payment-admin-idempotency.ts";
import { refundableBalance } from "./payment-admin.service.ts";
import { openRefundChainSafely } from "./payment-refund.service.ts";
import { appendPaymentEvent } from "./payment-support.ts";
import { pendingRefundIdr } from "./pos-order-late-payment.ts";

/**
 * Requester of the QR late-payment refund (legend-dahl); listed in the shared
 * `systemRefundActorSchema` so the refund screen names it.
 */
export const QR_SYSTEM_ACTOR: SystemRefundActor = "system:qr";

export const qrLatePaymentRefundKey = (intentId: string) =>
  `qr-late-payment-refund:${intentId}`;

const AUDIT_FIELDS = ["amountIdr", "status", "refundId"] as const;

/**
 * Files a full refund request for what `intentId` still holds. Returns the
 * refund id, or null when nothing is refundable (not settled, or already fully
 * reserved by an earlier refund). Run inside the consumption transaction with
 * the voided order row already locked.
 */
export async function requestQrLatePaymentRefund(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    order: { id: string; outletId: string };
    paymentLinkId: string;
    intentId: string;
    now: Date;
    /**
     * legend-p61pe: a refund filed after another refund of the intent failed
     * uses its own once-only key (`<key>:<failedRefundId>`).
     */
    keySuffix?: string;
  },
): Promise<string | null> {
  const tenantId = context.tenant.tenantId;
  const [intent] = await tx
    .select()
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, tenantId),
        eq(paymentIntents.id, input.intentId),
        eq(paymentIntents.paymentLinkId, input.paymentLinkId),
      ),
    )
    .for("update");
  if (
    !intent ||
    !intent.paidAt ||
    !["paid", "partially_refunded"].includes(intent.status)
  )
    return null;
  const response = await idempotentPaymentAdminWrite(
    tx,
    context,
    QR_SYSTEM_ACTOR,
    input.keySuffix === undefined
      ? qrLatePaymentRefundKey(intent.id)
      : `${qrLatePaymentRefundKey(intent.id)}:${input.keySuffix}`,
    "refund.create",
    { paymentIntentId: intent.id, reason: "qr_late_payment" },
    async () => {
      const { cap, reserved } = await refundableBalance(tx, intent);
      // legend-leqj6: a refund still `pending` is not subtracted; the key
      // above is used once, so a pending refund rejected or failed later would
      // never be returned to the guest. Its approval fails `cap_exceeded`.
      const pending = await pendingRefundIdr(tx, tenantId, intent.id);
      // A re-file (keySuffix) subtracts pending too: it only files the real
      // remainder, so live refunds never exceed what was paid (legend-weuo2).
      const amount =
        input.keySuffix === undefined
          ? cap - (reserved - pending)
          : cap - reserved;
      if (amount <= 0n) return { refundId: null };
      const [inserted] = await tx
        .insert(paymentRefunds)
        .values({
          tenantId: intent.tenantId,
          outletId: intent.outletId,
          paymentIntentId: intent.id,
          amountIdr: idr(Number(amount)),
          reason:
            "Refund pembayaran online terlambat (pesanan QR batal atau meja sudah ditutup)",
          note: null,
          requestedBy: QR_SYSTEM_ACTOR,
        })
        .returning();
      if (!inserted) throw new Error("Refund insert returned no row");
      const row = await openRefundChainSafely(tx, context, inserted, input.now);
      await recordAudit(
        tx,
        context,
        {
          id: createUlid(input.now.getTime()),
          tenantId,
          outletId: row.outletId,
          actorType: "system",
          actorId: null,
          deviceId: null,
          action: "payment.refund_requested",
          objectType: "payment_refund",
          objectId: row.id,
          reason: row.reason,
          maskedChanges: {
            before: null,
            after: { amountIdr: row.amountIdr, status: row.status },
          },
          ipHash: null,
          sensitiveAccess: false,
          retentionClass: "audit_2y",
          createdAt: input.now.toISOString(),
        },
        AUDIT_FIELDS,
      );
      await appendPaymentEvent(tx, context, {
        name: "payment.refund_requested",
        aggregateId: row.id,
        outletId: row.outletId,
        actor: { type: "system" },
        payload: {
          refundId: row.id,
          paymentIntentId: row.paymentIntentId,
          amountIdr: row.amountIdr,
        },
        now: input.now,
      });
      // The voided order's own trail names the refund that returns its money.
      await recordAudit(
        tx,
        context,
        {
          id: createUlid(input.now.getTime()),
          tenantId,
          outletId: input.order.outletId,
          actorType: "system",
          actorId: null,
          deviceId: null,
          action: "qr_order.late_payment_refund_requested",
          objectType: "order",
          objectId: input.order.id,
          reason:
            "Online payment arrived after the QR order was voided or its session closed",
          maskedChanges: {
            before: null,
            after: {
              refundId: row.id,
              amountIdr: row.amountIdr,
              status: row.status,
            },
          },
          ipHash: null,
          sensitiveAccess: false,
          retentionClass: "audit_2y",
          createdAt: input.now.toISOString(),
        },
        AUDIT_FIELDS,
      );
      return { refundId: row.id };
    },
  );
  return response.refundId;
}

/**
 * legend-g510l: intent statuses that still hold money to return. A refund that
 * completed before the paid event was consumed moves the intent on to
 * `partially_refunded`; its rest goes back like a full `paid` payment
 * (`refunded` holds nothing).
 */
export const HOLDS_REFUNDABLE_MONEY: readonly PaymentStatus[] = [
  "paid",
  "partially_refunded",
];

/**
 * legend-gjf1: a voided order whose link already settled holds money of a
 * voided order (a split part, a partial code, a code paid after the void).
 * One refund request per paid intent of the link, in id order. Each is replay
 * safe (once-only key per intent in `requestQrLatePaymentRefund`), so the
 * sweep, the staff void, and the callers that file the event's own refund
 * afterwards all find the same request and a second void refunds nothing more.
 * Shared by every QR void path (`voidUnpaidQrOrderTx`).
 */
export async function requestRefundsForVoidedQrOrder(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    order: { id: string; outletId: string; paymentLinkId: string | null };
    now: Date;
  },
): Promise<void> {
  const paymentLinkId = input.order.paymentLinkId;
  if (paymentLinkId === null) return;
  const [link] = await tx
    .select({ paidIdr: paymentLinks.paidIdr })
    .from(paymentLinks)
    .where(
      and(
        eq(paymentLinks.tenantId, context.tenant.tenantId),
        eq(paymentLinks.id, paymentLinkId),
      ),
    );
  if (!link || link.paidIdr <= 0) return;
  const paid = await tx
    .select({ id: paymentIntents.id })
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, context.tenant.tenantId),
        eq(paymentIntents.paymentLinkId, paymentLinkId),
        inArray(paymentIntents.status, [...HOLDS_REFUNDABLE_MONEY]),
      ),
    )
    .orderBy(asc(paymentIntents.id));
  for (const row of paid)
    await requestQrLatePaymentRefund(tx, context, {
      order: input.order,
      paymentLinkId,
      intentId: row.id,
      now: input.now,
    });
}

/**
 * Files a refund request for every unresolved `double_payment` fund row of
 * `intentId` that has no live refund yet. Returns the new refund ids (empty on
 * a replay). Run inside the consumption transaction with the order locked.
 */
export async function requestQrDoublePaymentRefund(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    /** Not read here; a caller that has no order (a parked-fund re-file) omits it. */
    order?: { id: string; outletId: string };
    paymentLinkId: string;
    intentId: string;
    now: Date;
    /** Requester and reason text for a non-QR caller (facility breakfast). */
    source?: { requestedBy: SystemRefundActor; reason: string };
    /**
     * Refund only this fund of the intent, whatever its reason (a
     * `payment.funds_unallocated` event names its fund). Without it: every
     * unresolved `double_payment` fund of the intent.
     */
    fundId?: string;
  },
): Promise<string[]> {
  const tenantId = context.tenant.tenantId;
  // Lock order: payment intent -> fund -> refund (same as the admin resolve).
  const [intent] = await tx
    .select({ id: paymentIntents.id })
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, tenantId),
        eq(paymentIntents.id, input.intentId),
        eq(paymentIntents.paymentLinkId, input.paymentLinkId),
      ),
    )
    .for("update");
  if (!intent) return [];
  const funds = await tx
    .select()
    .from(paymentUnallocatedFunds)
    .where(
      and(
        eq(paymentUnallocatedFunds.tenantId, tenantId),
        eq(paymentUnallocatedFunds.paymentIntentId, intent.id),
        input.fundId === undefined
          ? eq(paymentUnallocatedFunds.reason, "double_payment")
          : eq(paymentUnallocatedFunds.id, input.fundId),
        isNull(paymentUnallocatedFunds.resolution),
      ),
    )
    .for("update");
  const refundIds: string[] = [];
  for (const fund of funds) {
    const [live] = await tx
      .select({ id: paymentRefunds.id })
      .from(paymentRefunds)
      .where(
        and(
          eq(paymentRefunds.tenantId, tenantId),
          eq(paymentRefunds.unallocatedFundId, fund.id),
          ne(paymentRefunds.status, "failed"),
        ),
      );
    if (live) continue;
    // legend-9pz0m: a fund whose budget of failed system refunds is spent is
    // left to a person (alarm and audit row), also on a re-delivered event.
    // Lazy import: system-refund-followup imports this module (cycle).
    const { parkedFundRefileBudgetSpent } =
      await import("./system-refund-followup.ts");
    if (await parkedFundRefileBudgetSpent(tx, tenantId, fund.id)) continue;
    const [inserted] = await tx
      .insert(paymentRefunds)
      .values({
        tenantId,
        outletId: fund.outletId,
        paymentIntentId: fund.paymentIntentId,
        unallocatedFundId: fund.id,
        amountIdr: fund.amountIdr,
        reason:
          input.source?.reason ??
          "Refund pembayaran ganda (pesanan QR sudah dibayar dengan kode lain)",
        note: null,
        requestedBy: input.source?.requestedBy ?? QR_SYSTEM_ACTOR,
        status: "pending",
      })
      .returning();
    if (!inserted) throw new Error("Refund insert returned no row");
    const row = await openRefundChainSafely(tx, context, inserted, input.now);
    await recordAudit(
      tx,
      context,
      {
        id: createUlid(input.now.getTime()),
        tenantId,
        outletId: row.outletId,
        actorType: "system",
        actorId: null,
        deviceId: null,
        action: "payment.unallocated_refund_requested",
        objectType: "payment_refund",
        objectId: row.id,
        reason: row.reason,
        maskedChanges: {
          before: null,
          after: { amountIdr: row.amountIdr, status: row.status },
        },
        ipHash: null,
        sensitiveAccess: false,
        retentionClass: "audit_2y",
        createdAt: input.now.toISOString(),
      },
      AUDIT_FIELDS,
    );
    await appendPaymentEvent(tx, context, {
      name: "payment.refund_requested",
      aggregateId: row.id,
      outletId: row.outletId,
      actor: { type: "system" },
      payload: {
        refundId: row.id,
        paymentIntentId: row.paymentIntentId,
        amountIdr: row.amountIdr,
        unallocatedFundId: fund.id,
      },
      now: input.now,
    });
    refundIds.push(row.id);
  }
  return refundIds;
}

// Late QRIS payment of a POS bill that no longer takes it (bead legend-b0au;
// PRD v1.7 §3.13 "Siklus Pembayaran", PAY-04).
//
// A guest can still scan a code after the tender was voided (cash took over,
// the order was voided or completed) or after the intent expired at the
// gateway. The money is real and verified, but the POS bill cannot book it, so
// the full amount the intent still holds goes back through a WS-05 refund
// REQUEST by the system actor, the same way `reservation-refunds.ts` returns a
// late DP. This file only files the request: the APPROVAL stays with WS-05
// (`approveRefund`, another person with `payment.reconcile`); nothing here
// pays out money.
// - Idempotent: the WS-05 admin key `pos-late-payment-refund:<intentId>` makes
//   an event replay return the first answer, and the intent row lock plus
//   `refundableBalance` (what is not already reserved) stop a second row.
// - The amount is re-read from the locked intent, never from the event.

import {
  createUlid,
  idr,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type { SystemRefundActor } from "@starter/shared/payment/admin";
import { and, eq } from "drizzle-orm";
import { paymentIntents, paymentRefunds } from "../db/schema/index.ts";
import { recordAudit } from "./core-audit.ts";
import { idempotentPaymentAdminWrite } from "./payment-admin-idempotency.ts";
import { refundableBalance } from "./payment-admin.service.ts";
import { openRefundChainSafely } from "./payment-refund.service.ts";
import { appendPaymentEvent } from "./payment-support.ts";
import type { Tx } from "./permission-resolver.ts";
import { auditPos } from "./pos-order-support.ts";

/**
 * Requester of the POS late-payment refund (legend-b0au); listed in the shared
 * `systemRefundActorSchema` so the refund screen names it.
 */
export const POS_SYSTEM_ACTOR: SystemRefundActor = "system:pos";

export const posLatePaymentRefundKey = (intentId: string) =>
  `pos-late-payment-refund:${intentId}`;

/**
 * Files a full refund request for what `intentId` still holds. Returns the
 * refund id, or null when nothing is refundable (not settled, or already fully
 * reserved by an earlier refund). Run inside the consumption transaction with
 * the order row already locked.
 */
export async function requestPosLatePaymentRefund(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    order: Parameters<typeof auditPos>[2]["order"];
    paymentLinkId: string;
    intentId: string;
    now: Date;
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
    POS_SYSTEM_ACTOR,
    posLatePaymentRefundKey(intent.id),
    "refund.create",
    { paymentIntentId: intent.id, reason: "pos_late_payment" },
    async () => {
      const { cap, reserved } = await refundableBalance(tx, intent);
      const amount = cap - reserved;
      if (amount <= 0n) return { refundId: null };
      const [inserted] = await tx
        .insert(paymentRefunds)
        .values({
          tenantId: intent.tenantId,
          outletId: intent.outletId,
          paymentIntentId: intent.id,
          amountIdr: idr(Number(amount)),
          reason:
            "Refund pembayaran QRIS terlambat (tagihan POS sudah ditutup)",
          note: null,
          requestedBy: POS_SYSTEM_ACTOR,
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
        ["amountIdr", "status"],
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
      await auditPos(
        tx,
        context,
        {
          action: "pos_order.late_payment_refund_requested",
          order: input.order,
          caller: null,
          before: null,
          after: {
            id: input.order.id,
            amountIdr: row.amountIdr,
            status: row.status,
          },
          reason: "QRIS paid after the POS tender closed",
          objectType: "payment_refund",
          objectId: row.id,
        },
        input.now,
      );
      return { refundId: row.id };
    },
  );
  return response.refundId;
}

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
// - Refunds still pending are not subtracted (legend-leqj6): see the amount.
// - The amount is re-read from the locked intent, never from the event.

import {
  createUlid,
  idr,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type { SystemRefundActor } from "@starter/shared/payment/admin";
import { and, eq, sql } from "drizzle-orm";
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
 * legend-leqj6 (first written for legend-r5brx): refunds of the intent still
 * `pending`, with the filter of `refundableBalance().reserved` (no unallocated
 * fund). Read under the intent row lock, so `reserved - pending` is what
 * approved and completed refunds already committed. Shared by the POS paid
 * consumer and the QR late-payment refund.
 */
export async function pendingRefundIdr(
  tx: Tx,
  tenantId: ScopedTenantContext["tenant"]["tenantId"],
  intentId: string,
): Promise<bigint> {
  const result = await tx.execute(sql`
    SELECT coalesce(sum(amount_idr), 0)::text AS pending
      FROM payment_refunds
     WHERE tenant_id = ${tenantId}
       AND payment_intent_id = ${intentId}::uuid
       AND status = 'pending'
       AND unallocated_fund_id IS NULL
  `);
  return BigInt(String(result.rows[0]?.pending ?? "0"));
}

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
      // legend-leqj6: a refund still `pending` is not subtracted. This
      // request is filed once per intent (the key above), so if that refund
      // were rejected or failed later its amount would never be returned to
      // the guest. Its approval fails `cap_exceeded` instead (reserved then
      // exceeds the cap), see `payment-refund.service.ts`.
      const pending = await pendingRefundIdr(tx, tenantId, intent.id);
      const amount = cap - (reserved - pending);
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

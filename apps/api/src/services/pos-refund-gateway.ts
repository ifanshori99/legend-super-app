// Gateway part of a POS refund (bead legend-ghgei, P3).
//
// A POS refund (`refundPosOrder`) names the gateway tender and payment intent
// of each refund line (`lines[].paymentIntentId`) but moves no gateway money
// itself. Before this file the guest only got that money back if an admin filed
// an intent refund by hand (and could then file one for money the sale still
// held). The POS refund transaction now files a `system:pos` payment refund
// REQUEST per intent for what its lines return, the same way
// `pos-order-late-payment.ts` files the late-payment refund. This file only
// files the request: the APPROVAL and the payout stay with WS-05
// (`approveRefund`, another person with `payment.reconcile`).
// - Only gateway lines (`tenderBucket` = gateway) with an intent and an amount
//   above 0, grouped per intent. An intent that holds a terminal (EDC)
//   transaction is skipped: the terminal returned that money, a gateway refund
//   would pay it twice.
// - Idempotent: the WS-05 admin key `pos-refund-gateway:<posRefundId>:<intentId>`.
// - Run after the POS refund row is written, with the order row locked. The
//   intent rows are locked ascending by `lockIntentsForFact`; `refundableBalance`
//   then no longer counts what this refund gave back as held by the sale.
// - The amount is the lines' sum, at most what the cap leaves beyond ALL
//   refunds already reserved (pending included). A shortfall is never silent: it
//   is written to the audit trail (`pos_order.refund_gateway_shortfall`).
// - Not a late-payment refund: the key is NOT in the late-payment key list of
//   `payment-refund.service.ts`, so approval counts every other pending refund.

import {
  createUlid,
  idr,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { tenderBucket } from "@starter/shared/pos";
import type { SystemRefundActor } from "@starter/shared/payment/admin";
import { and, eq, inArray } from "drizzle-orm";
import { paymentIntents, paymentRefunds } from "../db/schema/index.ts";
import { HttpError } from "../lib/http-error.ts";
import { recordAudit } from "./core-audit.ts";
import { idempotentPaymentAdminWrite } from "./payment-admin-idempotency.ts";
import { refundableBalance } from "./payment-admin.service.ts";
import { lockIntentsForFact } from "./payment-refund-fact-time.ts";
import { openRefundChainSafely } from "./payment-refund.service.ts";
import { appendPaymentEvent } from "./payment-support.ts";
import type { Tx } from "./permission-resolver.ts";
import { auditPos } from "./pos-order-support.ts";

const POS_REQUESTER: SystemRefundActor = "system:pos";

export const posRefundGatewayKey = (posRefundId: string, intentId: string) =>
  `pos-refund-gateway:${posRefundId}:${intentId}`;

export async function requestPosRefundGatewayPart(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    order: Parameters<typeof auditPos>[2]["order"];
    caller: Parameters<typeof auditPos>[2]["caller"];
    posRefundId: string;
    lines: readonly {
      method: string;
      amountIdr: number;
      paymentIntentId?: string | null;
    }[];
    /** Verified Q81 releases; their original method stays on the intent. */
    depositParts?: readonly { paymentIntentId: string; amountIdr: number }[];
    now: Date;
  },
): Promise<void> {
  const tenantId = context.tenant.tenantId;
  const byIntent = new Map<string, number>();
  for (const line of input.lines)
    if (
      line.paymentIntentId &&
      line.amountIdr > 0 &&
      tenderBucket(line.method as never) === "gateway"
    )
      byIntent.set(
        line.paymentIntentId,
        (byIntent.get(line.paymentIntentId) ?? 0) + line.amountIdr,
      );
  const lineIntents = new Set(byIntent.keys());
  for (const part of input.depositParts ?? [])
    if (part.amountIdr > 0) {
      // legend-fpy9s: one key per refund + intent. A DP part and a line on the
      // same intent would share it (the DP could cover a line shortfall, or a
      // second call would replay the first and file nothing). Refuse.
      if (lineIntents.has(part.paymentIntentId))
        throw new HttpError(
          409,
          "DP_REFUND_SOURCE_UNVERIFIED",
          "Sumber pembayaran DP belum dapat diverifikasi; refund DP harus melalui pembayaran asal.",
        );
      byIntent.set(
        part.paymentIntentId,
        (byIntent.get(part.paymentIntentId) ?? 0) + part.amountIdr,
      );
    }
  if (byIntent.size === 0) return;
  // Locks the intent rows (ascending); the order row is already held.
  const at = await lockIntentsForFact(tx, tenantId, byIntent.keys(), input.now);
  const intents = await tx
    .select()
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, tenantId),
        inArray(paymentIntents.id, [...byIntent.keys()]),
      ),
    );
  for (const intent of [...intents].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  )) {
    // Money a terminal returned, or an intent never settled: nothing to pay.
    if (intent.edcTransactionId !== null) continue;
    const lineIdr = byIntent.get(intent.id) ?? 0;
    const settled =
      intent.paidAt !== null &&
      ["paid", "partially_refunded"].includes(intent.status);
    await idempotentPaymentAdminWrite(
      tx,
      context,
      POS_REQUESTER,
      posRefundGatewayKey(input.posRefundId, intent.id),
      "refund.create",
      {
        paymentIntentId: intent.id,
        posRefundId: input.posRefundId,
        reason: "pos_refund_gateway",
      },
      async () => {
        let room = 0n;
        if (settled) {
          const { cap, reserved } = await refundableBalance(tx, intent);
          room = cap > reserved ? cap - reserved : 0n;
        }
        const amount = BigInt(lineIdr) < room ? BigInt(lineIdr) : room;
        if (amount < BigInt(lineIdr))
          await auditPos(
            tx,
            context,
            {
              action: "pos_order.refund_gateway_shortfall",
              order: input.order,
              caller: input.caller,
              before: null,
              after: {
                id: input.order.id,
                posRefundId: input.posRefundId,
                wantedIdr: lineIdr,
                filedIdr: Number(amount),
              },
              reason: "POS refund of a gateway tender: cap leaves less",
              objectType: "payment_intent",
              objectId: intent.id,
            },
            at,
          );
        if (amount <= 0n) return { refundId: null };
        const [inserted] = await tx
          .insert(paymentRefunds)
          .values({
            tenantId: intent.tenantId,
            outletId: intent.outletId,
            paymentIntentId: intent.id,
            amountIdr: idr(Number(amount)),
            reason: "Refund POS bagian pembayaran online",
            note: null,
            requestedBy: POS_REQUESTER,
          })
          .returning();
        if (!inserted) throw new Error("Refund insert returned no row");
        const row = await openRefundChainSafely(tx, context, inserted, at);
        await recordAudit(
          tx,
          context,
          {
            id: createUlid(at.getTime()),
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
            createdAt: at.toISOString(),
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
          now: at,
        });
        await auditPos(
          tx,
          context,
          {
            action: "pos_order.refund_gateway_requested",
            order: input.order,
            caller: input.caller,
            before: null,
            after: {
              id: input.order.id,
              posRefundId: input.posRefundId,
              amountIdr: row.amountIdr,
              status: row.status,
            },
            reason: "POS refund of a gateway tender",
            objectType: "payment_refund",
            objectId: row.id,
          },
          at,
        );
        return { refundId: row.id };
      },
    );
  }
}

// legend-94q2l: the money side of a failed-item manual refund (ORD-09). The
// resolve step (order-recovery.service.ts) only settles the issue and appends
// `order_issue.manual_refund_approved`; this consumer, wired in worker-main.ts,
// opens the payment refund REQUEST for that line. It never pays out: approval
// and payout stay with WS-05 (`approveRefund`, a person with `payment.reconcile`
// who is neither the resolver nor the ORD-09 approver).
//
// - Locks: the issue row, then the order row (always this sequence), then the
//   payment intent (`lockIntentsForFact`, after the business rows).
// - Idempotent: the WS-05 admin key `order-recovery-refund:<orderIssueId>` and
//   the partial unique index on `payment_refunds.order_issue_id`. A replayed or
//   second event for the same issue opens nothing.
// - Business conditions (POS bill, split bill, no or unsettled intent, nothing
//   left) never throw: a retry cannot fix them and would dead-letter the
//   event. They leave an audit row on the issue saying why. Technical errors
//   throw so the outbox retries.
// - QR pay-first sale: the refund also appends `order.refunded` (the journal
//   reverses the line's revenue) and the sale's hold on the intent shrinks by
//   the refund. Open bill: a plain intent refund, the bill is not a sale yet.
// Events of another tenant or outlet, and every other event, are ignored.

import { and, eq, gte, ne, sql } from "drizzle-orm";
import {
  createUlid,
  idr,
  toIsoDateTime,
  ulidToUuid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type { EventEnvelope } from "@starter/shared/events";
import type { SystemRefundActor } from "@starter/shared/payment/admin";
import { orderIssueManualRefundApprovedPayloadSchema } from "@starter/shared/qr-order";
import { auditLogs } from "../db/schema/core-audit.ts";
import { orderIssues } from "../db/schema/kds-issues.ts";
import { paymentIntents, paymentRefunds } from "../db/schema/index.ts";
import { posOrders } from "../db/schema/pos-order.ts";
import { orderItems, orders } from "../db/schema/qr-order.ts";
import { recordAudit } from "./core-audit.ts";
import { OrderRevenueMismatch } from "./order-revenue.ts";
import { recoveryRefundSplit } from "./order-recovery-refund-amount.ts";
import { idempotentPaymentAdminWrite } from "./payment-admin-idempotency.ts";
import { refundableBalance } from "./payment-admin.service.ts";
import { lockIntentsForFact } from "./payment-refund-fact-time.ts";
import { openRefundChainSafely } from "./payment-refund.service.ts";
import { appendPaymentEvent } from "./payment-support.ts";
import type { Tx } from "./permission-resolver.ts";
import { qrTenderMethod } from "./qr-order-paid.ts";
import { appendPosEvent } from "./pos-order-support.ts";

const RECOVERY_REQUESTER: SystemRefundActor = "system:recovery";
const REFUND_REASON = "Refund item gagal (ORD-09)";
const AUDIT_REQUESTED = "order_issue.refund_requested";
const AUDIT_BLOCKED = "order_issue.refund_blocked";
const AUDIT_ROUTED_POS = "order_issue.refund_routed_pos";
const AUDIT_SHORTFALL = "order_issue.refund_shortfall";
const AUDIT_SAFE_FIELDS = [
  "id",
  "orderId",
  "orderItemId",
  "paymentIntentId",
  "refundId",
  "wantedIdr",
  "amountIdr",
  "shortfallIdr",
  "status",
  "blockedReason",
];

export const orderRecoveryRefundKey = (orderIssueId: string) =>
  `order-recovery-refund:${orderIssueId}`;

/**
 * Applies one `order_issue.manual_refund_approved` event in the consumption
 * transaction `tx`. Anything that is not such an event of this tenant and
 * outlet, for a resolved manual-refund issue, is a no-op.
 */
export async function deliverOrderRecoveryRefundEvent(
  context: ScopedTenantContext,
  event: EventEnvelope,
  tx: Tx,
): Promise<void> {
  if (event.name !== "order_issue.manual_refund_approved") return;
  const tenantId = context.tenant.tenantId;
  if (event.tenantId !== tenantId) return;
  const payload = orderIssueManualRefundApprovedPayloadSchema.safeParse(
    event.payload,
  );
  if (!payload.success) return;
  const issueId = payload.data.orderIssueId;

  const [issue] = await tx
    .select()
    .from(orderIssues)
    .where(and(eq(orderIssues.tenantId, tenantId), eq(orderIssues.id, issueId)))
    .for("update");
  if (!issue) return;
  if (
    issue.status !== "resolved" ||
    issue.resolution !== "manual_refund" ||
    event.outletId !== issue.outletId ||
    issue.orderId !== payload.data.orderId
  )
    return;

  const [order] = await tx
    .select()
    .from(orders)
    .where(and(eq(orders.tenantId, tenantId), eq(orders.id, issue.orderId)))
    // Lock order after issue (always this sequence).
    .for("update");
  if (!order || order.outletId !== issue.outletId) return;
  const [line] = await tx
    .select({ id: orderItems.id, lineTotalIdr: orderItems.lineTotalIdr })
    .from(orderItems)
    .where(
      and(
        eq(orderItems.tenantId, tenantId),
        eq(orderItems.orderId, order.id),
        eq(orderItems.id, issue.orderItemId),
      ),
    );
  if (!line) return;

  // A refund already open for this issue (the unique index covers every status
  // but failed): a replayed or second event changes nothing.
  const [open] = await tx
    .select({ id: paymentRefunds.id })
    .from(paymentRefunds)
    .where(
      and(
        eq(paymentRefunds.tenantId, tenantId),
        eq(paymentRefunds.orderIssueId, issue.id),
        ne(paymentRefunds.status, "failed"),
      ),
    )
    .limit(1);
  if (open) return;

  let at = new Date();
  const actorUserId = event.actor.type === "user" ? event.actor.id : null;
  // The audit row is written after the issue was resolved, so a one-day margin
  // before resolvedAt bounds the replay scan to audit_logs_retention_idx.
  const auditSince = new Date(
    (issue.resolvedAt ?? issue.createdAt).getTime() - 24 * 60 * 60 * 1000,
  );
  const audit = (
    action: string,
    after: Record<string, string | number>,
    reason: string | null,
  ): Promise<void> =>
    recordAudit(
      tx,
      context,
      {
        id: createUlid(at.getTime()),
        tenantId,
        outletId: order.outletId,
        actorType: "system",
        actorId: null,
        deviceId: null,
        action,
        objectType: "order_issue",
        objectId: issue.id,
        reason,
        maskedChanges: { before: null, after },
        ipHash: null,
        sensitiveAccess: false,
        retentionClass: "audit_2y",
        createdAt: toIsoDateTime(at),
      },
      AUDIT_SAFE_FIELDS,
    );
  // A blocked or short event is replayed under the issue row lock: write its
  // audit row only once.
  const auditOnce = async (
    action: string,
    after: Record<string, string | number>,
    reason: string | null,
  ): Promise<void> => {
    const [existing] = await tx
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.tenantId, tenantId),
          gte(auditLogs.createdAt, auditSince),
          sql`${auditLogs.event}->>'objectId' = ${issue.id}`,
          sql`${auditLogs.event}->>'action' = ${action}`,
        ),
      )
      .limit(1);
    if (!existing) await audit(action, after, reason);
  };
  const blocked = (
    blockedReason: string,
    extra: Record<string, string | number> = {},
  ) =>
    auditOnce(
      AUDIT_BLOCKED,
      { id: issue.id, orderId: order.id, blockedReason, ...extra },
      "Refund item gagal tidak dibuka",
    );

  // 1. A POS bill: the cashier refunds it (`refundPosOrder`).
  const [pos] = await tx
    .select({ orderId: posOrders.orderId })
    .from(posOrders)
    .where(
      and(eq(posOrders.tenantId, tenantId), eq(posOrders.orderId, order.id)),
    );
  if (pos) {
    await auditOnce(
      AUDIT_ROUTED_POS,
      { id: issue.id, orderId: order.id },
      "Refund item gagal pada bill kasir lewat refund kasir",
    );
    return;
  }

  // 3. No intent pinned: no gateway money to give back.
  if (order.paymentIntentId === null) {
    await blocked("no_intent");
    return;
  }
  // The intent row lock follows the business rows (payment-refund-fact-time.ts);
  // the lock also gives the fact time the refund is written at.
  at = await lockIntentsForFact(tx, tenantId, [order.paymentIntentId], at);
  const [intent] = await tx
    .select()
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, tenantId),
        eq(paymentIntents.id, order.paymentIntentId),
      ),
    );
  if (!intent) {
    await blocked("no_intent");
    return;
  }

  // 2. A split bill: the parts are separate intents, the line cannot be mapped
  // to one payer. Checked on the pinned intent, any split row of the order,
  // and any other intent of the order or of its payment link (a QR bill split
  // over several codes, legend-nslvm) that took money, the same test as the
  // payout guard (accounting-auto-journal-guards.ts qrSales).
  const orderUuid = ulidToUuid(order.id);
  const splitCheck = await tx.execute(sql`
    SELECT
      (SELECT count(*) FROM bill_splits
        WHERE tenant_id = ${tenantId} AND order_id = ${orderUuid}::uuid)::int AS splits,
      (SELECT count(*) FROM payment_intents other
        WHERE other.tenant_id = ${tenantId}
          AND other.id <> ${intent.id}::uuid
          AND (other.order_id = ${orderUuid}::uuid
               OR (${order.paymentLinkId}::uuid IS NOT NULL
                   AND other.payment_link_id = ${order.paymentLinkId}::uuid))
          AND other.status IN ('paid', 'partially_refunded', 'refunded')
          AND (SELECT coalesce(sum(e.amount_idr), 0) FROM payment_evidence e
                WHERE e.tenant_id = other.tenant_id AND e.payment_intent_id = other.id)
            - (SELECT coalesce(sum(f.amount_idr), 0) FROM payment_unallocated_funds f
                WHERE f.tenant_id = other.tenant_id AND f.payment_intent_id = other.id)
            > 0)::int AS other_payers
  `);
  const splits = Number(splitCheck.rows[0]?.splits ?? 0);
  const otherPayers = Number(splitCheck.rows[0]?.other_payers ?? 0);
  if (intent.billSplitId !== null || splits > 0 || otherPayers > 0) {
    await blocked("split_bill");
    return;
  }

  // 4. Money not settled: nothing to give back yet.
  if (
    intent.paidAt === null ||
    !["paid", "partially_refunded"].includes(intent.status)
  ) {
    await blocked("intent_not_settled");
    return;
  }

  const payFirst = order.paymentMode === "pay_first";
  if (payFirst && order.firedAt === null) {
    // No sale was made yet, so there is no line revenue to reverse.
    await blocked("order_not_fired");
    return;
  }

  // What other issues of this order already gave back: per issue the largest
  // refund, whatever its status (a failed one may be retried by hand).
  const releasedResult = await tx.execute(sql`
    SELECT coalesce(sum(m.amt), 0)::text AS released FROM (
      SELECT max(r.amount_idr) AS amt
        FROM payment_refunds r
        JOIN order_issues i
          ON i.tenant_id = r.tenant_id AND i.id = r.order_issue_id
       WHERE r.tenant_id = ${tenantId}
         AND i.order_id = ${orderUuid}::uuid
         AND r.order_issue_id <> ${issue.id}::uuid
       GROUP BY r.order_issue_id) m
  `);
  let releasedIdr = Number(String(releasedResult.rows[0]?.released ?? "0"));
  if (!payFirst) {
    // 6. Open bill: the intent's own cap bounds the refund, whatever else the
    // bill holds. Reading the room as released money makes the split cut to it.
    const { cap, reserved } = await refundableBalance(tx, intent);
    const room = cap > reserved ? Number(cap - reserved) : 0;
    releasedIdr = Math.max(
      releasedIdr,
      order.totalIdr - order.depositAppliedIdr - room,
    );
  }

  let split: ReturnType<typeof recoveryRefundSplit>;
  try {
    split = recoveryRefundSplit({
      order,
      lineTotalIdr: line.lineTotalIdr,
      releasedIdr,
    });
  } catch (error) {
    // Order amounts that fail their tax-mode identity: a retry cannot fix them.
    if (error instanceof OrderRevenueMismatch) {
      await blocked("order_amounts_mismatch");
      return;
    }
    throw error;
  }
  if (split.shortfallIdr > 0)
    await auditOnce(
      AUDIT_SHORTFALL,
      {
        id: issue.id,
        orderId: order.id,
        paymentIntentId: intent.id,
        wantedIdr: split.wantedIdr,
        amountIdr: split.amountIdr,
        shortfallIdr: split.shortfallIdr,
      },
      "Refund item gagal dipotong sisa yang bisa dikembalikan",
    );
  if (split.amountIdr <= 0) {
    await blocked("nothing_left");
    return;
  }

  await idempotentPaymentAdminWrite(
    tx,
    context,
    RECOVERY_REQUESTER,
    orderRecoveryRefundKey(issue.id),
    "refund.create",
    {
      orderIssueId: issue.id,
      paymentIntentId: intent.id,
      resolvedBy: actorUserId,
      approvedBy: payload.data.approvedBy,
    },
    async () => {
      // A QR pay-first sale: the journal reverses this line's revenue.
      if (payFirst)
        await appendPosEvent(tx, context, "order.refunded", {
          order,
          payload: {
            orderId: order.id,
            outletId: order.outletId,
            businessDate: order.businessDate,
            refundId: issue.id,
            amountIdr: split.amountIdr,
            reason: "other",
            reasonNote: payload.data.reason,
            approvedBy: payload.data.approvedBy,
            overrideId: null,
            approvalRequestId: payload.data.approvalRequestId,
            grossSalesIdr: split.grossSalesIdr,
            discountIdr: split.discountIdr,
            serviceChargeIdr: split.serviceChargeIdr,
            pbjtIdr: split.pbjtIdr,
            refundCashIdr: 0,
            refundGatewayIdr: split.amountIdr,
            refundEdcIdr: 0,
            refundPointsIdr: 0,
            lines: [
              {
                method: qrTenderMethod(intent.method),
                amountIdr: split.amountIdr,
              },
            ],
            refundedAt: at.toISOString(),
          },
          caller: null,
          now: at,
        });
      const [inserted] = await tx
        .insert(paymentRefunds)
        .values({
          tenantId: intent.tenantId,
          outletId: intent.outletId,
          paymentIntentId: intent.id,
          orderIssueId: issue.id,
          amountIdr: idr(split.amountIdr),
          reason: REFUND_REASON,
          note: null,
          requestedBy: RECOVERY_REQUESTER,
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
      await audit(
        AUDIT_REQUESTED,
        {
          id: issue.id,
          orderId: order.id,
          paymentIntentId: intent.id,
          refundId: row.id,
          amountIdr: row.amountIdr,
          status: row.status,
        },
        REFUND_REASON,
      );
      return {
        refundId: row.id as string | null,
        resolvedBy: actorUserId,
        approvedBy: payload.data.approvedBy,
      };
    },
  );
}

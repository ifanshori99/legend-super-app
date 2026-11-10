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
// - Promo order (legend-h1dyy): the CRM promo port re-prices the order
//   without the failed line (founder Q41/Q19), so a free item pays Rp0 and a
//   line that drops the bill below the promo condition pays what the guest
//   paid minus what the kept goods now cost. The port runs after the intent
//   lock (issue -> order -> intent -> promo; the refund graph that rejects a
//   refund also holds the intent before the promo, and the QR paths that take
//   the promo lock - checkout redeem, unpaid void - hold no intent lock). The
//   goods payout goes on the promo ledger once the refund row is filed. A
//   failed item was never delivered, whatever happened to its refund, so the
//   kept lines leave out the item of every manual_refund issue of the order,
//   and a rejected refund keeps its promo payout (the money is not owed).
// - Replay (legend-pti5r): a final failure that is not `rejected` leaves the
//   promo ledger as it is (the payout stays reserved for that line, so no
//   other issue absorbs it; a withdrawn promo cannot be undone). When the
//   same item is reported again, the new issue files the failed refund's
//   amount and `order.refunded` split again, without a promo recompute and
//   without a second payout, cut to the room the intent still has
//   (`replayOfIssueId` on its idempotency response and audit row). A rejected
//   earlier issue or a live or paid refund takes the normal path; so does a
//   pay-first earlier refund without an `order.refunded` split. An open bill
//   files no split: it replays the failed amount whole. A chain of replays
//   follows `replayOfIssueId` back to the root issue.
// - Swap (replacement item): the predecessor of a replay (or a `rejected`
//   marker) is matched through the swap chain (`toOriginal`) only on an order
//   with a live promo (Round 3 design; the swap decision on a promo order is
//   with the CTO). Without a promo it must be the same line
//   (`row.orderItemId === issue.orderItemId`): a replacement item is another
//   line with its own price, so a swap to a cheaper item that then fails is
//   paid its own normal amount, never the earlier failed line's amount, and a
//   rejected refund of the original does not turn the replacement into
//   `nothing_left`.
// Events of another tenant or outlet, and every other event, are ignored.

import { and, desc, eq, gte, inArray, isNull, ne, sql } from "drizzle-orm";
import {
  createUlid,
  idr,
  toIsoDateTime,
  ulidToUuid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type { EventEnvelope } from "@starter/shared/events";
import type { SystemRefundActor } from "@starter/shared/payment/admin";
import {
  orderIssueManualRefundApprovedPayloadSchema,
  qrOrderEvents,
} from "@starter/shared/qr-order";
import { auditLogs } from "../db/schema/core-audit.ts";
import { domainEventOutbox } from "../db/schema/core-events.ts";
import { orderIssues } from "../db/schema/kds-issues.ts";
import { paymentIntents, paymentRefunds } from "../db/schema/index.ts";
import { paymentAdminIdempotency } from "../db/schema/payment-admin.ts";
import { posOrders } from "../db/schema/pos-order.ts";
import { orderItems, orders } from "../db/schema/qr-order.ts";
import { recordAudit } from "./core-audit.ts";
import { appendOutbox } from "./core-outbox.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  livePromoApplicationOf,
  orderPromoPartialRefundPort,
} from "./order-promo-refund.ts";
import { OrderRevenueMismatch, orderRevenueSplit } from "./order-revenue.ts";
import {
  recoveryRefundReplaySplit,
  recoveryRefundSplit,
  type RecoveryRefundPromo,
} from "./order-recovery-refund-amount.ts";
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
/** An issue whose refunds failed this many times is left to a person. */
const MAX_FAILED_REFUNDS = 3;
const AUDIT_REJECTED = "order_issue.refund_rejected";
const AUDIT_REFILED = "order_issue.refund_refiled";
const AUDIT_REFILE_BLOCKED = "order_issue.refund_refile_blocked";
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
  "failureReason",
  "replayOfIssueId",
];

const REVERSAL_EVENT = "order_issue.refund_reversal_requested";
const REVERSAL_DESTINATION = "cloud-sync";

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
  // payout guard (accounting-auto-journal-guards.ts qrSales). The intent of a
  // swap-difference charge (legend-i83ls) is no payer of the order's bill: it
  // paid its own payment link, so it is skipped (by intent and by link).
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
          AND NOT EXISTS (SELECT 1 FROM order_issue_charges c
                WHERE c.tenant_id = other.tenant_id
                  AND (c.payment_intent_id = other.id
                       OR c.payment_link_id = other.payment_link_id))
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
  // refund, whatever its status. An issue gives money back only while it has
  // a live refund (`status <> 'failed'`, same rule as qrSaleInUseOfIntent):
  // once every refund of it is `failed` (`rejected` or any final failure) its
  // journal is reversed and the sale holds that money again. A line can be
  // reported again after such a final failure
  // (order_issues.refund_rejected_at, legend-wumm8); any other settled issue
  // of the line still blocks a second one (order_issues_resolved_item_once_idx).
  // The same issues give the line totals already refunded (`priorLinesIdr`,
  // cumulative rounding).
  const releasedResult = await tx.execute(sql`
    SELECT coalesce(sum(m.amt), 0)::text AS released,
           coalesce(sum(m.line_total), 0)::text AS prior_lines
      FROM (
      SELECT max(r.amount_idr) AS amt,
             max(oi.line_total_idr) AS line_total
        FROM payment_refunds r
        JOIN order_issues i
          ON i.tenant_id = r.tenant_id AND i.id = r.order_issue_id
        LEFT JOIN order_items oi
          ON oi.tenant_id = i.tenant_id AND oi.id = i.order_item_id
       WHERE r.tenant_id = ${tenantId}
         AND i.order_id = ${orderUuid}::uuid
         AND r.order_issue_id <> ${issue.id}::uuid
       GROUP BY r.order_issue_id
      HAVING coalesce(bool_or(r.status <> 'failed'), false)) m
  `);
  const released = releasedResult.rows[0];
  let releasedIdr = Number(String(released?.released ?? "0"));
  const priorLinesIdr = Number(String(released?.prior_lines ?? "0"));
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
  let promo: RecoveryRefundPromo | undefined;
  let replay: RecoveryRefundReplaySource | null = null;
  try {
    // Order amounts that fail their tax-mode identity are refused before the
    // promo port changes anything.
    orderRevenueSplit(order);
    // legend-pti5r: the same item reported again after a final failure of its
    // refund (not `rejected`) replays that refund's amount and split, for every
    // order (promo or not, pay-first or open bill): a new split could differ by
    // a rounding step. The promo ledger still holds its payout, so a replay
    // recomputes and records nothing.
    const issues = await tx
      .select({
        id: orderIssues.id,
        orderItemId: orderIssues.orderItemId,
        replacementOrderItemId: orderIssues.replacementOrderItemId,
        status: orderIssues.status,
        resolution: orderIssues.resolution,
        refundRejectedAt: orderIssues.refundRejectedAt,
      })
      .from(orderIssues)
      .where(
        and(
          eq(orderIssues.tenantId, tenantId),
          eq(orderIssues.orderId, order.id),
        ),
      );
    // The promo was priced on the checkout lines: a swap (legend-zm1e6)
    // voids the original line and adds a replacement at the swap price, so
    // the original stands for both and the replacement is left out. A
    // failed replacement maps back to its original.
    const originalOf = new Map<string, string>();
    for (const row of issues)
      if (row.replacementOrderItemId !== null)
        originalOf.set(row.replacementOrderItemId, row.orderItemId);
    const toOriginal = (itemId: string) => {
      let id = itemId;
      for (let hop = 0; hop <= issues.length; hop++) {
        const original = originalOf.get(id);
        if (original === undefined) break;
        id = original;
      }
      return id;
    };
    const swappedOriginals = new Set(originalOf.values());
    // A live promo: the port re-prices the order without the failed lines
    // (founder Q41/Q19). It records no payout here (`deferPayout`): the
    // refund records what it files below.
    const hasLivePromo = Boolean(
      await livePromoApplicationOf(tx, context, order.id),
    );
    const found = await findRecoveryRefundReplay(
      tx,
      tenantId,
      order.id,
      issue,
      issues,
      toOriginal,
      payFirst,
      hasLivePromo,
    );
    if (found !== REPLAY_REJECTED) replay = found;
    // legend-h1dyy: the earlier refund of this item was `rejected`: the money
    // is not owed, so a re-report gives nothing back. A promo order reaches
    // the same end below: the rejected item stays out of the kept lines.
    if (found === REPLAY_REJECTED && !hasLivePromo) {
      await blocked("nothing_left");
      return;
    }
    if (hasLivePromo) {
      const items = await tx
        .select({
          id: orderItems.id,
          menuItemId: orderItems.menuItemId,
          quantity: orderItems.quantity,
          unitPriceIdr: orderItems.unitPriceIdr,
          modifiersTotalIdr: orderItems.modifiersTotalIdr,
          status: orderItems.status,
        })
        .from(orderItems)
        .where(
          and(
            eq(orderItems.tenantId, tenantId),
            eq(orderItems.orderId, order.id),
          ),
        )
        .orderBy(orderItems.id);
      if (replay === null) {
        // A failed item was never delivered, whatever happened to its refund
        // (nothing_left, rejected, ...): the item of every other manual_refund
        // issue this consumer already processed is out of the kept lines, this
        // one included. Processed = it has a refund row (any status) or a
        // `refund_blocked` audit row for nothing_left (its recompute ran). A
        // promo_state_mismatch issue is not: its recompute never ran, so the
        // promo still holds its line and a later refund must not pay it. An
        // issue whose event has not run yet keeps its item here: its own event
        // refunds it later (two items resolved before either event runs).
        const others = issues
          .filter(
            (row) =>
              row.id !== issue.id &&
              row.status === "resolved" &&
              row.resolution === "manual_refund",
          )
          .map((row) => row.id);
        const processed = new Set<string>();
        if (others.length > 0) {
          const refunded = await tx
            .selectDistinct({ id: paymentRefunds.orderIssueId })
            .from(paymentRefunds)
            .where(
              and(
                eq(paymentRefunds.tenantId, tenantId),
                inArray(paymentRefunds.orderIssueId, others),
              ),
            );
          for (const row of refunded)
            if (row.id !== null) processed.add(row.id);
          const blockedIssues = await tx
            .select({ id: sql<string>`${auditLogs.event}->>'objectId'` })
            .from(auditLogs)
            .where(
              and(
                eq(auditLogs.tenantId, tenantId),
                // Written after the order existed: bounds the scan.
                gte(auditLogs.createdAt, order.createdAt),
                sql`${auditLogs.event}->>'action' = ${AUDIT_BLOCKED}`,
                sql`${auditLogs.event}->>'objectId' IN (${sql.join(
                  others.map((id) => sql`${id}`),
                  sql`, `,
                )})`,
                sql`${auditLogs.event}->'maskedChanges'->'after'->>'blockedReason' = 'nothing_left'`,
              ),
            );
          for (const row of blockedIssues) processed.add(row.id);
        }
        const failed = new Set<string>([toOriginal(line.id)]);
        for (const row of issues)
          if (processed.has(row.id)) failed.add(toOriginal(row.orderItemId));
        // Kept lines priced as at checkout (`toPromoLines`, order-promo.ts):
        // unit = item or variant price + modifiers.
        const keptLines = items
          .filter(
            (item) =>
              !originalOf.has(item.id) &&
              (item.status !== "voided" || swappedOriginals.has(item.id)) &&
              !failed.has(item.id),
          )
          .map((item) => {
            const unitPriceIdr = item.unitPriceIdr + item.modifiersTotalIdr;
            return {
              menuItemId: item.menuItemId,
              quantity: item.quantity,
              unitPriceIdr: idr(unitPriceIdr),
              lineTotalIdr: idr(unitPriceIdr * item.quantity),
            };
          });
        let recomputed: Awaited<
          ReturnType<
            typeof orderPromoPartialRefundPort.recomputeAfterPartialRefund
          >
        >;
        try {
          recomputed =
            await orderPromoPartialRefundPort.recomputeAfterPartialRefund(
              tx,
              context,
              {
                orderId: order.id,
                keptLines,
                reason: REFUND_REASON,
                actorUserId,
                at,
                deferPayout: true,
              },
            );
        } catch (error) {
          // A void released the promo in between: a retry cannot fix it.
          if (
            error instanceof HttpError &&
            error.status === 409 &&
            error.code === "PROMO_APPLICATION_RELEASED"
          ) {
            await blocked("promo_released");
            return;
          }
          // The kept lines do not fit the promo ledger (e.g. more than it
          // still stands): a retry gives the same answer, so the event must
          // not loop. A person looks at the audit row.
          if (error instanceof HttpError && error.status === 422) {
            await blocked("promo_state_mismatch");
            return;
          }
          throw error;
        }
        if (recomputed.adjusted)
          promo = {
            refundedSubtotalIdr: recomputed.refundedSubtotalIdr,
            goodsDueIdr: recomputed.refundDueIdr,
            remainingPaidIdr: recomputed.remainingPaidIdr,
          };
      }
    }
    split =
      replay === null
        ? recoveryRefundSplit({
            order,
            lineTotalIdr: line.lineTotalIdr,
            priorLinesIdr,
            releasedIdr,
            ...(promo === undefined ? {} : { promo }),
          })
        : recoveryRefundReplaySplit({
            order,
            wantedIdr: replay.amountIdr,
            grossSalesIdr: replay.grossSalesIdr,
            discountIdr: replay.discountIdr,
            serviceChargeIdr: replay.serviceChargeIdr,
            pbjtIdr: replay.pbjtIdr,
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
  // A promo order with nothing due (a returned free item) ends here too: the
  // promo recompute above stays, the item really failed.
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
      const row = await fileRecoveryRefund(tx, context, {
        tenantId: intent.tenantId,
        outletId: intent.outletId,
        paymentIntentId: intent.id,
        orderIssueId: issue.id,
        amountIdr: split.amountIdr,
        at,
      });
      // The goods part of the refund goes on the promo ledger, on its
      // item-price basis (`goodsIdr`: tax included for inclusive prices).
      // Only after a recompute that adjusted the promo (never a released
      // application, which the recompute refuses).
      // A replay records nothing: the ledger already holds this line's payout.
      const promoRecordedIdr =
        promo === undefined
          ? 0
          : (
              await orderPromoPartialRefundPort.recordPartialRefundPayout(
                tx,
                context,
                { orderId: order.id, payoutIdr: split.goodsIdr, at },
              )
            ).recordedIdr;
      await audit(
        AUDIT_REQUESTED,
        {
          id: issue.id,
          orderId: order.id,
          paymentIntentId: intent.id,
          refundId: row.id,
          amountIdr: row.amountIdr,
          status: row.status,
          ...(replay === null ? {} : { replayOfIssueId: replay.issueId }),
        },
        REFUND_REASON,
      );
      return {
        refundId: row.id as string | null,
        resolvedBy: actorUserId,
        approvedBy: payload.data.approvedBy,
        promoRecordedIdr,
        ...(replay === null ? {} : { replayOfIssueId: replay.issueId }),
      };
    },
  );
}

/** The failed refund a re-reported line replays (legend-pti5r). */
type RecoveryRefundReplaySource = {
  /** The earlier issue whose refund failed finally. */
  issueId: string;
  /** Amount of its failed refund, split as its `order.refunded` was. */
  amountIdr: number;
  grossSalesIdr: number;
  discountIdr: number;
  serviceChargeIdr: number;
  pbjtIdr: number;
};

/** The earlier refund of the item was `rejected`: no replay, nothing owed. */
const REPLAY_REJECTED = "rejected" as const;

/**
 * legend-pti5r: the replay source of `issue`, `REPLAY_REJECTED`, or null for
 * the normal path. Among the OTHER issues of the same order whose item maps to
 * the same original item (swaps), resolved `manual_refund`, and that already
 * have a refund row (they were processed), the one filed most recently decides:
 * by the time of its first refund row (a later issue opened earlier may be
 * processed first), the newest wins, the id breaks a tie. It is a source only
 * when its refund ended in a final failure that is not `rejected`
 * (`refund_rejected_at` set, latest refund `failed`) and its `order.refunded`
 * (`payload.refundId` = its id) holds a split that adds up to the failed
 * refund's amount. A `rejected` final failure answers `REPLAY_REJECTED`: the
 * caller gives nothing back (legend-h1dyy). A live or paid refund, or
 * (pay-first) no split: null. An open bill files no split nor `order.refunded`:
 * its replay is the failed amount as gross sales, with no discount, service
 * charge or tax.
 * A chain (A -> B replayed and cut by room -> B final-fails -> C) follows the
 * `replayOfIssueId` of each filing's idempotency response back to the root
 * issue (at most 10 hops) and takes the root's amount and split, so a cut is
 * recovered; the caller caps it by the room again. The source reports the
 * root. The caller holds the intent lock, which serializes this read with the
 * failure hook that stamps `refund_rejected_at`.
 * `hasLivePromo`: with a live promo the items match through `toOriginal`
 * (swaps); without one only the same line (`orderItemId`) counts as the
 * predecessor, for a replay source and for a `rejected` marker alike.
 */
async function findRecoveryRefundReplay(
  tx: Tx,
  tenantId: ScopedTenantContext["tenant"]["tenantId"],
  orderId: string,
  issue: { id: string; orderItemId: string },
  issues: {
    id: string;
    orderItemId: string;
    status: string;
    resolution: string | null;
    refundRejectedAt: Date | null;
  }[],
  toOriginal: (itemId: string) => string,
  payFirst: boolean,
  hasLivePromo: boolean,
): Promise<RecoveryRefundReplaySource | typeof REPLAY_REJECTED | null> {
  const original = toOriginal(issue.orderItemId);
  const others = issues.filter(
    (row) =>
      row.id !== issue.id &&
      row.status === "resolved" &&
      row.resolution === "manual_refund" &&
      (hasLivePromo
        ? toOriginal(row.orderItemId) === original
        : row.orderItemId === issue.orderItemId),
  );
  if (others.length === 0) return null;
  const refunds = await tx
    .select({
      id: paymentRefunds.id,
      orderIssueId: paymentRefunds.orderIssueId,
      status: paymentRefunds.status,
      failureReason: paymentRefunds.failureReason,
      amountIdr: paymentRefunds.amountIdr,
      createdAt: paymentRefunds.createdAt,
    })
    .from(paymentRefunds)
    .where(
      and(
        eq(paymentRefunds.tenantId, tenantId),
        inArray(
          paymentRefunds.orderIssueId,
          others.map((row) => row.id),
        ),
      ),
    )
    .orderBy(desc(paymentRefunds.createdAt), desc(paymentRefunds.id));
  // Per issue: its latest refund (rows come newest first) and the time of its
  // first refund row (its filing order).
  const latest = new Map<string, (typeof refunds)[number]>();
  const firstFiledAt = new Map<string, number>();
  for (const row of refunds) {
    if (row.orderIssueId === null) continue;
    if (!latest.has(row.orderIssueId)) latest.set(row.orderIssueId, row);
    firstFiledAt.set(row.orderIssueId, row.createdAt.getTime());
  }
  const previous = others
    .filter((row) => latest.has(row.id))
    .sort(
      (a, b) =>
        (firstFiledAt.get(b.id) ?? 0) - (firstFiledAt.get(a.id) ?? 0) ||
        (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
    )[0];
  if (previous === undefined) return null;
  const failedRefund = latest.get(previous.id);
  if (
    failedRefund === undefined ||
    previous.refundRejectedAt === null ||
    failedRefund.status !== "failed"
  )
    return null;
  if ((failedRefund.failureReason ?? "unknown") === "rejected")
    return REPLAY_REJECTED;
  // Follow the replay chain to the root issue.
  let rootId = previous.id;
  for (let hop = 0; hop < 10; hop++) {
    const [filing] = await tx
      .select({ response: paymentAdminIdempotency.response })
      .from(paymentAdminIdempotency)
      .where(
        and(
          eq(paymentAdminIdempotency.tenantId, tenantId),
          eq(paymentAdminIdempotency.key, orderRecoveryRefundKey(rootId)),
        ),
      );
    const next = (
      filing?.response as { replayOfIssueId?: unknown } | null | undefined
    )?.replayOfIssueId;
    if (typeof next !== "string" || next === rootId) break;
    rootId = next;
  }
  const isRoot = rootId === previous.id;
  if (!payFirst) {
    // Open bill: no split to read; the root's filed amount is what to replay.
    let amountIdr = failedRefund.amountIdr;
    if (!isRoot) {
      const [rootRefund] = await tx
        .select({ amountIdr: paymentRefunds.amountIdr })
        .from(paymentRefunds)
        .where(
          and(
            eq(paymentRefunds.tenantId, tenantId),
            eq(paymentRefunds.orderIssueId, rootId),
          ),
        )
        .orderBy(desc(paymentRefunds.createdAt), desc(paymentRefunds.id))
        .limit(1);
      if (rootRefund === undefined) return null;
      amountIdr = rootRefund.amountIdr;
    }
    return {
      issueId: rootId,
      amountIdr,
      grossSalesIdr: amountIdr,
      discountIdr: 0,
      serviceChargeIdr: 0,
      pbjtIdr: 0,
    };
  }
  const [refunded] = await tx
    .select({ payload: sql<unknown>`${domainEventOutbox.event}->'payload'` })
    .from(domainEventOutbox)
    .where(
      and(
        eq(domainEventOutbox.tenantId, tenantId),
        eq(domainEventOutbox.aggregateType, "order"),
        sql`${domainEventOutbox.event}->>'name' = 'order.refunded'`,
        sql`${domainEventOutbox.event}->'payload'->>'refundId' = ${rootId}`,
        sql`${domainEventOutbox.event}->'payload'->>'orderId' = ${orderId}`,
      ),
    )
    .limit(1);
  const payload = refunded?.payload as Record<string, unknown> | undefined;
  if (!payload) return null;
  const part = (key: string): number | null => {
    const value = payload[key];
    return typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 0
      ? value
      : null;
  };
  const amountIdr = isRoot ? failedRefund.amountIdr : part("amountIdr");
  const grossSalesIdr = part("grossSalesIdr");
  const discountIdr = part("discountIdr");
  const serviceChargeIdr = part("serviceChargeIdr");
  const pbjtIdr = part("pbjtIdr");
  if (
    amountIdr === null ||
    grossSalesIdr === null ||
    discountIdr === null ||
    serviceChargeIdr === null ||
    pbjtIdr === null ||
    grossSalesIdr - discountIdr + serviceChargeIdr + pbjtIdr !== amountIdr
  )
    return null;
  return {
    issueId: rootId,
    amountIdr,
    grossSalesIdr,
    discountIdr,
    serviceChargeIdr,
    pbjtIdr,
  };
}

/**
 * Inserts the `system:recovery` payment refund of an issue, opens its approval
 * chain and writes the `payment.refund_requested` audit row and event. Shared
 * by the first filing and the re-filing after a failure; the caller holds the
 * intent row lock and writes its own `order_issue.*` audit row.
 * Lock order: the first filing runs under the consumer's issue -> order ->
 * intent locks. A re-file holds the intent lock (the refund graph locks it
 * first) and then the insert takes the FK key-share lock on `order_issues`,
 * the reverse order. A deadlock is rare; Postgres aborts one side and the
 * outbox retries the event.
 */
async function fileRecoveryRefund(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    tenantId: ScopedTenantContext["tenant"]["tenantId"];
    outletId: (typeof paymentRefunds.$inferInsert)["outletId"];
    paymentIntentId: string;
    orderIssueId: string;
    amountIdr: number;
    at: Date;
  },
) {
  const { at } = input;
  const [inserted] = await tx
    .insert(paymentRefunds)
    .values({
      tenantId: input.tenantId,
      outletId: input.outletId,
      paymentIntentId: input.paymentIntentId,
      orderIssueId: input.orderIssueId,
      amountIdr: idr(input.amountIdr),
      reason: REFUND_REASON,
      note: null,
      requestedBy: RECOVERY_REQUESTER,
      // The fact clock of the guard (lockIntentsForFact), not the DB default.
      createdAt: input.at,
    })
    .returning();
  if (!inserted) throw new Error("Refund insert returned no row");
  const row = await openRefundChainSafely(tx, context, inserted, at);
  await recordAudit(
    tx,
    context,
    {
      id: createUlid(at.getTime()),
      tenantId: input.tenantId,
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
  return row;
}

/**
 * legend-94q2l: a `rejected` QR pay-first refund asks the journal to be
 * reversed: `order_issue.refund_reversal_requested`, once per issue, only when
 * an `order.refunded` event of the issue (`payload.refundId` = issue id)
 * exists. An open bill refund has none: nothing to reverse, no event. Local
 * twin of `appendRecoveryEvent` (order-recovery.service.ts).
 * Returns whether this call appended the event.
 */
async function requestRecoveryRefundReversal(
  tx: Tx,
  context: ScopedTenantContext,
  failedRefund: typeof paymentRefunds.$inferSelect,
  issueId: string,
  now: Date,
): Promise<boolean> {
  const tenantId = failedRefund.tenantId;
  const [refunded] = await tx
    .select({ id: domainEventOutbox.id })
    .from(domainEventOutbox)
    .where(
      and(
        eq(domainEventOutbox.tenantId, tenantId),
        eq(domainEventOutbox.aggregateType, "order"),
        sql`${domainEventOutbox.event}->>'name' = 'order.refunded'`,
        sql`${domainEventOutbox.event}->'payload'->>'refundId' = ${issueId}`,
      ),
    )
    .limit(1);
  if (!refunded) return false;
  const [issue] = await tx
    .select({ orderId: orderIssues.orderId, outletId: orderIssues.outletId })
    .from(orderIssues)
    .where(
      and(eq(orderIssues.tenantId, tenantId), eq(orderIssues.id, issueId)),
    );
  if (!issue) return false;
  const [sent] = await tx
    .select({ id: domainEventOutbox.id })
    .from(domainEventOutbox)
    .where(
      and(
        eq(domainEventOutbox.tenantId, tenantId),
        eq(domainEventOutbox.aggregateType, "order_issue"),
        eq(domainEventOutbox.aggregateId, issueId),
        sql`${domainEventOutbox.event}->>'name' = ${REVERSAL_EVENT}`,
      ),
    )
    .limit(1);
  if (sent) return false;
  const definition = qrOrderEvents[REVERSAL_EVENT];
  const [last] = await tx
    .select({
      last: sql<number>`coalesce(max(${domainEventOutbox.sequence}), 0)`,
    })
    .from(domainEventOutbox)
    .where(
      and(
        eq(domainEventOutbox.tenantId, tenantId),
        eq(domainEventOutbox.destination, REVERSAL_DESTINATION),
        eq(domainEventOutbox.aggregateType, definition.entry.aggregateType),
        eq(domainEventOutbox.aggregateId, issueId),
      ),
    );
  const sequence = Number(last?.last ?? 0) + 1;
  const event = definition.envelopeSchema.parse({
    id: createUlid(now.getTime()),
    tenantId,
    outletId: issue.outletId,
    name: definition.name,
    version: definition.version,
    aggregateType: definition.entry.aggregateType,
    aggregateId: issueId,
    sequence,
    occurredAt: toIsoDateTime(now),
    actor: { type: "system" },
    deviceId: null,
    idempotencyKey: `${definition.name}:${issueId}:${sequence}`.slice(0, 100),
    payloadSchemaRef: definition.payloadSchemaRef,
    payload: {
      orderId: issue.orderId,
      orderIssueId: issueId,
      refundId: failedRefund.id,
      amountIdr: failedRefund.amountIdr,
      rejectedAt: toIsoDateTime(now),
    },
  });
  await appendOutbox(tx, context, {
    id: createUlid(now.getTime()),
    event,
    destination: REVERSAL_DESTINATION,
    direction: null,
    peerId: null,
  });
  return true;
}

/**
 * legend-94q2l: a `system:recovery` refund that ended `failed` is filed again
 * (`failRefund`, payment-refund.service.ts, lazy import: import cycle), so a
 * guest owed money for a failed item is not left with a dead request. Only for
 * the failures that say nothing about the money itself:
 * - `approval_expired` and `approver_unauthorized` file a new request for the
 *   same amount;
 * - `rejected` is final: not re-filed, audited (`order_issue.refund_rejected`);
 *   a QR pay-first refund (it has an `order.refunded`) also appends
 *   `order_issue.refund_reversal_requested` once, which reverses its journal,
 *   and the sale holds the money again (`qrSaleInUseOfIntent`);
 * - `provider_declined`, `cap_exceeded` and `source_document` are final too:
 *   not re-filed, audited `order_issue.refund_refile_blocked`
 *   (`failure_needs_person`). `provider_declined` is only the provider's
 *   definitive decline (payment-refund.service.ts header): the money did not
 *   leave; an unknown outcome stays `approved` and never lands here;
 * - an issue with 3 failed refunds is not re-filed again (`refile_limit`).
 * Every final failure (and the `no_first_filing` block) is treated like
 * `rejected` (legend-iu91r): the refund journal is reversed, the points come
 * back, the sale holds the money again and the line may be reported again
 * (`refund_rejected_at`, legend-wumm8), since a person cannot refund a
 * source-document intent by hand and the money would be stuck.
 * legend-pti5r: a final failure leaves the promo ledger untouched (the payout
 * stays reserved for the line). The same item reported again re-files the
 * failed refund's amount and split (replay, `deliverOrderRecoveryRefundEvent`).
 * No new `order.refunded`: the revenue was already reversed. Idempotent per
 * failed refund (key `order-recovery-refund:<issueId>:<failedRefundId>`); the
 * resolver and approver are copied from the first filing's idempotency row,
 * which four-eyes reads. Without that row nothing is filed: the parties
 * would be unknown (`order_issue.refund_refile_blocked`).
 * A repeated call for the same failed refund changes nothing: its audit rows
 * (`refund_rejected`, `refund_refile_blocked`) are written once per refund id,
 * the `refund_rejected_at` stamp and the reversal event are set once.
 * The caller holds the refund graph locks (intent row first).
 */
export async function refileRecoveryRefundAfterFailure(
  tx: Tx,
  context: ScopedTenantContext,
  failedRefund: typeof paymentRefunds.$inferSelect,
  now: Date,
): Promise<void> {
  const issueId = failedRefund.orderIssueId;
  if (
    failedRefund.requestedBy !== RECOVERY_REQUESTER ||
    issueId === null ||
    failedRefund.status !== "failed"
  )
    return;
  const tenantId = failedRefund.tenantId;
  const auditIssueRow = (
    action: string,
    after: Record<string, string | number>,
    reason: string,
  ) =>
    recordAudit(
      tx,
      context,
      {
        id: createUlid(now.getTime()),
        tenantId,
        outletId: failedRefund.outletId,
        actorType: "system",
        actorId: null,
        deviceId: null,
        action,
        objectType: "order_issue",
        objectId: issueId,
        reason,
        maskedChanges: { before: null, after },
        ipHash: null,
        sensitiveAccess: false,
        retentionClass: "audit_2y",
        createdAt: toIsoDateTime(now),
      },
      AUDIT_SAFE_FIELDS,
    );
  // The hook can run again for the same failed refund (a backfill helper, a
  // retried failure): its audit row is written once per refund id.
  const auditIssue = async (
    action: string,
    after: Record<string, string | number>,
    reason: string,
  ): Promise<void> => {
    const [existing] = await tx
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.tenantId, tenantId),
          // Written after the refund existed: bounds the scan.
          gte(
            auditLogs.createdAt,
            new Date(failedRefund.createdAt.getTime() - 24 * 60 * 60 * 1000),
          ),
          sql`${auditLogs.event}->>'objectId' = ${issueId}`,
          sql`${auditLogs.event}->>'action' = ${action}`,
          sql`${auditLogs.event}->'maskedChanges'->'after'->>'refundId' = ${failedRefund.id}`,
        ),
      )
      .limit(1);
    if (!existing) await auditIssueRow(action, after, reason);
  };
  // A final failure (`rejected`, a person-needed failure, `refile_limit`,
  // `no_first_filing`) gives the sale its money back (legend-iu91r): the line
  // may be reported again (legend-wumm8, same idempotent stamp as `rejected`)
  // and the refund journal and the points are reversed.
  const settleFinalFailure = async () => {
    await tx
      .update(orderIssues)
      .set({ refundRejectedAt: now })
      .where(
        and(
          eq(orderIssues.tenantId, tenantId),
          eq(orderIssues.id, issueId),
          eq(orderIssues.resolution, "manual_refund"),
          isNull(orderIssues.refundRejectedAt),
        ),
      );
    await requestRecoveryRefundReversal(
      tx,
      context,
      failedRefund,
      issueId,
      now,
    );
  };
  const failureReason = failedRefund.failureReason ?? "unknown";
  if (failureReason === "rejected") {
    await auditIssue(
      AUDIT_REJECTED,
      {
        id: issueId,
        refundId: failedRefund.id,
        paymentIntentId: failedRefund.paymentIntentId,
        amountIdr: failedRefund.amountIdr,
        failureReason,
      },
      "Refund item gagal ditolak, tidak diajukan ulang",
    );
    await settleFinalFailure();
    // legend-h1dyy: the promo payout this refund recorded stays on the promo
    // ledger. The approver decided the money is not owed, so a later refund
    // of this order must not pay it (the item stays out of the kept lines).
    // legend-pti5r: no replay either; a re-report of it stays nothing_left.
    return;
  }
  if (
    failureReason !== "approval_expired" &&
    failureReason !== "approver_unauthorized"
  ) {
    await auditIssue(
      AUDIT_REFILE_BLOCKED,
      {
        id: issueId,
        refundId: failedRefund.id,
        blockedReason: "failure_needs_person",
        failureReason,
      },
      "Refund item gagal tidak diajukan ulang: perlu keputusan orang",
    );
    await settleFinalFailure();
    return;
  }
  const [live] = await tx
    .select({ id: paymentRefunds.id })
    .from(paymentRefunds)
    .where(
      and(
        eq(paymentRefunds.tenantId, tenantId),
        eq(paymentRefunds.orderIssueId, issueId),
        ne(paymentRefunds.status, "failed"),
      ),
    )
    .limit(1);
  if (live) return;
  // This refund is already `failed` in this transaction, so it counts.
  const [failures] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(paymentRefunds)
    .where(
      and(
        eq(paymentRefunds.tenantId, tenantId),
        eq(paymentRefunds.orderIssueId, issueId),
        eq(paymentRefunds.status, "failed"),
      ),
    );
  if ((failures?.count ?? 0) >= MAX_FAILED_REFUNDS) {
    await auditIssue(
      AUDIT_REFILE_BLOCKED,
      {
        id: issueId,
        refundId: failedRefund.id,
        blockedReason: "refile_limit",
        failureReason,
      },
      "Refund item gagal tidak diajukan ulang: sudah gagal 3 kali",
    );
    await settleFinalFailure();
    return;
  }
  const [first] = await tx
    .select({ response: paymentAdminIdempotency.response })
    .from(paymentAdminIdempotency)
    .where(
      and(
        eq(paymentAdminIdempotency.tenantId, tenantId),
        eq(paymentAdminIdempotency.key, orderRecoveryRefundKey(issueId)),
      ),
    );
  const firstResponse = first?.response as
    { resolvedBy?: string | null; approvedBy?: string } | null | undefined;
  if (!firstResponse) {
    await auditIssue(
      AUDIT_REFILE_BLOCKED,
      {
        id: issueId,
        refundId: failedRefund.id,
        blockedReason: "no_first_filing",
        failureReason,
      },
      "Refund item gagal tidak diajukan ulang: pihak asli tidak terbaca",
    );
    await settleFinalFailure();
    return;
  }
  await idempotentPaymentAdminWrite(
    tx,
    context,
    RECOVERY_REQUESTER,
    `${orderRecoveryRefundKey(issueId)}:${failedRefund.id}`,
    "refund.create",
    {
      orderIssueId: issueId,
      paymentIntentId: failedRefund.paymentIntentId,
      failedRefundId: failedRefund.id,
    },
    async () => {
      const row = await fileRecoveryRefund(tx, context, {
        tenantId,
        outletId: failedRefund.outletId,
        paymentIntentId: failedRefund.paymentIntentId,
        orderIssueId: issueId,
        amountIdr: failedRefund.amountIdr,
        at: now,
      });
      await auditIssue(
        AUDIT_REFILED,
        {
          id: issueId,
          paymentIntentId: row.paymentIntentId,
          refundId: row.id,
          amountIdr: row.amountIdr,
          status: row.status,
          failureReason,
        },
        REFUND_REASON,
      );
      return {
        refundId: row.id as string | null,
        resolvedBy: firstResponse.resolvedBy ?? null,
        approvedBy: firstResponse.approvedBy ?? null,
      };
    },
  );
}

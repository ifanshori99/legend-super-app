// legend-rat9r (founder W4 Q25): what the guest PAID for an order line (after
// promo and discount, with service and PBJT), read without changing anything.
// A cheaper swap credits at most that value, and every later refund of the
// item (the original or a replacement, first filing or replay) stays within
// it, less the swap vouchers and the live refunds of the item.
//
// The paid value is the amount the refund consumer (order-recovery-refund.ts)
// would want for the line, before any cap or room cut:
// - a replay source of the line (an earlier refund that failed finally, not
//   `rejected`): that refund's amount; `rejected`: Rp0 (the money is not owed);
// - no live promo: the line's pro-rata share (`recoveryRefundSplit`);
// - a live promo: the CRM promo recompute without the line, run in a savepoint
//   that is always rolled back (a dry run). A 422 of the recompute (the kept
//   lines do not fit the promo ledger) refuses the swap: a person decides.
// The shared reads of the consumer (the issues of the order and their swap
// chain, what other issues already released, the kept promo lines, the replay
// source) live here so both sides compute the same thing.

import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import {
  idr,
  ulidToUuid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { auditLogs } from "../db/schema/core-audit.ts";
import { domainEventOutbox } from "../db/schema/core-events.ts";
import { orderIssues } from "../db/schema/kds-issues.ts";
import { paymentRefunds } from "../db/schema/index.ts";
import { paymentAdminIdempotency } from "../db/schema/payment-admin.ts";
import { orderItems, orders } from "../db/schema/qr-order.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  livePromoApplicationOf,
  orderPromoPartialRefundPort,
} from "./order-promo-refund.ts";
import { OrderRevenueMismatch } from "./order-revenue.ts";
import {
  recoveryRefundSplit,
  type RecoveryRefundPromo,
} from "./order-recovery-refund-amount.ts";
import type { Tx } from "./permission-resolver.ts";

const AUDIT_BLOCKED = "order_issue.refund_blocked";

export const orderRecoveryRefundKey = (orderIssueId: string) =>
  `order-recovery-refund:${orderIssueId}`;

/** An issue of the order as the refund consumer and the swap read it. */
export type RecoveryIssue = {
  id: string;
  orderItemId: string;
  replacementOrderItemId: string | null;
  status: string;
  resolution: string | null;
  refundRejectedAt: Date | null;
  /** Apology voucher of the issue (a swap credit or a voucher resolution). */
  voucherId: string | null;
  /** legend-rat9r: paid value read at a cheaper swap; null = no cap. */
  paidValueIdr: number | null;
};

/** Every issue of the order. */
export async function recoveryIssuesOf(
  tx: Tx,
  tenantId: ScopedTenantContext["tenant"]["tenantId"],
  orderId: string,
): Promise<RecoveryIssue[]> {
  return tx
    .select({
      id: orderIssues.id,
      orderItemId: orderIssues.orderItemId,
      replacementOrderItemId: orderIssues.replacementOrderItemId,
      status: orderIssues.status,
      resolution: orderIssues.resolution,
      refundRejectedAt: orderIssues.refundRejectedAt,
      voucherId: orderIssues.voucherId,
      paidValueIdr: orderIssues.paidValueIdr,
    })
    .from(orderIssues)
    .where(
      and(eq(orderIssues.tenantId, tenantId), eq(orderIssues.orderId, orderId)),
    );
}

/**
 * The promo was priced on the checkout lines: a swap (legend-zm1e6) voids the
 * original line and adds a replacement at the swap price, so the original
 * stands for both and the replacement is left out. A failed replacement maps
 * back to its original (`toOriginal`).
 */
export function recoverySwapChain(issues: readonly RecoveryIssue[]) {
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
  return {
    originalOf,
    toOriginal,
    swappedOriginals: new Set(originalOf.values()),
  };
}

export type RecoverySwapChain = ReturnType<typeof recoverySwapChain>;

/**
 * What other issues of this order already gave back: per issue the largest
 * refund, whatever its status. An issue gives money back only while it has
 * a live refund (`status <> 'failed'`, same rule as qrSaleInUseOfIntent):
 * once every refund of it is `failed` (`rejected` or any final failure) its
 * journal is reversed and the sale holds that money again. A line can be
 * reported again after such a final failure
 * (order_issues.refund_rejected_at, legend-wumm8); any other settled issue
 * of the line still blocks a second one (order_issues_resolved_item_once_idx).
 * The same issues give the line totals already refunded (`priorLinesIdr`,
 * cumulative rounding).
 */
export async function recoveryReleasedOf(
  tx: Tx,
  tenantId: ScopedTenantContext["tenant"]["tenantId"],
  orderId: string,
  issueId: string,
): Promise<{ releasedIdr: number; priorLinesIdr: number }> {
  const orderUuid = ulidToUuid(orderId);
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
         AND r.order_issue_id <> ${issueId}::uuid
       GROUP BY r.order_issue_id
      HAVING coalesce(bool_or(r.status <> 'failed'), false)) m
  `);
  const released = releasedResult.rows[0];
  return {
    releasedIdr: Number(String(released?.released ?? "0")),
    priorLinesIdr: Number(String(released?.prior_lines ?? "0")),
  };
}

/** The lines of the order as the kept-lines builder reads them. */
export async function recoveryOrderItemsOf(
  tx: Tx,
  tenantId: ScopedTenantContext["tenant"]["tenantId"],
  orderId: string,
) {
  return tx
    .select({
      id: orderItems.id,
      menuItemId: orderItems.menuItemId,
      quantity: orderItems.quantity,
      unitPriceIdr: orderItems.unitPriceIdr,
      modifiersTotalIdr: orderItems.modifiersTotalIdr,
      lineTotalIdr: orderItems.lineTotalIdr,
      status: orderItems.status,
    })
    .from(orderItems)
    .where(
      and(eq(orderItems.tenantId, tenantId), eq(orderItems.orderId, orderId)),
    )
    .orderBy(orderItems.id);
}

/**
 * The lines the promo recompute keeps when `failedLineId` fails. A failed item
 * was never delivered, whatever happened to its refund (nothing_left,
 * rejected, ...): the item of every other manual_refund issue the refund
 * consumer already processed is out of the kept lines, this one included.
 * Processed = it has a refund row (any status) or a `refund_blocked` audit row
 * for nothing_left (its recompute ran). A promo_state_mismatch issue is not:
 * its recompute never ran, so the promo still holds its line and a later
 * refund must not pay it. An issue whose event has not run yet keeps its item
 * here: its own event refunds it later (two items resolved before either
 * event runs).
 */
export async function recoveryKeptLines(
  tx: Tx,
  tenantId: ScopedTenantContext["tenant"]["tenantId"],
  input: {
    order: { createdAt: Date };
    issueId: string;
    failedLineId: string;
    issues: readonly RecoveryIssue[];
    chain: RecoverySwapChain;
    items: Awaited<ReturnType<typeof recoveryOrderItemsOf>>;
  },
) {
  const { issues, chain } = input;
  const others = issues
    .filter(
      (row) =>
        row.id !== input.issueId &&
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
    for (const row of refunded) if (row.id !== null) processed.add(row.id);
    const blockedIssues = await tx
      .select({ id: sql<string>`${auditLogs.event}->>'objectId'` })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.tenantId, tenantId),
          // Written after the order existed: bounds the scan.
          gte(auditLogs.createdAt, input.order.createdAt),
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
  const failed = new Set<string>([chain.toOriginal(input.failedLineId)]);
  for (const row of issues)
    if (processed.has(row.id)) failed.add(chain.toOriginal(row.orderItemId));
  // Kept lines priced as at checkout (`toPromoLines`, order-promo.ts):
  // unit = item or variant price + modifiers.
  return input.items
    .filter(
      (item) =>
        !chain.originalOf.has(item.id) &&
        (item.status !== "voided" || chain.swappedOriginals.has(item.id)) &&
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
}

/**
 * legend-rat9r: what the item of `issue` has already given back, other than
 * through `issue` itself: the face value of every apology voucher of its
 * chain (issues whose item maps to the same original) plus, per issue, the
 * largest refund while that issue still has a live refund (same rule as
 * `recoveryReleasedOf`). `paidValueIdr` is the smallest paid value read on
 * the chain; null when no swap of the chain read one (no cap).
 */
export async function recoveryChainOf(
  tx: Tx,
  tenantId: ScopedTenantContext["tenant"]["tenantId"],
  issue: { id: string; orderItemId: string },
  issues: readonly RecoveryIssue[],
  toOriginal: (itemId: string) => string,
): Promise<{ paidValueIdr: number | null; givenIdr: number }> {
  const original = toOriginal(issue.orderItemId);
  const chain = issues.filter(
    (row) => row.id !== issue.id && toOriginal(row.orderItemId) === original,
  );
  const paid = chain.flatMap((row) =>
    row.paidValueIdr === null ? [] : [Number(row.paidValueIdr)],
  );
  if (chain.length === 0) return { paidValueIdr: null, givenIdr: 0 };
  const ids = chain.map((row) => row.id);
  const voucherIds = chain.flatMap((row) =>
    row.voucherId === null ? [] : [row.voucherId],
  );
  const given = await tx.execute(sql`
    SELECT
      (SELECT coalesce(sum(v.value_idr), 0)
         FROM apology_vouchers a
         JOIN vouchers v ON v.tenant_id = a.tenant_id AND v.id = a.voucher_id
        WHERE a.tenant_id = ${tenantId}
          AND a.id IN (${
            voucherIds.length === 0
              ? sql`NULL::uuid`
              : sql.join(
                  voucherIds.map((id) => sql`${id}::uuid`),
                  sql`, `,
                )
          }))::text AS vouchers,
      (SELECT coalesce(sum(m.amt), 0)
         FROM (SELECT max(r.amount_idr) AS amt
                 FROM payment_refunds r
                WHERE r.tenant_id = ${tenantId}
                  AND r.order_issue_id IN (${sql.join(
                    ids.map((id) => sql`${id}::uuid`),
                    sql`, `,
                  )})
                GROUP BY r.order_issue_id
               HAVING coalesce(bool_or(r.status <> 'failed'), false)) m)::text AS refunds
  `);
  const row = given.rows[0];
  return {
    paidValueIdr: paid.length === 0 ? null : Math.min(...paid),
    givenIdr:
      Number(String(row?.vouchers ?? "0")) +
      Number(String(row?.refunds ?? "0")),
  };
}

/** Carries the dry-run result out of the savepoint it rolls back. */
class PromoDryRun extends Error {
  constructor(
    readonly result: Awaited<
      ReturnType<typeof orderPromoPartialRefundPort.recomputeAfterPartialRefund>
    >,
  ) {
    super("promo dry run");
  }
}

const SWAP_PROMO_REASON = "Nilai dibayar item untuk penukaran (dry run)";

/**
 * legend-rat9r: the paid value of `lineId` for a cheaper swap of `issueId`,
 * and what its chain already gave back. Takes the order row lock (after the
 * caller's issue lock, the consumer's sequence). Writes nothing: the promo
 * recompute runs in a savepoint that is always rolled back.
 */
export async function swapPaidValueOf(
  tx: Tx,
  context: ScopedTenantContext,
  input: { orderId: string; issueId: string; lineId: string; at: Date },
): Promise<{ paidValueIdr: number; givenIdr: number }> {
  const tenantId = context.tenant.tenantId;
  const [order] = await tx
    .select()
    .from(orders)
    .where(and(eq(orders.tenantId, tenantId), eq(orders.id, input.orderId)))
    .for("update");
  if (!order) throw new Error("Order of the swapped line is missing");
  const issues = await recoveryIssuesOf(tx, tenantId, order.id);
  const chain = recoverySwapChain(issues);
  const issue = { id: input.issueId, orderItemId: input.lineId };
  const given = await recoveryChainOf(
    tx,
    tenantId,
    issue,
    issues,
    chain.toOriginal,
  );
  // A replacement swapped again: the paid value read at the first swap.
  if (given.paidValueIdr !== null)
    return { paidValueIdr: given.paidValueIdr, givenIdr: given.givenIdr };
  const result = (paidValueIdr: number) => ({
    paidValueIdr,
    givenIdr: given.givenIdr,
  });

  const hasLivePromo = Boolean(
    await livePromoApplicationOf(tx, context, order.id),
  );
  const replay = await findRecoveryRefundReplay(
    tx,
    tenantId,
    order.id,
    issue,
    issues,
    chain.toOriginal,
    order.paymentMode === "pay_first",
    hasLivePromo,
  );
  if (replay === REPLAY_REJECTED) return result(0);
  if (replay !== null) return result(replay.amountIdr);

  const items = await recoveryOrderItemsOf(tx, tenantId, order.id);
  const line = items.find((item) => item.id === input.lineId);
  if (!line) throw new Error("Swapped line is missing");
  const { priorLinesIdr } = await recoveryReleasedOf(
    tx,
    tenantId,
    order.id,
    input.issueId,
  );
  let promo: RecoveryRefundPromo | undefined;
  if (hasLivePromo) {
    const keptLines = await recoveryKeptLines(tx, tenantId, {
      order,
      issueId: input.issueId,
      failedLineId: input.lineId,
      issues,
      chain,
      items,
    });
    let recomputed: PromoDryRun["result"] | undefined;
    try {
      await tx.transaction(async (savepoint) => {
        throw new PromoDryRun(
          await orderPromoPartialRefundPort.recomputeAfterPartialRefund(
            savepoint,
            context,
            {
              orderId: order.id,
              keptLines,
              reason: SWAP_PROMO_REASON,
              actorUserId: null,
              at: input.at,
              deferPayout: true,
            },
          ),
        );
      });
    } catch (error) {
      if (error instanceof PromoDryRun) recomputed = error.result;
      else if (error instanceof HttpError && error.status === 422)
        throw new HttpError(
          422,
          "VALIDATION_ERROR",
          "Nilai yang dibayar untuk item ini tidak bisa dihitung; minta bantuan staf.",
        );
      else throw error;
    }
    if (recomputed?.adjusted)
      promo = {
        refundedSubtotalIdr: recomputed.refundedSubtotalIdr,
        goodsDueIdr: recomputed.refundDueIdr,
        remainingPaidIdr: recomputed.remainingPaidIdr,
      };
  }
  try {
    return result(
      recoveryRefundSplit({
        order,
        lineTotalIdr: line.lineTotalIdr,
        priorLinesIdr,
        releasedIdr: 0,
        ...(promo === undefined ? {} : { promo }),
      }).wantedIdr,
    );
  } catch (error) {
    // Order amounts that fail their tax-mode identity: no paid value to read.
    if (error instanceof OrderRevenueMismatch)
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        "Nilai yang dibayar untuk item ini tidak bisa dihitung; minta bantuan staf.",
      );
    throw error;
  }
}

/** The failed refund a re-reported line replays (legend-pti5r). */
export type RecoveryRefundReplaySource = {
  /** The earlier issue whose refund failed finally. */
  issueId: string;
  /** Amount of its failed refund, split as its `order.refunded` was. */
  amountIdr: number;
  grossSalesIdr: number;
  discountIdr: number;
  serviceChargeIdr: number;
  pbjtIdr: number;
  /** Item of the root issue of the chain (another item = a swap in between). */
  rootOrderItemId: string;
};

/** The earlier refund of the item was `rejected`: no replay, nothing owed. */
export const REPLAY_REJECTED = "rejected" as const;

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
export async function findRecoveryRefundReplay(
  tx: Tx,
  tenantId: ScopedTenantContext["tenant"]["tenantId"],
  orderId: string,
  issue: { id: string; orderItemId: string },
  issues: readonly RecoveryIssue[],
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
  const rootOrderItemId =
    issues.find((row) => row.id === rootId)?.orderItemId ??
    previous.orderItemId;
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
      rootOrderItemId,
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
    rootOrderItemId,
  };
}

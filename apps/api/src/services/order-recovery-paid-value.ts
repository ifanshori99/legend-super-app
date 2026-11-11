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
import { lineGivenOf, orderGivenOf, orderRoomOf } from "./order-given.ts";
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
 * cumulative rounding) and (legend-hhm5m 5) the components their
 * `order.refunded` already reversed (`reversed`, pay-first; an open bill has
 * none), so a refund never reverses more of a component than the order holds.
 * `reversed` counts every live `order.refunded` of the order but this issue's
 * own (architect Q25 #6): POS refunds too; an issue's only while it still has
 * a live refund.
 */
export async function recoveryReleasedOf(
  tx: Tx,
  tenantId: ScopedTenantContext["tenant"]["tenantId"],
  orderId: string,
  issueId: string,
): Promise<{
  releasedIdr: number;
  priorLinesIdr: number;
  reversed: {
    grossSalesIdr: number;
    discountIdr: number;
    serviceChargeIdr: number;
    pbjtIdr: number;
  };
}> {
  const orderUuid = ulidToUuid(orderId);
  const reversedResult = await tx.execute(sql`
    SELECT coalesce(sum((e.event->'payload'->>'grossSalesIdr')::bigint), 0)::text AS gross,
           coalesce(sum((e.event->'payload'->>'discountIdr')::bigint), 0)::text AS discount,
           coalesce(sum((e.event->'payload'->>'serviceChargeIdr')::bigint), 0)::text AS service,
           coalesce(sum((e.event->'payload'->>'pbjtIdr')::bigint), 0)::text AS pbjt
      FROM domain_event_outbox e
     WHERE e.tenant_id = ${tenantId}
       AND e.aggregate_type = 'order'
       AND e.event->>'name' = 'order.refunded'
       AND e.event->'payload'->>'orderId' = ${orderId}
       AND e.event->'payload'->>'refundId' <> ${issueId}
       AND e.event->'payload'->>'refundId' NOT IN (
         SELECT i.id::text
           FROM order_issues i
          WHERE i.tenant_id = ${tenantId}
            AND i.order_id = ${orderUuid}::uuid
            AND NOT EXISTS (
              SELECT 1 FROM payment_refunds r
               WHERE r.tenant_id = i.tenant_id
                 AND r.order_issue_id = i.id
                 AND r.status <> 'failed'))
  `);
  const reversedRow = reversedResult.rows[0];
  const reversedPart = (key: string) =>
    Number(String(reversedRow?.[key] ?? "0"));
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
    reversed: {
      grossSalesIdr: reversedPart("gross"),
      discountIdr: reversedPart("discount"),
      serviceChargeIdr: reversedPart("service"),
      pbjtIdr: reversedPart("pbjt"),
    },
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
 * through `issue` itself, read from the one source of every payout path
 * (`orderGivenOf`, architect Q25): the vouchers and live refunds of the
 * issues of its chain (issues whose item maps to the same original) and its
 * part of the POS refunds that named it. `orderRoomIdr`: what the order as a
 * whole still leaves (paid less every voucher and refund, this issue's own
 * left out). `paidValueIdr` is the smallest paid value stored on the chain
 * plus the extra charges of its dearer swaps the guest really paid
 * (legend-hhm5m: an unpaid extra never counts); null when no swap of the chain
 * stored one (no swap, or a swap from before migration 0235).
 */
export async function recoveryChainOf(
  tx: Tx,
  tenantId: ScopedTenantContext["tenant"]["tenantId"],
  issue: { id: string; orderItemId: string; orderId: string },
  issues: readonly RecoveryIssue[],
  toOriginal: (itemId: string) => string,
): Promise<{
  paidValueIdr: number | null;
  givenIdr: number;
  orderRoomIdr: number;
}> {
  const orderGiven = await orderGivenOf(tx, tenantId, issue.orderId);
  const givenIdr = lineGivenOf(orderGiven, issue.orderItemId, issue.id);
  const orderRoomIdr = orderRoomOf(orderGiven, issue.id);
  const original = toOriginal(issue.orderItemId);
  const chain = issues.filter(
    (row) => row.id !== issue.id && toOriginal(row.orderItemId) === original,
  );
  const paid = chain.flatMap((row) =>
    row.paidValueIdr === null ? [] : [Number(row.paidValueIdr)],
  );
  if (paid.length === 0) return { paidValueIdr: null, givenIdr, orderRoomIdr };
  const extra = await tx.execute(sql`
    SELECT coalesce(sum(c.amount_idr), 0)::text AS extra
      FROM order_issue_charges c
     WHERE c.tenant_id = ${tenantId}
       AND c.order_issue_id IN (${sql.join(
         chain.map((row) => sql`${row.id}::uuid`),
         sql`, `,
       )})
       AND c.status = 'paid'
  `);
  return {
    paidValueIdr:
      Math.min(...paid) + Number(String(extra.rows[0]?.extra ?? "0")),
    givenIdr,
    orderRoomIdr,
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

const unreadablePaidValue = () =>
  new HttpError(
    422,
    "VALIDATION_ERROR",
    "Nilai yang dibayar untuk item ini tidak bisa dihitung; minta bantuan staf.",
  );

const swapChargePending = () =>
  new HttpError(
    422,
    "VALIDATION_ERROR",
    "Tagihan selisih penukaran sebelumnya untuk item ini belum selesai; selesaikan tagihan selisih dulu.",
  );

/**
 * legend-hhm5m: the extra charges of the dearer swaps of a chain (those that
 * wrote a replacement line; a blocked swap charges nothing). `paid`: the guest
 * paid the extra (`amount_idr`, with service and PBJT), it adds to the paid
 * value. `waived`/`expired`: never paid, so the line that swap wrote is worth
 * its difference less (only the swap that wrote `lineId`: a later swap's
 * difference is already measured against that lower list value). A swap
 * whose charge was blocked (`order_issue.charge_blocked`, no charge row ever
 * comes) charges nothing, so it reads as waived (architect Q25 #8). Anything
 * else (`open`, `routed_pos`, no charge row yet): pending.
 */
async function chainChargesOf(
  tx: Tx,
  tenantId: ScopedTenantContext["tenant"]["tenantId"],
  chain: readonly RecoveryIssue[],
  lineId: string,
): Promise<{
  paidExtraIdr: number;
  waivedDifferenceIdr: number;
  pending: boolean;
}> {
  const none = { paidExtraIdr: 0, waivedDifferenceIdr: 0, pending: false };
  if (chain.length === 0) return none;
  const result = await tx.execute(sql`
    SELECT i.id::text AS issue_id, c.status,
           c.amount_idr::text AS amount,
           coalesce(c.difference_idr, i.price_difference_idr)::text AS difference,
           (c.id IS NULL AND EXISTS (
              SELECT 1 FROM audit_logs a
               WHERE a.tenant_id = i.tenant_id
                 AND a.created_at >= coalesce(i.resolved_at, i.created_at) - interval '1 day'
                 AND a.event->>'action' = 'order_issue.charge_blocked'
                 AND a.event->>'objectId' = i.id::text)) AS blocked
      FROM order_issues i
      LEFT JOIN order_issue_charges c
        ON c.tenant_id = i.tenant_id AND c.order_issue_id = i.id
     WHERE i.tenant_id = ${tenantId}
       AND i.id IN (${sql.join(
         chain.map((row) => sql`${row.id}::uuid`),
         sql`, `,
       )})
       AND i.status = 'resolved'
       AND i.resolution = 'swap'
       AND i.price_difference_idr > 0
       AND i.replacement_order_item_id IS NOT NULL
  `);
  const writer = chain.find((row) => row.replacementOrderItemId === lineId);
  const charges = { ...none };
  for (const row of result.rows) {
    const status =
      row.blocked === true
        ? "waived"
        : row.status === null
          ? null
          : String(row.status);
    if (status === "paid")
      charges.paidExtraIdr += Number(String(row.amount ?? "0"));
    else if (status === "waived" || status === "expired") {
      if (writer !== undefined && String(row.issue_id) === writer.id)
        charges.waivedDifferenceIdr += Number(String(row.difference ?? "0"));
    } else charges.pending = true;
  }
  return charges;
}

/**
 * The paid value of the ORIGINAL item of the chain computed from the order
 * (no swap of the chain stored one): a replay source's amount; else the
 * line's pro-rata share, with a live promo the CRM recompute without the
 * line run as a dry run (savepoint always rolled back). Writes nothing.
 */
async function computedPaidValueOf(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    order: typeof orders.$inferSelect;
    issue: { id: string; orderItemId: string };
    issues: readonly RecoveryIssue[];
    chain: RecoverySwapChain;
    items: Awaited<ReturnType<typeof recoveryOrderItemsOf>>;
    original: Awaited<ReturnType<typeof recoveryOrderItemsOf>>[number];
    at: Date;
  },
): Promise<number> {
  const tenantId = context.tenant.tenantId;
  const { order, issue, issues, chain } = input;
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
  // A `rejected` earlier refund paid nothing back: the guest still paid the
  // line, so its paid value is read below as for a first swap (legend-pbwzq
  // T6: the replacement line is refunded normally).
  if (replay !== null && replay !== REPLAY_REJECTED) return replay.amountIdr;

  const { priorLinesIdr } = await recoveryReleasedOf(
    tx,
    tenantId,
    order.id,
    issue.id,
  );
  let promo: RecoveryRefundPromo | undefined;
  if (hasLivePromo) {
    const keptLines = await recoveryKeptLines(tx, tenantId, {
      order,
      issueId: issue.id,
      failedLineId: issue.orderItemId,
      issues,
      chain,
      items: input.items,
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
        throw unreadablePaidValue();
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
    return recoveryRefundSplit({
      order,
      lineTotalIdr: input.original.lineTotalIdr,
      priorLinesIdr,
      releasedIdr: 0,
      ...(promo === undefined ? {} : { promo }),
    }).wantedIdr;
  } catch (error) {
    // Order amounts that fail their tax-mode identity: no paid value to read.
    if (error instanceof OrderRevenueMismatch) throw unreadablePaidValue();
    throw error;
  }
}

/** What a swap of a line may credit and what its difference is measured against. */
export type SwapPaidValue = {
  /** Paid value of the original item of the chain, dearer extras left out. */
  baseIdr: number;
  /** `baseIdr` plus the extra charges of the chain the guest really paid. */
  paidValueIdr: number;
  /** Vouchers and live refunds of the chain (other than the issue itself). */
  givenIdr: number;
  /** What the order as a whole still leaves (`orderGivenOf`). */
  orderRoomIdr: number;
  /** List total of the line: a dearer swap is measured against it. */
  lineTotalIdr: number;
  /** List value a cheaper swap's credit is measured against (waived extra out). */
  listBaseIdr: number;
};

type PaidValueRead = SwapPaidValue & {
  /** A dearer swap of the chain whose extra is not settled yet. */
  chargePending: boolean;
};

/**
 * legend-hhm5m: the paid value read behind a swap, a voucher room and their
 * previews. Base: the smallest paid value stored on the chain, else computed
 * from the order for the original item. Takes the order row lock unless
 * `lock` is false (a read-only preview).
 */
async function readPaidValue(
  tx: Tx,
  context: ScopedTenantContext,
  input: { orderId: string; issueId: string; lineId: string; at: Date },
  lock: boolean,
): Promise<{ read: PaidValueRead; orderId: string }> {
  const tenantId = context.tenant.tenantId;
  const query = tx
    .select()
    .from(orders)
    .where(and(eq(orders.tenantId, tenantId), eq(orders.id, input.orderId)));
  const [order] = lock ? await query.for("update") : await query;
  if (!order) throw new Error("Order of the reported line is missing");
  const issues = await recoveryIssuesOf(tx, tenantId, order.id);
  const chain = recoverySwapChain(issues);
  const issue = { id: input.issueId, orderItemId: input.lineId };
  const originalId = chain.toOriginal(input.lineId);
  const chainIssues = issues.filter(
    (row) =>
      row.id !== input.issueId &&
      chain.toOriginal(row.orderItemId) === originalId,
  );
  const given = await recoveryChainOf(
    tx,
    tenantId,
    { ...issue, orderId: order.id },
    issues,
    chain.toOriginal,
  );
  const charges = await chainChargesOf(tx, tenantId, chainIssues, input.lineId);
  const items = await recoveryOrderItemsOf(tx, tenantId, order.id);
  const line = items.find((item) => item.id === input.lineId);
  const original = items.find((item) => item.id === originalId);
  if (!line || !original) throw new Error("Reported line is missing");
  const stored = chainIssues.flatMap((row) =>
    row.paidValueIdr === null ? [] : [Number(row.paidValueIdr)],
  );
  const baseIdr =
    stored.length > 0
      ? Math.min(...stored)
      : await computedPaidValueOf(tx, context, {
          order,
          issue,
          issues,
          chain,
          items,
          original,
          at: input.at,
        });
  return {
    orderId: order.id,
    read: {
      baseIdr,
      paidValueIdr: baseIdr + charges.paidExtraIdr,
      givenIdr: given.givenIdr,
      orderRoomIdr: given.orderRoomIdr,
      lineTotalIdr: line.lineTotalIdr,
      listBaseIdr: line.lineTotalIdr - charges.waivedDifferenceIdr,
      chargePending: charges.pending,
    },
  };
}

/** The item room of a read, clamped to the room of the order. */
function roomOfRead(read: SwapPaidValue): number {
  return Math.min(
    Math.max(0, read.paidValueIdr - read.givenIdr),
    read.orderRoomIdr,
  );
}

/**
 * legend-rat9r (architect H1), legend-eajpb: what an apology voucher for
 * `lineId` may still be worth: the paid value of its item chain (stored on a
 * swap, else computed from the order) less the chain's vouchers and live
 * refunds, clamped to the room of the order. Never unbounded. Takes the order
 * row lock (after the caller's issue lock, the consumer's sequence); 422 when
 * the paid value cannot be read.
 */
export async function voucherRoomOf(
  tx: Tx,
  context: ScopedTenantContext,
  input: { orderId: string; issueId: string; lineId: string; at?: Date },
  /** False for a read-only preview (the guest's options): no row lock. */
  lock = true,
): Promise<number> {
  const { read } = await readPaidValue(
    tx,
    context,
    { ...input, at: input.at ?? new Date() },
    lock,
  );
  return roomOfRead(read);
}

/**
 * legend-rat9r, legend-hhm5m: the paid value of the item of `lineId` for a
 * swap of `issueId` (every swap, dearer or cheaper), what its chain already
 * gave back, and the list value its difference is measured against. Takes the
 * order row lock unless `lock` is false (preview). Writes nothing: the promo
 * recompute runs in a savepoint that is always rolled back. 422 while a dearer
 * swap of the chain has an extra charge not settled yet, or when the paid
 * value cannot be read.
 */
export async function swapPaidValueOf(
  tx: Tx,
  context: ScopedTenantContext,
  input: { orderId: string; issueId: string; lineId: string; at: Date },
  lock = true,
): Promise<SwapPaidValue> {
  const { read } = await readPaidValue(tx, context, input, lock);
  if (read.chargePending) throw swapChargePending();
  return swapPaidValue(read);
}

function swapPaidValue(read: PaidValueRead): SwapPaidValue {
  return {
    baseIdr: read.baseIdr,
    paidValueIdr: read.paidValueIdr,
    givenIdr: read.givenIdr,
    orderRoomIdr: read.orderRoomIdr,
    lineTotalIdr: read.lineTotalIdr,
    listBaseIdr: read.listBaseIdr,
  };
}

/**
 * The difference of a swap to a replacement worth `replacementIdr` (unit price
 * x quantity): above the line's list total it is charged (architect Q25 #7: a
 * waived extra is not charged again for the same price); below the list value
 * less a waived extra (`listBaseIdr`) it is credited (< 0); in between, 0.
 */
export function swapDifferenceOf(paid: SwapPaidValue, replacementIdr: number) {
  const dearer = replacementIdr - paid.lineTotalIdr;
  return dearer > 0 ? dearer : Math.min(0, replacementIdr - paid.listBaseIdr);
}

/**
 * The credit of a swap whose list difference is `differenceIdr` (< 0): at
 * most what the item's paid value still leaves and what the order still
 * leaves (architect Q25 #2).
 */
export function swapCreditOf(paid: SwapPaidValue, differenceIdr: number) {
  return Math.min(-differenceIdr, roomOfRead(paid));
}

/**
 * legend-pqm3t: the guest's preview of an open issue, read once without a
 * lock. `swap` null: no swap can be priced (a pending extra charge, or the
 * paid value cannot be read); `voucherRoomIdr` null: the paid value cannot be
 * read. The promo dry run locks the promo rows briefly.
 */
export async function recoveryPreviewOf(
  tx: Tx,
  context: ScopedTenantContext,
  input: { orderId: string; issueId: string; lineId: string; at: Date },
): Promise<{ swap: SwapPaidValue | null; voucherRoomIdr: number | null }> {
  let found: Awaited<ReturnType<typeof readPaidValue>>;
  try {
    found = await readPaidValue(tx, context, input, false);
  } catch (error) {
    if (error instanceof HttpError && error.status === 422)
      return { swap: null, voucherRoomIdr: null };
    throw error;
  }
  const { read } = found;
  return {
    swap: read.chargePending ? null : swapPaidValue(read),
    voucherRoomIdr: roomOfRead(read),
  };
}

/**
 * legend-ti19m: the filing order of the first filings of one order. A refund's
 * `created_at` is the fact clock of the intent lock (`lockIntentsForFact`),
 * which is only `>= max(completed_at)`: a host clock that went back or equal
 * timestamps make it a poor order. The first filing of an issue therefore takes
 * `filingSeq` = the highest seq of the order + 1, counted under the intent row
 * lock (the consumer holds it, and so does the failure hook), so two filings of
 * one order never run at once and the seq grows with the commit order. It is
 * stored in the filing's idempotency response and its `refund_requested` audit
 * row. A re-file (approval_expired) keeps the seq of its issue.
 */
function filingSeqOf(response: unknown): number | null {
  const seq = (response as { filingSeq?: unknown } | null | undefined)
    ?.filingSeq;
  return typeof seq === "number" && Number.isSafeInteger(seq) && seq > 0
    ? seq
    : null;
}

/** The `filingSeq` of each of `issueIds` that has one (filings before ti19m have none). */
export async function filingSeqsOf(
  tx: Tx,
  tenantId: ScopedTenantContext["tenant"]["tenantId"],
  issueIds: string[],
): Promise<Map<string, number>> {
  const seqs = new Map<string, number>();
  if (issueIds.length === 0) return seqs;
  const rows = await tx
    .select({
      key: paymentAdminIdempotency.key,
      response: paymentAdminIdempotency.response,
    })
    .from(paymentAdminIdempotency)
    .where(
      and(
        eq(paymentAdminIdempotency.tenantId, tenantId),
        inArray(
          paymentAdminIdempotency.key,
          issueIds.map((id) => orderRecoveryRefundKey(id)),
        ),
      ),
    );
  for (const row of rows) {
    const seq = filingSeqOf(row.response);
    if (seq !== null)
      seqs.set(row.key.slice(orderRecoveryRefundKey("").length), seq);
  }
  return seqs;
}

/**
 * legend-hhm5m 4: the amount of an issue's first filing, read through the
 * `refundId` of its filing response (no clock: a refile can carry an older
 * `created_at` or a lower id). A filing whose response names no row of
 * `refunds` (old data) takes the smallest amount of them: a refile repeats
 * the amount, and when in doubt the smaller one is paid.
 */
async function firstFiledAmountOf(
  tx: Tx,
  tenantId: ScopedTenantContext["tenant"]["tenantId"],
  issueId: string,
  refunds: readonly { id: string; amountIdr: number }[],
): Promise<number> {
  const [filing] = await tx
    .select({ response: paymentAdminIdempotency.response })
    .from(paymentAdminIdempotency)
    .where(
      and(
        eq(paymentAdminIdempotency.tenantId, tenantId),
        eq(paymentAdminIdempotency.key, orderRecoveryRefundKey(issueId)),
      ),
    );
  const refundId = (
    filing?.response as { refundId?: unknown } | null | undefined
  )?.refundId;
  const first = refunds.find((row) => row.id === refundId);
  return first !== undefined
    ? first.amountIdr
    : Math.min(...refunds.map((row) => row.amountIdr));
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
 * by its `filingSeq` (legend-ti19m, assigned under the intent lock), the highest
 * wins; filings without a seq (old data) rank below, ordered by the time of
 * their first refund row, the id breaking a tie. It is a source only
 * when its refund ended in a final failure that is not `rejected`
 * (`refund_rejected_at` set, every refund row `failed`, none `rejected`;
 * legend-hhm5m 4: no clock) and its `order.refunded` (`payload.refundId` =
 * its id) holds a split that adds up to its first filing's amount. A
 * `rejected` refund among its rows answers `REPLAY_REJECTED`: the
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
  // Per issue: its refund rows (first filing and refiles) and the time of its
  // first refund row (its filing order of the old data).
  const rowsOf = new Map<string, (typeof refunds)[number][]>();
  const firstFiledAt = new Map<string, number>();
  for (const row of refunds) {
    if (row.orderIssueId === null) continue;
    rowsOf.set(row.orderIssueId, [
      ...(rowsOf.get(row.orderIssueId) ?? []),
      row,
    ]);
    firstFiledAt.set(row.orderIssueId, row.createdAt.getTime());
  }
  // legend-ti19m: the predecessor is the issue with the highest `filingSeq`
  // (set under the intent lock, so monotone; `created_at` is not: a host clock
  // that went back or a tie would pick the wrong one). A filing from before
  // the seq has none and ranks below every filing that has one (it is older by
  // construction: new filings always get a seq); among those the old order
  // stays: first refund `created_at`, then the id.
  const seqs = await filingSeqsOf(
    tx,
    tenantId,
    others.map((row) => row.id),
  );
  const previous = others
    .filter((row) => rowsOf.has(row.id))
    .sort(
      (a, b) =>
        (seqs.get(b.id) ?? 0) - (seqs.get(a.id) ?? 0) ||
        (firstFiledAt.get(b.id) ?? 0) - (firstFiledAt.get(a.id) ?? 0) ||
        (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
    )[0];
  if (previous === undefined) return null;
  // legend-hhm5m 4: no clock. The refunds of the predecessor (its first filing
  // and every refile) decide as a set: one still live -> no replay; else one
  // `rejected` -> nothing owed (a rejected refund is never refiled, so it ends
  // the chain whatever its `created_at` or id); else the final failure is
  // replayed for the amount of the first filing (`refundId` of its filing).
  const previousRefunds = rowsOf.get(previous.id) ?? [];
  if (
    previous.refundRejectedAt === null ||
    previousRefunds.some((row) => row.status !== "failed")
  )
    return null;
  if (previousRefunds.some((row) => row.failureReason === "rejected"))
    return REPLAY_REJECTED;
  const firstFiledAmount = await firstFiledAmountOf(
    tx,
    tenantId,
    previous.id,
    previousRefunds,
  );
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
    let amountIdr = firstFiledAmount;
    if (!isRoot) {
      const rootRefunds = await tx
        .select({
          id: paymentRefunds.id,
          amountIdr: paymentRefunds.amountIdr,
        })
        .from(paymentRefunds)
        .where(
          and(
            eq(paymentRefunds.tenantId, tenantId),
            eq(paymentRefunds.orderIssueId, rootId),
          ),
        );
      if (rootRefunds.length === 0) return null;
      amountIdr = await firstFiledAmountOf(tx, tenantId, rootId, rootRefunds);
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
  const amountIdr = isRoot ? firstFiledAmount : part("amountIdr");
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

// legend-5g9sn (founder rule Q25, 11 Nov 2026): what an order has already given
// back to the guest, per order and per original line, read without any lock.
// Vouchers + POS refunds + live recovery refunds never exceed what the guest
// paid for the order, nor for one item. This is the ONE source every payout
// path reads (architect Q25 review): the POS refund (`refundPosOrder`, under
// its order lock), the recovery voucher room and swap credit, and the
// recovery refund consumer (order lock taken by the caller). No issue lock is
// taken here: the voucher side locks issue then order, so locking an issue
// from the POS side (order first) would deadlock.
//
// - Vouchers: every apology voucher of an issue of the order, reached through
//   `order_issues.voucher_id` or `apology_vouchers.order_issue_id`, each once.
// - POS refunds: every `pos_order_refunds` row of the order.
// - Recovery refunds: per issue, the largest refund while the issue still has a
//   live one (same rule as `recoveryReleasedOf`).
// - Paid: the captured tenders of a POS order; otherwise the order total less
//   the deposit applied, plus the dearer-swap charges the guest paid.
// - Per line (Q25 is per item): the vouchers and live recovery refunds of the
//   issues of each ORIGINAL line, a replacement line mapped back to the line it
//   replaced through the swap chain (`originalOf`), plus its part of the POS
//   refunds that named items (each row split over its items by value, the
//   last item taking the rest). A POS refund naming no item counts for the
//   order only.

import { and, eq, sql } from "drizzle-orm";
import {
  ulidToUuid,
  uuidToUlid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { posOrderRefunds } from "../db/schema/pos-order.ts";
import { orderItems } from "../db/schema/qr-order.ts";
import type { Tx } from "./permission-resolver.ts";

export type OrderGiven = {
  /** What the guest paid for the order (see the header). */
  paidIdr: number;
  vouchersIdr: number;
  posRefundsIdr: number;
  recoveryRefundsIdr: number;
  /** vouchers + POS refunds + recovery refunds. */
  givenIdr: number;
  /**
   * Original line id -> vouchers + live recovery refunds of its issues + its
   * part of the POS refunds that named items.
   */
  lineGivenIdr: Map<string, number>;
  /** Original line id -> vouchers + live recovery refunds of its issues only. */
  lineRecoveryGivenIdr: Map<string, number>;
  /** Per issue: its original line and its vouchers + live recovery refund. */
  issueGiven: Map<string, { lineId: string; givenIdr: number }>;
  /** Maps a line (a replacement too) to the original line of its swap chain. */
  toOriginal: (lineId: string) => string;
};

/**
 * What the original line of `lineId` already gave back, other than through
 * `exceptIssueId` (the issue being settled: a replayed consumer must not count
 * its own refund).
 */
export function lineGivenOf(
  given: Pick<OrderGiven, "lineGivenIdr" | "issueGiven" | "toOriginal">,
  lineId: string,
  exceptIssueId?: string,
): number {
  const line = given.toOriginal(lineId);
  const own =
    exceptIssueId === undefined
      ? undefined
      : given.issueGiven.get(exceptIssueId);
  return Math.max(
    0,
    (given.lineGivenIdr.get(line) ?? 0) -
      (own !== undefined && own.lineId === line ? own.givenIdr : 0),
  );
}

/** What the order still leaves for `exceptIssueId` (never below Rp0). */
export function orderRoomOf(
  given: Pick<OrderGiven, "paidIdr" | "givenIdr" | "issueGiven">,
  exceptIssueId?: string,
): number {
  const own =
    exceptIssueId === undefined
      ? 0
      : (given.issueGiven.get(exceptIssueId)?.givenIdr ?? 0);
  return Math.max(0, given.paidIdr - (given.givenIdr - own));
}

export async function orderGivenOf(
  tx: Tx,
  tenantId: ScopedTenantContext["tenant"]["tenantId"],
  orderId: string,
): Promise<OrderGiven> {
  const orderUuid = ulidToUuid(orderId);
  const result = await tx.execute(sql`
    WITH issues AS (
      SELECT i.id, i.voucher_id
        FROM order_issues i
       WHERE i.tenant_id = ${tenantId} AND i.order_id = ${orderUuid}::uuid
    )
    SELECT
      (SELECT coalesce(sum(v.value_idr), 0)
         FROM apology_vouchers a
         JOIN vouchers v ON v.tenant_id = a.tenant_id AND v.id = a.voucher_id
        WHERE a.tenant_id = ${tenantId}
          AND (a.id IN (SELECT voucher_id FROM issues WHERE voucher_id IS NOT NULL)
               OR a.order_issue_id IN (SELECT id FROM issues)))::text AS vouchers,
      (SELECT coalesce(sum(r.amount_idr), 0)
         FROM pos_order_refunds r
        WHERE r.tenant_id = ${tenantId}
          AND r.order_id = ${orderUuid}::uuid)::text AS pos_refunds,
      (SELECT coalesce(sum(m.amt), 0)
         FROM (SELECT max(r.amount_idr) AS amt
                 FROM payment_refunds r
                WHERE r.tenant_id = ${tenantId}
                  AND r.order_issue_id IN (SELECT id FROM issues)
                GROUP BY r.order_issue_id
               HAVING coalesce(bool_or(r.status <> 'failed'), false)) m)::text AS recovery_refunds,
      (CASE
         WHEN EXISTS (SELECT 1 FROM pos_orders p
                       WHERE p.tenant_id = ${tenantId}
                         AND p.order_id = ${orderUuid}::uuid)
         THEN (SELECT coalesce(sum(t.amount_idr), 0)
                 FROM pos_order_tenders t
                WHERE t.tenant_id = ${tenantId}
                  AND t.order_id = ${orderUuid}::uuid
                  AND t.status = 'captured')
         ELSE (SELECT coalesce(max(o.total_idr - o.deposit_applied_idr), 0)
                 FROM orders o
                WHERE o.tenant_id = ${tenantId} AND o.id = ${orderUuid}::uuid)
            + (SELECT coalesce(sum(c.amount_idr), 0)
                 FROM order_issue_charges c
                WHERE c.tenant_id = ${tenantId}
                  AND c.order_id = ${orderUuid}::uuid
                  AND c.status = 'paid')
       END)::text AS paid
  `);
  const perIssue = await tx.execute(sql`
    SELECT i.id::text AS id,
           i.order_item_id::text AS item,
           i.replacement_order_item_id::text AS replacement,
           (SELECT coalesce(sum(v.value_idr), 0)
              FROM apology_vouchers a
              JOIN vouchers v ON v.tenant_id = a.tenant_id AND v.id = a.voucher_id
             WHERE a.tenant_id = i.tenant_id
               AND (a.id = i.voucher_id OR a.order_issue_id = i.id))::text AS vouchers,
           coalesce((SELECT max(r.amount_idr)
                       FROM payment_refunds r
                      WHERE r.tenant_id = i.tenant_id AND r.order_issue_id = i.id
                     HAVING coalesce(bool_or(r.status <> 'failed'), false)), 0)::text AS refunds
      FROM order_issues i
     WHERE i.tenant_id = ${tenantId} AND i.order_id = ${orderUuid}::uuid
  `);
  const row = result.rows[0];
  const read = (value: unknown) => Number(String(value ?? "0"));
  const originalOf = new Map<string, string>();
  for (const issue of perIssue.rows)
    if (issue.replacement !== null && issue.replacement !== undefined)
      originalOf.set(
        uuidToUlid(String(issue.replacement)),
        uuidToUlid(String(issue.item)),
      );
  const toOriginal = (lineId: string) => {
    let id = lineId;
    for (let hop = 0; hop <= originalOf.size; hop++) {
      const original = originalOf.get(id);
      if (original === undefined) break;
      id = original;
    }
    return id;
  };
  const lineGivenIdr = new Map<string, number>();
  const lineRecoveryGivenIdr = new Map<string, number>();
  const issueGiven = new Map<string, { lineId: string; givenIdr: number }>();
  const add = (map: Map<string, number>, line: string, amount: number) =>
    map.set(line, (map.get(line) ?? 0) + amount);
  for (const issue of perIssue.rows) {
    const line = toOriginal(uuidToUlid(String(issue.item)));
    const amount = read(issue.vouchers) + read(issue.refunds);
    issueGiven.set(String(issue.id), { lineId: line, givenIdr: amount });
    add(lineGivenIdr, line, amount);
    add(lineRecoveryGivenIdr, line, amount);
  }
  // The POS refunds that named items, split over them by value.
  const posRefunds = await tx
    .select({
      amountIdr: posOrderRefunds.amountIdr,
      items: posOrderRefunds.items,
    })
    .from(posOrderRefunds)
    .where(
      and(
        eq(posOrderRefunds.tenantId, tenantId),
        eq(posOrderRefunds.orderId, orderId),
      ),
    );
  if (posRefunds.some((row) => row.items.length > 0)) {
    const lines = await tx
      .select({
        id: orderItems.id,
        quantity: orderItems.quantity,
        lineTotalIdr: orderItems.lineTotalIdr,
      })
      .from(orderItems)
      .where(
        and(eq(orderItems.tenantId, tenantId), eq(orderItems.orderId, orderId)),
      );
    const byId = new Map(lines.map((item) => [item.id as string, item]));
    const valueOf = (itemId: string, quantity: number) => {
      const item = byId.get(itemId);
      return item && item.quantity > 0
        ? (Number(item.lineTotalIdr) * quantity) / item.quantity
        : 0;
    };
    for (const row of posRefunds) {
      if (row.items.length === 0) continue;
      const weights = row.items.map((entry) =>
        valueOf(entry.itemId, entry.quantity),
      );
      const total = weights.reduce((sum, weight) => sum + weight, 0);
      const amount = Number(row.amountIdr);
      let left = amount;
      row.items.forEach((entry, index) => {
        const share =
          index === row.items.length - 1
            ? left
            : total > 0
              ? Math.floor((amount * weights[index]!) / total)
              : 0;
        left -= share;
        add(lineGivenIdr, toOriginal(entry.itemId), share);
      });
    }
  }
  const vouchersIdr = read(row?.vouchers);
  const posRefundsIdr = read(row?.pos_refunds);
  const recoveryRefundsIdr = read(row?.recovery_refunds);
  return {
    paidIdr: read(row?.paid),
    vouchersIdr,
    posRefundsIdr,
    recoveryRefundsIdr,
    givenIdr: vouchersIdr + posRefundsIdr + recoveryRefundsIdr,
    lineGivenIdr,
    lineRecoveryGivenIdr,
    issueGiven,
    toOriginal,
  };
}

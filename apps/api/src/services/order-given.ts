// legend-5g9sn (founder rule Q25, 11 Nov 2026): what an order has already given
// back to the guest, at order level, read without any lock. Vouchers + POS
// refunds + live recovery refunds never exceed what the guest paid for the
// order. Callers: the POS refund (`refundPosOrder`) and `voucherRoomIdr`
// (order-voucher-room.ts, the voucher side); both read it under the order
// lock. No issue lock is taken here: the voucher side locks issue then order,
// so locking an issue from the POS side (order first) would deadlock.
//
// - Vouchers: every apology voucher of an issue of the order, reached through
//   `order_issues.voucher_id` or `apology_vouchers.order_issue_id`, each once.
// - POS refunds: every `pos_order_refunds` row of the order.
// - Recovery refunds: per issue, the largest refund while the issue still has a
//   live one (same rule as `recoveryReleasedOf`).
// - Paid: the captured tenders of a POS order; otherwise the order total less
//   the deposit applied, plus the dearer-swap charges the guest paid, each less
//   what was already refunded of it (payment refunds of its intent that are not
//   failed, manual refunds that are not rejected).
// - Per line (Q25 is per item): the vouchers and live recovery refunds of the
//   issues of each ORIGINAL line, a replacement line mapped back to the line it
//   replaced through the swap chain (`originalOf`).

import { sql } from "drizzle-orm";
import {
  ulidToUuid,
  uuidToUlid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type { Tx } from "./permission-resolver.ts";

export type OrderGiven = {
  /** What the guest paid for the order (see the header). */
  paidIdr: number;
  vouchersIdr: number;
  posRefundsIdr: number;
  recoveryRefundsIdr: number;
  /** Dearer-swap charges of the order still unpaid (open or routed to the till). */
  openChargesCount: number;
  /** vouchers + POS refunds + recovery refunds. */
  givenIdr: number;
  /** Original line id -> vouchers + live recovery refunds of its issues. */
  lineGivenIdr: Map<string, number>;
  /** Maps a line (a replacement too) to the original line of its swap chain. */
  toOriginal: (lineId: string) => string;
};

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
            + (SELECT coalesce(sum(greatest(0, c.amount_idr
                      - coalesce((SELECT sum(r.amount_idr)
                                    FROM payment_refunds r
                                   WHERE r.tenant_id = c.tenant_id
                                     AND r.payment_intent_id = c.payment_intent_id
                                     AND r.status <> 'failed'), 0)
                      - coalesce((SELECT sum(m.amount_idr)
                                    FROM order_issue_charge_manual_refunds m
                                   WHERE m.tenant_id = c.tenant_id
                                     AND m.charge_id = c.id
                                     AND m.status <> 'rejected'), 0))), 0)
                 FROM order_issue_charges c
                WHERE c.tenant_id = ${tenantId}
                  AND c.order_id = ${orderUuid}::uuid
                  AND c.status = 'paid')
       END)::text AS paid,
      (SELECT count(*)
         FROM order_issue_charges c
        WHERE c.tenant_id = ${tenantId}
          AND c.order_id = ${orderUuid}::uuid
          AND c.status IN ('open', 'routed_pos'))::text AS open_charges
  `);
  const perIssue = await tx.execute(sql`
    SELECT i.order_item_id::text AS item,
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
  for (const issue of perIssue.rows) {
    const line = toOriginal(uuidToUlid(String(issue.item)));
    lineGivenIdr.set(
      line,
      (lineGivenIdr.get(line) ?? 0) +
        read(issue.vouchers) +
        read(issue.refunds),
    );
  }
  const vouchersIdr = read(row?.vouchers);
  const posRefundsIdr = read(row?.pos_refunds);
  const recoveryRefundsIdr = read(row?.recovery_refunds);
  return {
    paidIdr: read(row?.paid),
    vouchersIdr,
    posRefundsIdr,
    recoveryRefundsIdr,
    openChargesCount: read(row?.open_charges),
    givenIdr: vouchersIdr + posRefundsIdr + recoveryRefundsIdr,
    lineGivenIdr,
    toOriginal,
  };
}

type LineItem = {
  id: string;
  quantity: number;
  lineTotalIdr: number | string | bigint;
};
type RefundRowLike = {
  amountIdr: number;
  items: readonly { itemId: string; quantity: number }[];
};

/**
 * legend-5g9sn (Q25 per item): what the lines named by a POS refund still
 * hold. Per original line (a replacement maps back through the swap chain):
 * its share of the bill (line total x total / subtotal, floor) less the
 * vouchers and live recovery refunds of its issues and its part of the earlier
 * POS refunds that named items (each row split over its items by value, the
 * last item taking the rest). Rows without items are covered by the order room.
 */
export function lineRoomIdr(
  order: { totalIdr: number; subtotalIdr: number },
  items: readonly LineItem[],
  refunds: readonly RefundRowLike[],
  given: Pick<OrderGiven, "lineGivenIdr" | "toOriginal">,
  requested: readonly { itemId: string }[],
): number {
  const byId = new Map(items.map((item) => [item.id as string, item]));
  const valueOf = (itemId: string, quantity: number) => {
    const item = byId.get(itemId);
    return item && item.quantity > 0
      ? (Number(item.lineTotalIdr) * quantity) / item.quantity
      : 0;
  };
  const priorPos = new Map<string, number>();
  for (const row of refunds) {
    if (row.items.length === 0) continue;
    const weights = row.items.map((entry) =>
      valueOf(entry.itemId, entry.quantity),
    );
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let left = Number(row.amountIdr);
    row.items.forEach((entry, index) => {
      const share =
        index === row.items.length - 1
          ? left
          : total > 0
            ? Math.floor((row.amountIdr * weights[index]!) / total)
            : 0;
      left -= share;
      const line = given.toOriginal(entry.itemId);
      priorPos.set(line, (priorPos.get(line) ?? 0) + share);
    });
  }
  const lines = new Set(
    requested.map((entry) => given.toOriginal(entry.itemId)),
  );
  let room = 0;
  for (const line of lines) {
    const item = byId.get(line);
    const paid =
      item && order.subtotalIdr > 0
        ? Number(
            (BigInt(item.lineTotalIdr) * BigInt(order.totalIdr)) /
              BigInt(order.subtotalIdr),
          )
        : 0;
    room += Math.max(
      0,
      paid - (given.lineGivenIdr.get(line) ?? 0) - (priorPos.get(line) ?? 0),
    );
  }
  return room;
}

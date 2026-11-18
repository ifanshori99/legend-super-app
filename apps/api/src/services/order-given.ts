// legend-5g9sn (founder rule Q25, 11 Nov 2026): what an order has already given
// back to the guest, at order level, read without any lock. Vouchers + POS
// refunds + live recovery refunds never exceed what the guest paid for the
// order. Callers: the POS refund (`refundPosOrder`) and `voucherRoomIdr`
// (order-voucher-room.ts, the voucher side); both read it under the order
// lock. No issue lock is taken here: the voucher side locks issue then order,
// so locking an issue from the POS side (order first) would deadlock.
//
// - Vouchers: every apology voucher of an issue of the order, reached through
//   `order_issues.voucher_id` or `apology_vouchers.order_issue_id`, and any CRM
//   voucher a report stored directly in `order_issues.voucher_id` (report-time
//   resolution, legend-eajpb), each voucher once.
// - POS refunds: every `pos_order_refunds` row of the order.
// - Recovery refunds: per issue, the largest refund while the issue still has a
//   live one (same rule as `recoveryReleasedOf`).
// - Paid (1116, restrictive: when in doubt, count less): money the guest
//   finally paid, less what went back through the provider.
//   * POS order: the captured tenders, a points tender left out (not money,
//     936). A tender backed by an intent counts net of the provider's own
//     refunds (`providerRefundedForeignIdrSql`, excessOffBill false) and of our
//     gateway refunds of the intent (`payment_refunds`, not failed) that are
//     not counted elsewhere. An intent flagged `provider_refunded_at` or
//     `provider_refunded_after_paid_at` counts 0 (no sure amount; same rule as
//     `manualRefundAmountIdr`).
//   * Otherwise: the intents of the order (linked by `orders.payment_link_id`,
//     unique per order, `orders.payment_intent_id`, or `payment_intents.order_id`;
//     the real insert leaves `order_id` empty), each at most what it put toward
//     the bill (evidence less unallocated funds: a parked double payment is
//     not the bill's), that ended paid (`paid`,
//     `partially_refunded`, `refunded` with `paid_at`; pending, expired and
//     failed count 0), net as above, at most the order total less the deposit
//     applied; plus the dearer-swap charges the guest paid, each less what was
//     already refunded of it (payment refunds of its intent that are not
//     failed, manual refunds that are not rejected). A swap charge intent is
//     not counted twice as an order intent.
//   * Refunds not subtracted from an intent because they are counted elsewhere:
//     the recovery refunds of the order's issues (`recovery_refunds`, the
//     largest per issue; a further live refund of the same issue is
//     subtracted from paid) and the gateway part of a POS refund (a
//     `system:pos` `payment_refunds` row filed under the idempotency key
//     `pos-refund-gateway:<pos_order_refunds.id>:<intent>`, already inside
//     `pos_refunds`). No column links the two tables; the key row's
//     `response.refundId` is the only link. Not matched = counted (restrictive).
//   * Open refund holds (`refund_recon_holds`) are not on this branch yet.
// - Per line (Q25 is per item): the vouchers and live recovery refunds of the
//   issues of each ORIGINAL line, a replacement line mapped back to the line it
//   replaced through the swap chain (`originalOf`).

import { sql } from "drizzle-orm";
import {
  ulidToUuid,
  uuidToUlid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { providerRefundedForeignIdrSql } from "./payment-provider-refunded-foreign-sql.ts";
import { HttpError } from "../lib/http-error.ts";
import type { Tx } from "./permission-resolver.ts";

// 1116: the provider answered "refunded" with no sure amount -> count the
// intent as 0 (fail closed). `alias` is the payment_intents alias.
const flagged = (alias: string) =>
  sql.raw(
    `(${alias}.provider_refunded_at IS NOT NULL OR ${alias}.provider_refunded_after_paid_at IS NOT NULL)`,
  );

// 1127: parked-money rule, stated once. Money the guest sent that is not the
// bill's (parked) is neither paid nor subtracted from paid; the two sides below
// must stay symmetric:
// - Overpayment: the part of an intent parked as a `payment_unallocated_funds`
//   row is left out of paid by `allocated()`, and a refund of it
//   (`payment_refunds.unallocated_fund_id`) is not subtracted in `ownRefunds`.
// - Late payment (the order was already expired or voided when the guest paid):
//   an intent with a late-payment request key (`latePaid`) counts 0 paid, and
//   the refund filed by that request is not subtracted in `ownRefunds`. Key
//   prefixes follow LATE_PAYMENT_REFUND_KEY_PREFIXES (payment-refund.service.ts).
const LATE_PAYMENT_KEY_PREFIXES = [
  "pos-late-payment-refund:",
  "qr-late-payment-refund:",
  "facility-breakfast-refund:late:",
  "fb-refile:late:",
];

// 1127: the intent was paid late (see the parked-money rule above): its key row
// is `<prefix><intent id>` or `<prefix><intent id>:<failed refund id>`, matched
// exactly, never by a loose prefix. `alias` is the payment_intents alias.
const latePaid = (alias: string) =>
  sql.raw(
    `EXISTS (SELECT 1 FROM payment_admin_idempotency pk
              WHERE pk.tenant_id = ${alias}.tenant_id
                AND (${LATE_PAYMENT_KEY_PREFIXES.map(
                  (prefix) =>
                    `pk.key = '${prefix}' || ${alias}.id::text OR pk.key LIKE '${prefix}' || ${alias}.id::text || ':%'`,
                ).join(" OR ")}))`,
  );

// 1116: our own gateway refunds of the intent (not failed) that no other part
// of `OrderGiven` counts: not a recovery refund of an issue of this order
// (`recovery_refunds`), not the gateway part of a POS refund of this order
// (`pos_refunds`). Needs the `issues` CTE of `orderGivenOf`.
const ownRefunds = (alias: string, orderUuid: string) =>
  sql`coalesce((SELECT sum(r.amount_idr)
      FROM payment_refunds r
     WHERE r.tenant_id = ${sql.raw(alias)}.tenant_id
       AND r.payment_intent_id = ${sql.raw(alias)}.id
       AND r.status <> 'failed'
       -- a refund of parked money (an overpayment fund, a late payment) is not
       -- the bill's money (refundableBalance leaves it out the same way); see
       -- the parked-money rule above
       AND r.unallocated_fund_id IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM payment_admin_idempotency lk
          WHERE lk.tenant_id = r.tenant_id
            AND lk.response ->> 'refundId' = r.id::text
            AND (${sql.raw(LATE_PAYMENT_KEY_PREFIXES.map((prefix) => `lk.key LIKE '${prefix}%'`).join(" OR "))}))
       AND (r.order_issue_id IS NULL
            OR NOT EXISTS (SELECT 1 FROM issues x WHERE x.id = r.order_issue_id))
       AND NOT EXISTS (
         SELECT 1
           FROM payment_admin_idempotency k
           JOIN pos_order_refunds por
             ON k.key = 'pos-refund-gateway:' || por.id::text || ':' || r.payment_intent_id::text
          WHERE k.tenant_id = r.tenant_id
            AND por.tenant_id = r.tenant_id
            AND por.order_id = ${orderUuid}::uuid
            AND k.response ->> 'refundId' = r.id::text)), 0)`;

// 1116 (architect P2-1): what the intent put toward its bill, at most its
// amount: the provider evidence less the part parked as unallocated funds (a
// second payment of a settled bill is `paid` but its money is parked, not
// the bill's). `alias` is the payment_intents alias.
const allocated = (alias: string) => {
  const a = sql.raw(alias);
  return sql`least(${a}.amount_idr, greatest(0,
      coalesce((SELECT sum(e.amount_idr) FROM payment_evidence e
                 WHERE e.tenant_id = ${a}.tenant_id
                   AND e.payment_intent_id = ${a}.id), 0)
      - coalesce((SELECT sum(f.amount_idr) FROM payment_unallocated_funds f
                   WHERE f.tenant_id = ${a}.tenant_id
                     AND f.payment_intent_id = ${a}.id), 0)))`;
};

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
         FROM vouchers v
        WHERE v.tenant_id = ${tenantId}
          AND v.id IN (
                SELECT a.voucher_id
                  FROM apology_vouchers a
                 WHERE a.tenant_id = ${tenantId}
                   AND (a.id IN (SELECT voucher_id FROM issues WHERE voucher_id IS NOT NULL)
                        OR a.order_issue_id IN (SELECT id FROM issues))
                UNION
                SELECT voucher_id FROM issues WHERE voucher_id IS NOT NULL))::text AS vouchers,
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
         THEN (SELECT coalesce(sum(CASE
                  WHEN s.payment_intent_id IS NULL THEN s.amount
                  WHEN i.id IS NULL THEN 0
                  WHEN ${flagged("i")} OR ${latePaid("i")} THEN 0
                  ELSE greatest(0, s.amount
                         - ${providerRefundedForeignIdrSql(sql`${tenantId}::uuid`, sql`i.id`, undefined, false)}
                         - ${ownRefunds("i", orderUuid)}) END), 0)
                 FROM (SELECT t.payment_intent_id, sum(t.amount_idr) AS amount
                         FROM pos_order_tenders t
                        WHERE t.tenant_id = ${tenantId}
                          AND t.order_id = ${orderUuid}::uuid
                          AND t.status = 'captured'
                          AND t.method <> 'points'
                        GROUP BY t.payment_intent_id) s
                 LEFT JOIN payment_intents i
                   ON i.tenant_id = ${tenantId} AND i.id = s.payment_intent_id)
         ELSE greatest(0, least(
                (SELECT coalesce(max(o.total_idr - o.deposit_applied_idr), 0)
                   FROM orders o
                  WHERE o.tenant_id = ${tenantId} AND o.id = ${orderUuid}::uuid),
                (SELECT coalesce(sum(CASE
                          WHEN ${flagged("i")} OR ${latePaid("i")} THEN 0
                          ELSE greatest(0, ${allocated("i")}
                                 - ${providerRefundedForeignIdrSql(sql`${tenantId}::uuid`, sql`i.id`, undefined, false)}
                                 - ${ownRefunds("i", orderUuid)}) END), 0)
                   FROM payment_intents i
                  WHERE i.tenant_id = ${tenantId}
                    AND (i.order_id = ${orderUuid}::uuid
                         OR EXISTS (SELECT 1 FROM orders lo
                                     WHERE lo.tenant_id = i.tenant_id
                                       AND lo.id = ${orderUuid}::uuid
                                       AND (lo.payment_intent_id = i.id
                                            OR lo.payment_link_id = i.payment_link_id)))
                    AND i.status IN ('paid', 'partially_refunded', 'refunded')
                    AND i.paid_at IS NOT NULL
                    AND NOT EXISTS (SELECT 1 FROM order_issue_charges c
                                     WHERE c.tenant_id = i.tenant_id
                                       AND c.payment_intent_id = i.id)))
            - (SELECT coalesce(sum(greatest(0, e.live - e.largest)), 0)
                 FROM (SELECT sum(r.amount_idr) FILTER (WHERE r.status <> 'failed') AS live,
                              max(r.amount_idr) AS largest
                         FROM payment_refunds r
                        WHERE r.tenant_id = ${tenantId}
                          AND r.order_issue_id IN (SELECT id FROM issues)
                        GROUP BY r.order_issue_id) e))
            + (SELECT coalesce(sum(CASE
                      WHEN c.payment_intent_id IS NOT NULL
                           AND (ci.id IS NULL OR ${flagged("ci")} OR ${latePaid("ci")}) THEN 0
                      ELSE greatest(0, CASE WHEN ci.id IS NULL THEN c.amount_idr
                                            ELSE least(c.amount_idr, ${allocated("ci")})
                                                 - ${providerRefundedForeignIdrSql(sql`${tenantId}::uuid`, sql`ci.id`, undefined, false)} END
                      - coalesce((SELECT sum(r.amount_idr)
                                    FROM payment_refunds r
                                   WHERE r.tenant_id = c.tenant_id
                                     AND r.payment_intent_id = c.payment_intent_id
                                     AND r.status <> 'failed'), 0)
                      - coalesce((SELECT sum(m.amount_idr)
                                    FROM order_issue_charge_manual_refunds m
                                   WHERE m.tenant_id = c.tenant_id
                                     AND m.charge_id = c.id
                                     AND m.status <> 'rejected'), 0)) END), 0)
                 FROM order_issue_charges c
                 LEFT JOIN payment_intents ci
                   ON ci.tenant_id = c.tenant_id AND ci.id = c.payment_intent_id
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
              FROM vouchers v
             WHERE v.tenant_id = i.tenant_id
               AND v.id IN (
                     SELECT a.voucher_id
                       FROM apology_vouchers a
                      WHERE a.tenant_id = i.tenant_id
                        AND (a.id = i.voucher_id OR a.order_issue_id = i.id)
                     UNION
                     SELECT i.voucher_id WHERE i.voucher_id IS NOT NULL))::text AS vouchers,
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

/**
 * 1116 (SO 1114 P1): a POS void pays the whole bill back, so it is refused
 * when any money of the order's tenders already went back through the
 * provider: its own refunds, our gateway refunds not filed by a POS refund, or
 * an intent flagged refunded with no sure amount (`orderGivenOf().paidIdr`
 * counts all of those off the non-points captured tenders). The caller holds
 * the order lock.
 */
export async function assertNothingBackThroughProvider(
  tx: Tx,
  context: ScopedTenantContext,
  orderId: string,
): Promise<void> {
  const tenantId = context.tenant.tenantId;
  const tenders = await tx.execute(sql`
    SELECT coalesce(sum(t.amount_idr), 0)::text AS amount
      FROM pos_order_tenders t
     WHERE t.tenant_id = ${tenantId}
       AND t.order_id = ${ulidToUuid(orderId)}::uuid
       AND t.status = 'captured'
       AND t.method <> 'points'
  `);
  const nonPointsPaid = Number(String(tenders.rows[0]?.amount ?? "0"));
  const given = await orderGivenOf(tx, tenantId, orderId);
  if (given.paidIdr < nonPointsPaid)
    throw new HttpError(
      409,
      "VOID_PROVIDER_REFUNDED",
      "Sebagian pembayaran pesanan ini sudah dikembalikan lewat penyedia pembayaran; tidak bisa di-void. Hubungi finance.",
    );
}

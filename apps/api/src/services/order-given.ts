// legend-5g9sn (founder rule Q25, 11 Nov 2026): what an order has already given
// back to the guest, at order level, read without any lock. Vouchers + POS
// refunds + live recovery refunds never exceed what the guest paid for the
// order. The POS refund (`refundPosOrder`) reads it under its order lock; the
// recovery voucher room clamps to it (order lock taken by the caller). No issue
// lock is taken here: the voucher side locks issue then order, so locking an
// issue from the POS side (order first) would deadlock.
//
// - Vouchers: every apology voucher of an issue of the order, reached through
//   `order_issues.voucher_id` or `apology_vouchers.order_issue_id`, each once.
// - POS refunds: every `pos_order_refunds` row of the order.
// - Recovery refunds: per issue, the largest refund while the issue still has a
//   live one (same rule as `recoveryReleasedOf`).
// - Paid: the captured tenders of a POS order; otherwise the order total less
//   the deposit applied, plus the dearer-swap charges the guest paid.

import { sql } from "drizzle-orm";
import { ulidToUuid, type ScopedTenantContext } from "@starter/shared/core";
import type { Tx } from "./permission-resolver.ts";

export type OrderGiven = {
  /** What the guest paid for the order (see the header). */
  paidIdr: number;
  vouchersIdr: number;
  posRefundsIdr: number;
  recoveryRefundsIdr: number;
  /** vouchers + POS refunds + recovery refunds. */
  givenIdr: number;
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
            + (SELECT coalesce(sum(c.amount_idr), 0)
                 FROM order_issue_charges c
                WHERE c.tenant_id = ${tenantId}
                  AND c.order_id = ${orderUuid}::uuid
                  AND c.status = 'paid')
       END)::text AS paid
  `);
  const row = result.rows[0];
  const read = (value: unknown) => Number(String(value ?? "0"));
  const vouchersIdr = read(row?.vouchers);
  const posRefundsIdr = read(row?.pos_refunds);
  const recoveryRefundsIdr = read(row?.recovery_refunds);
  return {
    paidIdr: read(row?.paid),
    vouchersIdr,
    posRefundsIdr,
    recoveryRefundsIdr,
    givenIdr: vouchersIdr + posRefundsIdr + recoveryRefundsIdr,
  };
}

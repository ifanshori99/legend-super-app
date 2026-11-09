// POS tenders of a payment intent, net of what POS refunds gave back
// (legend-hxpd5, legend-060xt). One SQL builder for the refund guard
// (payment-admin.service.ts posSaleInUseOfIntent: what a sale still holds) and
// the payout check (accounting-auto-journal-guards.ts intentBackedAt: what the
// intent's receipt still backs), so the two never disagree on attribution.
//
// Per order and tender method:
// - on_intent: the tenders paid by the intent; on_method: every tender of
//   that method on the order;
// - returned: what POS refund lines (pos_order_refunds.lines) of that order
//   gave back for that method.
// A POS refund line written since legend-186 names its tender (`tenderId`)
// and that tender's intent (`paymentIntentId`), legend-9z1vm. Such a line
// gives the intent back its amount (allocated) only when the tender is one of
// the intent's tenders on that order and method and the line names this
// intent; any other tender line gives nothing (fail closed). A legacy line
// (no `tenderId`) names a method, not a tender; for those (returned) the
// intent gets back:
// - its whole on_intent when the refunds returned the whole method (total:
//   legacy lines plus tender lines naming a counted tender of that order and
//   method with that tender's own intent; the writer mixes both when legacy
//   rows came first);
// - least(returned, on_intent) when every tender of the method is the
//   intent's (on_intent = on_method);
// - else nothing (fail closed: the money stays attributed to the intent).
// Both add up, never above on_intent.

import { sql, type SQL } from "drizzle-orm";

/**
 * Which tenders count:
 * - held (refund guard, now): captured tenders paid by the intent, plus
 *   `authorized` tenders of an open order on the intent's payment link (a QR
 *   refresh opens a new intent on the same link without rebinding the
 *   tender; the paid webhook rebinds at capture). Voided sales
 *   (`pos_order_voids`) hold nothing. Every POS refund counts.
 * - ledger (payout / sale check at a bound): captured tenders paid by the
 *   intent (payment_intent_id) of the orders `sales` keeps; POS refunds
 *   `posRefunds` keeps. `sales` filters the `orders` table and `posRefunds`
 *   the `pos_order_refunds` table, both unaliased. The caller keeps only POS
 *   refunds whose journal posted (see posRefundsOfIntentSql).
 */
export type PosIntentTenders =
  { kind: "held" } | { kind: "ledger"; sales: SQL; posRefunds: SQL };

/**
 * A query with one row and one text column `amount`: the intent's tenders
 * less the POS refunds attributed to it (rules in the header), never below
 * 0 per order and method.
 */
export function netPosTendersOfIntentSql(
  tenantId: string,
  intentId: string,
  tenders: PosIntentTenders,
): SQL {
  const intent = sql`${intentId}::uuid`;
  const link = sql`(SELECT pi.payment_link_id FROM payment_intents pi
                     WHERE pi.tenant_id = ${tenantId} AND pi.id = ${intent})`;
  // A tender row of the intent (alias t or u).
  const ofIntent = (t: "t" | "u") => {
    const col = (name: string) => sql.raw(`${t}.${name}`);
    const captured = sql`${col("status")} = 'captured' AND ${col("payment_intent_id")} = ${intent}`;
    if (tenders.kind === "ledger") return sql`(${captured})`;
    // legend-060xt: an authorized tender may still name an earlier intent of
    // its link. Its own intent id also counts (fail closed).
    return sql`((${captured})
      OR (${col("status")} = 'authorized'
          AND (${col("payment_link_id")} = ${link}
               OR ${col("payment_intent_id")} = ${intent})))`;
  };
  const counted =
    tenders.kind === "ledger"
      ? sql`t.status = 'captured' AND ${tenders.sales}`
      : sql`(t.status = 'captured'
              OR (t.status = 'authorized'
                  AND orders.status NOT IN ('completed', 'voided')))
            AND NOT EXISTS (
              SELECT 1 FROM pos_order_voids v
               WHERE v.tenant_id = ${tenantId}
                 AND v.order_id = t.order_id)`;
  const posRefunds = tenders.kind === "ledger" ? tenders.posRefunds : sql`TRUE`;
  return sql`
    WITH used AS (
      SELECT t.order_id, t.method,
             sum(t.amount_idr) FILTER (WHERE ${ofIntent("t")}) AS on_intent,
             sum(t.amount_idr) AS on_method,
             array_agg(t.id::text) FILTER (WHERE ${ofIntent("t")}) AS intent_tenders,
             array_agg(t.id::text || '/' || coalesce(t.payment_intent_id::text, ''))
               AS method_tenders
        FROM pos_order_tenders t
        JOIN orders ON orders.tenant_id = t.tenant_id AND orders.id = t.order_id
       WHERE t.tenant_id = ${tenantId}
         AND ${counted}
         AND t.order_id IN (
           SELECT u.order_id FROM pos_order_tenders u
            WHERE u.tenant_id = ${tenantId} AND ${ofIntent("u")})
       GROUP BY t.order_id, t.method
    ), refund_lines AS (
      SELECT pos_order_refunds.order_id, l.value AS line
        FROM pos_order_refunds
       CROSS JOIN LATERAL jsonb_array_elements(pos_order_refunds.lines) AS l(value)
       WHERE pos_order_refunds.tenant_id = ${tenantId}
         AND pos_order_refunds.order_id IN (SELECT order_id FROM used)
         AND ${posRefunds}
    ), returned AS (
      SELECT r.order_id, r.line->>'method' AS method,
             sum((r.line->>'amountIdr')::numeric)
               FILTER (WHERE r.line->>'tenderId' IS NULL) AS amount,
             sum((r.line->>'amountIdr')::numeric) AS total
        FROM refund_lines r
        JOIN used u ON u.order_id = r.order_id AND u.method = r.line->>'method'
       WHERE r.line->>'tenderId' IS NULL
          OR (r.line->>'tenderId') || '/' || coalesce(r.line->>'paymentIntentId', '')
             = ANY(u.method_tenders)
       GROUP BY r.order_id, r.line->>'method'
    ), allocated AS (
      SELECT r.order_id, r.line->>'method' AS method,
             sum((r.line->>'amountIdr')::numeric) AS amount
        FROM refund_lines r
        JOIN used u ON u.order_id = r.order_id AND u.method = r.line->>'method'
       WHERE r.line->>'tenderId' = ANY(u.intent_tenders)
         AND r.line->>'paymentIntentId' = ${intent}::text
       GROUP BY r.order_id, r.line->>'method'
    )
    SELECT coalesce(sum(
             u.on_intent - least(u.on_intent, coalesce(a.amount, 0) + CASE
               WHEN coalesce(f.total, 0) >= u.on_method THEN u.on_intent
               WHEN u.on_intent = u.on_method
                 THEN least(coalesce(f.amount, 0), u.on_intent)
               ELSE 0
             END)), 0)::text AS amount
      FROM used u
      LEFT JOIN returned f ON f.order_id = u.order_id AND f.method = u.method
      LEFT JOIN allocated a ON a.order_id = u.order_id AND a.method = u.method
     WHERE u.on_intent IS NOT NULL
  `;
}

/**
 * legend-hxpd5 review: the POS refunds the ledger mode may attribute to the
 * intent: refunds `posRefunds` keeps with a line whose method is that of a
 * captured tender of the intent on the same order, the order kept by `sales`
 * (same filters as the ledger mode). A line naming a tender (legend-9z1vm)
 * counts only when it names a captured tender of that order and method with
 * that tender's own intent: one of another intent gives this intent nothing
 * itself but counts toward the whole method being returned. Rows: `id`
 * (pos_order_refunds.id). The caller subtracts only those whose
 * order.refunded journal posted (the credit back to customer_deposit is
 * booked).
 */
export function posRefundsOfIntentSql(
  tenantId: string,
  intentId: string,
  filters: { sales: SQL; posRefunds: SQL },
): SQL {
  return sql`
    SELECT DISTINCT pos_order_refunds.id::text AS id
      FROM pos_order_refunds
     CROSS JOIN LATERAL jsonb_array_elements(pos_order_refunds.lines) AS l(value)
     WHERE pos_order_refunds.tenant_id = ${tenantId}
       AND ${filters.posRefunds}
       AND EXISTS (
         SELECT 1 FROM pos_order_tenders t
           JOIN orders ON orders.tenant_id = t.tenant_id AND orders.id = t.order_id
          WHERE t.tenant_id = ${tenantId}
            AND t.order_id = pos_order_refunds.order_id
            AND t.method = l.value->>'method'
            AND t.status = 'captured'
            AND t.payment_intent_id = ${intentId}::uuid
            AND ${filters.sales})
       AND (l.value->>'tenderId' IS NULL
            OR EXISTS (
              SELECT 1 FROM pos_order_tenders n
               WHERE n.tenant_id = ${tenantId}
                 AND n.order_id = pos_order_refunds.order_id
                 AND n.method = l.value->>'method'
                 AND n.status = 'captured'
                 AND n.id::text = l.value->>'tenderId'
                 AND coalesce(n.payment_intent_id::text, '')
                     = coalesce(l.value->>'paymentIntentId', '')))
  `;
}

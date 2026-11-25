// legend-aja6g (1042 F3, 1095): one money-back lane per order. A failed-item
// refund (ORD-09: a `payment_refunds` row with `order_issue_id`, status other
// than `failed`, a manual queue entry included) and a void / cashier refund of
// the same order never both pay the guest.
//
// Plain reads, no lock of their own: the caller holds the `orders` row lock
// (FOR UPDATE) in the same transaction, so two racing requests serialise on
// that row. Never take an issue lock here: the ORD-09 consumer locks issue then
// order, the void and cashier refund lock order only, and an issue lock taken
// after the order lock would invert the sequence.

import { ulidToUuid, type TenantId } from "@starter/shared/core";
import { sql } from "drizzle-orm";
import { HttpError } from "../lib/http-error.ts";
import { hasParkedEdgeRefund } from "./payment-refund-edge-history.ts";
import type { Tx } from "./permission-resolver.ts";

type LaneTx = Pick<Tx, "execute">;

/** True when the order has a live ORD-09 refund (any status but `failed`). */
export async function ord09RefundExistsOf(
  tx: LaneTx,
  tenantId: TenantId,
  orderId: string,
): Promise<boolean> {
  const result = await tx.execute(sql`
    SELECT 1
      FROM payment_refunds r
      JOIN order_issues i
        ON i.tenant_id = r.tenant_id AND i.id = r.order_issue_id
     WHERE r.tenant_id = ${tenantId}
       AND i.order_id = ${ulidToUuid(orderId)}::uuid
       AND r.order_issue_id IS NOT NULL
       AND r.status <> 'failed'
     LIMIT 1
  `);
  return result.rows.length > 0;
}

/**
 * Cloud void and cashier refund: refuse (409) when an ORD-09 refund exists.
 * Call it after the order lock, in the same transaction.
 */
export async function assertNoOrd09Refund(
  tx: LaneTx,
  tenantId: TenantId,
  orderId: string,
): Promise<void> {
  if (await ord09RefundExistsOf(tx, tenantId, orderId))
    throw new HttpError(
      409,
      "REFUND_ORD09_REFUND_EXISTS",
      "Pesanan ini sudah punya refund item gagal (ORD-09). Void atau refund kasir tidak bisa dilakukan; selesaikan lewat refund tersebut.",
    );
}

/** Why an order can no longer take an ORD-09 refund. */
export type OrderMoneyBackLane =
  | "voided"
  | "edge_voided"
  | "edge_void_parked"
  | "edge_refund_parked"
  | "pos_refunded";

/**
 * ORD-09 side: the order already gave the guest money back another way, or
 * is being voided. Null when the lane is free. Checks, in order: a cloud void
 * (`pos_order_voids`), an edge void in the ingest ledger, a final-sale
 * `order.voided` still parked from an edge, an `order.refunded` still parked
 * from an edge, a cashier refund
 * (`pos_order_refunds`). Call it after the order lock.
 */
export async function orderMoneyBackLaneOf(
  tx: LaneTx,
  tenantId: TenantId,
  orderId: string,
): Promise<OrderMoneyBackLane | null> {
  const orderUuid = ulidToUuid(orderId);
  // Parked events carry the id as ULID or UUID, in any case (same aliases as
  // payment-refund-edge-history.ts).
  const ids = sql.join(
    [orderId.toLowerCase(), orderUuid.toLowerCase()].map((id) => sql`${id}`),
    sql`, `,
  );
  const result = await tx.execute(sql`
    SELECT
      EXISTS (SELECT 1 FROM pos_order_voids v
               WHERE v.tenant_id = ${tenantId}
                 AND v.order_id = ${orderUuid}::uuid) AS voided,
      EXISTS (SELECT 1 FROM edge_order_ingests e
               WHERE e.tenant_id = ${tenantId}
                 AND e.order_id = ${orderUuid}::uuid
                 AND e.state = 'voided') AS edge_voided,
      EXISTS (SELECT 1 FROM edge_deferred_events d
               WHERE d.tenant_id = ${tenantId}
                 AND (d.event_name = 'order.voided'
                      OR d.envelope->>'name' = 'order.voided')
                 AND (
                   (d.aggregate_type = 'order'
                    AND lower(d.aggregate_id) IN (${ids}))
                   OR lower(d.envelope->>'aggregateId') IN (${ids})
                   OR lower(d.envelope->'payload'->>'orderId') IN (${ids})
                 )
                 AND d.envelope->'payload'->>'voidedFinalOrder' = 'true')
        AS edge_void_parked,
      EXISTS (SELECT 1 FROM pos_order_refunds f
               WHERE f.tenant_id = ${tenantId}
                 AND f.order_id = ${orderUuid}::uuid) AS pos_refunded
  `);
  const row = result.rows[0];
  if (row?.voided === true) return "voided";
  if (row?.edge_voided === true) return "edge_voided";
  if (row?.edge_void_parked === true) return "edge_void_parked";
  // Brief 1264: a parked edge `order.refunded` already paid the guest from the
  // drawer and has no native row yet (same check as the edge void ingest, 1244).
  if (await hasParkedEdgeRefund(tx, { tenantId, orderId }))
    return "edge_refund_parked";
  if (row?.pos_refunded === true) return "pos_refunded";
  return null;
}

// legend-3dsih (1095): what a void does to the vouchers already given for the
// order. A void pays the guest back the whole bill, so a voucher bound to the
// same order (an apology voucher of one of its issues, or a CRM voucher a
// report stored in `order_issues.voucher_id`; the same set `orderGivenOf`
// counts) would be money handed back twice.
//
// - `issued` (not used yet): cancelled here, in the caller's transaction.
// - `redeemed` (used; a voucher is never part-used): the void is refused.
// - `expired` / `cancelled`: ignored.
// One redeemed voucher refuses them all: nothing is written in that case, and
// the caller throws, so its transaction (savepoint on the edge) rolls back.
//
// The caller MUST already hold the `orders` row lock (FOR UPDATE) of the order
// in the same transaction. Lock order: orders, then the voucher rows by id,
// the same as a voucher redeem at checkout (crm-promo-engine.ts, steps 1 and
// 4). No issue row is locked here: the issue side locks issue then order, so
// taking an issue after the order would deadlock.

import { and, eq, sql } from "drizzle-orm";
import {
  createUlid,
  toIsoDateTime,
  ulidToUuid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { vouchers } from "../db/schema/crm-promo.ts";
import { orders } from "../db/schema/qr-order.ts";
import { recordAudit } from "./core-audit.ts";
import type { Tx } from "./permission-resolver.ts";

const AUDIT_SAFE_FIELDS = ["id", "status", "orderId", "cancelledReason"];
const CANCELLED_REASON = "order_voided";
const IGNORED: ReadonlySet<string> = new Set(["expired", "cancelled"]);

export type OrderVoucherVoidResult =
  { kind: "ok"; cancelledVoucherIds: string[] } | { kind: "used" };

export async function settleOrderVouchersForVoid(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    orderId: string;
    /** The user behind the void; null writes a system actor. */
    actor: { userId: string | null };
    now: Date;
  },
): Promise<OrderVoucherVoidResult> {
  const tenantId = context.tenant.tenantId;
  const { orderId, actor, now } = input;
  const orderUuid = ulidToUuid(orderId);

  // Same voucher set as `orderGivenOf` (order-given.ts), locked in id order.
  const locked = await tx.execute(sql`
    SELECT v.id::text AS id, v.status AS status
      FROM vouchers v
     WHERE v.tenant_id = ${tenantId}
       AND v.id IN (
             SELECT a.voucher_id
               FROM apology_vouchers a
              WHERE a.tenant_id = ${tenantId}
                AND (a.id IN (SELECT i.voucher_id FROM order_issues i
                               WHERE i.tenant_id = ${tenantId}
                                 AND i.order_id = ${orderUuid}::uuid
                                 AND i.voucher_id IS NOT NULL)
                     OR a.order_issue_id IN (SELECT i.id FROM order_issues i
                                              WHERE i.tenant_id = ${tenantId}
                                                AND i.order_id = ${orderUuid}::uuid))
             UNION
             SELECT i.voucher_id
               FROM order_issues i
              WHERE i.tenant_id = ${tenantId}
                AND i.order_id = ${orderUuid}::uuid
                AND i.voucher_id IS NOT NULL)
     ORDER BY v.id
       FOR UPDATE
  `);
  const rows = locked.rows as { id: string; status: string }[];
  // Fail closed: only a voucher that is surely dead is ignored; an unknown
  // status counts as used.
  if (rows.some((row) => row.status !== "issued" && !IGNORED.has(row.status)))
    return { kind: "used" };
  const open = rows.filter((row) => row.status === "issued");
  if (open.length === 0) return { kind: "ok", cancelledVoucherIds: [] };

  const [order] = await tx
    .select({ outletId: orders.outletId })
    .from(orders)
    .where(and(eq(orders.tenantId, tenantId), eq(orders.id, orderId)));
  if (!order) return { kind: "used" };

  const cancelledVoucherIds: string[] = [];
  for (const { id } of open) {
    const done = await tx
      .update(vouchers)
      .set({ status: "cancelled", cancelledReason: CANCELLED_REASON })
      .where(
        and(
          eq(vouchers.tenantId, tenantId),
          eq(vouchers.id, id),
          eq(vouchers.status, "issued"),
        ),
      )
      .returning({ id: vouchers.id });
    // Locked above, so this cannot lose a race; if it ever does, refuse.
    if (done.length === 0) return { kind: "used" };
    cancelledVoucherIds.push(id);
    await recordAudit(
      tx,
      context,
      {
        id: createUlid(now.getTime()),
        tenantId,
        outletId: order.outletId,
        actorType: actor.userId === null ? "system" : "user",
        actorId: actor.userId,
        deviceId: null,
        action: "voucher.cancelled",
        objectType: "voucher",
        objectId: id,
        reason: "Pesanan di-void; voucher terikat pesanan dibatalkan.",
        maskedChanges: {
          before: { id, status: "issued" },
          after: {
            id,
            status: "cancelled",
            orderId,
            cancelledReason: CANCELLED_REASON,
          },
        },
        ipHash: null,
        sensitiveAccess: false,
        retentionClass: "audit_2y",
        createdAt: toIsoDateTime(now),
      },
      AUDIT_SAFE_FIELDS,
    );
  }
  return { kind: "ok", cancelledVoucherIds };
}

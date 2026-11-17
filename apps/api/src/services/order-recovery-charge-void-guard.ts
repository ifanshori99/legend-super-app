// legend-vl6bk (SO 996 F2): a POS order voided through `voidPosOrderCorrection`
// stays `completed`; the proof is its `pos_order_voids` row. An unpaid swap
// charge of that order must not take money after the void: the collect routes
// (cash, QRIS, EDC) refuse with 409 `order_voided`, and a QRIS that lands after
// the void is a late payment (the consumer refunds it in full, no
// `order_issue.charge_paid`). Call both inside the transaction, after
// `lockChargeChain` (issue, order, charge): the void locks the same order row
// before it inserts its row, so a webhook or collect racing the void sees it.

import { and, eq } from "drizzle-orm";
import type { TenantId } from "@starter/shared/core";
import { posOrderVoids } from "../db/schema/pos-order.ts";
import { HttpError } from "../lib/http-error.ts";
import type { Tx } from "./permission-resolver.ts";

export async function isOrderVoidedByCorrection(
  tx: Tx,
  tenantId: TenantId,
  orderId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: posOrderVoids.id })
    .from(posOrderVoids)
    .where(
      and(
        eq(posOrderVoids.tenantId, tenantId),
        eq(posOrderVoids.orderId, orderId),
      ),
    )
    .limit(1);
  return row !== undefined;
}

export async function assertOrderNotVoidedByCorrection(
  tx: Tx,
  tenantId: TenantId,
  orderId: string,
): Promise<void> {
  if (await isOrderVoidedByCorrection(tx, tenantId, orderId))
    throw new HttpError(
      409,
      "order_voided",
      "Transaksi sudah di-void; tagihan selisih tidak dapat dibayar.",
    );
}

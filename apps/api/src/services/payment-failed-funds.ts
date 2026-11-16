// SO-885 (legend-0owye), widened by SO-896 (legend-5h8ob): a code whose money
// is still parked.
//
// An amount mismatch (`holdGatewayAmountMismatch`), an underpayment found by the
// poll, or a late payment on a closed code parks the paid money in
// `payment_unallocated_funds`. The intent is not collectible again (`failed`,
// `expired`, `superseded`, ...), but the guest already paid: until that money is
// refunded or credited (`resolved_at` set) the bill must not ask for a new
// code, or the guest pays twice. No intent status is proof the money is back, so
// only `paid` is left out (its money is allocated to the bill).

import { and, eq, exists, ne, sql } from "drizzle-orm";
import type { TenantId } from "@starter/shared/core";
import { paymentIntents, paymentUnallocatedFunds } from "../db/schema/index.ts";
import type { Tx } from "./menu-internals.ts";
import { openFundOfPosOrderTx } from "./pos-order-open-funds.ts";

function intentWithOpenFund() {
  return and(
    ne(paymentIntents.status, "paid"),
    exists(
      sql`(select 1 from ${paymentUnallocatedFunds} f
        where f.tenant_id = ${paymentIntents.tenantId}
          and f.payment_intent_id = ${paymentIntents.id}
          and f.resolved_at is null)`,
    ),
  );
}

/** Open parked money of the order, whichever intent holds it: a whole-order
 * code, a part code (even of a part voided since, SO-889), and, SO-896, the
 * intent of a POS tender or QR hold (a manager force release voids the tender,
 * a late payment is then parked on its intent). Same scope as the POS tender
 * guard (`openFundOfPosOrderTx`), so a re-split, a part or a whole-order code
 * cannot step around money parked on a tender. */
export async function failedOrderCodeWithOpenFundTx(
  tx: Tx,
  tenantId: TenantId,
  order: { id: string; paymentLinkId: string | null },
): Promise<{ id: string } | null> {
  return openFundOfPosOrderTx(tx, tenantId, order);
}

/** A code of one split part (any status but paid) whose money is still unresolved. */
export async function failedPartCodeWithOpenFundTx(
  tx: Tx,
  tenantId: TenantId,
  billSplitId: string,
): Promise<{ id: string } | null> {
  const [code] = await tx
    .select({ id: paymentIntents.id })
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, tenantId),
        eq(paymentIntents.billSplitId, billSplitId),
        intentWithOpenFund(),
      ),
    )
    .limit(1);
  return code ?? null;
}

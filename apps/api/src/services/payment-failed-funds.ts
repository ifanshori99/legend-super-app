// SO-885 (legend-0owye): a `failed` code whose money is still parked.
//
// An amount mismatch (`holdGatewayAmountMismatch`) closes the intent as
// `failed` AND parks the paid money in `payment_unallocated_funds`. The intent
// is not collectible again, but the guest already paid: until that money is
// refunded or credited (`resolved_at` set) the bill must not ask for a new
// code, or the guest pays twice. `failed` alone is no proof the money is back.

import { and, eq, exists, inArray, or, sql } from "drizzle-orm";
import type { TenantId } from "@starter/shared/core";
import {
  billSplits,
  paymentIntents,
  paymentUnallocatedFunds,
} from "../db/schema/index.ts";
import type { Tx } from "./menu-internals.ts";

function failedWithOpenFund() {
  return and(
    eq(paymentIntents.status, "failed"),
    exists(
      sql`(select 1 from ${paymentUnallocatedFunds} f
        where f.tenant_id = ${paymentIntents.tenantId}
          and f.payment_intent_id = ${paymentIntents.id}
          and f.resolved_at is null)`,
    ),
  );
}

/** A failed code of the order whose money is still unresolved, if any. ANY
 * code counts: a whole-order code, a part code, even of a part voided since
 * (SO-889). Found through the order's link or through its split parts, voided
 * ones included, so a re-split or a whole-order payment cannot step around it. */
export async function failedOrderCodeWithOpenFundTx(
  tx: Tx,
  tenantId: TenantId,
  order: { id: string; paymentLinkId: string | null },
): Promise<{ id: string } | null> {
  const [code] = await tx
    .select({ id: paymentIntents.id })
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, tenantId),
        or(
          order.paymentLinkId === null
            ? undefined
            : eq(paymentIntents.paymentLinkId, order.paymentLinkId),
          inArray(
            paymentIntents.billSplitId,
            tx
              .select({ id: billSplits.id })
              .from(billSplits)
              .where(
                and(
                  eq(billSplits.tenantId, tenantId),
                  eq(billSplits.orderId, order.id),
                ),
              ),
          ),
        ),
        failedWithOpenFund(),
      ),
    )
    .limit(1);
  return code ?? null;
}

/** A failed code of one split part whose money is still unresolved, if any. */
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
        failedWithOpenFund(),
      ),
    )
    .limit(1);
  return code ?? null;
}

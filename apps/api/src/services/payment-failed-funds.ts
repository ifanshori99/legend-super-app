// SO-885 (legend-0owye): a `failed` code whose money is still parked.
//
// An amount mismatch (`holdGatewayAmountMismatch`) closes the intent as
// `failed` AND parks the paid money in `payment_unallocated_funds`. The intent
// is not collectible again, but the guest already paid: until that money is
// refunded or credited (`resolved_at` set) the bill must not ask for a new
// code, or the guest pays twice. `failed` alone is no proof the money is back.

import { and, eq, exists, isNull, sql } from "drizzle-orm";
import type { TenantId } from "@starter/shared/core";
import { paymentIntents, paymentUnallocatedFunds } from "../db/schema/index.ts";
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

/** A failed code of the order's link (whole-order codes only) whose money is
 * still unresolved, if any. */
export async function failedOrderCodeWithOpenFundTx(
  tx: Tx,
  tenantId: TenantId,
  paymentLinkId: string,
): Promise<{ id: string } | null> {
  const [code] = await tx
    .select({ id: paymentIntents.id })
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, tenantId),
        eq(paymentIntents.paymentLinkId, paymentLinkId),
        isNull(paymentIntents.billSplitId),
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

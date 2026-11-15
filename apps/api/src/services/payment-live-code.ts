// SO-885 (legend-tqkbb): which payment codes of a bill may still take money.
//
// Local time (the code's expiry, the 24 hour poll window, the late-payment
// grace) is never proof that a code is dead. A `pending` code is always live
// (a lapsed one stays pending until the gateway answers). An `expired` code
// the provider received is live until the provider answered final (expired /
// failed / cancelled) or its money was reconciled: `provider_final_at`. A code
// the QR hold proved dead (hold `closed`: provider proof, or the founder's
// manager release) is dead too.
//
// Shared by the three places that ask "is the old code still collectible":
// the whole-order guard (`qr-order-payment.ts`), the split part and split
// change guards (`bill-split.service.ts`) and the poll selector
// (`payment.service.ts`), so they can never disagree.

import { and, eq, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { paymentIntents } from "../db/schema/index.ts";

/** No closed QR hold on the intent. Raw SQL so it works in any query. */
export const noClosedHold: SQL = sql`not exists (select 1 from pos_qris_holds h
  where h.tenant_id = ${paymentIntents.tenantId}
    and h.payment_intent_id = ${paymentIntents.id}
    and h.state = 'closed')`;

/**
 * An `expired` (locally superseded, voided or timed out) code the provider
 * received and has not declared final: it may still be paid.
 */
export function expiredCodeMayStillPay(): SQL {
  return and(
    eq(paymentIntents.status, "expired"),
    isNotNull(paymentIntents.providerRef),
    isNull(paymentIntents.providerFinalAt),
    noClosedHold,
  )!;
}

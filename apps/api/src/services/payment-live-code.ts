// SO-885 (legend-tqkbb): which payment codes of a bill may still take money.
//
// Local time (the code's expiry, the 24 hour poll window, the late-payment
// grace) is never proof that a code is dead. A `pending` code is always live
// (a lapsed one stays pending until the gateway answers). An `expired` or
// `failed` code the provider received is live until the provider answered final
// (expired / failed / cancelled) or its money was reconciled:
// `provider_final_at`. A code
// the QR hold proved dead (hold `closed`: provider proof, or the founder's
// manager release) is dead too.
//
// Shared by the three places that ask "is the old code still collectible":
// the whole-order guard (`qr-order-payment.ts`), the split part and split
// change guards (`bill-split.service.ts`) and the poll selector
// (`payment.service.ts`), so they can never disagree.

import { and, eq, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import { paymentIntents } from "../db/schema/index.ts";
import { HOLD_CLOSE_MARGIN_MS } from "./pos-qris-hold.ts";

/**
 * No closed QR hold and no staff VA release on the intent: nothing proved or
 * declared the code dead. Raw SQL so it works in any query.
 */
export const noVaRelease: SQL = sql`(not exists (select 1 from payment_va_releases r
  where r.tenant_id = ${paymentIntents.tenantId}
    and r.payment_intent_id = ${paymentIntents.id}))`;

export const noClosedHold: SQL = sql`(not exists (select 1 from pos_qris_holds h
  where h.tenant_id = ${paymentIntents.tenantId}
    and h.payment_intent_id = ${paymentIntents.id}
    and h.state = 'closed')
  and ${noVaRelease})`;

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

/**
 * SO-896: a `failed` code the provider received and has not declared final
 * (Duitku `02`, DOIT `failed` before the code lapsed) is a retryable attempt:
 * it may still be paid. Like an `expired` code it stays in the poll until the
 * provider answers final or its money was reconciled; local time never kills
 * it, and parked money (resolved or not) does not change that.
 */
export function failedCodeNotFinal(): SQL {
  return and(
    eq(paymentIntents.status, "failed"),
    isNotNull(paymentIntents.providerRef),
    isNull(paymentIntents.providerFinalAt),
    noClosedHold,
  )!;
}

/**
 * SO-889 / SO-896: the `failed` code that blocks a replacement code as a live
 * code: `failedCodeNotFinal` whose parked money, if any, is already resolved
 * (refunded or credited). Money still open is not "live" here: it is its own
 * guard, `FUNDS_UNRESOLVED` (`payment-failed-funds.ts`), which refuses every
 * new tender, code or split whatever the status. Once the money is resolved the
 * code is live again until the provider answers final.
 */
export function failedCodeMayStillPay(): SQL {
  return and(
    failedCodeNotFinal(),
    sql`not exists (select 1 from payment_unallocated_funds f
      where f.tenant_id = ${paymentIntents.tenantId}
        and f.payment_intent_id = ${paymentIntents.id}
        and f.resolved_at is null
        and f.provider_refunded_at is null)`,
  )!;
}

/**
 * A code that may still take money: any `pending` code whatever its expiry
 * (a lapsed one stays pending until the gateway answers final) unless the hold
 * or a staff release proved it dead, or an `expired` / `failed` code the
 * provider received and has not declared final. One predicate for every
 * "is the old code still collectible" guard: the whole-order guard
 * (`orderLiveCodeTx`), the split guards (`bill-split.service.ts`) and the
 * code issue guard (`assertLinkOrderCanIssueTx`, legend-4n8rs).
 */
export function liveCodeWhere(): SQL {
  return or(
    and(eq(paymentIntents.status, "pending"), noClosedHold),
    expiredCodeMayStillPay(),
    failedCodeMayStillPay(),
  )!;
}

/**
 * SO-889 (design `qris-dp-intent.md` D-03): the provider's answer proves the
 * code dead only once the code lapsed on its own: `now >= expires_at + 60 s`
 * (`HOLD_CLOSE_MARGIN_MS`). Before that a failed attempt (Duitku `02`, DOIT
 * `failed`, an early `expired`) may be retried on the same code, so the guest
 * can still pay it. Duitku proves it with its raw code `02` (a mapped status
 * without it never does); other providers with a mapped `expired` / `failed`.
 * The caller checks the answer is about this intent's reference. A `paid`
 * answer is not handled here: money is recorded or parked at any time.
 *
 * Shared by `provider_final_at` (`payment.service.ts`), the strict DP close
 * (`payment-provider-proof.ts`), the QR hold check and the release recon.
 */
export function providerAnswerFinal(
  intent: { provider: string; expiresAt: Date },
  answer: { status: string; rawStatus?: string | undefined },
  now: Date,
): boolean {
  if (now.getTime() < intent.expiresAt.getTime() + HOLD_CLOSE_MARGIN_MS)
    return false;
  return intent.provider === "duitku"
    ? answer.rawStatus === "02"
    : answer.status === "expired" || answer.status === "failed";
}

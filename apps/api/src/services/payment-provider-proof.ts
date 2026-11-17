// Provider proof before a payment link is closed locally (design legend-ukbq3).
//
// `cancelPaymentLinkInTx` only closes the LOCAL link, so a customer who pays
// the old code afterwards becomes a late payment and a refund. Before a caller
// cancels, it asks the provider here, outside any transaction and business
// lock (network I/O): money already at the provider is applied once through
// the normal settlement path, an unclear answer holds the cancel (fail-closed),
// and only a provider that holds no money lets the caller cancel locally.

import { and, eq, inArray, isNotNull, isNull, ne } from "drizzle-orm";
import type { ScopedTenantContext } from "@starter/shared/core";
import { db } from "../db/index.ts";
import { paymentIntents, paymentUnallocatedFunds } from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error";
import { logger } from "../lib/logger";
import { settleGatewayIntentNow } from "./payment.service.ts";
import { paymentGatewayFor } from "./payment-gateway.ts";
import { providerAnswerFinal } from "./payment-live-code.ts";
import type { Tx } from "./permission-resolver.ts";
import { HOLD_CLOSE_MARGIN_MS } from "./pos-qris-hold.ts";

export type LinkProviderVerdict = "unpaid" | "settled";

const unconfirmed = () =>
  new HttpError(
    409,
    "PAYMENT_PROVIDER_UNCONFIRMED",
    "The payment provider could not confirm the payment status. Try again shortly.",
  );

/**
 * Asks the provider about every `pending` or `expired` intent of the link that
 * already reached it (`provider_ref` set; an intent without one is local only).
 * An `expired` intent is only expired LOCALLY (superseded by a newer code, or
 * closed before its code lapsed): the provider code may still be payable, so
 * it is asked too (legend-9ho2v).
 *
 * - `paid` for the same reference: settles it once through
 *   `settleGatewayIntentNow` (idempotent: payment applied to the bill or parked
 *   as unallocated funds) and the verdict is `settled`; the caller must not
 *   cancel locally and re-reads its own state. The intent is re-read after
 *   settling; if its status did not change the payment was not applied.
 * - the provider call fails, or answers about another reference, or settling a
 *   paid answer fails or leaves the intent `pending`: throws 409
 *   `PAYMENT_PROVIDER_UNCONFIRMED`; nothing is cancelled and nothing is
 *   refunded.
 * - a `pending` intent answered `pending` / `expired` / `failed`: no money at
 *   the provider; nothing is sent to the provider. This helper never cancels
 *   the code there: the caller may still reject the close, and the webhook and
 *   the poller still catch a late payment.
 * - a locally `expired` intent (so-879 P3) is safe only when the provider says
 *   `expired` / `failed`, or when its own `expires_at` + 60 s
 *   (`HOLD_CLOSE_MARGIN_MS`) has passed (the code lapsed on its own). A
 *   `pending` answer for a code that has not lapsed yet means the customer can
 *   still pay it: throws 409 `PAYMENT_PROVIDER_UNCONFIRMED`.
 *
 * `unpaid` only when every intent is safe to cancel locally.
 */
export function confirmLinkUnpaidAtProvider(
  context: ScopedTenantContext,
  linkId: string,
  now: Date,
): Promise<LinkProviderVerdict> {
  return askProviderAboutLink(context, linkId, now, false).then(
    (proof) => proof.verdict,
  );
}

/**
 * Fail-closed variant for closing a reservation whose DP is on the link
 * (legend-m7tnt, so-879 P1). Local time is never proof that a code is dead:
 *
 * - every intent that reached the provider is asked, whatever its local
 *   status (`pending`, `expired`, superseded, `failed`);
 * - a `pending` answer is refused (409 `PAYMENT_PROVIDER_UNCONFIRMED`) for
 *   every one of them, before and after expiry + margin; only a final
 *   `expired` / `failed` / `cancelled` answer, or money applied once, proves a
 *   code holds nothing;
 * - an answer `paid` for an intent that stays `failed` (amount mismatch) is
 *   accepted only when its money was recorded as unallocated funds;
 * - unallocated funds of a non-paid intent of the link that are not resolved
 *   yet (refunded or credited) refuse the close until they are reconciled.
 *
 * Returns the ids of the intents asked, for `assertDepositLinkProvenInTx`.
 */
export async function confirmDepositLinkUnpaidAtProvider(
  context: ScopedTenantContext,
  linkId: string,
  now: Date,
): Promise<{ verdict: LinkProviderVerdict; askedIntentIds: string[] }> {
  const proof = await askProviderAboutLink(context, linkId, now, true);
  await withTenant(db, context, (tx) =>
    assertNoOpenFundsOfLink(tx, context, linkId),
  );
  return proof;
}

/**
 * Re-checks under the caller's lock (reservation, then DP link) what the
 * provider proof read outside it: an intent of the link that was not asked
 * (opened since), or unallocated funds that are not resolved yet, refuse the
 * close with 409 `PAYMENT_PROVIDER_UNCONFIRMED`.
 */
export async function assertDepositLinkProvenInTx(
  tx: Tx,
  context: ScopedTenantContext,
  linkId: string,
  askedIntentIds: readonly string[],
): Promise<void> {
  const tenantId = context.tenant.tenantId;
  const intents = await tx
    .select({ id: paymentIntents.id })
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, tenantId),
        eq(paymentIntents.paymentLinkId, linkId),
        inArray(paymentIntents.status, ["pending", "expired", "failed"]),
        isNotNull(paymentIntents.providerRef),
      ),
    );
  if (intents.some((intent) => !askedIntentIds.includes(intent.id)))
    throw unconfirmed();
  await assertNoOpenFundsOfLink(tx, context, linkId);
}

async function assertNoOpenFundsOfLink(
  tx: Tx,
  context: ScopedTenantContext,
  linkId: string,
): Promise<void> {
  const tenantId = context.tenant.tenantId;
  const [open] = await tx
    .select({ id: paymentUnallocatedFunds.id })
    .from(paymentUnallocatedFunds)
    .innerJoin(
      paymentIntents,
      and(
        eq(paymentIntents.tenantId, paymentUnallocatedFunds.tenantId),
        eq(paymentIntents.id, paymentUnallocatedFunds.paymentIntentId),
      ),
    )
    .where(
      and(
        eq(paymentUnallocatedFunds.tenantId, tenantId),
        eq(paymentIntents.paymentLinkId, linkId),
        // Money on a paid intent is a double payment or an overpayment next to
        // the settled DP; it does not change what the DP itself holds.
        ne(paymentIntents.status, "paid"),
        isNull(paymentUnallocatedFunds.resolvedAt),
        // legend-7uqbs: already returned by the provider, nothing is open.
        isNull(paymentUnallocatedFunds.providerRefundedAt),
      ),
    )
    .limit(1);
  if (open) throw unconfirmed();
}

async function askProviderAboutLink(
  context: ScopedTenantContext,
  linkId: string,
  now: Date,
  strict: boolean,
): Promise<{ verdict: LinkProviderVerdict; askedIntentIds: string[] }> {
  const tenantId = context.tenant.tenantId;
  const intents = await withTenant(db, context, async (tx) =>
    tx
      .select()
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.tenantId, tenantId),
          eq(paymentIntents.paymentLinkId, linkId),
          inArray(
            paymentIntents.status,
            strict ? ["pending", "expired", "failed"] : ["pending", "expired"],
          ),
          isNotNull(paymentIntents.providerRef),
        ),
      ),
  );
  const askedIntentIds: string[] = [];
  let verdict: LinkProviderVerdict = "unpaid";
  for (const intent of intents) {
    const providerRef = intent.providerRef;
    if (providerRef === null) continue;
    askedIntentIds.push(intent.id);
    const gateway = paymentGatewayFor(intent.provider);
    let answer: Awaited<ReturnType<typeof gateway.getStatus>>;
    try {
      answer = await gateway.getStatus({
        context,
        outletId: intent.outletId,
        integrationId: intent.gatewayIntegrationId,
        providerRef,
        intentId: intent.id,
      });
    } catch (error) {
      logger.warn(
        { intentId: intent.id, err: error },
        "Payment: provider status check before link cancel failed",
      );
      throw unconfirmed();
    }
    if (answer.providerRef !== providerRef) throw unconfirmed();
    // Money on another provider reference of the same code is not yet
    // accounted for: no proof the code holds nothing (908).
    if (answer.extraPayments?.length) throw unconfirmed();
    if (answer.status === "paid") {
      try {
        await settleGatewayIntentNow(context, intent.id, now);
      } catch (error) {
        logger.warn(
          { intentId: intent.id, err: error },
          "Payment: settling a paid intent before link cancel failed",
        );
        throw unconfirmed();
      }
      // `settleGatewayIntentNow` asks the provider again and can return without
      // error while the intent keeps its status (second answer failed, or paid
      // without an amount). Only a re-read proves the payment was applied.
      const [reread] = await withTenant(db, context, async (tx) =>
        tx
          .select({ status: paymentIntents.status })
          .from(paymentIntents)
          .where(
            and(
              eq(paymentIntents.tenantId, tenantId),
              eq(paymentIntents.id, intent.id),
            ),
          ),
      );
      if (!reread) throw unconfirmed();
      if (reread.status === intent.status) {
        // An intent that was already `failed` (amount mismatch) stays failed;
        // its money is accounted when it was parked as unallocated funds
        // (open ones are refused by the funds check).
        if (!(strict && intent.status === "failed")) throw unconfirmed();
        if (!(await hasParkedFunds(context, intent.id))) throw unconfirmed();
      }
      verdict = "settled";
      continue;
    }
    // Strict: a `pending` answer is never proof of a dead code, whatever the
    // local status and clock say (`providerAnswerFinal` is false for it).
    // SO-889 (strict): any non-paid answer proves the code dead only once it
    // lapsed on its own (`expires_at` + 60 s); before that the guest can still
    // pay it (a failed attempt may be retried), whatever the local status says.
    if (strict && !providerAnswerFinal(intent, answer, now))
      throw unconfirmed();
    // A code only expired in our books (superseded, or closed before it
    // lapsed) is still payable while the provider says pending and its own
    // lifetime has not run out: no proof that it holds no money.
    if (
      intent.status === "expired" &&
      answer.status === "pending" &&
      now.getTime() < intent.expiresAt.getTime() + HOLD_CLOSE_MARGIN_MS
    )
      throw unconfirmed();
  }
  return { verdict, askedIntentIds };
}

async function hasParkedFunds(
  context: ScopedTenantContext,
  intentId: string,
): Promise<boolean> {
  const rows = await withTenant(db, context, async (tx) =>
    tx
      .select({ id: paymentUnallocatedFunds.id })
      .from(paymentUnallocatedFunds)
      .where(
        and(
          eq(paymentUnallocatedFunds.tenantId, context.tenant.tenantId),
          eq(paymentUnallocatedFunds.paymentIntentId, intentId),
        ),
      )
      .limit(1),
  );
  return rows.length > 0;
}

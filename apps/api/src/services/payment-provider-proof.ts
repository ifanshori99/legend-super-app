// Provider proof before a payment link is closed locally (design legend-ukbq3).
//
// `cancelPaymentLinkInTx` only closes the LOCAL link, so a customer who pays
// the old code afterwards becomes a late payment and a refund. Before a caller
// cancels, it asks the provider here, outside any transaction and business
// lock (network I/O): money already at the provider is applied once through
// the normal settlement path, an unclear answer holds the cancel (fail-closed),
// and only a provider that holds no money lets the caller cancel locally.

import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { ScopedTenantContext } from "@starter/shared/core";
import { db } from "../db/index.ts";
import { paymentIntents } from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error";
import { logger } from "../lib/logger";
import { settleGatewayIntentNow } from "./payment.service.ts";
import { paymentGatewayFor } from "./payment-gateway.ts";
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
export async function confirmLinkUnpaidAtProvider(
  context: ScopedTenantContext,
  linkId: string,
  now: Date,
): Promise<LinkProviderVerdict> {
  const tenantId = context.tenant.tenantId;
  const intents = await withTenant(db, context, async (tx) =>
    tx
      .select()
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.tenantId, tenantId),
          eq(paymentIntents.paymentLinkId, linkId),
          inArray(paymentIntents.status, ["pending", "expired"]),
          isNotNull(paymentIntents.providerRef),
        ),
      ),
  );
  let verdict: LinkProviderVerdict = "unpaid";
  for (const intent of intents) {
    const providerRef = intent.providerRef;
    if (providerRef === null) continue;
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
      if (!reread || reread.status === intent.status) throw unconfirmed();
      verdict = "settled";
      continue;
    }
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
  return verdict;
}

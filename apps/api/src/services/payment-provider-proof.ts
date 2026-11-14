// Provider proof before a payment link is closed locally (design legend-ukbq3).
//
// `cancelPaymentLinkInTx` only closes the LOCAL link, so a customer who pays
// the old code afterwards becomes a late payment and a refund. Before a caller
// cancels, it asks the provider here, outside any transaction and business
// lock (network I/O): money already at the provider is applied once through
// the normal settlement path, an unclear answer holds the cancel (fail-closed),
// and only a provider that holds no money lets the caller cancel locally.

import { and, eq, isNotNull } from "drizzle-orm";
import type { ScopedTenantContext } from "@starter/shared/core";
import { db } from "../db/index.ts";
import { paymentIntents } from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error";
import { logger } from "../lib/logger";
import { settleGatewayIntentNow } from "./payment.service.ts";
import { paymentGatewayFor } from "./payment-gateway.ts";

export type LinkProviderVerdict = "unpaid" | "settled";

const unconfirmed = () =>
  new HttpError(
    409,
    "PAYMENT_PROVIDER_UNCONFIRMED",
    "The payment provider could not confirm the payment status. Try again shortly.",
  );

/**
 * Asks the provider about every `pending` intent of the link that already
 * reached it (`provider_ref` set; an intent without one is local only).
 *
 * - `paid` for the same reference: settles it once through
 *   `settleGatewayIntentNow` (idempotent: payment applied to the bill or parked
 *   as unallocated funds) and the verdict is `settled`; the caller must not
 *   cancel locally and re-reads its own state. The intent is re-read after
 *   settling; if it is still `pending` the payment was not applied.
 * - the provider call fails, or answers about another reference, or settling a
 *   paid answer fails or leaves the intent `pending`: throws 409
 *   `PAYMENT_PROVIDER_UNCONFIRMED`; nothing is cancelled and nothing is
 *   refunded.
 * - `pending` / `expired` / `failed`: no money at the provider; nothing is
 *   sent to the provider. This helper never cancels the code there: the caller
 *   may still reject the close, and the webhook and the poller still catch a
 *   late payment.
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
          eq(paymentIntents.status, "pending"),
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
      // error while the intent stays `pending` (second answer failed, or paid
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
      if (!reread || reread.status === "pending") throw unconfirmed();
      verdict = "settled";
    }
  }
  return verdict;
}

// Payment gateway fallback sweep (bead legend-b9i; PRD v1.7 PAY-02/03).
//
// Runs from the worker relay tick per tenant (wired in worker-main.ts next to
// the other sweeps). When a DOIT webhook never arrives, pending intents are
// settled by asking the gateway for their status; webhook events that were
// stored but not processed are retried. Both paths end in the same payment
// service calls the webhook uses, so a repeated or overlapping run settles
// nothing twice. Throttled per tenant: the relay ticks every minute, the
// grace period before a pending intent is polled is 60 s.

import {
  assertTrustedScopedContext,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { pollPendingGatewayIntents } from "../services/payment.service.ts";
import { reprocessDuitkuWebhookEvents } from "../services/payment-duitku-webhook.service.ts";
import {
  purgeRejectedWebhookEvents,
  reprocessParkedRecurringEvents,
  reprocessStoredWebhookEvents,
} from "../services/payment-webhook.service.ts";

/** Minimum time between two runs for one tenant. */
export const PAYMENT_GATEWAY_POLL_INTERVAL_MS = 30_000;

const lastRunByTenant = new Map<string, number>();

export type PaymentGatewayPollResult = {
  polled: { checked: number; settled: number };
  webhooks: { checked: number; processed: number };
};

export async function runPaymentGatewayPollJob(
  context: ScopedTenantContext,
  now: Date = new Date(),
  options: { force?: boolean } = {},
): Promise<PaymentGatewayPollResult | null> {
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  const last = lastRunByTenant.get(tenantId);
  if (
    !options.force &&
    last !== undefined &&
    now.getTime() - last < PAYMENT_GATEWAY_POLL_INTERVAL_MS
  )
    return null;
  lastRunByTenant.set(tenantId, now.getTime());
  // The two sweeps are independent: a failing one must not starve the other.
  const result: PaymentGatewayPollResult = {
    polled: { checked: 0, settled: 0 },
    webhooks: { checked: 0, processed: 0 },
  };
  let failed = false;
  try {
    result.webhooks = await reprocessStoredWebhookEvents(context, now);
  } catch {
    failed = true;
  }
  try {
    // Recurring invoice events parked until their subscription exists (no
    // 24 h window, unlike the sweep above).
    const parked = await reprocessParkedRecurringEvents(context, now);
    result.webhooks = {
      checked: result.webhooks.checked + parked.checked,
      processed: result.webhooks.processed + parked.processed,
    };
  } catch {
    failed = true;
  }
  try {
    const duitku = await reprocessDuitkuWebhookEvents(context, now);
    result.webhooks = {
      checked: result.webhooks.checked + duitku.checked,
      processed: result.webhooks.processed + duitku.processed,
    };
  } catch {
    failed = true;
  }
  try {
    result.polled = await pollPendingGatewayIntents(context, now);
  } catch {
    failed = true;
  }
  try {
    // Retention for bad-signature rows; the count is not needed here.
    await purgeRejectedWebhookEvents(context, now);
  } catch {
    failed = true;
  }
  if (failed) throw new Error("Payment gateway sweep failed");
  return result;
}

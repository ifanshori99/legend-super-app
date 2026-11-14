import { createHash } from "node:crypto";
import { pushSubscriptionInputSchema } from "@starter/shared/notification";
import { openSecret, sealSecret, sealedVersion } from "./secrets.ts";

const subscriptionSchema = pushSubscriptionInputSchema.omit({
  deviceLabel: true,
});
export type StoredPushSubscription = ReturnType<
  typeof subscriptionSchema.parse
>;

/** Saved endpoints are untrusted: only browser push services may receive POSTs. */
export function assertPushServiceEndpoint(endpoint: string): void {
  const url = new URL(endpoint);
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    (url.port !== "" && url.port !== "443") ||
    url.username ||
    url.password ||
    url.hash ||
    !(
      host === "fcm.googleapis.com" ||
      host.endsWith(".push.services.mozilla.com") ||
      host.endsWith(".push.apple.com") ||
      host.endsWith(".notify.windows.com")
    )
  )
    throw new Error(
      "Push subscription endpoint is not an approved push service",
    );
}

export function pushEndpointHash(endpoint: string): string {
  return createHash("sha256").update(endpoint).digest("hex");
}

const associatedData = (tenantId: string, userId: string) =>
  `push-subscription:${tenantId}:${userId}`;

/** Compatible with notification-center's protector port; no plaintext is stored. */
export function createPushSubscriptionProtector() {
  return {
    async seal(
      input: StoredPushSubscription,
      tenantId: string,
      userId: string,
    ) {
      const subscription = subscriptionSchema.parse(input);
      assertPushServiceEndpoint(subscription.endpoint);
      const ciphertext = sealSecret(
        JSON.stringify(subscription),
        associatedData(tenantId, userId),
      );
      return {
        endpointHash: pushEndpointHash(subscription.endpoint),
        ciphertext,
        keyVersion: `v${sealedVersion(ciphertext)}`,
      };
    },
  };
}

export function openPushSubscription(
  ciphertext: string,
  tenantId: string,
  userId: string,
  endpointHash: string,
): StoredPushSubscription {
  try {
    const subscription = subscriptionSchema.parse(
      JSON.parse(openSecret(ciphertext, associatedData(tenantId, userId))),
    );
    assertPushServiceEndpoint(subscription.endpoint);
    if (pushEndpointHash(subscription.endpoint) !== endpointHash)
      throw new Error("Push subscription hash mismatch");
    return subscription;
  } catch {
    // Crypto/parser errors can contain private data. Keep the operator error safe.
    throw new Error("Stored push subscription could not be opened");
  }
}

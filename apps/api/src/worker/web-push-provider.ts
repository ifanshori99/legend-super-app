import { createHash } from "node:crypto";
import webpush from "web-push";
import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  assertOutletInScope,
  assertTrustedScopedContext,
} from "@starter/shared/core";
import { pushRequestSchema, type PushProvider } from "@starter/shared/adapters";
import { inAppLinkSchema } from "@starter/shared/notification";
import type * as schema from "../db/schema/index.ts";
import {
  deliveryAttempts,
  notifications,
  pushSubscriptions,
} from "../db/schema/notification.ts";
import { withTenant } from "../db/tenant.ts";
import {
  assertPushServiceEndpoint,
  openPushSubscription,
  pushEndpointHash,
} from "../lib/push-subscription.ts";

export type WebPushSend = typeof webpush.sendNotification;
export type WebPushConfig = {
  subject: string;
  publicKey: string;
  privateKey: string;
};

/** The attempt reference supplies a stable topic/tag across transport retries. */
export function createWebPushProvider(
  database: NodePgDatabase<typeof schema>,
  config: WebPushConfig,
  send: WebPushSend = webpush.sendNotification.bind(webpush),
): PushProvider {
  return {
    async send(context, input) {
      assertTrustedScopedContext(context);
      const request = pushRequestSchema.parse(input);
      if (request.tenantId !== context.tenant.tenantId)
        throw new Error("Push notification tenant mismatch");
      if (request.outletId === null) {
        if (context.outletScope.kind !== "tenant")
          throw new Error("Tenant-wide push requires tenant scope");
      } else assertOutletInScope(context.outletScope, request.outletId);
      assertPushServiceEndpoint(request.endpoint);
      const endpointHash = pushEndpointHash(request.endpoint);
      const selected = await withTenant(database, context, async (tx) => {
        // The persisted attempt identifies the recipient. An endpoint shared
        // with another account must never select that account's sealed keys.
        const rows = await tx
          .select({ subscription: pushSubscriptions, link: notifications.link })
          .from(deliveryAttempts)
          .innerJoin(
            notifications,
            and(
              eq(notifications.tenantId, deliveryAttempts.tenantId),
              eq(notifications.id, deliveryAttempts.notificationId),
            ),
          )
          .innerJoin(
            pushSubscriptions,
            and(
              eq(pushSubscriptions.tenantId, notifications.tenantId),
              eq(pushSubscriptions.userId, notifications.userId),
            ),
          )
          .where(
            and(
              eq(deliveryAttempts.tenantId, context.tenant.tenantId),
              eq(deliveryAttempts.idempotencyKey, request.reference),
              eq(deliveryAttempts.channel, "web_push"),
              eq(deliveryAttempts.status, "sending"),
              eq(pushSubscriptions.endpointHash, endpointHash),
            ),
          );
        const row = rows[0]?.subscription;
        if (!row) return null;
        const subscription = openPushSubscription(
          row.subscriptionCiphertext,
          row.tenantId,
          row.userId,
          row.endpointHash,
        );
        if (subscription.endpoint !== request.endpoint)
          throw new Error("Push subscription endpoint mismatch");
        const link = inAppLinkSchema.safeParse(rows[0]?.link);
        return { row, subscription, url: link.success ? link.data : "/" };
      });
      if (!selected) return { reference: request.reference, accepted: false };
      try {
        await send(
          selected.subscription,
          JSON.stringify({
            title: request.title,
            body: request.body,
            tag: request.reference,
            data: { url: selected.url },
          }),
          {
            vapidDetails: config,
            TTL: 300,
            urgency: "high",
            timeout: 10_000,
            topic: createHash("sha256")
              .update(request.reference)
              .digest("base64url")
              .slice(0, 32),
          },
        );
      } catch (error) {
        const status =
          typeof error === "object" &&
          error !== null &&
          "statusCode" in error &&
          typeof error.statusCode === "number"
            ? error.statusCode
            : null;
        if (status === 404 || status === 410) {
          await withTenant(database, context, (tx) =>
            tx
              .delete(pushSubscriptions)
              .where(
                and(
                  eq(pushSubscriptions.tenantId, context.tenant.tenantId),
                  eq(pushSubscriptions.id, selected.row.id),
                ),
              ),
          );
          return { reference: request.reference, accepted: false };
        }
        // A WebPushError carries endpoint and response body: never propagate it.
        throw new Error(
          status === null
            ? "Web push transport failed"
            : `Web push request failed with status ${status}`,
        );
      }
      // Delivery succeeded already. Optional telemetry must never schedule a
      // second external send if its write fails after the provider accepted.
      await withTenant(database, context, (tx) =>
        tx
          .update(pushSubscriptions)
          .set({ lastSuccessAt: new Date() })
          .where(
            and(
              eq(pushSubscriptions.tenantId, context.tenant.tenantId),
              eq(pushSubscriptions.id, selected.row.id),
            ),
          ),
      ).catch(() => undefined);
      return { reference: request.reference, accepted: true };
    },
  };
}

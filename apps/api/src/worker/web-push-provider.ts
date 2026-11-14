import { createHash } from "node:crypto";
import webpush from "web-push";
import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
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
import { logger } from "../lib/logger.ts";
import {
  assertPushServiceEndpoint,
  openPushSubscription,
  pushEndpointHash,
} from "../lib/push-subscription.ts";

/** One alert reaches at most this many of a recipient's browsers, newest first. */
export const MAX_PUSH_SUBSCRIPTIONS_PER_ALERT = 5;

/**
 * Which saved subscriptions may still receive a push. Legacy rows (never
 * stamped by a verified registration) and registrations older than 30 days
 * never qualify. The registering session must not be revoked, but it may have
 * expired: a staff session ends after 30 idle minutes, and a locked phone must
 * keep its panic alarms. Once the expired session row is cleaned up the FK
 * nulls session_id and the row still qualifies; sign-out and revoke delete the
 * rows instead (session delete trigger in 0375, identity-session.service.ts). A bound device must
 * still be active. Whether the recipient may still receive the alert
 * (permission, duty, active user) is checked separately. Identifiers are
 * written qualified because a single-table Drizzle select drops the table name.
 */
export function deliverablePushSubscription(now: Date): SQL {
  return sql`("push_subscriptions"."registered_at" is not null
    and "push_subscriptions"."registered_at" > ${now}::timestamptz - interval '30 days'
    and ("push_subscriptions"."session_id" is null
      or exists (
        select 1 from "session" as "ps_session"
        where "ps_session"."id" = "push_subscriptions"."session_id"
          and "ps_session"."user_id" = "push_subscriptions"."user_id"::text
          and "ps_session"."revoked_at" is null))
    and ("push_subscriptions"."device_id" is null
      or exists (
        select 1 from "devices" as "ps_device"
        where "ps_device"."id" = "push_subscriptions"."device_id"
          and "ps_device"."tenant_id" = "push_subscriptions"."tenant_id"
          and "ps_device"."status" = 'active'
          and "ps_device"."revoked_at" is null)))`;
}

/** A panic alarm goes only to browsers registered for the alarm's outlet. */
export function pushOutletMatches(outlet: SQL | string | null): SQL {
  return outlet === null
    ? sql`true`
    : sql`"push_subscriptions"."outlet_id" = ${outlet}`;
}

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
          .select({
            subscription: pushSubscriptions,
            link: notifications.link,
          })
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
              deliverablePushSubscription(new Date()),
              // An emergency alarm only reaches browsers of its own outlet.
              sql`("notifications"."category" <> 'emergency'
                or "notifications"."outlet_id" is null
                or "push_subscriptions"."outlet_id" = "notifications"."outlet_id")`,
            ),
          )
          .orderBy(desc(pushSubscriptions.registeredAt))
          .limit(MAX_PUSH_SUBSCRIPTIONS_PER_ALERT);
        const targets: {
          row: typeof pushSubscriptions.$inferSelect;
          subscription: ReturnType<typeof openPushSubscription>;
        }[] = [];
        for (const { subscription: row } of rows) {
          // One unreadable subscription must not stop the others.
          try {
            const subscription = openPushSubscription(
              row.subscriptionCiphertext,
              row.tenantId,
              row.userId,
              row.endpointHash,
            );
            targets.push({ row, subscription });
          } catch {
            logger.warn(
              { subscriptionId: row.id },
              "Push subscription could not be opened; skipped",
            );
          }
        }
        // The attempt was planned for one saved endpoint: it must still be
        // among the deliverable ones, otherwise the plan is stale.
        if (!targets.some((t) => t.row.endpointHash === endpointHash))
          return null;
        const link = inAppLinkSchema.safeParse(rows[0]?.link);
        return { targets, url: link.success ? link.data : "/" };
      });
      if (!selected) return { reference: request.reference, accepted: false };
      const payload = JSON.stringify({
        title: request.title,
        body: request.body,
        tag: request.reference,
        data: { url: selected.url },
      });
      const topic = createHash("sha256")
        .update(request.reference)
        .digest("base64url")
        .slice(0, 32);
      // Sent in parallel: one endpoint that hangs (up to the 10 s timeout)
      // must not hold back the recipient's other browsers.
      const outcomes = await Promise.allSettled(
        selected.targets.map(async (target) => {
          try {
            await send(target.subscription, payload, {
              vapidDetails: config,
              TTL: 300,
              urgency: "high",
              timeout: 10_000,
              topic,
            });
            return { id: target.row.id, gone: false };
          } catch (error) {
            const status =
              typeof error === "object" &&
              error !== null &&
              "statusCode" in error &&
              typeof error.statusCode === "number"
                ? error.statusCode
                : null;
            if (status === 404 || status === 410)
              return { id: target.row.id, gone: true };
            // A WebPushError carries endpoint and response body: never
            // propagate it.
            throw new Error(
              status === null
                ? "Web push transport failed"
                : `Web push request failed with status ${status}`,
            );
          }
        }),
      );
      const succeeded: string[] = [];
      const gone: string[] = [];
      let transientFailure: Error | null = null;
      for (const outcome of outcomes) {
        if (outcome.status === "rejected")
          transientFailure =
            outcome.reason instanceof Error
              ? outcome.reason
              : new Error("Web push transport failed");
        else if (outcome.value.gone) gone.push(outcome.value.id);
        else succeeded.push(outcome.value.id);
      }
      // The push service says these browsers unsubscribed: drop their rows.
      // A failed cleanup must not turn a delivered alert into a retry (a
      // second send); the next alert meets the same 404/410 and retries it.
      if (gone.length > 0)
        await withTenant(database, context, (tx) =>
          tx
            .delete(pushSubscriptions)
            .where(
              and(
                eq(pushSubscriptions.tenantId, context.tenant.tenantId),
                inArray(pushSubscriptions.id, gone),
              ),
            ),
        ).catch(() =>
          logger.warn(
            { subscriptionIds: gone },
            "Gone push subscriptions could not be deleted",
          ),
        );
      const delivered = succeeded.length;
      // Any browser that took the alert counts as delivered. Only when none did
      // and one failed for a retryable reason is the attempt retried.
      if (delivered === 0 && transientFailure) throw transientFailure;
      if (delivered === 0)
        return { reference: request.reference, accepted: false };
      // Delivery succeeded already. Optional telemetry must never schedule a
      // second external send if its write fails after the provider accepted.
      await withTenant(database, context, (tx) =>
        tx
          .update(pushSubscriptions)
          .set({ lastSuccessAt: new Date() })
          .where(
            and(
              eq(pushSubscriptions.tenantId, context.tenant.tenantId),
              inArray(pushSubscriptions.id, succeeded),
            ),
          ),
      ).catch(() => undefined);
      return { reference: request.reference, accepted: true };
    },
  };
}

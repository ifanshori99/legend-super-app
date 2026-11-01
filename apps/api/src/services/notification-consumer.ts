import { sql } from "drizzle-orm";
import {
  createUlid,
  ulidToUuid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type { EventEnvelope } from "@starter/shared/events";
import {
  deliveryAttempts,
  notificationOutbox,
  notifications,
} from "../db/schema/notification.ts";
import type { consumeOutbox } from "./core-outbox.ts";
import {
  buildNotificationBatch,
  type NotificationRecipient,
} from "./notification-core.ts";

type Deliver = Parameters<typeof consumeOutbox>[2]["deliver"];
/** Resolve recipients, content and channel policy exclusively from trusted server state. */
export type NotificationRecipientResolver = (
  context: ScopedTenantContext,
  event: EventEnvelope,
  tx: Parameters<Deliver>[2],
) => Promise<NotificationRecipient[]>;

/** Used as consumeOutbox's callback: all rows and the source consumption commit together. */
export function createNotificationConsumer(
  context: ScopedTenantContext,
  resolve: NotificationRecipientResolver,
): Deliver {
  return async (event, _key, tx) => {
    const now = new Date();
    const batch = buildNotificationBatch(
      context,
      event,
      await resolve(context, event, tx),
      now,
    );
    const outboxId = ulidToUuid(createUlid());
    const inserted = await tx
      .insert(notificationOutbox)
      .values({
        tenantId: event.tenantId,
        outletId: event.outletId,
        id: outboxId,
        sourceEventId: ulidToUuid(event.id),
        eventType: event.name,
        payload: event.payload,
        status: "done",
        attempts: 1,
      })
      .onConflictDoNothing()
      .returning({ id: notificationOutbox.id });
    if (!inserted.length) return;
    for (const { notification, plan } of batch) {
      const notificationId = ulidToUuid(notification.id);
      const created = await tx
        .insert(notifications)
        .values({
          ...notification,
          id: notificationId,
          sourceEventId: ulidToUuid(event.id),
          createdAt: now,
          readAt: null,
        })
        .onConflictDoNothing()
        .returning({ id: notifications.id });
      if (!created.length) continue;
      for (const channel of plan.channels) {
        await tx.insert(deliveryAttempts).values({
          tenantId: event.tenantId,
          id: ulidToUuid(createUlid()),
          outletId: event.outletId,
          notificationId,
          channel: channel.channel,
          status: channel.decision === "skip" ? "skipped" : "queued",
          nextAttemptAt:
            channel.decision === "defer"
              ? new Date(channel.notBefore)
              : channel.decision === "send"
                ? now
                : null,
          idempotencyKey: `${notification.dedupeKey}:${channel.channel}`,
          skipReason: channel.decision === "skip" ? channel.reason : null,
        });
      }
      if (plan.realtime)
        await tx.execute(
          sql`SELECT pg_notify('legend_notification_wakeup', ${JSON.stringify({ tenantId: event.tenantId, notificationId: notification.id })})`,
        );
    }
  };
}

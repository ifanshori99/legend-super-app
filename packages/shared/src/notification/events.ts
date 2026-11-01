// Notification events (WS-05 line in events/catalog.ts). Payloads carry ids
// and categories only: no titles, bodies, addresses or phone numbers (PII
// stays in the notification rows, which are tenant-scoped under RLS).

import { z, userIdSchema } from "../core/index.ts";
import { defineDomainEvent } from "../events/define.ts";
import {
  deliveryAttemptIdSchema,
  externalChannelSchema,
  notificationCategorySchema,
  notificationIdSchema,
} from "./schemas.ts";

const base = {
  notificationId: notificationIdSchema,
  userId: userIdSchema,
  category: notificationCategorySchema,
};
const errorCode = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);

export const notificationCreated = defineDomainEvent({
  name: "notification.created",
  payload: z.strictObject({ ...base, realtime: z.boolean() }),
});
export const notificationSent = defineDomainEvent({
  name: "notification.sent",
  payload: z.strictObject({
    ...base,
    deliveryAttemptId: deliveryAttemptIdSchema,
    channel: externalChannelSchema,
    attempts: z.number().int().positive(),
  }),
});
export const notificationFailed = defineDomainEvent({
  name: "notification.failed",
  payload: z.strictObject({
    ...base,
    deliveryAttemptId: deliveryAttemptIdSchema,
    channel: externalChannelSchema,
    attempts: z.number().int().positive(),
    /** true = retries exhausted (status dead). */
    final: z.boolean(),
    errorCode,
  }),
});
export const notificationRead = defineDomainEvent({
  name: "notification.read",
  payload: z.strictObject(base),
});
export const notificationPreferenceUpdated = defineDomainEvent({
  name: "notification_preference.updated",
  payload: z.strictObject({
    userId: userIdSchema,
    changedCategories: z.array(notificationCategorySchema),
    quietHoursChanged: z.boolean(),
  }),
});

export const NOTIFICATION_EVENTS = [
  notificationCreated,
  notificationSent,
  notificationFailed,
  notificationRead,
  notificationPreferenceUpdated,
] as const;

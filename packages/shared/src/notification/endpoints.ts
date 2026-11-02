// HTTP contracts for the notification center, preferences, web push and the
// tenant channel policy (defineEndpoint pattern). The user is always the
// verified session user; tenant from the trusted context (TEN-02).

import {
  z,
  clientInputSchema,
  cursorPageQuerySchema,
  cursorPageSchema,
  dataResponseSchema,
  idrSchema,
  timeZoneSchema,
} from "../core/index.ts";
import { defineEndpoint } from "../api/endpoint.ts";
import {
  channelPreferenceSchema,
  notificationCategorySchema,
  notificationIdSchema,
  notificationPolicySchema,
  notificationPreferenceSchema,
  notificationSchema,
  notificationTemplateSchema,
  pushSubscriptionIdSchema,
  pushSubscriptionInputSchema,
  pushSubscriptionSchema,
  quietHoursSchema,
} from "./schemas.ts";

export const listNotifications = defineEndpoint({
  method: "GET",
  path: "/api/notifications",
  query: cursorPageQuerySchema.extend({
    unreadOnly: z.enum(["true", "false"]).optional(),
    category: notificationCategorySchema.optional(),
  }),
  response: cursorPageSchema(notificationSchema),
});
export const getUnreadNotificationCount = defineEndpoint({
  method: "GET",
  path: "/api/notifications/unread-count",
  response: dataResponseSchema(
    z.strictObject({ unread: z.number().int().nonnegative() }),
  ),
});
export const markNotificationRead = defineEndpoint({
  method: "POST",
  path: "/api/notifications/:notificationId/read",
  params: z.strictObject({ notificationId: notificationIdSchema }),
  response: dataResponseSchema(notificationSchema),
});
export const markAllNotificationsRead = defineEndpoint({
  method: "POST",
  path: "/api/notifications/read-all",
  response: dataResponseSchema(
    z.strictObject({ updated: z.number().int().nonnegative() }),
  ),
});

export const updateNotificationPreferenceInputSchema = clientInputSchema({
  categories: z.partialRecord(
    notificationCategorySchema,
    channelPreferenceSchema,
  ),
  quietHours: quietHoursSchema.nullable(),
  timeZone: timeZoneSchema,
});
export const getNotificationPreferences = defineEndpoint({
  method: "GET",
  path: "/api/notifications/preferences",
  response: dataResponseSchema(notificationPreferenceSchema),
});
export const updateNotificationPreferences = defineEndpoint({
  method: "PUT",
  path: "/api/notifications/preferences",
  body: updateNotificationPreferenceInputSchema,
  response: dataResponseSchema(notificationPreferenceSchema),
});

export const registerPushSubscription = defineEndpoint({
  method: "POST",
  path: "/api/notifications/push-subscriptions",
  body: pushSubscriptionInputSchema,
  response: dataResponseSchema(pushSubscriptionSchema),
});
/**
 * The tenant's VAPID public key for PushManager.subscribe. Served at runtime
 * per tenant (one web build serves every tenant), never baked into the
 * bundle. `null` while the tenant has web push off or no key configured.
 */
export const pushPublicKeySchema = z.strictObject({
  vapidPublicKey: z
    .string()
    .min(80)
    .max(100)
    .regex(/^[A-Za-z0-9_-]+$/)
    .nullable(),
});
export type PushPublicKey = z.infer<typeof pushPublicKeySchema>;
export const getPushPublicKey = defineEndpoint({
  method: "GET",
  path: "/api/notifications/push-key",
  response: dataResponseSchema(pushPublicKeySchema),
});
export const removePushSubscription = defineEndpoint({
  method: "DELETE",
  path: "/api/notifications/push-subscriptions/:subscriptionId",
  params: z.strictObject({ subscriptionId: pushSubscriptionIdSchema }),
});

/** Admin: tenant channel policy (WhatsApp stays off unless set here). */
export const updateNotificationPolicyInputSchema = clientInputSchema({
  webPushEnabled: z.boolean(),
  emailEnabled: z.boolean(),
  whatsapp: z.strictObject({
    enabled: z.boolean(),
    allowedCategories: z.array(notificationCategorySchema),
    monthlyCap: z.number().int().nonnegative().max(1_000_000),
    costPerMessageIdr: idrSchema.refine((n) => n >= 0),
  }),
  maxAttempts: z.number().int().min(1).max(10),
  retryBackoffSeconds: z.array(z.number().int().min(1).max(86_400)).min(1),
}).refine(
  (p) => !p.whatsapp.enabled || p.whatsapp.allowedCategories.length > 0,
  {
    path: ["whatsapp", "allowedCategories"],
    message: "Enabling WhatsApp needs at least one allowed category",
  },
);
export const getNotificationPolicy = defineEndpoint({
  method: "GET",
  path: "/api/notifications/policy",
  response: dataResponseSchema(notificationPolicySchema),
});
export const updateNotificationPolicy = defineEndpoint({
  method: "PUT",
  path: "/api/notifications/policy",
  body: updateNotificationPolicyInputSchema,
  response: dataResponseSchema(notificationPolicySchema),
});
export const listNotificationTemplates = defineEndpoint({
  method: "GET",
  path: "/api/notifications/templates",
  query: cursorPageQuerySchema.extend({
    category: notificationCategorySchema.optional(),
  }),
  response: cursorPageSchema(notificationTemplateSchema),
});

export const notificationEndpoints = [
  listNotifications,
  getUnreadNotificationCount,
  markNotificationRead,
  markAllNotificationsRead,
  getNotificationPreferences,
  updateNotificationPreferences,
  registerPushSubscription,
  getPushPublicKey,
  removePushSubscription,
  getNotificationPolicy,
  updateNotificationPolicy,
  listNotificationTemplates,
] as const;

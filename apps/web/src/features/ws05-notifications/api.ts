import type { z } from "zod";
import { callEndpoint } from "@/lib/api/endpoint";
import { listPushDevices } from "@starter/shared/identity";
import * as notification from "@starter/shared/notification";

// One caller per notification endpoint of @starter/shared/notification (bead
// legend-t9c). The screen reads fixtures through these in mock mode and the
// same code hits the API once legend-5ub / legend-hyq land. The user is the
// session user; no tenant id ever comes from the client (TEN-02).

export type NotificationListInput = z.input<
  typeof notification.listNotifications.query
>;
export type NotificationPreferenceInput = z.input<
  typeof notification.updateNotificationPreferences.body
>;
export type PushSubscriptionInput = z.input<
  typeof notification.registerPushSubscription.body
>;

export const fetchNotifications = (query: NotificationListInput) =>
  callEndpoint(notification.listNotifications, { query });

export const fetchUnreadNotificationCount = () =>
  callEndpoint(notification.getUnreadNotificationCount);

export const markNotificationAsRead = (notificationId: string) =>
  callEndpoint(notification.markNotificationRead, {
    params: { notificationId },
  });

export const markAllNotificationsAsRead = () =>
  callEndpoint(notification.markAllNotificationsRead);

export const fetchNotificationPreferences = () =>
  callEndpoint(notification.getNotificationPreferences);

export const saveNotificationPreferences = (
  body: NotificationPreferenceInput,
) => callEndpoint(notification.updateNotificationPreferences, { body });

/** Tenant channel policy: decides whether WhatsApp is offered at all. */
export const fetchNotificationPolicy = () =>
  callEndpoint(notification.getNotificationPolicy);

export const savePushSubscription = (body: PushSubscriptionInput) =>
  callEndpoint(notification.registerPushSubscription, { body });

export const deletePushSubscription = (subscriptionId: string) =>
  callEndpoint(notification.removePushSubscription, {
    params: { subscriptionId },
  });

/**
 * This account's deliverable push devices (the server's own view). Used to
 * confirm that this browser's stored subscription id is still registered.
 */
export const fetchOwnPushDevices = (signal?: AbortSignal) =>
  callEndpoint(listPushDevices, undefined, { signal });

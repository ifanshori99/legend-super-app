import { endpointQueryKey, endpointQueryOptions } from "@/lib/api/endpoint";
import { listPushDevices } from "@starter/shared/identity";
import * as notification from "@starter/shared/notification";
import { fetchOwnPushDevices } from "./api";

// Query keys and options for the notification center. Every key starts with
// the endpoint id, so one invalidateQueries({ queryKey: [id] }) refreshes
// every cached page of that endpoint (docs/frontend.md).

export const NOTIFICATIONS_PAGE_SIZE = 25;

export type NotificationFilters = {
  unreadOnly: boolean;
  category: notification.NotificationCategory | null;
};

/** One cursor page with the endpoint's wire query (unreadOnly is a string). */
export function notificationsPageQuery(
  filters: NotificationFilters,
  cursor?: string,
) {
  const query = {
    limit: NOTIFICATIONS_PAGE_SIZE,
    ...(cursor === undefined ? {} : { cursor }),
    ...(filters.unreadOnly ? { unreadOnly: "true" as const } : {}),
    ...(filters.category === null ? {} : { category: filters.category }),
  };
  // An inbox is read state, not a report: always revalidate on mount, also
  // after the SSR render, so ?mock=empty and ?mock=error apply in mock mode.
  return {
    ...endpointQueryOptions(notification.listNotifications, { query }),
    staleTime: 0,
  };
}

export const notificationsKeys = {
  /** Every cached list page (all filters, all cursors). */
  lists: () => [notification.listNotifications.id] as const,
  unreadCount: () => endpointQueryKey(notification.getUnreadNotificationCount),
  preferences: () => endpointQueryKey(notification.getNotificationPreferences),
  policy: () => endpointQueryKey(notification.getNotificationPolicy),
};

export const unreadCountQuery = () =>
  endpointQueryOptions(notification.getUnreadNotificationCount);

export const notificationPreferencesQuery = () =>
  endpointQueryOptions(notification.getNotificationPreferences);

/** Tenant VAPID public key, served at runtime per tenant (never build-time). */
export const pushPublicKeyQuery = () => ({
  ...endpointQueryOptions(notification.getPushPublicKey),
  staleTime: 5 * 60_000,
  retry: false,
});

export const notificationPolicyQuery = () =>
  endpointQueryOptions(notification.getNotificationPolicy);

/**
 * The server's list of deliverable push devices. Always fetched fresh: a
 * cached answer would hide a registration that just lapsed or was renewed.
 */
export const pushDevicesQuery = () => ({
  queryKey: endpointQueryKey(listPushDevices),
  queryFn: ({ signal }: { signal: AbortSignal }) => fetchOwnPushDevices(signal),
  staleTime: 0,
  retry: false,
});

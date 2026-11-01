import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useState } from "react";
import type { CursorPage } from "@starter/shared/core";
import type { Notification } from "@starter/shared/notification";
import {
  deletePushSubscription,
  markAllNotificationsAsRead,
  markNotificationAsRead,
  saveNotificationPreferences,
  savePushSubscription,
} from "./api";
import {
  notificationsKeys,
  notificationsPageQuery,
  notificationPolicyQuery,
  notificationPreferencesQuery,
  type NotificationFilters,
  unreadCountQuery,
} from "./queries";

// Cached notification pages, mutations with optimistic updates, preferences
// and the push subscription calls. Components never call apiFetch directly.

type UnreadCount = { data: { unread: number } };

function isUnreadOnlyKey(key: readonly unknown[]): boolean {
  const input = key[1] as { query?: { unreadOnly?: string } } | undefined;
  return input?.query?.unreadOnly === "true";
}

/** Reads every cached list page, applies `change`, keeps the rest untouched. */
function updateCachedPages(
  queryClient: ReturnType<typeof useQueryClient>,
  change: (
    page: CursorPage<Notification>,
    unreadOnly: boolean,
  ) => CursorPage<Notification>,
) {
  const entries = queryClient.getQueriesData<CursorPage<Notification>>({
    queryKey: notificationsKeys.lists(),
  });
  for (const [key, page] of entries) {
    if (!page) continue;
    queryClient.setQueryData(key, change(page, isUnreadOnlyKey(key)));
  }
}

export function useUnreadNotificationCount() {
  return useQuery(unreadCountQuery());
}

/**
 * The inbox, cursor by cursor (D-CORE-5). The first page is the route loader's
 * cache entry; "Muat lebih banyak" appends one more cursor.
 */
export function useNotificationPages(filters: NotificationFilters) {
  const queryClient = useQueryClient();
  const signature = `${filters.unreadOnly ? "unread" : "all"}:${filters.category ?? ""}`;
  const [cursors, setCursors] = useState<readonly (string | undefined)[]>([
    undefined,
  ]);
  // New filters start from the first page again (derived reset, no flash).
  const [lastSignature, setLastSignature] = useState(signature);
  if (lastSignature !== signature) {
    setLastSignature(signature);
    setCursors([undefined]);
  }
  const queries = useQueries({
    queries: cursors.map((cursor) => notificationsPageQuery(filters, cursor)),
  });
  const last = queries[queries.length - 1];
  const items = queries.flatMap((query) => query.data?.data ?? []);
  const nextCursor = last?.data?.meta.nextCursor ?? null;
  return {
    items,
    isLoading: queries[0]?.isPending ?? true,
    isFetchingMore: queries.slice(1).some((query) => query.isFetching),
    error: queries.find((query) => query.error)?.error ?? null,
    hasMore: nextCursor !== null,
    loadMore: () => {
      if (nextCursor !== null)
        setCursors((current) => [...current, nextCursor]);
    },
    refetch: () =>
      queryClient.invalidateQueries({ queryKey: notificationsKeys.lists() }),
  };
}

export function useMarkNotificationRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: markNotificationAsRead,
    onMutate: async (notificationId) => {
      await queryClient.cancelQueries({ queryKey: notificationsKeys.lists() });
      const previousLists = queryClient.getQueriesData<
        CursorPage<Notification>
      >({ queryKey: notificationsKeys.lists() });
      const previousCount = queryClient.getQueryData<UnreadCount>(
        notificationsKeys.unreadCount(),
      );
      let wasUnread = false;
      const readAt = new Date().toISOString();
      updateCachedPages(queryClient, (page, unreadOnly) => {
        const item = page.data.find((entry) => entry.id === notificationId);
        if (item && item.readAt === null) wasUnread = true;
        return {
          ...page,
          data: unreadOnly
            ? page.data.filter((entry) => entry.id !== notificationId)
            : page.data.map((entry) =>
                entry.id === notificationId ? { ...entry, readAt } : entry,
              ),
        };
      });
      if (wasUnread && previousCount) {
        queryClient.setQueryData<UnreadCount>(notificationsKeys.unreadCount(), {
          data: { unread: Math.max(0, previousCount.data.unread - 1) },
        });
      }
      return { previousLists, previousCount };
    },
    onError: (_error, _id, context) => {
      for (const [key, page] of context?.previousLists ?? [])
        queryClient.setQueryData(key, page);
      if (context?.previousCount)
        queryClient.setQueryData(
          notificationsKeys.unreadCount(),
          context.previousCount,
        );
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: notificationsKeys.lists(),
      });
      void queryClient.invalidateQueries({
        queryKey: notificationsKeys.unreadCount(),
      });
    },
  });
}

export function useMarkAllNotificationsRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: markAllNotificationsAsRead,
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: notificationsKeys.lists() });
      const previousLists = queryClient.getQueriesData<
        CursorPage<Notification>
      >({ queryKey: notificationsKeys.lists() });
      const previousCount = queryClient.getQueryData<UnreadCount>(
        notificationsKeys.unreadCount(),
      );
      const readAt = new Date().toISOString();
      updateCachedPages(queryClient, (page, unreadOnly) => ({
        ...page,
        data: unreadOnly
          ? []
          : page.data.map((entry) =>
              entry.readAt === null ? { ...entry, readAt } : entry,
            ),
      }));
      queryClient.setQueryData<UnreadCount>(notificationsKeys.unreadCount(), {
        data: { unread: 0 },
      });
      return { previousLists, previousCount };
    },
    onError: (_error, _variables, context) => {
      for (const [key, page] of context?.previousLists ?? [])
        queryClient.setQueryData(key, page);
      if (context?.previousCount)
        queryClient.setQueryData(
          notificationsKeys.unreadCount(),
          context.previousCount,
        );
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: notificationsKeys.lists(),
      });
      void queryClient.invalidateQueries({
        queryKey: notificationsKeys.unreadCount(),
      });
    },
  });
}

export function useNotificationPreferences() {
  return useQuery({ ...notificationPreferencesQuery(), retry: false });
}

/** Tenant policy: a 403 is not an error for this screen, just unknown. */
export function useNotificationPolicy() {
  return useQuery({ ...notificationPolicyQuery(), retry: false });
}

export function useSaveNotificationPreferences() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: saveNotificationPreferences,
    onSuccess: (preference) => {
      queryClient.setQueryData(notificationsKeys.preferences(), preference);
    },
  });
}

export function useSavePushSubscription() {
  return useMutation({ mutationFn: savePushSubscription });
}

export function useDeletePushSubscription() {
  return useMutation({ mutationFn: deletePushSubscription });
}

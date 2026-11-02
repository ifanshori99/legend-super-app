import { ApiError } from "@/lib/api/errors";
import { paginateFixture } from "@/lib/mock/paginate";
import { registerMock } from "@/lib/mock/registry";
import { createMockStore } from "@/lib/mock/store";
import * as contract from "@starter/shared/notification";

// Fixtures for the notification screens (docs/frontend.md "Mock mode"): the
// Cafe Legend sample user's inbox, preferences and tenant channel policy come
// from @starter/shared/notification, so the screen is reviewable with
// VITE_API_MOCK=true and the same contracts the API will validate with.

type MockState = {
  notifications: contract.Notification[];
  preference: contract.NotificationPreference;
  policy: contract.NotificationPolicy;
  subscriptions: contract.PushSubscription[];
};

const seed = (): MockState => {
  const fixtures = contract.cafeLegendNotificationFixtures;
  return {
    notifications: fixtures.notifications.map((item) => ({ ...item })),
    preference: {
      ...fixtures.baristaPreference,
      categories: { ...fixtures.baristaPreference.categories },
      quietHours: fixtures.baristaPreference.quietHours
        ? { ...fixtures.baristaPreference.quietHours }
        : null,
    },
    policy: {
      ...fixtures.policy,
      whatsapp: {
        ...fixtures.policy.whatsapp,
        allowedCategories: [...fixtures.policy.whatsapp.allowedCategories],
      },
    },
    subscriptions: [],
  };
};

const store = createMockStore(seed);

registerMock(contract.listNotifications, ({ query, scenario }) => {
  const { notifications } = store.get();
  const filtered = notifications.filter((item) => {
    if (query.unreadOnly === "true" && item.readAt !== null) return false;
    if (query.category !== undefined && item.category !== query.category)
      return false;
    return true;
  });
  return paginateFixture(filtered, query, (item) => item.id, scenario);
});

registerMock(contract.getUnreadNotificationCount, ({ scenario }) => ({
  data: {
    unread:
      scenario === "empty"
        ? 0
        : store.get().notifications.filter((item) => item.readAt === null)
            .length,
  },
}));

registerMock(contract.markNotificationRead, ({ params }) => {
  const state = store.get();
  const found = state.notifications.find(
    (item) => item.id === params.notificationId,
  );
  if (!found)
    throw new ApiError(404, "NOT_FOUND", "Notifikasi tidak ditemukan.");
  const updated =
    found.readAt === null
      ? { ...found, readAt: new Date().toISOString() }
      : found;
  store.set({
    ...state,
    notifications: state.notifications.map((item) =>
      item.id === updated.id ? updated : item,
    ),
  });
  return { data: updated };
});

registerMock(contract.markAllNotificationsRead, () => {
  const state = store.get();
  const readAt = new Date().toISOString();
  let updated = 0;
  const notifications = state.notifications.map((item) => {
    if (item.readAt !== null) return item;
    updated += 1;
    return { ...item, readAt };
  });
  store.set({ ...state, notifications });
  return { data: { updated } };
});

registerMock(contract.getNotificationPreferences, ({ scenario }) => {
  const { preference } = store.get();
  // "empty" = the user has never customized anything; catalog defaults apply.
  if (scenario === "empty")
    return { data: { ...preference, categories: {}, quietHours: null } };
  return { data: preference };
});

registerMock(contract.updateNotificationPreferences, ({ body }) => {
  const state = store.get();
  const preference: contract.NotificationPreference = {
    ...state.preference,
    categories: body.categories,
    quietHours: body.quietHours,
    timeZone: body.timeZone,
    updatedAt: new Date().toISOString(),
  };
  store.set({ ...state, preference });
  return { data: preference };
});

registerMock(contract.getNotificationPolicy, () => ({
  data: store.get().policy,
}));

// The tenant key follows the channel policy: off = no key = "unavailable".
registerMock(contract.getPushPublicKey, () => ({
  data: {
    vapidPublicKey: store.get().policy.webPushEnabled
      ? contract.cafeLegendNotificationFixtures.pushPublicKey
      : null,
  },
}));

registerMock(contract.registerPushSubscription, ({ body }) => {
  const state = store.get();
  // One row per browser in the sample data; the real API keys on endpoint.
  const existing = state.subscriptions.find(
    (item) => item.deviceLabel === body.deviceLabel,
  );
  if (existing) return { data: existing };
  const subscription: contract.PushSubscription = {
    id: contract.pushSubscriptionIdSchema.parse(crypto.randomUUID()),
    tenantId: state.preference.tenantId,
    userId: state.preference.userId,
    deviceLabel: body.deviceLabel,
    createdAt: new Date().toISOString(),
    lastSuccessAt: null,
  };
  store.set({
    ...state,
    subscriptions: [...state.subscriptions, subscription],
  });
  return { data: subscription };
});

registerMock(contract.removePushSubscription, ({ params }) => {
  const state = store.get();
  store.set({
    ...state,
    subscriptions: state.subscriptions.filter(
      (item) => item.id !== params.subscriptionId,
    ),
  });
  // Idempotent like a DELETE: removing a row that is already gone is fine.
});

import assert from "node:assert/strict";
import { test } from "node:test";
import * as n from "../packages/shared/src/notification/index.ts";
import { eventCatalogByName } from "../packages/shared/src/events/index.ts";

const f = n.cafeLegendNotificationFixtures;
const reachable = {
  hasPushSubscription: true,
  hasVerifiedEmail: true,
  whatsappOptIn: true,
};
const midday = new Date("2026-11-02T05:12:00.000Z"); // 12:12 WIB
const lateNight = new Date("2026-11-02T16:30:00.000Z"); // 23:30 WIB
const plan = (overrides = {}) =>
  n.planDelivery({
    category: "order_ready",
    policy: f.policy,
    preference: f.baristaPreference,
    reachability: reachable,
    whatsappSentThisMonth: 0,
    now: midday,
    defaultTimeZone: "Asia/Jakarta",
    ...overrides,
  });
const decision = (result, channel) =>
  result.channels.find((c) => c.channel === channel);
const waPolicy = {
  ...f.policy,
  whatsapp: {
    enabled: true,
    allowedCategories: ["subscription_billing"],
    monthlyCap: 1000,
    costPerMessageIdr: 500,
  },
};

test("F12 fixtures parse: policy, preferences, templates, records, outbox", () => {
  n.notificationPolicySchema.parse(f.policy);
  n.notificationPreferenceSchema.parse(f.baristaPreference);
  for (const t of f.templates) n.notificationTemplateSchema.parse(t);
  for (const row of f.notifications) n.notificationSchema.parse(row);
  for (const a of f.deliveryAttempts) n.deliveryAttemptSchema.parse(a);
  n.notificationOutboxRowSchema.parse(f.outboxRow);
  n.listNotifications.response.parse(f.notificationsPage);
  assert.ok(n.NOTIFICATION_CATEGORIES.length >= 10);
});

test("F12 channel cascade order is in-app, web push, email, WhatsApp; in-app always", () => {
  assert.deepEqual(
    [...n.NOTIFICATION_CHANNELS],
    ["in_app", "web_push", "email", "whatsapp"],
  );
  const result = plan();
  assert.equal(result.inApp, true);
  assert.equal(result.realtime, true);
  assert.deepEqual(
    result.channels.map((c) => c.channel),
    ["web_push", "email", "whatsapp"],
  );
  assert.equal(decision(result, "web_push").decision, "send");
  assert.equal(decision(result, "email").reason, "opted_out");
  // No preference row: the catalog default (web push only for order_ready).
  const fresh = plan({ preference: null });
  assert.equal(decision(fresh, "web_push").decision, "send");
  assert.equal(decision(fresh, "email").reason, "opted_out");
});

test("AUTH-03 U14 WhatsApp is off by default and never chosen under the default policy", () => {
  assert.equal(f.policy.whatsapp.enabled, false);
  for (const category of n.NOTIFICATION_CATEGORIES) {
    for (const meta of [n.categoryMeta(category)])
      assert.equal(meta.defaultChannels.includes("whatsapp"), false);
    const result = plan({
      category,
      preference: null,
      reachability: {
        hasPushSubscription: false,
        hasVerifiedEmail: false,
        whatsappOptIn: true,
      },
    });
    assert.equal(decision(result, "whatsapp").reason, "policy_disabled");
  }
  assert.equal(
    n.notificationPolicySchema.safeParse({
      ...f.policy,
      whatsapp: { ...f.policy.whatsapp, enabled: true },
    }).success,
    false,
  );
});

test("U14 WhatsApp is a capped last resort for allowed, opted-in categories only", () => {
  const optedIn = {
    ...f.baristaPreference,
    categories: {
      subscription_billing: { web_push: true, email: true, whatsapp: true },
    },
  };
  const base = {
    category: "subscription_billing",
    policy: waPolicy,
    preference: optedIn,
  };
  assert.equal(
    decision(plan(base), "whatsapp").reason,
    "free_channel_available",
  );
  const noFree = {
    ...base,
    reachability: {
      hasPushSubscription: false,
      hasVerifiedEmail: false,
      whatsappOptIn: true,
    },
  };
  assert.equal(decision(plan(noFree), "whatsapp").decision, "send");
  assert.equal(
    decision(plan({ ...noFree, whatsappSentThisMonth: 1000 }), "whatsapp")
      .reason,
    "cap_reached",
  );
  assert.equal(
    decision(plan({ ...noFree, category: "order_status" }), "whatsapp").reason,
    "category_not_allowed",
  );
  assert.equal(
    decision(
      plan({
        ...noFree,
        reachability: { ...noFree.reachability, whatsappOptIn: false },
      }),
      "whatsapp",
    ).reason,
    "unreachable",
  );
  assert.equal(n.FREE_CHANNELS.includes("whatsapp"), false);
});

test("F12 quiet hours defer external channels except security and emergency", () => {
  const night = plan({ now: lateNight });
  const push = decision(night, "web_push");
  assert.equal(push.decision, "defer");
  assert.equal(push.notBefore, "2026-11-03T00:00:00.000Z"); // 07:00 WIB
  assert.equal(night.inApp, true); // the record is still written at once
  for (const category of ["security", "emergency"]) {
    assert.equal(
      decision(plan({ now: lateNight, category }), "web_push").decision,
      "send",
    );
  }
  assert.equal(
    n.quietHoursEnd({ start: "22:00", end: "07:00" }, "Asia/Jakarta", midday),
    null,
  );
  // Same-day window, and the end instant is exclusive.
  const window = { start: "13:00", end: "15:00" };
  assert.equal(
    n
      .quietHoursEnd(
        window,
        "Asia/Jakarta",
        new Date("2026-11-02T07:30:00.000Z"),
      )
      ?.toISOString(),
    "2026-11-02T08:00:00.000Z",
  );
  assert.equal(
    n.quietHoursEnd(
      window,
      "Asia/Jakarta",
      new Date("2026-11-02T08:00:00.000Z"),
    ),
    null,
  );
  assert.equal(
    n.quietHoursSchema.safeParse({ start: "22:00", end: "22:00" }).success,
    false,
  );
});

test("legend-ahgg quiet hours end at the local wall time across spring DST", () => {
  assert.equal(
    n
      .quietHoursEnd(
        { start: "22:00", end: "07:00" },
        "America/New_York",
        new Date("2026-03-08T05:30:00.125Z"), // 00:30 EST
      )
      ?.toISOString(),
    "2026-03-08T11:00:00.000Z", // 07:00 EDT
  );
});

test("legend-ahgg quiet hours end at the local wall time across fall DST", () => {
  assert.equal(
    n
      .quietHoursEnd(
        { start: "22:00", end: "07:00" },
        "America/New_York",
        new Date("2026-11-01T04:30:00.125Z"), // 00:30 EDT
      )
      ?.toISOString(),
    "2026-11-01T12:00:00.000Z", // 07:00 EST
  );
});

test("legend-ahgg a same-day quiet window also follows a DST offset change", () => {
  assert.equal(
    n
      .quietHoursEnd(
        { start: "01:00", end: "04:00" },
        "America/New_York",
        new Date("2026-03-08T06:30:00.000Z"), // 01:30 EST
      )
      ?.toISOString(),
    "2026-03-08T08:00:00.000Z", // 04:00 EDT
  );
  assert.equal(
    n.quietHoursEnd(
      { start: "01:00", end: "04:00" },
      "America/New_York",
      new Date("2026-03-08T08:00:00.000Z"),
    ),
    null,
  );
});

test("legend-ahgg a missing spring end time ends quiet hours at the clock jump", () => {
  assert.equal(
    n
      .quietHoursEnd(
        { start: "22:00", end: "02:30" },
        "America/New_York",
        new Date("2026-03-08T06:30:00.000Z"), // 01:30 EST
      )
      ?.toISOString(),
    "2026-03-08T07:00:00.000Z", // The clock jumps straight to 03:00 EDT
  );
});

test("legend-ahgg a repeated fall end time chooses its next future occurrence", () => {
  const quiet = { start: "22:00", end: "01:30" };
  assert.equal(
    n
      .quietHoursEnd(
        quiet,
        "America/New_York",
        new Date("2026-11-01T05:15:00.000Z"), // First 01:15, EDT
      )
      ?.toISOString(),
    "2026-11-01T05:30:00.000Z",
  );
  assert.equal(
    n
      .quietHoursEnd(
        quiet,
        "America/New_York",
        new Date("2026-11-01T06:15:00.000Z"), // Second 01:15, EST
      )
      ?.toISOString(),
    "2026-11-01T06:30:00.000Z",
  );
});

test("F12 reliable delivery: status machine and limited retries", () => {
  assert.equal(n.canTransitionDelivery("queued", "sending"), true);
  assert.equal(n.canTransitionDelivery("failed", "queued"), true);
  assert.equal(n.canTransitionDelivery("delivered", "queued"), false);
  assert.equal(n.canTransitionDelivery("dead", "queued"), false);
  assert.throws(
    () => n.assertDeliveryTransition("sent", "sending"),
    (e) =>
      e instanceof n.NotificationError &&
      e.code === "NOTIFICATION_INVALID_TRANSITION",
  );
  const at = new Date("2026-11-02T05:00:00.000Z");
  assert.equal(
    n.nextRetryAt(f.policy, 1, at)?.toISOString(),
    "2026-11-02T05:00:30.000Z",
  );
  assert.equal(
    n.nextRetryAt(f.policy, 4, at)?.toISOString(),
    "2026-11-02T06:00:00.000Z",
  );
  assert.equal(n.nextRetryAt(f.policy, 5, at), null); // maxAttempts reached -> dead
});

test("F12 dedupe key is one per event, recipient and category", () => {
  const key = n.notificationDedupeKey(
    "01JBR2M4N5P6Q7R8S9T0V1W2X3",
    n.BARISTA_USER_ID,
    "order_ready",
  );
  assert.equal(key, f.notifications[0].dedupeKey);
  assert.notEqual(
    key,
    n.notificationDedupeKey(
      "01JBR2M4N5P6Q7R8S9T0V1W2X3",
      n.CUSTOMER_USER_ID,
      "order_ready",
    ),
  );
});

test("F12 templates: declared variables only, strict rendering, links stay relative", () => {
  const template = f.templates[0];
  const out = n.renderTemplate(template, {
    orderNumber: "A-042",
    itemCount: "3",
    tableName: "Private Room 2",
    orderId: "../../evil.com/x?y",
  });
  assert.equal(out.title, "Pesanan A-042 siap");
  assert.ok(out.link.startsWith("/staf/pesanan/"));
  assert.ok(!out.link.includes("/evil"));
  assert.throws(
    () => n.renderTemplate(template, { orderNumber: "A-1" }),
    (e) =>
      e instanceof n.NotificationError &&
      e.code === "NOTIFICATION_TEMPLATE_VARIABLE_MISSING",
  );
  assert.equal(
    n.renderTemplate(
      { title: "{{x}}", body: "b", link: null },
      { x: "a\r\nBcc: z" },
    ).title,
    "a  Bcc: z",
  );
  assert.equal(
    n.notificationTemplateSchema.safeParse({ ...template, title: "{{secret}}" })
      .success,
    false,
  );
  assert.equal(
    n.notificationTemplateSchema.safeParse({
      ...template,
      link: "https://evil.com",
    }).success,
    false,
  );
  assert.equal(
    n.notificationTemplateSchema.safeParse({ ...template, channel: "whatsapp" })
      .success,
    false,
  );
  assert.equal(n.inAppLinkSchema.safeParse("//evil.com").success, false);
  assert.equal(n.inAppLinkSchema.safeParse("/staf/perangkat").success, true);
});

test("TEN-02 endpoints refuse tenant/user fields and unsafe push endpoints", () => {
  const pref = { categories: {}, quietHours: null, timeZone: "Asia/Jakarta" };
  assert.equal(
    n.updateNotificationPreferences.body.safeParse(pref).success,
    true,
  );
  assert.equal(
    n.updateNotificationPreferences.body.safeParse({
      ...pref,
      tenantId: f.policy.tenantId,
    }).success,
    false,
  );
  assert.equal(
    n.updateNotificationPreferences.body.safeParse({
      ...pref,
      userId: n.BARISTA_USER_ID,
    }).success,
    false,
  );
  assert.equal(
    n.updateNotificationPreferences.body.safeParse({
      ...pref,
      categories: {
        marketing: { web_push: true, email: true, whatsapp: true },
      },
    }).success,
    false,
  );
  const push = {
    endpoint: "https://fcm.googleapis.com/fcm/send/abc",
    keys: {
      p256dh:
        "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
      auth: "tBHItJI5svbpez7KI4CCXg",
    },
    deviceLabel: "Android kasir",
  };
  assert.equal(n.registerPushSubscription.body.safeParse(push).success, true);
  assert.equal(
    n.registerPushSubscription.body.safeParse({
      ...push,
      endpoint: "http://fcm.googleapis.com/x",
    }).success,
    false,
  );
  assert.equal(
    n.registerPushSubscription.body.safeParse({
      ...push,
      endpoint: "https://10.0.0.5/x",
    }).success,
    false,
  );
  assert.equal(
    n.updateNotificationPolicy.body.safeParse({
      webPushEnabled: true,
      emailEnabled: true,
      whatsapp: {
        enabled: true,
        allowedCategories: [],
        monthlyCap: 10,
        costPerMessageIdr: 500,
      },
      maxAttempts: 3,
      retryBackoffSeconds: [30],
    }).success,
    false,
  );
  for (const endpoint of n.notificationEndpoints)
    assert.ok(endpoint.path.startsWith("/api/notifications"));
});

test("legend-w3v VAPID public key is served per tenant at runtime, nullable when off", () => {
  const key = n.getPushPublicKey.response;
  assert.equal(n.getPushPublicKey.method, "GET");
  assert.ok(n.notificationEndpoints.includes(n.getPushPublicKey));
  assert.equal(
    key.safeParse({ data: { vapidPublicKey: f.pushPublicKey } }).success,
    true,
  );
  assert.equal(key.safeParse({ data: { vapidPublicKey: null } }).success, true);
  for (const bad of ["", "short", `${f.pushPublicKey}=`, "a b".repeat(30)])
    assert.equal(
      key.safeParse({ data: { vapidPublicKey: bad } }).success,
      false,
    );
  // The private half or any tenant field never rides along.
  assert.equal(
    key.safeParse({
      data: { vapidPublicKey: f.pushPublicKey, privateKey: "x" },
    }).success,
    false,
  );
});

test("F12 notification events are registered on WS-05 and carry no message text", () => {
  for (const event of n.NOTIFICATION_EVENTS)
    assert.equal(eventCatalogByName.get(event.name)?.workstream, "WS-05");
  const payload = {
    notificationId: f.notifications[0].id,
    userId: n.BARISTA_USER_ID,
    category: "order_ready",
    realtime: true,
  };
  assert.equal(
    n.notificationCreated.payloadSchema.safeParse(payload).success,
    true,
  );
  assert.equal(
    n.notificationCreated.payloadSchema.safeParse({ ...payload, title: "x" })
      .success,
    false,
  );
  assert.equal(
    n.notificationFailed.payloadSchema.safeParse({
      ...payload,
      realtime: undefined,
      deliveryAttemptId: f.deliveryAttempts[0].id,
      channel: "web_push",
      attempts: 5,
      final: true,
      errorCode: "PUSH_GONE",
    }).success,
    false, // strict: unknown key `realtime`
  );
  const rest = { ...payload };
  delete rest.realtime;
  assert.equal(
    n.notificationFailed.payloadSchema.safeParse({
      ...rest,
      deliveryAttemptId: f.deliveryAttempts[0].id,
      channel: "web_push",
      attempts: 5,
      final: true,
      errorCode: "PUSH_GONE",
    }).success,
    true,
  );
  n.realtimeNotificationMessageSchema.parse({
    type: "notification",
    notification: f.notifications[0],
  });
});

test("F12 template links reject browser-normalized external hosts", () => {
  for (const link of ["/\\evil.example", "/\n/evil.example"]) {
    assert.equal(
      n.notificationTemplateSchema.safeParse({ ...f.templates[0], link })
        .success,
      false,
    );
    assert.throws(() => n.renderTemplate({ title: "t", body: "b", link }, {}));
  }
});

test("legend-307w3 security email ignores the tenant email switch and the user opt-out", () => {
  const emailOff = { ...f.policy, emailEnabled: false };
  const optedOut = {
    ...f.baristaPreference,
    categories: {
      security: { web_push: false, email: false, whatsapp: false },
    },
  };
  for (const preference of [null, f.baristaPreference, optedOut]) {
    const result = plan({
      category: "security",
      policy: emailOff,
      preference,
      now: lateNight,
    });
    assert.equal(decision(result, "email").decision, "send");
    assert.equal(decision(result, "email").notBefore, null);
    assert.equal(result.inApp, true);
  }
  // The user's own opt-out still wins for the other channels.
  assert.equal(
    decision(
      plan({ category: "security", policy: emailOff, preference: optedOut }),
      "web_push",
    ).reason,
    "opted_out",
  );
});

test("legend-307w3 security email still needs a verified address", () => {
  const result = plan({
    category: "security",
    policy: { ...f.policy, emailEnabled: false },
    preference: null,
    reachability: { ...reachable, hasVerifiedEmail: false },
  });
  assert.equal(decision(result, "email").reason, "unreachable");
});

test("legend-307w3 other categories keep the tenant email switch and the user opt-out", () => {
  for (const category of n.NOTIFICATION_CATEGORIES) {
    // Mandatory-email categories (security, tenant_invitation) have their own test above/below.
    if (n.isEmailMandatory(category)) continue;
    assert.equal(
      decision(
        plan({
          category,
          policy: { ...f.policy, emailEnabled: false },
          preference: null,
        }),
        "email",
      ).reason,
      "policy_disabled",
      category,
    );
    assert.equal(
      decision(
        plan({
          category,
          preference: {
            ...f.baristaPreference,
            categories: {
              [category]: { web_push: true, email: false, whatsapp: false },
            },
          },
        }),
        "email",
      ).reason,
      "opted_out",
      category,
    );
  }
});

test("legend-fy5y the first-admin invitation email ignores the tenant email switch and the user opt-out", () => {
  const emailOff = { ...f.policy, emailEnabled: false };
  const optedOut = {
    ...f.baristaPreference,
    categories: {
      tenant_invitation: { web_push: false, email: false, whatsapp: false },
    },
  };
  for (const preference of [null, f.baristaPreference, optedOut]) {
    const result = plan({
      category: "tenant_invitation",
      policy: emailOff,
      preference,
      now: lateNight,
    });
    assert.equal(decision(result, "email").decision, "send");
    assert.equal(decision(result, "email").notBefore, null);
  }
});

test("legend-md0zx the no-policy fallback is one shared, valid policy: web push only, email off, 3 tries", () => {
  const tenantId = f.policy.tenantId;
  const now = new Date("2026-11-09T10:00:00.000Z");
  const policy = n.defaultNotificationPolicy(tenantId, now);
  assert.deepEqual(n.notificationPolicySchema.parse(policy), policy);
  assert.equal(policy.tenantId, tenantId);
  assert.equal(policy.webPushEnabled, true);
  assert.equal(policy.emailEnabled, false);
  assert.equal(policy.whatsapp.enabled, false);
  assert.equal(policy.maxAttempts, 3);
  assert.deepEqual(policy.retryBackoffSeconds, [30, 120]);
  assert.equal(policy.updatedAt, now.toISOString());
});

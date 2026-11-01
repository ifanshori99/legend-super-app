import { describe, expect, it } from "vitest";
import { eventFixture } from "@starter/shared/events";
import {
  cafeLegendNotificationFixtures,
  notificationPolicySchema,
} from "@starter/shared/notification";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { buildNotificationBatch } from "../services/notification-core.ts";

const tenantId = eventFixture.tenantId;
const context = establishScopedTenantContext(
  establishTenantContext({ tenantId, brandId: null, source: "job" }),
  { kind: "tenant" },
);
const event = { ...eventFixture, outletId: null };
const policy = notificationPolicySchema.parse({
  ...cafeLegendNotificationFixtures.policy,
  tenantId,
});
const recipient = {
  userId: "33333333-3333-4333-8333-333333333333",
  category: "order_ready" as const,
  title: "Ready",
  body: "Order ready",
  link: null,
  policy,
  preference: null,
  reachability: {
    hasPushSubscription: true,
    hasVerifiedEmail: true,
    whatsappOptIn: false,
  },
  whatsappSentThisMonth: 0,
  defaultTimeZone: "Asia/Jakarta",
};

describe("notification event planning", () => {
  it("F15 creates one official record per event, recipient, and category and plans free channels first", () => {
    const result = buildNotificationBatch(
      context,
      event,
      [recipient, recipient],
      new Date("2026-11-01T12:00:00Z"),
    );
    expect(result).toHaveLength(1);
    expect(result[0].notification.dedupeKey).toBe(
      `${event.id}:${recipient.userId}:order_ready`,
    );
    expect(result[0].plan.inApp).toBe(true);
    expect(result[0].plan.channels.map((channel) => channel.channel)).toEqual([
      "web_push",
      "email",
      "whatsapp",
    ]);
    expect(result[0].plan.channels[2].decision).toBe("skip");
  });
  it("AUTH-03 F15 leaves WhatsApp disabled when policy defaults disable it", () => {
    const [result] = buildNotificationBatch(
      context,
      event,
      [
        {
          ...recipient,
          reachability: {
            hasPushSubscription: false,
            hasVerifiedEmail: false,
            whatsappOptIn: true,
          },
        },
      ],
      new Date("2026-11-01T12:00:00Z"),
    );
    expect(result.plan.channels[2]).toEqual({
      channel: "whatsapp",
      decision: "skip",
      reason: "policy_disabled",
    });
  });
  it("TEN-01 rejects a policy from a different tenant", () => {
    expect(() =>
      buildNotificationBatch(
        context,
        event,
        [{ ...recipient, policy: cafeLegendNotificationFixtures.policy }],
        new Date(),
      ),
    ).toThrow();
  });
});

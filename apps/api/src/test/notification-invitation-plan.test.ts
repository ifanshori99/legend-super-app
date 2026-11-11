// legend-fy5y T1-T3: the narrow "unverified email" exception for the first-admin
// invitation, at the pure planning level (@starter/shared/notification).
// No shared package has its own test runner; shared logic is tested here, like
// notification-core.test.ts.
//
// Contract (design-invite.md): Reachability.hasUnverifiedEmail is optional
// (missing = false, fail closed). Only category `tenant_invitation` may use it.
import { describe, expect, it } from "vitest";
import {
  NOTIFICATION_CATEGORIES,
  defaultNotificationPolicy,
  notificationPreferenceSchema,
  planDelivery,
  type NotificationCategory,
  type Reachability,
} from "@starter/shared/notification";

const tenantId = "a7000000-0000-4000-8000-000000000001";
const userId = "a7000000-0000-4000-8000-000000000002";
const now = new Date("2026-11-11T05:00:00.000Z");
// Default policy of a brand-new tenant: no policy row, emailEnabled false.
const policy = defaultNotificationPolicy(tenantId, now);

function reachability(extra: Record<string, boolean>): Reachability {
  return {
    hasPushSubscription: false,
    hasVerifiedEmail: false,
    whatsappOptIn: false,
    ...extra,
  } as Reachability;
}

function emailDecision(
  category: NotificationCategory,
  reach: Reachability,
  preference = null as ReturnType<
    typeof notificationPreferenceSchema.parse
  > | null,
) {
  const plan = planDelivery({
    category,
    policy,
    preference,
    reachability: reach,
    whatsappSentThisMonth: 0,
    now,
    defaultTimeZone: "Asia/Jakarta",
  });
  const email = plan.channels.find((c) => c.channel === "email");
  if (!email) throw new Error("plan has no email decision");
  return email;
}

const optedOut = notificationPreferenceSchema.parse({
  tenantId,
  userId,
  categories: {
    tenant_invitation: { web_push: false, email: false, whatsapp: false },
  },
  quietHours: null,
  timeZone: "Asia/Jakarta",
  updatedAt: "2026-11-11T04:00:00.000Z",
});

describe("legend-fy5y invitation email reachability", () => {
  it("T1 legend-fy5y no other category may email an unverified address", () => {
    const others = NOTIFICATION_CATEGORIES.filter(
      (category) => category !== "tenant_invitation",
    );
    expect(others.length).toBeGreaterThan(0);
    for (const category of others) {
      const decision = emailDecision(
        category,
        reachability({ hasVerifiedEmail: false, hasUnverifiedEmail: true }),
      );
      expect(decision.decision, category).toBe("skip");
      // `security` is mandatory-email so it reaches the reachability check;
      // the others stop earlier on policy/opt-out. Either way: never send.
      expect(decision.decision === "skip" && decision.reason, category).toMatch(
        /^(unreachable|policy_disabled|opted_out)$/,
      );
    }
    // security is the one that reaches the reachability gate: be exact there.
    expect(
      emailDecision("security", reachability({ hasUnverifiedEmail: true })),
    ).toEqual({ channel: "email", decision: "skip", reason: "unreachable" });
  });

  it("T2 legend-fy5y tenant_invitation sends to an unverified address despite policy off and user opt-out", () => {
    const decision = emailDecision(
      "tenant_invitation",
      reachability({ hasVerifiedEmail: false, hasUnverifiedEmail: true }),
      optedOut,
    );
    expect(decision).toEqual({
      channel: "email",
      decision: "send",
      notBefore: null,
    });
  });

  it("T3 legend-fy5y tenant_invitation fails closed when hasUnverifiedEmail is omitted", () => {
    expect(
      emailDecision("tenant_invitation", reachability({}), optedOut),
    ).toEqual({ channel: "email", decision: "skip", reason: "unreachable" });
    expect(
      emailDecision(
        "tenant_invitation",
        reachability({ hasUnverifiedEmail: false }),
      ),
    ).toEqual({ channel: "email", decision: "skip", reason: "unreachable" });
  });
});

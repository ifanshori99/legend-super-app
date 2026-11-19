// legend-z274 follow-up: `checklist_alert` is a new category. Users who tuned
// `schedule_update` before it existed keep that choice (no data migration):
// without an explicit `checklist_alert` preference it inherits `schedule_update`
// per channel; an explicit one always wins. Pure planning level, like
// notification-invitation-plan.test.ts.
import { describe, expect, it } from "vitest";
import {
  defaultNotificationPolicy,
  effectiveChannelPreference,
  notificationPreferenceSchema,
  planDelivery,
  type ChannelPreference,
  type NotificationCategory,
} from "@starter/shared/notification";

const tenantId = "a7000000-0000-4000-8000-000000000011";
const userId = "a7000000-0000-4000-8000-000000000012";
const now = new Date("2026-11-19T05:00:00.000Z");
const policy = {
  ...defaultNotificationPolicy(tenantId, now),
  webPushEnabled: true,
  emailEnabled: true,
};

const on: ChannelPreference = { web_push: true, email: true, whatsapp: false };
const off: ChannelPreference = {
  web_push: false,
  email: false,
  whatsapp: false,
};

function preference(
  categories: Partial<Record<NotificationCategory, ChannelPreference>>,
) {
  return notificationPreferenceSchema.parse({
    tenantId,
    userId,
    categories,
    quietHours: null,
    timeZone: "Asia/Jakarta",
    updatedAt: "2026-11-19T04:00:00.000Z",
  });
}

function decisions(pref: ReturnType<typeof preference> | null) {
  const plan = planDelivery({
    category: "checklist_alert",
    policy,
    preference: pref,
    reachability: {
      hasPushSubscription: true,
      hasVerifiedEmail: true,
      whatsappOptIn: false,
    },
    whatsappSentThisMonth: 0,
    now,
    defaultTimeZone: "Asia/Jakarta",
  });
  const get = (channel: string) =>
    plan.channels.find((c) => c.channel === channel)?.decision;
  return { push: get("web_push"), email: get("email") };
}

describe("legend-z274 checklist_alert inherits schedule_update", () => {
  it("a) a supervisor who turned schedule_update off gets no checklist alert", () => {
    const pref = preference({ schedule_update: off });
    expect(effectiveChannelPreference(pref, "checklist_alert")).toEqual(off);
    expect(decisions(pref)).toEqual({ push: "skip", email: "skip" });
  });

  it("a) inherits per channel, not all-or-nothing", () => {
    const pref = preference({
      schedule_update: { web_push: false, email: true, whatsapp: false },
    });
    expect(decisions(pref)).toEqual({ push: "skip", email: "send" });
  });

  it("b) an explicit checklist_alert on wins over schedule_update off", () => {
    const pref = preference({ schedule_update: off, checklist_alert: on });
    expect(decisions(pref)).toEqual({ push: "send", email: "send" });
  });

  it("b) an explicit checklist_alert off wins over schedule_update on", () => {
    const pref = preference({ schedule_update: on, checklist_alert: off });
    expect(decisions(pref)).toEqual({ push: "skip", email: "skip" });
  });

  it("c) with neither preference the catalog default applies (push only)", () => {
    expect(decisions(null)).toEqual({ push: "send", email: "skip" });
    expect(decisions(preference({ payslip: off }))).toEqual({
      push: "send",
      email: "skip",
    });
  });

  it("schedule_update itself never inherits from checklist_alert", () => {
    const pref = preference({ checklist_alert: off });
    expect(effectiveChannelPreference(pref, "schedule_update")).toEqual({
      web_push: true,
      email: false,
      whatsapp: false,
    });
  });
});

// Pure delivery rules (PRD §3.15): channel cascade, preferences, quiet hours,
// WhatsApp cap, retry state machine and template rendering. The worker in
// legend-5ub / legend-hyq calls these; the FE uses them for previews.

import {
  allowsUnverifiedEmail,
  categoryMeta,
  inAppLinkSchema,
  isEmailMandatory,
} from "./schemas.ts";
import type {
  ChannelPreference,
  DeliveryStatus,
  ExternalChannel,
  NotificationCategory,
  NotificationPolicy,
  NotificationPreference,
  NotificationTemplate,
  QuietHours,
} from "./schemas.ts";

export const notificationErrorHttpStatus = {
  /** A template variable was not supplied (never send half-rendered text). */
  NOTIFICATION_TEMPLATE_VARIABLE_MISSING: 422,
  /** Invalid delivery status transition. */
  NOTIFICATION_INVALID_TRANSITION: 409,
} as const satisfies Record<string, number>;
export type NotificationErrorCode = keyof typeof notificationErrorHttpStatus;

export class NotificationError extends Error {
  readonly code: NotificationErrorCode;
  readonly status: number;

  constructor(code: NotificationErrorCode, message: string = code) {
    super(message);
    this.name = "NotificationError";
    this.code = code;
    this.status = notificationErrorHttpStatus[code];
  }
}

// ---- Preferences + quiet hours ----------------------------------------------

/** The user's channels for a category, or the catalog default. */
export function effectiveChannelPreference(
  preference: NotificationPreference | null,
  category: NotificationCategory,
): ChannelPreference {
  const own = preference?.categories[category];
  if (own) return own;
  // legend-z274: `checklist_alert` was split out of `schedule_update`. A user
  // with no explicit `checklist_alert` keeps what they chose for
  // `schedule_update`, per channel, so no data migration is needed.
  if (category === "checklist_alert") {
    const legacy = preference?.categories.schedule_update;
    if (legacy) return legacy;
  }
  const defaults: readonly ExternalChannel[] =
    categoryMeta(category).defaultChannels;
  return {
    web_push: defaults.includes("web_push"),
    email: defaults.includes("email"),
    whatsapp: false,
  };
}

function minutesOf(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

function localSecondsOfDay(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(now);
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");
  return get("hour") * 3600 + get("minute") * 60 + get("second");
}

/**
 * If `now` falls inside the quiet window (start inclusive, end exclusive,
 * windows may cross midnight), returns the instant the window ends; else null.
 * Indonesian zones (Asia/Jakarta, Asia/Makassar, Asia/Jayapura) have no DST,
 * so wall-clock arithmetic is exact for every Legend outlet. A zone with DST
 * could see the end shift by an hour; supporting one needs a zoned-instant
 * computation first (bead legend-ahgg, low priority).
 */
export function quietHoursEnd(
  quietHours: QuietHours | null,
  timeZone: string,
  now: Date,
): Date | null {
  if (!quietHours) return null;
  const start = minutesOf(quietHours.start) * 60;
  const end = minutesOf(quietHours.end) * 60;
  const t = localSecondsOfDay(now, timeZone);
  const inside = start < end ? t >= start && t < end : t >= start || t < end;
  if (!inside) return null;
  const wait = (end - t + 86_400) % 86_400;
  const at = new Date(now.getTime() + wait * 1000);
  at.setUTCMilliseconds(0);
  return at;
}

// ---- Channel cascade ---------------------------------------------------------

export type SkipReason =
  | "policy_disabled"
  | "category_not_allowed"
  | "opted_out"
  | "unreachable"
  | "free_channel_available"
  | "cap_reached";

export type ChannelDecision =
  | { channel: ExternalChannel; decision: "send"; notBefore: null }
  | { channel: ExternalChannel; decision: "defer"; notBefore: string }
  | { channel: ExternalChannel; decision: "skip"; reason: SkipReason };

export type DeliveryPlan = {
  /** Always true: in-app is the official record (PRD §3.15). */
  inApp: true;
  /** Push the in-app record live over WebSocket. */
  realtime: boolean;
  channels: ChannelDecision[];
};

export type Reachability = {
  hasPushSubscription: boolean;
  hasVerifiedEmail: boolean;
  /**
   * Usable but unverified address. Counts only for categories that
   * `allowsUnverifiedEmail`; missing means false (fail closed).
   */
  hasUnverifiedEmail?: boolean;
  /** WhatsApp number on file with an explicit opt-in for notifications. */
  whatsappOptIn: boolean;
};

/**
 * Plans one notification for one recipient. WhatsApp is the last resort: it
 * is chosen only when the tenant enabled it, the category is allowed, the user
 * opted in, no free external channel will deliver, and the monthly cap is not
 * reached (PRD §3.15, U14). Quiet hours defer external channels unless the
 * category bypasses them (security, emergency).
 */
export function planDelivery(input: {
  category: NotificationCategory;
  policy: NotificationPolicy;
  preference: NotificationPreference | null;
  reachability: Reachability;
  whatsappSentThisMonth: number;
  now: Date;
  /** Recipient time zone when no preference row exists. */
  defaultTimeZone: string;
}): DeliveryPlan {
  const meta = categoryMeta(input.category);
  const wants = effectiveChannelPreference(input.preference, input.category);
  const quietEnd = meta.bypassQuietHours
    ? null
    : quietHoursEnd(
        input.preference?.quietHours ?? null,
        input.preference?.timeZone ?? input.defaultTimeZone,
        input.now,
      );
  const go = (channel: ExternalChannel): ChannelDecision =>
    quietEnd
      ? { channel, decision: "defer", notBefore: quietEnd.toISOString() }
      : { channel, decision: "send", notBefore: null };
  const skip = (
    channel: ExternalChannel,
    reason: SkipReason,
  ): ChannelDecision => ({
    channel,
    decision: "skip",
    reason,
  });

  const push = !input.policy.webPushEnabled
    ? skip("web_push", "policy_disabled")
    : !wants.web_push
      ? skip("web_push", "opted_out")
      : !input.reachability.hasPushSubscription
        ? skip("web_push", "unreachable")
        : go("web_push");
  // Security email is mandatory: neither the tenant switch nor the user's
  // opt-out applies (legend-307w3); only an unverified address skips it.
  const mandatoryEmail = isEmailMandatory(input.category);
  const email =
    !mandatoryEmail && !input.policy.emailEnabled
      ? skip("email", "policy_disabled")
      : !mandatoryEmail && !wants.email
        ? skip("email", "opted_out")
        : !(
              input.reachability.hasVerifiedEmail ||
              (allowsUnverifiedEmail(input.category) &&
                input.reachability.hasUnverifiedEmail === true)
            )
          ? skip("email", "unreachable")
          : go("email");
  const freeWillDeliver = push.decision !== "skip" || email.decision !== "skip";
  const wa = input.policy.whatsapp;
  const whatsapp = !wa.enabled
    ? skip("whatsapp", "policy_disabled")
    : !wa.allowedCategories.includes(input.category)
      ? skip("whatsapp", "category_not_allowed")
      : !wants.whatsapp
        ? skip("whatsapp", "opted_out")
        : !input.reachability.whatsappOptIn
          ? skip("whatsapp", "unreachable")
          : freeWillDeliver
            ? skip("whatsapp", "free_channel_available")
            : input.whatsappSentThisMonth >= wa.monthlyCap
              ? skip("whatsapp", "cap_reached")
              : go("whatsapp");

  return {
    inApp: true,
    realtime: meta.realtime,
    channels: [push, email, whatsapp],
  };
}

// ---- Delivery attempt state machine -----------------------------------------

const transitions: Record<DeliveryStatus, readonly DeliveryStatus[]> = {
  queued: ["sending", "skipped"],
  sending: ["sent", "failed"],
  sent: ["delivered", "failed"],
  failed: ["queued", "dead"],
  delivered: [],
  dead: [],
  skipped: [],
};

export function canTransitionDelivery(
  from: DeliveryStatus,
  to: DeliveryStatus,
): boolean {
  return transitions[from].includes(to);
}

export function assertDeliveryTransition(
  from: DeliveryStatus,
  to: DeliveryStatus,
): void {
  if (!canTransitionDelivery(from, to))
    throw new NotificationError(
      "NOTIFICATION_INVALID_TRANSITION",
      `Delivery cannot go from ${from} to ${to}`,
    );
}

/**
 * After a failed try: when to retry, or null when the attempt is dead
 * ("retry terbatas"). `attempts` counts tries made, the failed one included.
 */
export function nextRetryAt(
  policy: Pick<NotificationPolicy, "maxAttempts" | "retryBackoffSeconds">,
  attempts: number,
  failedAt: Date,
): Date | null {
  if (attempts >= policy.maxAttempts) return null;
  const table = policy.retryBackoffSeconds;
  const seconds = table[Math.min(attempts - 1, table.length - 1)];
  return new Date(failedAt.getTime() + seconds * 1000);
}

// ---- Template rendering -----------------------------------------------------

const PLACEHOLDER = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;
// Control characters (incl. CR/LF) are stripped from substituted values.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;

function fill(
  text: string,
  values: Readonly<Record<string, string>>,
  encode: (value: string) => string,
): string {
  return text.replace(PLACEHOLDER, (_, name: string) => {
    const value = values[name];
    if (value === undefined)
      throw new NotificationError(
        "NOTIFICATION_TEMPLATE_VARIABLE_MISSING",
        `Missing template variable ${name}`,
      );
    return encode(value.replace(CONTROL, " "));
  });
}

/** Renders title/body/link. Values in the link are URI-encoded, so they can
 * never turn a relative link into another host. */
export function renderTemplate(
  template: Pick<NotificationTemplate, "title" | "body" | "link">,
  values: Readonly<Record<string, string>>,
): { title: string; body: string; link: string | null } {
  return {
    title: fill(template.title, values, (v) => v),
    body: fill(template.body, values, (v) => v),
    link:
      template.link === null
        ? null
        : inAppLinkSchema.parse(
            fill(template.link, values, encodeURIComponent),
          ),
  };
}

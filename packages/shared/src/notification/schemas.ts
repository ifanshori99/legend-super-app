// Notification contracts (PRD v1.7 §3 item 15 "Notifikasi Hemat Biaya", F12,
// U14; §6.J `notifications` / `delivery_attempts` / `notification_outbox`).
// Channel order: in-app (the official record) -> web push -> email ->
// WhatsApp template (paid, off by default, allowed categories only, capped).
// Reuse source: 119connect notifikasi (categories, quiet hours, push
// subscription shape), adapted to Legend's categories and the transactional
// domain-event outbox (docs/plan/119connect-inventory.md).

import {
  z,
  uuidIdSchema,
  ulidIdSchema,
  ulidSchema,
  tenantIdSchema,
  outletIdSchema,
  userIdSchema,
  idrSchema,
  isoDateTimeSchema,
  timeOfDaySchema,
  timeZoneSchema,
} from "../core/index.ts";
import { eventNameSchema } from "../events/schemas.ts";
import { publicHttpsUrlSchema } from "../adapters/safety.ts";

export const notificationIdSchema = ulidIdSchema<"NotificationId">();
export const deliveryAttemptIdSchema = ulidIdSchema<"DeliveryAttemptId">();
export const notificationOutboxIdSchema =
  ulidIdSchema<"NotificationOutboxId">();
export const notificationTemplateIdSchema =
  uuidIdSchema<"NotificationTemplateId">();
export const pushSubscriptionIdSchema = uuidIdSchema<"PushSubscriptionId">();
export type NotificationId = z.infer<typeof notificationIdSchema>;

// ---- Channels ---------------------------------------------------------------

/** PRD §3.15 "Urutan Kanal", in cascade order. */
export const NOTIFICATION_CHANNELS = [
  "in_app",
  "web_push",
  "email",
  "whatsapp",
] as const;
export const notificationChannelSchema = z.enum(NOTIFICATION_CHANNELS);
export type NotificationChannel = z.infer<typeof notificationChannelSchema>;
/** Channels with a delivery attempt (in-app is the stored record itself). */
export const externalChannelSchema = z.enum(["web_push", "email", "whatsapp"]);
export type ExternalChannel = z.infer<typeof externalChannelSchema>;
/** Channels that cost nothing per message (U14: >= 90% of volume). */
export const FREE_CHANNELS: readonly NotificationChannel[] = [
  "in_app",
  "web_push",
  "email",
];

// ---- Categories -------------------------------------------------------------

type CategoryMeta = {
  audience: "staff" | "customer" | "any";
  /** Pushed live to staff devices over WebSocket (PRD §3.15 operasional). */
  realtime: boolean;
  /** Ignores quiet hours (PRD §3.15 "kecuali pemberitahuan keamanan"). */
  bypassQuietHours: boolean;
  /** Default external channels when the user has not set a preference. */
  defaultChannels: readonly ExternalChannel[];
  prd: string;
};

/**
 * Category catalog. WhatsApp is never a default channel: it needs the
 * tenant's policy, an allowed category and the user's opt-in.
 */
export const NOTIFICATION_CATEGORY_CATALOG = {
  waiter_call: {
    audience: "staff",
    realtime: true,
    bypassQuietHours: false,
    defaultChannels: ["web_push"],
    prd: "§3.15 Notifikasi Operasional",
  },
  order_ready: {
    audience: "staff",
    realtime: true,
    bypassQuietHours: false,
    defaultChannels: ["web_push"],
    prd: "§3.15 Notifikasi Operasional",
  },
  stock_critical: {
    audience: "staff",
    realtime: true,
    bypassQuietHours: false,
    defaultChannels: ["web_push"],
    prd: "§3.15 Notifikasi Operasional",
  },
  approval_request: {
    audience: "staff",
    realtime: true,
    bypassQuietHours: false,
    defaultChannels: ["web_push"],
    prd: "§3.15 Notifikasi Operasional; §3.7 Kotak Approval",
  },
  printer_offline: {
    audience: "staff",
    realtime: true,
    bypassQuietHours: false,
    defaultChannels: ["web_push"],
    prd: "§3.15 Notifikasi Operasional; EDG-05",
  },
  edge_sync_conflict: {
    audience: "staff",
    realtime: true,
    bypassQuietHours: false,
    defaultChannels: ["web_push"],
    prd: "§3 F5 Sinkronisasi; EDG-02 (legend-wqc6)",
  },
  // legend-8vgid: the payment gateway went down and bills move to the cashier.
  payment_failover: {
    audience: "staff",
    realtime: true,
    bypassQuietHours: false,
    defaultChannels: ["web_push"],
    prd: "§3.13 Failover; PAY-04 (legend-8vgid)",
  },
  cash_variance: {
    audience: "staff",
    realtime: true,
    bypassQuietHours: false,
    defaultChannels: ["web_push"],
    prd: "§3.15 Notifikasi Operasional",
  },
  emergency: {
    audience: "staff",
    realtime: true,
    bypassQuietHours: true,
    defaultChannels: ["web_push"],
    prd: "FAC-08 tombol darurat",
  },
  security: {
    audience: "any",
    realtime: false,
    bypassQuietHours: true,
    defaultChannels: ["web_push", "email"],
    prd: "§3.15 Preferensi (keamanan); §3.4 Support Access",
  },
  order_status: {
    audience: "customer",
    realtime: true,
    bypassQuietHours: false,
    defaultChannels: ["web_push"],
    prd: "§3.15; ORD-08",
  },
  reservation_confirmation: {
    audience: "customer",
    realtime: false,
    bypassQuietHours: false,
    defaultChannels: ["web_push", "email"],
    prd: "§3.22 DP & Kebijakan; RSV-03 (legend-lb3c)",
  },
  reservation_reminder: {
    audience: "customer",
    realtime: false,
    bypassQuietHours: false,
    defaultChannels: ["web_push", "email"],
    prd: "§3 Reservasi Pengingat",
  },
  facility_session: {
    audience: "customer",
    realtime: false,
    bypassQuietHours: false,
    defaultChannels: ["web_push"],
    prd: "§3 Fasilitas Sesi & Pengingat",
  },
  // legend-e24cz: polite reminder to a WFC guest who sat for full hours without
  // reaching the zone's minimum spend per hour (PRD §3 F39).
  wfc_min_spend: {
    audience: "customer",
    realtime: false,
    bypassQuietHours: false,
    defaultChannels: ["web_push"],
    prd: "§3 F39 Wi-Fi Berbasis Belanja; legend-e24cz",
  },
  subscription_billing: {
    audience: "customer",
    realtime: false,
    bypassQuietHours: false,
    defaultChannels: ["web_push", "email"],
    prd: "D24",
  },
  schedule_update: {
    audience: "staff",
    realtime: false,
    bypassQuietHours: false,
    defaultChannels: ["web_push"],
    prd: "§3 Notifikasi Jadwal",
  },
  // legend-z274: a checklist run that passed its deadline unfinished, or ended
  // with failed items (OPS-01). Its own category so a supervisor can tune it
  // apart from shift-schedule changes (`schedule_update`).
  checklist_alert: {
    audience: "staff",
    realtime: false,
    bypassQuietHours: false,
    defaultChannels: ["web_push"],
    prd: "§3 F27 Operasional Checklist; OPS-01; legend-z274",
  },
  payslip: {
    audience: "staff",
    realtime: false,
    bypassQuietHours: false,
    defaultChannels: ["web_push"],
    prd: "§4 Alur K",
  },
  daily_summary: {
    audience: "staff",
    realtime: false,
    bypassQuietHours: false,
    defaultChannels: ["web_push"],
    prd: "AI-10",
  },
  // AI-09: rule-based void / discount / refund / waste anomaly of one outlet
  // day. Its own category because `cash_variance` means a counted-cash
  // difference and would mislead for waste or discount spikes.
  operational_anomaly: {
    audience: "staff",
    realtime: true,
    bypassQuietHours: false,
    defaultChannels: ["web_push"],
    prd: "AI-09",
  },
  // legend-fy5y: first-admin invitation of a new tenant. The only category
  // that may reach an unverified address (see UNVERIFIED_EMAIL_CATEGORIES).
  tenant_invitation: {
    audience: "staff",
    realtime: false,
    bypassQuietHours: true,
    defaultChannels: ["email"],
    prd: "TEN-01",
  },
  // legend-jitc3: HR hears that a collective leave day was deducted again for
  // an employee whose offboarding is already settled (bill by hand).
  hr_settlement: {
    audience: "staff",
    realtime: false,
    bypassQuietHours: false,
    defaultChannels: ["web_push"],
    prd: "§3 F28 Offboarding; legend-jitc3",
  },
  // legend-078b: a QR line with no kitchen station, or a kitchen void of a QR
  // order. Not `waiter_call` (a guest request) or `order_ready` (a done order).
  kitchen_alert: {
    audience: "staff",
    realtime: true,
    bypassQuietHours: false,
    defaultChannels: ["web_push"],
    prd: "§3 F9 Kitchen Display System; KDS-01",
  },
  // legend-7gghu: the person whose login approved, proposed, recorded or
  // confirmed a payout step is told outside that session ("Bukan Anda?"). It
  // is the detection for a forged session row, so it ignores quiet hours and
  // its email cannot be switched off (see MANDATORY_EMAIL_CATEGORIES).
  payout_receipt: {
    audience: "staff",
    realtime: false,
    bypassQuietHours: true,
    defaultChannels: ["web_push", "email"],
    prd: "§4 Alur K; legend-7gghu",
  },
} as const satisfies Record<string, CategoryMeta>;

export type NotificationCategory = keyof typeof NOTIFICATION_CATEGORY_CATALOG;
export const NOTIFICATION_CATEGORIES = Object.keys(
  NOTIFICATION_CATEGORY_CATALOG,
) as [NotificationCategory, ...NotificationCategory[]];
export const notificationCategorySchema = z.enum(NOTIFICATION_CATEGORIES);

/**
 * Categories whose email cannot be switched off by the tenant policy
 * (`emailEnabled`) or by the user's own preference (legend-307w3): the user
 * must always learn about security events by email. An unverified address
 * stays unreachable; the other channels keep their normal opt-outs.
 */
export const MANDATORY_EMAIL_CATEGORIES: readonly NotificationCategory[] = [
  "security",
  "tenant_invitation",
  "payout_receipt",
];

/**
 * Narrow exception (legend-fy5y): the first-admin invitation is the only kind
 * that may be sent to an address that is not verified yet, because the link in
 * it is what verifies the address. Every other category keeps requiring a
 * verified email.
 */
export const UNVERIFIED_EMAIL_CATEGORIES: readonly NotificationCategory[] = [
  "tenant_invitation",
] as const;

export function allowsUnverifiedEmail(category: NotificationCategory): boolean {
  return UNVERIFIED_EMAIL_CATEGORIES.includes(category);
}

export function isEmailMandatory(category: NotificationCategory): boolean {
  return MANDATORY_EMAIL_CATEGORIES.includes(category);
}

export function categoryMeta(category: NotificationCategory): CategoryMeta {
  return NOTIFICATION_CATEGORY_CATALOG[category];
}

// ---- Tenant channel policy --------------------------------------------------

/** Tenant-wide channel policy. Costs, caps and retry limits are data. */
export const notificationPolicySchema = z
  .strictObject({
    tenantId: tenantIdSchema,
    webPushEnabled: z.boolean(),
    emailEnabled: z.boolean(),
    whatsapp: z.strictObject({
      /** Off by default (PRD §3.15; AUTH-03 for the login flow). */
      enabled: z.boolean(),
      allowedCategories: z.array(notificationCategorySchema),
      /** Messages per calendar month across the tenant; 0 = none. */
      monthlyCap: z.number().int().nonnegative().max(1_000_000),
      costPerMessageIdr: idrSchema.refine((n) => n >= 0),
    }),
    /** Total tries per external delivery, first one included. */
    maxAttempts: z.number().int().min(1).max(10),
    /** Wait before retry n (index 0 = before the 2nd try), in seconds. */
    retryBackoffSeconds: z.array(z.number().int().min(1).max(86_400)).min(1),
    updatedAt: isoDateTimeSchema,
  })
  .refine(
    (p) => !p.whatsapp.enabled || p.whatsapp.allowedCategories.length > 0,
    {
      path: ["whatsapp", "allowedCategories"],
      message: "Enabling WhatsApp needs at least one allowed category",
    },
  );
export type NotificationPolicy = z.infer<typeof notificationPolicySchema>;

/**
 * The policy a tenant has before it saves one (no `notification_policies`
 * row): web push only, no email, no WhatsApp, 3 tries with 30 s / 120 s
 * backoff. The worker, service requests, edge sync alerts and the
 * notification center all read this one fallback (legend-md0zx).
 */
export function defaultNotificationPolicy(
  tenantId: string,
  now: Date,
): NotificationPolicy {
  return notificationPolicySchema.parse({
    tenantId,
    webPushEnabled: true,
    emailEnabled: false,
    whatsapp: {
      enabled: false,
      allowedCategories: [],
      monthlyCap: 0,
      costPerMessageIdr: 0,
    },
    maxAttempts: 3,
    retryBackoffSeconds: [30, 120],
    updatedAt: now.toISOString(),
  });
}

// ---- User preferences -------------------------------------------------------

export const channelPreferenceSchema = z.strictObject({
  web_push: z.boolean(),
  email: z.boolean(),
  whatsapp: z.boolean(),
});
export type ChannelPreference = z.infer<typeof channelPreferenceSchema>;

export const quietHoursSchema = z
  .strictObject({
    start: timeOfDaySchema,
    end: timeOfDaySchema,
  })
  .refine((q) => q.start !== q.end, {
    path: ["end"],
    message: "Quiet hours must not start and end at the same time",
  });
export type QuietHours = z.infer<typeof quietHoursSchema>;

/** PRD §3.15 "Preferensi": categories and channels per user, quiet hours. In-
 * app is not optional: it is the official record. */
export const notificationPreferenceSchema = z.strictObject({
  tenantId: tenantIdSchema,
  userId: userIdSchema,
  /** Missing category = the catalog's defaultChannels. */
  categories: z.partialRecord(
    notificationCategorySchema,
    channelPreferenceSchema,
  ),
  quietHours: quietHoursSchema.nullable(),
  timeZone: timeZoneSchema,
  updatedAt: isoDateTimeSchema,
});
export type NotificationPreference = z.infer<
  typeof notificationPreferenceSchema
>;

// ---- Templates --------------------------------------------------------------

const PLACEHOLDER = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;
export function templatePlaceholders(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((m) => m[1]);
}

/** Relative in-app link: one leading slash, never "//host" or a scheme. */
export const inAppLinkSchema = z
  .string()
  .max(500)
  .regex(/^\/(?!\/)[^\s\\]*$/, "Links are relative paths starting with /");

export const notificationTemplateSchema = z
  .strictObject({
    id: notificationTemplateIdSchema,
    /** Null = platform default; a tenant row overrides it (whitelabel). */
    tenantId: tenantIdSchema.nullable(),
    category: notificationCategorySchema,
    channel: notificationChannelSchema,
    locale: z.enum(["id", "en"]),
    title: z.string().min(1).max(120),
    body: z.string().min(1).max(1000),
    /** Relative path template, e.g. "/pesanan/{{orderId}}". */
    link: inAppLinkSchema.nullable(),
    /** Provider-approved WhatsApp template name; required for whatsapp. */
    whatsappTemplateName: z
      .string()
      .regex(/^[a-z0-9_]{1,512}$/)
      .nullable(),
    variables: z.array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/)).max(20),
    version: z.number().int().positive(),
    isActive: z.boolean(),
  })
  .superRefine((t, ctx) => {
    const declared = new Set(t.variables);
    for (const field of ["title", "body", "link"] as const) {
      const text = t[field];
      if (text === null) continue;
      for (const name of templatePlaceholders(text))
        if (!declared.has(name))
          ctx.addIssue({
            code: "custom",
            path: [field],
            message: `Undeclared variable {{${name}}}`,
          });
    }
    if ((t.channel === "whatsapp") !== (t.whatsappTemplateName !== null))
      ctx.addIssue({
        code: "custom",
        path: ["whatsappTemplateName"],
        message: "whatsappTemplateName is required for, and only for, whatsapp",
      });
  });
export type NotificationTemplate = z.infer<typeof notificationTemplateSchema>;

// ---- Records ----------------------------------------------------------------

/** In-app notification (§6.J `notifications`): the official record. */
export const notificationSchema = z.strictObject({
  id: notificationIdSchema,
  tenantId: tenantIdSchema,
  outletId: outletIdSchema.nullable(),
  userId: userIdSchema,
  category: notificationCategorySchema,
  title: z.string().min(1).max(120),
  body: z.string().max(1000),
  link: inAppLinkSchema.nullable(),
  readAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  /** Domain event that caused it (null for manual/system notices). */
  sourceEventId: ulidSchema.nullable(),
  dedupeKey: z.string().min(1).max(200),
});
export type Notification = z.infer<typeof notificationSchema>;

export const DELIVERY_STATUSES = [
  "queued",
  "sending",
  "sent",
  "delivered",
  "failed",
  "dead",
  "skipped",
] as const;
export const deliveryStatusSchema = z.enum(DELIVERY_STATUSES);
export type DeliveryStatus = z.infer<typeof deliveryStatusSchema>;

/** Per-channel status (§6.J `delivery_attempts`, PRD "status per kanal"). */
export const deliveryAttemptSchema = z.strictObject({
  id: deliveryAttemptIdSchema,
  tenantId: tenantIdSchema,
  notificationId: notificationIdSchema,
  channel: externalChannelSchema,
  status: deliveryStatusSchema,
  /** Tries made so far. */
  attempts: z.number().int().nonnegative(),
  nextAttemptAt: isoDateTimeSchema.nullable(),
  /** Realized cost (U14 cost report); 0 for free channels. */
  costIdr: idrSchema.refine((n) => n >= 0),
  providerRef: z.string().max(255).nullable(),
  /** Machine code only; never provider bodies or recipient data. */
  errorCode: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{0,63}$/)
    .nullable(),
  skipReason: z.string().max(40).nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type DeliveryAttempt = z.infer<typeof deliveryAttemptSchema>;

/** §6.J `notification_outbox`: written in the same transaction as the domain
 * event (transactional outbox, legend-x5z); the worker fans it out. */
export const notificationOutboxRowSchema = z.strictObject({
  id: notificationOutboxIdSchema,
  tenantId: tenantIdSchema,
  sourceEventId: ulidSchema,
  eventType: eventNameSchema,
  payload: z.record(z.string(), z.json()),
  status: z.enum(["pending", "processing", "done", "dead"]),
  attempts: z.number().int().nonnegative(),
  availableAt: isoDateTimeSchema,
  lastErrorCode: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{0,63}$/)
    .nullable(),
  createdAt: isoDateTimeSchema,
});
export type NotificationOutboxRow = z.infer<typeof notificationOutboxRowSchema>;

/** One notification per (event, recipient, category): replays and duplicate
 * events never notify twice (PRD §3.15 "deduplikasi"). */
export function notificationDedupeKey(
  sourceEventId: string,
  userId: string,
  category: NotificationCategory,
): string {
  return `${sourceEventId}:${userId}:${category}`;
}

// ---- Web push subscription --------------------------------------------------

const base64url = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[A-Za-z0-9_-]+=*$/);

/** Browser PushSubscription.toJSON() (iOS >= 16.4 PWA included). */
export const pushSubscriptionInputSchema = z.strictObject({
  endpoint: publicHttpsUrlSchema,
  keys: z.strictObject({ p256dh: base64url(200), auth: base64url(100) }),
  deviceLabel: z.string().trim().max(100).nullable(),
  /**
   * Outlet whose panic alarms this browser should receive. The server accepts
   * it only when the caller holds the emergency respond permission there; a
   * registered device (X-Device-Token) fixes the outlet itself.
   */
  outletId: outletIdSchema.optional(),
});
export const pushSubscriptionSchema = z.strictObject({
  id: pushSubscriptionIdSchema,
  tenantId: tenantIdSchema,
  userId: userIdSchema,
  /** The endpoint and keys stay server-side; clients see only the label. */
  deviceLabel: z.string().max(100).nullable(),
  createdAt: isoDateTimeSchema,
  lastSuccessAt: isoDateTimeSchema.nullable(),
});
export type PushSubscription = z.infer<typeof pushSubscriptionSchema>;

/** WebSocket frame for realtime operational notifications. */
export const realtimeNotificationMessageSchema = z.strictObject({
  type: z.literal("notification"),
  notification: notificationSchema,
});

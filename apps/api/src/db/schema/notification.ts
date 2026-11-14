import {
  bigint,
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { outlets } from "./platform-org";

/** IDs in the shared ULID contract are stored losslessly as UUIDs. */
export const notificationOutbox = pgTable(
  "notification_outbox",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").notNull(),
    outletId: uuid("outlet_id"),
    sourceEventId: uuid("source_event_id").notNull(),
    eventType: varchar("event_type", { length: 255 }).notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastErrorCode: varchar("last_error_code", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    unique("notification_outbox_event_key").on(
      table.tenantId,
      table.sourceEventId,
    ),
    index("notification_outbox_due_idx").on(
      table.tenantId,
      table.status,
      table.availableAt,
    ),
    index("notification_outbox_alarm_window_idx").on(
      table.tenantId,
      table.eventType,
      table.outletId,
      table.createdAt,
    ),
  ],
);

export const notifications = pgTable(
  "notifications",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").notNull(),
    outletId: uuid("outlet_id"),
    userId: uuid("user_id").notNull(),
    category: varchar("category", { length: 80 }).notNull(),
    title: varchar("title", { length: 120 }).notNull(),
    body: varchar("body", { length: 1000 }).notNull(),
    link: text("link"),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    sourceEventId: uuid("source_event_id"),
    dedupeKey: varchar("dedupe_key", { length: 200 }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    // legend-bd95: the outlet must belong to the row's own tenant (MATCH SIMPLE: NULL outlet stays valid).
    foreignKey({
      name: "notifications_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    unique("notifications_dedupe_key").on(table.tenantId, table.dedupeKey),
    index("notifications_user_created_idx").on(
      table.tenantId,
      table.userId,
      table.createdAt,
      table.id,
    ),
  ],
);

export const deliveryAttempts = pgTable(
  "delivery_attempts",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").notNull(),
    outletId: uuid("outlet_id"),
    notificationId: uuid("notification_id").notNull(),
    channel: varchar("channel", { length: 20 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    idempotencyKey: varchar("idempotency_key", { length: 255 }).notNull(),
    costIdr: bigint("cost_idr", { mode: "number" }).notNull().default(0),
    providerRef: varchar("provider_ref", { length: 255 }),
    errorCode: varchar("error_code", { length: 64 }),
    skipReason: varchar("skip_reason", { length: 40 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    // legend-bd95: the outlet must belong to the row's own tenant (MATCH SIMPLE: NULL outlet stays valid).
    foreignKey({
      name: "delivery_attempts_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    unique("delivery_attempts_channel_key").on(
      table.tenantId,
      table.notificationId,
      table.channel,
    ),
    unique("delivery_attempts_idempotency_key").on(
      table.tenantId,
      table.idempotencyKey,
    ),
    foreignKey({
      columns: [table.tenantId, table.notificationId],
      foreignColumns: [notifications.tenantId, notifications.id],
    }),
    index("delivery_attempts_due_idx").on(
      table.tenantId,
      table.status,
      table.nextAttemptAt,
    ),
  ],
);

/** Tenant policy, with WhatsApp disabled unless explicitly configured. */
export const notificationPolicies = pgTable("notification_policies", {
  tenantId: uuid("tenant_id").primaryKey(),
  webPushEnabled: boolean("web_push_enabled").notNull().default(true),
  emailEnabled: boolean("email_enabled").notNull().default(true),
  whatsapp: jsonb("whatsapp")
    .$type<{
      enabled: boolean;
      allowedCategories: string[];
      monthlyCap: number;
      costPerMessageIdr: number;
    }>()
    .notNull(),
  maxAttempts: integer("max_attempts").notNull().default(3),
  retryBackoffSeconds: jsonb("retry_backoff_seconds")
    .$type<number[]>()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const notificationPreferences = pgTable(
  "notification_preferences",
  {
    tenantId: uuid("tenant_id").notNull(),
    userId: uuid("user_id").notNull(),
    categories: jsonb("categories")
      .$type<
        Record<string, { web_push: boolean; email: boolean; whatsapp: boolean }>
      >()
      .notNull(),
    quietHours: jsonb("quiet_hours").$type<{ start: string; end: string }>(),
    timeZone: varchar("time_zone", { length: 100 }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.userId] })],
);

/** Endpoint and browser keys are encrypted together; lookup uses a keyed digest. */
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").notNull(),
    userId: uuid("user_id").notNull(),
    endpointHash: varchar("endpoint_hash", { length: 128 }).notNull(),
    subscriptionCiphertext: text("subscription_ciphertext").notNull(),
    keyVersion: varchar("key_version", { length: 64 }).notNull(),
    deviceLabel: varchar("device_label", { length: 100 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    unique("push_subscriptions_endpoint_key").on(
      table.tenantId,
      table.userId,
      table.endpointHash,
    ),
  ],
);

/** Platform templates are provided by a separate trusted catalog. */
export const notificationTemplates = pgTable(
  "notification_templates",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").notNull(),
    category: varchar("category", { length: 80 }).notNull(),
    channel: varchar("channel", { length: 20 }).notNull(),
    locale: varchar("locale", { length: 2 }).notNull(),
    title: varchar("title", { length: 120 }).notNull(),
    body: varchar("body", { length: 1000 }).notNull(),
    link: varchar("link", { length: 500 }),
    whatsappTemplateName: varchar("whatsapp_template_name", { length: 512 }),
    variables: jsonb("variables").$type<string[]>().notNull(),
    version: integer("version").notNull(),
    isActive: boolean("is_active").notNull().default(true),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    unique("notification_templates_version_key").on(
      table.tenantId,
      table.category,
      table.channel,
      table.locale,
      table.version,
    ),
  ],
);

/** A reservation survives ambiguous provider outcomes, preventing cap reuse. */
export const whatsappReservations = pgTable(
  "whatsapp_reservations",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").notNull(),
    outletId: uuid("outlet_id"),
    deliveryAttemptId: uuid("delivery_attempt_id").notNull(),
    month: varchar("month", { length: 7 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("reserved"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    // legend-bd95: the outlet must belong to the row's own tenant (MATCH SIMPLE: NULL outlet stays valid).
    foreignKey({
      name: "whatsapp_reservations_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    unique("whatsapp_reservations_attempt_key").on(
      table.tenantId,
      table.deliveryAttemptId,
    ),
    foreignKey({
      columns: [table.tenantId, table.deliveryAttemptId],
      foreignColumns: [deliveryAttempts.tenantId, deliveryAttempts.id],
    }),
    index("whatsapp_reservations_month_idx").on(table.tenantId, table.month),
  ],
);

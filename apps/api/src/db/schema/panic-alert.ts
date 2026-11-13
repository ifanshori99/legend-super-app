// Emergency (panic) button tables (bead legend-bod; design
// docs/design/edge-emergency.md D-08). All four tables exist in the cloud and
// edge databases (same image); receiver sessions and deliveries are only
// written where the relay hub runs.
//
// - device_id and unit_id carry NO foreign key: a safety record is never
//   refused because the cloud deleted the room or device while the edge was
//   offline. The alert keeps label snapshots instead.
// - panic_alerts is append-mostly: drizzle/0316_panic_alerts.sql adds the
//   guard trigger (identity, snapshots and received_at immutable;
//   acknowledged_* and resolved_* set once; no DELETE).
// - Tenant + outlet RLS (forced) on every table: drizzle/0316..0318.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { outletIdColumn, tenantIdColumn } from "../columns.ts";
import { outlets, tenants } from "./platform-org.ts";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

export const panicAlerts = pgTable(
  "panic_alerts",
  {
    /** Deterministic UUID from SHA-256(tenant, device, first device event). */
    id: uuid("id").notNull(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    deviceId: uuid("device_id").notNull(),
    unitId: uuid("unit_id"),
    firstDeviceEventId: text("first_device_event_id").notNull(),
    unitCodeSnapshot: text("unit_code_snapshot").notNull(),
    facilityNameSnapshot: text("facility_name_snapshot").notNull(),
    deviceLabelSnapshot: text("device_label_snapshot").notNull(),
    kind: text("kind").notNull().default("press"),
    /** Device clock, informational only. */
    triggeredAt: timestamp("triggered_at", { withTimezone: true }),
    /** Edge clock, authoritative for response time. */
    receivedAt: timestamp("received_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    pressCount: integer("press_count").notNull().default(1),
    origin: text("origin").notNull().default("edge"),
    originEdgeNodeId: uuid("origin_edge_node_id"),
    /** Raised on the edge while the outlet had no internet. */
    linkOffline: boolean("link_offline").notNull().default(false),
    firstDeliveredAt: timestamp("first_delivered_at", { withTimezone: true }),
    deliveredCount: integer("delivered_count").notNull().default(0),
    unroutedSince: timestamp("unrouted_since", { withTimezone: true }),
    fallbackShownAt: timestamp("fallback_shown_at", { withTimezone: true }),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    /** Better Auth account id of the first acknowledger. */
    acknowledgedBy: text("acknowledged_by"),
    ackDeviceId: uuid("ack_device_id"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: text("resolved_by"),
    resolutionNote: varchar("resolution_note", { length: 500 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    primaryKey({ name: "panic_alerts_pkey", columns: [t.tenantId, t.id] }),
    foreignKey({
      name: "panic_alerts_outlet_fk",
      columns: [t.tenantId, t.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    index("panic_alerts_outlet_received_idx").on(
      t.tenantId,
      t.outletId,
      t.receivedAt.desc(),
    ),
    index("panic_alerts_outlet_open_idx")
      .on(t.tenantId, t.outletId)
      .where(sql`${t.acknowledgedAt} IS NULL`),
    check("panic_alerts_kind_check", sql`${t.kind} IN ('press', 'test')`),
    check("panic_alerts_origin_check", sql`${t.origin} IN ('edge', 'cloud')`),
    check("panic_alerts_press_count_check", sql`${t.pressCount} >= 0`),
    check("panic_alerts_delivered_count_check", sql`${t.deliveredCount} >= 0`),
    check(
      "panic_alerts_ack_pair_check",
      sql`(${t.acknowledgedAt} IS NULL) = (${t.acknowledgedBy} IS NULL)`,
    ),
    check(
      "panic_alerts_resolve_pair_check",
      sql`(${t.resolvedAt} IS NULL) = (${t.resolvedBy} IS NULL)`,
    ),
  ],
);

export const panicPressEvents = pgTable(
  "panic_press_events",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    deviceId: uuid("device_id").notNull(),
    deviceEventId: text("device_event_id").notNull(),
    alertId: uuid("alert_id").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    primaryKey({
      name: "panic_press_events_pkey",
      columns: [t.tenantId, t.deviceId, t.deviceEventId],
    }),
    foreignKey({
      name: "panic_press_events_outlet_fk",
      columns: [t.tenantId, t.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "panic_press_events_alert_fk",
      columns: [t.tenantId, t.alertId],
      foreignColumns: [panicAlerts.tenantId, panicAlerts.id],
    }),
    index("panic_press_events_alert_idx").on(t.tenantId, t.alertId),
  ],
);

export const panicReceiverSessions = pgTable(
  "panic_receiver_sessions",
  {
    id: uuid("id").defaultRandom().notNull(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    deviceId: uuid("device_id").notNull(),
    userId: text("user_id").notNull(),
    /** SHA-256 of the cookie secret; the secret itself is never stored. */
    tokenHash: bytea("token_hash").notNull(),
    /** The PIN generation the session was opened with. */
    pinGenerationAt: timestamp("pin_generation_at", {
      withTimezone: true,
    }).notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokeReason: text("revoke_reason"),
  },
  (t) => [
    primaryKey({
      name: "panic_receiver_sessions_pkey",
      columns: [t.tenantId, t.id],
    }),
    foreignKey({
      name: "panic_receiver_sessions_outlet_fk",
      columns: [t.tenantId, t.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    uniqueIndex("panic_receiver_sessions_token_key").on(
      t.tenantId,
      t.tokenHash,
    ),
    uniqueIndex("panic_receiver_sessions_active_device_key")
      .on(t.tenantId, t.deviceId)
      .where(sql`${t.revokedAt} IS NULL`),
    index("panic_receiver_sessions_outlet_user_idx").on(
      t.tenantId,
      t.outletId,
      t.userId,
    ),
    check(
      "panic_receiver_sessions_token_hash_check",
      sql`octet_length(${t.tokenHash}) = 32`,
    ),
    check(
      "panic_receiver_sessions_revoke_reason_check",
      sql`${t.revokeReason} IS NULL OR ${t.revokeReason} IN ('logout', 'replaced', 'pin_changed', 'staff_inactive', 'permission_removed', 'device_revoked', 'off_duty', 'expired')`,
    ),
    check(
      "panic_receiver_sessions_revoke_pair_check",
      sql`(${t.revokedAt} IS NULL) = (${t.revokeReason} IS NULL)`,
    ),
  ],
);

export const panicAlertDeliveries = pgTable(
  "panic_alert_deliveries",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    alertId: uuid("alert_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    userId: text("user_id").notNull(),
    firstSentAt: timestamp("first_sent_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    sentCount: integer("sent_count").notNull().default(1),
    /** Receiver confirmation (`received` frame); null until confirmed. */
    receivedAt: timestamp("received_at", { withTimezone: true }),
  },
  (t) => [
    primaryKey({
      name: "panic_alert_deliveries_pkey",
      columns: [t.tenantId, t.alertId, t.sessionId],
    }),
    foreignKey({
      name: "panic_alert_deliveries_outlet_fk",
      columns: [t.tenantId, t.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "panic_alert_deliveries_alert_fk",
      columns: [t.tenantId, t.alertId],
      foreignColumns: [panicAlerts.tenantId, panicAlerts.id],
    }),
    foreignKey({
      name: "panic_alert_deliveries_session_fk",
      columns: [t.tenantId, t.sessionId],
      foreignColumns: [
        panicReceiverSessions.tenantId,
        panicReceiverSessions.id,
      ],
    }),
    check("panic_alert_deliveries_sent_count_check", sql`${t.sentCount} >= 1`),
  ],
);

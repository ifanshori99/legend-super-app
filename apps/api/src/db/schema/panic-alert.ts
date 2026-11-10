// Panic alert relay (bead legend-bod; PRD v1.7 §3 F25 "Keselamatan", FAC-08).
// One row per panic-button press the outlet's relay accepted. The device
// supplies `event_id` (idempotency: a replayed press is the same row) and
// `triggered_at` (device clock, informational). `received_at` is the server
// clock and the only time the response time is measured from.
//
// - `fanned_out_at` + `recipient_count` record the LAN fan-out to on-duty
//   staff; `facility_incident_id` links the incident row raised for the unit.
// - `acknowledged_by` is the Better Auth account id; the first ack wins.
// - Tenant + outlet RLS: drizzle/0238_panic_alert_relay.sql.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { outletIdColumn, tenantIdColumn, ulidInUuid } from "../columns.ts";
import { devices } from "./device.ts";
import { facilityIncidents } from "./facility.ts";
import { outlets, tenants } from "./platform-org.ts";

export const panicAlerts = pgTable(
  "panic_alerts",
  {
    id: ulidInUuid("id").primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    deviceId: uuid("device_id").notNull(),
    /** Device-supplied idempotency key. */
    eventId: varchar("event_id", { length: 100 }).notNull(),
    unitId: uuid("unit_id"),
    facilityIncidentId: uuid("facility_incident_id"),
    /** Device clock, informational only. */
    triggeredAt: timestamp("triggered_at", { withTimezone: true }).notNull(),
    /** Server clock, authoritative. */
    receivedAt: timestamp("received_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    fannedOutAt: timestamp("fanned_out_at", { withTimezone: true }),
    recipientCount: integer("recipient_count").notNull().default(0),
    acknowledgedBy: text("acknowledged_by"),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    /** Raised on the edge while the outlet had no internet. */
    offline: boolean("offline").notNull().default(false),
  },
  (t) => [
    unique("panic_alerts_tenant_id_id_key").on(t.tenantId, t.id),
    unique("panic_alerts_device_event_key").on(
      t.tenantId,
      t.deviceId,
      t.eventId,
    ),
    index("panic_alerts_outlet_received_idx").on(
      t.tenantId,
      t.outletId,
      t.receivedAt.desc(),
    ),
    foreignKey({
      name: "panic_alerts_outlet_fk",
      columns: [t.tenantId, t.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "panic_alerts_device_fk",
      columns: [t.tenantId, t.deviceId],
      foreignColumns: [devices.tenantId, devices.id],
    }),
    foreignKey({
      name: "panic_alerts_incident_fk",
      columns: [t.tenantId, t.facilityIncidentId],
      foreignColumns: [facilityIncidents.tenantId, facilityIncidents.id],
    }),
    check("panic_alerts_recipient_count_check", sql`${t.recipientCount} >= 0`),
    // The first acknowledgement sets both columns together.
    check(
      "panic_alerts_ack_pair_check",
      sql`(${t.acknowledgedBy} IS NULL) = (${t.acknowledgedAt} IS NULL)`,
    ),
  ],
);

// Edge Wi-Fi agent grant ledger (bead legend-hsk; PRD v1.7 §3 F5 + F25,
// FAC-11, FAC-13; plan docs/briefs/sub-ws09-wifi-plan.md §2).
// One row per controller grant the edge's Wi-Fi agent asks for. The row id is
// the provider `reference`: a reference's request (device, tier, rate,
// duration) is fixed at the controller, so those columns never change
// (edge-wifi.custom.sql trigger). The row is written `pending` BEFORE the
// controller is called (write-ahead); a lost answer leaves it `unknown` and the
// reconcile loop re-authorizes the same reference.
//
// - Edge-local operational table: never synced to the cloud. Same migration on
//   the cloud and the edge (one image); empty on the cloud.
// - Speed changes are make-before-break: the new grant becomes `active`, the
//   old one `superseded` (superseded_by), never revoked at the controller.
// - At most one `active` and one in-flight (`pending`/`unknown`) grant per
//   device per outlet.
// - controller_device_id is the raw controller id (MAC, personal data). It is
//   kept only while the grant is live and scrubbed (NULL) on every terminal
//   row. device_hash = sha256 hex of `${tenantId}:${normalized id}` is only a
//   lookup key, not anonymization.
// - wifi_session_id is opaque here; kmd3 adds the FK to wifi_sessions.
// - Tenant + outlet RLS and the update guard: edge-wifi.custom.sql.
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { outletIdColumn, tenantIdColumn } from "../columns.ts";
import { outlets, tenants } from "./platform-org.ts";

export const wifiDeviceGrants = pgTable(
  "wifi_device_grants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    wifiSessionId: uuid("wifi_session_id").notNull(),
    deviceHash: varchar("device_hash", { length: 64 }).notNull(),
    controllerDeviceId: varchar("controller_device_id", { length: 64 }),
    speedTier: varchar("speed_tier", { length: 8 }).notNull(),
    bandwidthKbps: integer("bandwidth_kbps").notNull(),
    // Lets the loop downgrade a full grant at quota end without kmd3 (FAC-13).
    baseBandwidthKbps: integer("base_bandwidth_kbps").notNull(),
    durationSeconds: integer("duration_seconds").notNull(),
    status: varchar("status", { length: 16 }).notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    // Code only, never a message from the vendor.
    lastErrorCode: varchar("last_error_code", { length: 64 }),
    // min(sessionEndsAt, requested_at + 24 h): base renewals stop here.
    renewUntil: timestamp("renew_until", { withTimezone: true }).notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull(),
    authorizedAt: timestamp("authorized_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    // Write-ahead for revoke retries; set together with end_reason.
    revokeRequestedAt: timestamp("revoke_requested_at", { withTimezone: true }),
    endReason: varchar("end_reason", { length: 32 }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    supersededBy: uuid("superseded_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    unique("wifi_device_grants_tenant_id_key").on(t.tenantId, t.id),
    unique("wifi_device_grants_tenant_outlet_id_key").on(
      t.tenantId,
      t.outletId,
      t.id,
    ),
    // One live controller grant per device: make-before-break keeps the old
    // active row until the new one is confirmed, then supersedes it.
    uniqueIndex("wifi_device_grants_one_active")
      .on(t.tenantId, t.outletId, t.deviceHash)
      .where(sql`${t.status} = 'active'`),
    uniqueIndex("wifi_device_grants_one_inflight")
      .on(t.tenantId, t.outletId, t.deviceHash)
      .where(sql`${t.status} IN ('pending','unknown')`),
    index("wifi_device_grants_session_idx").on(
      t.tenantId,
      t.outletId,
      t.wifiSessionId,
    ),
    index("wifi_device_grants_loop_idx").on(
      t.tenantId,
      t.outletId,
      t.status,
      t.expiresAt,
    ),
    foreignKey({
      name: "wifi_device_grants_outlet_fk",
      columns: [t.tenantId, t.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    // The successor is a grant of the same tenant and outlet.
    foreignKey({
      name: "wifi_device_grants_superseded_by_fk",
      columns: [t.tenantId, t.outletId, t.supersededBy],
      foreignColumns: [t.tenantId, t.outletId, t.id],
    }),
    check(
      "wifi_device_grants_device_hash_check",
      sql`${t.deviceHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "wifi_device_grants_speed_tier_check",
      sql`${t.speedTier} IN ('full','base')`,
    ),
    check(
      "wifi_device_grants_bandwidth_check",
      sql`${t.bandwidthKbps} BETWEEN 1 AND 1000000`,
    ),
    check(
      "wifi_device_grants_base_bandwidth_check",
      sql`${t.baseBandwidthKbps} BETWEEN 1 AND 1000000 AND ${t.baseBandwidthKbps} <= ${t.bandwidthKbps}`,
    ),
    check(
      "wifi_device_grants_duration_check",
      sql`${t.durationSeconds} BETWEEN 1 AND 129600`,
    ),
    check(
      "wifi_device_grants_status_check",
      sql`${t.status} IN ('pending','active','unknown','superseded','revoked','failed')`,
    ),
    check(
      "wifi_device_grants_attempt_count_check",
      sql`${t.attemptCount} >= 0`,
    ),
    // Personal data: the raw controller id lives only on live rows.
    check(
      "wifi_device_grants_scrub_check",
      sql`(${t.controllerDeviceId} IS NOT NULL) = (${t.status} IN ('pending','active','unknown'))`,
    ),
    check(
      "wifi_device_grants_active_check",
      sql`${t.status} <> 'active' OR (${t.authorizedAt} IS NOT NULL AND ${t.expiresAt} IS NOT NULL)`,
    ),
    check(
      "wifi_device_grants_ended_check",
      sql`(${t.endedAt} IS NOT NULL) = (${t.status} IN ('superseded','revoked','failed'))`,
    ),
    // FAC-13: running out of quota never ends a grant, so no quota reason.
    check(
      "wifi_device_grants_end_reason_check",
      sql`${t.endReason} IS NULL OR ${t.endReason} IN ('session_ended','staff_revoked','device_moved','day_closed')`,
    ),
    // end_reason is written with the revoke request (write-ahead), and a
    // revoked grant always carries both.
    check(
      "wifi_device_grants_revoke_request_check",
      sql`(${t.revokeRequestedAt} IS NULL) = (${t.endReason} IS NULL) AND (${t.status} <> 'revoked' OR ${t.revokeRequestedAt} IS NOT NULL)`,
    ),
    check(
      "wifi_device_grants_superseded_check",
      sql`(${t.supersededBy} IS NOT NULL) = (${t.status} = 'superseded') AND ${t.supersededBy} IS DISTINCT FROM ${t.id}`,
    ),
  ],
);

export type WifiDeviceGrantRow = typeof wifiDeviceGrants.$inferSelect;

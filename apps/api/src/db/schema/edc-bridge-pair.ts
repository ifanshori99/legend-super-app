// EDC bridge pairing codes (B4 legend-wasr7.24). Backoffice no longer shows a
// device token: creating a device (or "issue a new code") answers an
// 8-character code, valid 10 minutes, single use. The tablet trades it at
// POST /api/edc-bridge/pair for the device token (shown once).
//
// - `edc_bridge_pair_codes`: one row per code, tenant + outlet + device (FK on
//   all three, as 0541). The first 4 characters (`code_selector`) find the
//   row; only the keyed HMAC-SHA-256 of the whole code is stored
//   (`code_hash`, identityDigest "edc-pair-code"). A wrong code with a live
//   code's selector counts against that code (`failed_attempts`); at 5 the
//   code is locked, even for the right code. One live code per device: a new
//   one sets `revoked_at` on the old one.
// - `edc_bridge_pair_ip_slots`: the per-IP limit (5 wrong codes in 15 minutes)
//   in the database, so it survives a restart and is shared by every API
//   instance. No tenant (a tablet is anonymous before pairing); keyed by the
//   client IP digest, never the address. Reached only through SECURITY
//   DEFINER functions; legend_app has no grant on the table.
// RLS and functions: edc-bridge-pair.custom.sql (migration 0543).
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { outletIdColumn, tenantIdColumn, ulidInUuid } from "../columns.ts";
import { edcBridgeDevices } from "./edc-bridge-devices.ts";
import { outlets, tenants } from "./platform-org.ts";

export const edcBridgePairCodes = pgTable(
  "edc_bridge_pair_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    deviceId: ulidInUuid("device_id").notNull(),
    codeSelector: varchar("code_selector", { length: 4 }).notNull(),
    codeHash: varchar("code_hash", { length: 64 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    failedAttempts: integer("failed_attempts").notNull().default(0),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    foreignKey({
      name: "edc_bridge_pair_codes_device_fk",
      columns: [t.tenantId, t.outletId, t.deviceId],
      foreignColumns: [
        edcBridgeDevices.tenantId,
        edcBridgeDevices.outletId,
        edcBridgeDevices.id,
      ],
    }),
    foreignKey({
      name: "edc_bridge_pair_codes_outlet_fk",
      columns: [t.tenantId, t.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    // One live (unused, not cancelled) code per device.
    uniqueIndex("edc_bridge_pair_codes_live_device_key")
      .on(t.tenantId, t.deviceId)
      .where(sql`${t.usedAt} IS NULL AND ${t.revokedAt} IS NULL`),
    index("edc_bridge_pair_codes_live_selector_idx")
      .on(t.codeSelector)
      .where(sql`${t.usedAt} IS NULL AND ${t.revokedAt} IS NULL`),
    check(
      "edc_bridge_pair_codes_selector_check",
      sql`${t.codeSelector} ~ '^[2-9A-HJKMNP-Z]{4}$'`,
    ),
    check(
      "edc_bridge_pair_codes_hash_check",
      sql`${t.codeHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "edc_bridge_pair_codes_failed_attempts_check",
      sql`${t.failedAttempts} BETWEEN 0 AND 5`,
    ),
  ],
);

export type EdcBridgePairCodeRow = typeof edcBridgePairCodes.$inferSelect;

export const edcBridgePairIpSlots = pgTable(
  "edc_bridge_pair_ip_slots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ipHash: varchar("ip_hash", { length: 64 }).notNull(),
    takenAt: timestamp("taken_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("edc_bridge_pair_ip_slots_ip_idx").on(t.ipHash, t.takenAt),
    index("edc_bridge_pair_ip_slots_taken_idx").on(t.takenAt),
    check(
      "edc_bridge_pair_ip_slots_hash_check",
      sql`${t.ipHash} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

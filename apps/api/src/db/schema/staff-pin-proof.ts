// One-time PIN proofs for outlet-device attendance (bead legend-u7g9w).
//
// - staff_pin_proofs: a short-lived, single-use proof that a staff member typed
//   their PIN on a registered outlet device. Only sha256(token) is stored.
//   Bound to tenant, outlet, device, user and purpose. A new proof for the
//   same device ends the previous unused one (service layer). Tenant + outlet
//   owned (staff-pin-proof.custom.sql).
// - device_pin_throttle: per-device fixed window counter of wrong PINs across
//   all staff (guess-spraying guard). Tenant owned (staff-pin-proof.custom.sql).
//
// - user_pin_throttle: per-requester fixed window counter of wrong approver
//   PINs (bead legend-vfj7z). Keyed by the authenticated requester's user id, so
//   a client that drops X-Device-Token still meets a limit. Tenant owned
//   (staff-pin-proof.custom.sql).
//
// core_storage_objects.pin_proof_id (core-storage.ts) links a selfie upload to
// the proof that authorised it.
import { sql } from "drizzle-orm";
import {
  check,
  customType,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { outletIdColumn, tenantIdColumn } from "../columns.ts";
import { devices } from "./device.ts";
import { outlets, tenants } from "./platform-org.ts";
import { user } from "./user.ts";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

export type StaffPinProofPurpose = "attendance_clock";

export const staffPinProofs = pgTable(
  "staff_pin_proofs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    deviceId: uuid("device_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id),
    purpose: varchar("purpose", { length: 32 })
      .$type<StaffPinProofPurpose>()
      .notNull(),
    /** sha256 of the opaque token; the token itself is never stored. */
    tokenHash: bytea("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("staff_pin_proofs_device_idx").on(table.tenantId, table.deviceId),
    foreignKey({
      name: "staff_pin_proofs_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "staff_pin_proofs_device_fk",
      columns: [table.tenantId, table.outletId, table.deviceId],
      foreignColumns: [devices.tenantId, devices.outletId, devices.id],
    }),
    check(
      "staff_pin_proofs_purpose_check",
      sql`${table.purpose} IN ('attendance_clock')`,
    ),
    check(
      "staff_pin_proofs_token_hash_check",
      sql`octet_length(${table.tokenHash}) = 32`,
    ),
  ],
);

export const devicePinThrottle = pgTable(
  "device_pin_throttle",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    deviceId: uuid("device_id").notNull(),
    windowStartedAt: timestamp("window_started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    failures: integer("failures").notNull().default(0),
    /** Window for which the audit + alert already fired (once per window). */
    alertedWindowStartedAt: timestamp("alerted_window_started_at", {
      withTimezone: true,
    }),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.deviceId] }),
    foreignKey({
      name: "device_pin_throttle_device_fk",
      columns: [table.tenantId, table.deviceId],
      foreignColumns: [devices.tenantId, devices.id],
    }).onDelete("cascade"),
    check("device_pin_throttle_failures_check", sql`${table.failures} >= 0`),
  ],
);

export const userPinThrottle = pgTable(
  "user_pin_throttle",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    windowStartedAt: timestamp("window_started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    failures: integer("failures").notNull().default(0),
    /** Window for which the audit + alert already fired (once per window). */
    alertedWindowStartedAt: timestamp("alerted_window_started_at", {
      withTimezone: true,
    }),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.userId] }),
    check("user_pin_throttle_failures_check", sql`${table.failures} >= 0`),
  ],
);

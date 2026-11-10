// Acting cashier per device (bead legend-aruta; docs/DECISIONS.md "Kasir aktif
// per perangkat lewat token server").
//
// After a PIN switch on a shared POS device the server issues an opaque token
// (`pas_...`, only its sha256 is stored) bound to device, outlet, staff member
// AND the login session of the device owner. The `X-Acting-Staff` header makes
// that staff member the actor and the permission subject of POS requests.
//
// Tenant + outlet owned: the migration calls `app.enforce_tenant_rls(...)` and
// `app.enforce_outlet_rls(...)` (RLS ENABLE + FORCE). The app role may SELECT,
// INSERT and UPDATE (revoke, never delete). Separate from the PIN proof table
// of the device-pin service; the verify core is untouched.
//
// - One live token per device (partial unique index): a new switch revokes the
//   previous one in the same transaction.
// - TTL is capped at 12 hours by a check; shift and day close revoke earlier.
// - `revoked_at` and `revoke_reason` are set together or not at all.
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { outletIdColumn, tenantIdColumn } from "../columns";
import { devices } from "./device";
import { outlets, tenants } from "./platform-org";
import { user } from "./user";

export const posActingStaff = pgTable(
  "pos_acting_staff",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    deviceId: uuid("device_id").notNull(),
    /** The staff member who is the actor and permission subject. */
    staffUserId: text("staff_user_id")
      .notNull()
      .references(() => user.id),
    /** The login-session owner of the device (never the permission subject). */
    sessionUserId: text("session_user_id")
      .notNull()
      .references(() => user.id),
    /**
     * Better Auth session id, matched on every request so a logout ends the
     * token. No foreign key: a deleted session must not block or cascade.
     */
    sessionId: text("session_id").notNull(),
    /** sha256 hex of the token. Never the token. */
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokeReason: varchar("revoke_reason", { length: 20 }),
  },
  (table) => [
    unique("pos_acting_staff_token_hash_key").on(table.tokenHash),
    foreignKey({
      name: "pos_acting_staff_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "pos_acting_staff_device_fk",
      columns: [table.tenantId, table.outletId, table.deviceId],
      foreignColumns: [devices.tenantId, devices.outletId, devices.id],
    }),
    // One live token per device.
    uniqueIndex("pos_acting_staff_live_device_key")
      .on(table.tenantId, table.deviceId)
      .where(sql`${table.revokedAt} IS NULL`),
    index("pos_acting_staff_live_staff_idx")
      .on(table.tenantId, table.outletId, table.staffUserId)
      .where(sql`${table.revokedAt} IS NULL`),
    check(
      "pos_acting_staff_ttl_check",
      sql`${table.expiresAt} <= ${table.issuedAt} + interval '12 hours'`,
    ),
    check(
      "pos_acting_staff_revoke_check",
      sql`(${table.revokedAt} IS NULL) = (${table.revokeReason} IS NULL)`,
    ),
    check(
      "pos_acting_staff_revoke_reason_check",
      sql`${table.revokeReason} IS NULL OR ${table.revokeReason} IN ('switched', 'ended', 'shift_closed', 'day_closed', 'pin_reset', 'staff_inactive')`,
    ),
  ],
);

export type PosActingStaffRow = typeof posActingStaff.$inferSelect;

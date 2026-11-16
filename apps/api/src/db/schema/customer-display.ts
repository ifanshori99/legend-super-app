// Customer display backend (design legend-yhia9 D-08, migration 0370): the
// second screen a cashier pairs to a POS terminal. A display device asks for a
// six-digit code (stored only as an HMAC), the cashier types it on the terminal
// and one active pairing per display and per terminal links them. The cashier
// chooses the bill the display shows (session row); triggers bump the session
// `version` whenever the selection, the bill's money or its QRIS hold changes,
// so the display can drop older answers. Triggers and RLS are in
// customer-display.custom.sql.
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  customType,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { outletIdColumn, tenantIdColumn, ulidInUuid } from "../columns.ts";
import { devices } from "./device.ts";
import { outlets, tenants } from "./platform-org.ts";
import { orders } from "./qr-order.ts";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

export const CUSTOMER_DISPLAY_PAIRING_STATUSES = ["active", "revoked"] as const;
export type CustomerDisplayPairingStatus =
  (typeof CUSTOMER_DISPLAY_PAIRING_STATUSES)[number];

/** HMAC-SHA256(server key, tenant, outlet, code); never the plain code. */
export const customerDisplayPairingCodes = pgTable(
  "customer_display_pairing_codes",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    id: uuid("id").defaultRandom().notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    displayDeviceId: uuid("display_device_id").notNull(),
    codeHash: bytea("code_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "customer_display_pairing_codes_pkey",
      columns: [table.tenantId, table.id],
    }),
    foreignKey({
      name: "customer_display_pairing_codes_device_fk",
      columns: [table.tenantId, table.outletId, table.displayDeviceId],
      foreignColumns: [devices.tenantId, devices.outletId, devices.id],
    }),
    uniqueIndex("customer_display_pairing_codes_live_code_key")
      .on(table.tenantId, table.outletId, table.codeHash)
      .where(sql`${table.consumedAt} IS NULL`),
    uniqueIndex("customer_display_pairing_codes_live_display_key")
      .on(table.tenantId, table.displayDeviceId)
      .where(sql`${table.consumedAt} IS NULL`),
    check(
      "customer_display_pairing_codes_hash_check",
      sql`octet_length(${table.codeHash}) = 32`,
    ),
  ],
);

export const customerDisplayPairings = pgTable(
  "customer_display_pairings",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    id: uuid("id").defaultRandom().notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    terminalDeviceId: uuid("terminal_device_id").notNull(),
    displayDeviceId: uuid("display_device_id").notNull(),
    status: text("status")
      .$type<CustomerDisplayPairingStatus>()
      .notNull()
      .default("active"),
    pairedAt: timestamp("paired_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    pairedBy: text("paired_by").notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: text("revoked_by"),
  },
  (table) => [
    primaryKey({
      name: "customer_display_pairings_pkey",
      columns: [table.tenantId, table.id],
    }),
    foreignKey({
      name: "customer_display_pairings_terminal_fk",
      columns: [table.tenantId, table.outletId, table.terminalDeviceId],
      foreignColumns: [devices.tenantId, devices.outletId, devices.id],
    }),
    foreignKey({
      name: "customer_display_pairings_display_fk",
      columns: [table.tenantId, table.outletId, table.displayDeviceId],
      foreignColumns: [devices.tenantId, devices.outletId, devices.id],
    }),
    uniqueIndex("customer_display_pairings_active_display_key")
      .on(table.tenantId, table.displayDeviceId)
      .where(sql`${table.status} = 'active'`),
    uniqueIndex("customer_display_pairings_active_terminal_key")
      .on(table.tenantId, table.terminalDeviceId)
      .where(sql`${table.status} = 'active'`),
    check(
      "customer_display_pairings_status_check",
      sql`${table.status} IN ('active', 'revoked') AND ((${table.status} = 'revoked') = (${table.revokedAt} IS NOT NULL))`,
    ),
  ],
);

/** One row per terminal: the bill its display shows and the answer version. */
export const customerDisplaySessions = pgTable(
  "customer_display_sessions",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    terminalDeviceId: uuid("terminal_device_id").notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    selectedOrderId: ulidInUuid("selected_order_id"),
    version: bigint("version", { mode: "number" }).notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "customer_display_sessions_pkey",
      columns: [table.tenantId, table.terminalDeviceId],
    }),
    foreignKey({
      name: "customer_display_sessions_terminal_fk",
      columns: [table.tenantId, table.outletId, table.terminalDeviceId],
      foreignColumns: [devices.tenantId, devices.outletId, devices.id],
    }),
    foreignKey({
      name: "customer_display_sessions_order_fk",
      columns: [table.tenantId, table.selectedOrderId],
      foreignColumns: [orders.tenantId, orders.id],
    }),
    index("customer_display_sessions_order_idx")
      .on(table.tenantId, table.selectedOrderId)
      .where(sql`${table.selectedOrderId} IS NOT NULL`),
    check(
      "customer_display_sessions_version_check",
      sql`${table.version} >= 0`,
    ),
  ],
);

/**
 * Pair-code attempt slots (D-08 throttle, 5 per terminal and 20 per outlet in 5
 * minutes). A slot is taken before the code is checked, in its own committed
 * transaction, and given back when the code was right.
 */
export const customerDisplayPairAttempts = pgTable(
  "customer_display_pair_attempts",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    id: uuid("id").defaultRandom().notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    terminalDeviceId: uuid("terminal_device_id").notNull(),
    attemptedAt: timestamp("attempted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "customer_display_pair_attempts_pkey",
      columns: [table.tenantId, table.id],
    }),
    foreignKey({
      name: "customer_display_pair_attempts_terminal_fk",
      columns: [table.tenantId, table.outletId, table.terminalDeviceId],
      foreignColumns: [devices.tenantId, devices.outletId, devices.id],
    }),
    index("customer_display_pair_attempts_terminal_idx").on(
      table.tenantId,
      table.terminalDeviceId,
      table.attemptedAt,
    ),
    index("customer_display_pair_attempts_outlet_idx").on(
      table.tenantId,
      table.outletId,
      table.attemptedAt,
    ),
  ],
);

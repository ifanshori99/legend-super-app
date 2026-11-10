// Payslip PIN (bead legend-2ap3; PRD v1.7 §3 D.30 "Slip Gaji": a payslip opens
// only with the employee's own PIN). Contract: `@starter/shared/hris/payroll`
// payslips.ts / endpoints.ts.
//
// payslip_pins never stores a PIN: `pin_hash` is scrypt over an HMAC of the PIN
// under a tenant-bound pepper, bound to the `payslip` domain, tenant and
// employee (services/payslip-pin.service.ts), so a staff device pin hash never
// verifies as a payslip PIN. One row per employee; HR reset deletes the row.
//
// payslip_pin_reset_challenges holds the WhatsApp one-time code of a
// self-service reset: only its keyed hash, a short expiry, a try counter and a
// single-use stamp.
//
// Both tables are tenant-owned (no outlet): the migration calls
// `app.enforce_tenant_rls(...)` for each (0257_payslip_pins.sql).
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  smallint,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { tenantIdColumn } from "../columns.ts";
import { employees } from "./hris.ts";
import { tenants } from "./platform-org.ts";

export const payslipPins = pgTable(
  "payslip_pins",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    employeeId: uuid("employee_id").notNull(),
    /** Random 16-byte salt, base64. */
    pinSalt: varchar("pin_salt", { length: 24 }).notNull(),
    /** scrypt output, 64 lowercase hex. Never the PIN. */
    pinHash: varchar("pin_hash", { length: 64 }).notNull(),
    /** scrypt cost parameters the hash was made with. */
    kdfN: integer("kdf_n").notNull(),
    kdfR: integer("kdf_r").notNull(),
    kdfP: integer("kdf_p").notNull(),
    pepperVersion: smallint("pepper_version").notNull().default(1),
    failedAttempts: integer("failed_attempts").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    setAt: timestamp("set_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("payslip_pins_tenant_id_key").on(table.tenantId, table.id),
    unique("payslip_pins_tenant_employee_key").on(
      table.tenantId,
      table.employeeId,
    ),
    foreignKey({
      name: "payslip_pins_employee_fk",
      columns: [table.tenantId, table.employeeId],
      foreignColumns: [employees.tenantId, employees.id],
    }),
    check(
      "payslip_pins_failed_attempts_check",
      sql`${table.failedAttempts} BETWEEN 0 AND 5`,
    ),
    check(
      "payslip_pins_pepper_version_check",
      sql`${table.pepperVersion} >= 1`,
    ),
  ],
);

export const payslipPinResetChallenges = pgTable(
  "payslip_pin_reset_challenges",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    employeeId: uuid("employee_id").notNull(),
    /** HMAC-SHA-256 hex of the code under the tenant pepper. Never the code. */
    codeHash: varchar("code_hash", { length: 64 }).notNull(),
    pepperVersion: smallint("pepper_version").notNull().default(1),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("payslip_pin_reset_challenges_tenant_id_key").on(
      table.tenantId,
      table.id,
    ),
    index("payslip_pin_reset_challenges_employee_idx").on(
      table.tenantId,
      table.employeeId,
      table.createdAt,
    ),
    foreignKey({
      name: "payslip_pin_reset_challenges_employee_fk",
      columns: [table.tenantId, table.employeeId],
      foreignColumns: [employees.tenantId, employees.id],
    }),
    check(
      "payslip_pin_reset_challenges_attempts_check",
      sql`${table.attempts} BETWEEN 0 AND 5`,
    ),
    check(
      "payslip_pin_reset_challenges_pepper_version_check",
      sql`${table.pepperVersion} >= 1`,
    ),
  ],
);

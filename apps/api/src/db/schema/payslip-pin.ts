// Payslip PIN (bead legend-2ap3; PRD v1.7 §3 D.30 "Slip Gaji": a payslip opens
// only with the employee's own PIN). Contract: `@starter/shared/hris/payroll`
// payslips.ts / endpoints.ts.
//
// payslip_pins never stores a PIN: `pin_hash` is scrypt over an HMAC of the PIN
// under a tenant-bound pepper, bound to the `payslip` domain, tenant and
// employee (services/payslip-pin.service.ts), so a staff device pin hash never
// verifies as a payslip PIN. One row per employee; HR reset deletes the row.
//
// Self-service reset proves the employee's own WhatsApp number by an INBOUND
// message; that proof lives in `login_challenges` (purpose `payslip_pin_reset`,
// identity-wa-proof.service). The outbound-code table
// `payslip_pin_reset_challenges` was dropped in 0273 (legend-9h2oj).
//
// The table is tenant-owned (no outlet): the migration calls
// `app.enforce_tenant_rls(...)` (0246_payslip_pins.sql).
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
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

// Tenant PPh 21 policy versions (bead legend-y4wp, PRD v1.7 §3 D.30 "PPh 21",
// R15, R20). Where PP 58/2023 and PMK 168/2023 leave a choice to the employer,
// or the team's reading awaits the tax consultant, the choice is tenant data
// versioned by effective date (contract: `@starter/shared/hris/payroll`
// pph21-policy.ts), never code.
//
// Rows are append-only: the service never updates or deletes a version, so a
// payroll run can always be reproduced with the policy that applied to it
// (PRD R21). One version number and one effective date per tenant. Tenant RLS
// (ENABLE + FORCE) is installed in the RLS migration that follows the
// generated one.
import {
  check,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { UserId } from "@starter/shared/core";
import type {
  Pph21PolicyParameters,
  Pph21PolicyVersionId,
} from "@starter/shared/hris/payroll";
import { businessDate, tenantIdColumn } from "../columns.ts";
import { tenants } from "./platform-org.ts";

export const payrollPph21Policies = pgTable(
  "payroll_pph21_policies",
  {
    id: uuid("id").$type<Pph21PolicyVersionId>().defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    /** 1, 2, 3 ... per tenant. */
    version: integer("version").notNull(),
    effectiveFrom: businessDate("effective_from").notNull(),
    /** Validated by `pph21PolicyParametersSchema` on write and on read. */
    parameters: jsonb("parameters").$type<Pph21PolicyParameters>().notNull(),
    reason: varchar("reason", { length: 500 }).notNull(),
    // Actor reference without a foreign key: history must survive a deleted or
    // anonymised account (same choice as audit_logs.actor_id).
    createdBy: text("created_by").$type<UserId>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("payroll_pph21_policies_tenant_version_key").on(
      table.tenantId,
      table.version,
    ),
    unique("payroll_pph21_policies_tenant_effective_from_key").on(
      table.tenantId,
      table.effectiveFrom,
    ),
    check("payroll_pph21_policies_version_check", sql`${table.version} >= 1`),
  ],
);

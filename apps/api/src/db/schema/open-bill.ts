// Per-outlet open-bill policy (PRD v1.7 §3 F43 "Kontrol Open Bill"; bead
// legend-cqrw). One row per outlet; no row means the service defaults apply
// (open-bill-control.service.ts), never "no limit". Tenant + outlet RLS in the
// RLS migration that follows the generated one.
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  integer,
  pgTable,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { idrColumn, outletIdColumn, tenantIdColumn } from "../columns";
import { outlets, tenants } from "./platform-org";

export const outletOpenBillPolicies = pgTable(
  "outlet_open_bill_policies",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    maxBillValueIdr: idrColumn("max_bill_value_idr").notNull(),
    inactivityMinutes: integer("inactivity_minutes").notNull(),
    billRequestSloSeconds: integer("bill_request_slo_seconds").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("outlet_open_bill_policies_tenant_outlet_key").on(
      table.tenantId,
      table.outletId,
    ),
    foreignKey({
      name: "outlet_open_bill_policies_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    check(
      "outlet_open_bill_policies_max_value_check",
      sql`${table.maxBillValueIdr} > 0`,
    ),
    check(
      "outlet_open_bill_policies_inactivity_check",
      sql`${table.inactivityMinutes} > 0`,
    ),
    check(
      "outlet_open_bill_policies_slo_check",
      sql`${table.billRequestSloSeconds} > 0`,
    ),
  ],
);

// WS-11 sales_targets: the sales target of one outlet for one business date
// (bead legend-ne81z). The `sales_target` metric reads it (metric-sources/
// sales.ts); a month target is the sum of its days. Tenant + outlet RLS lives in
// sales-targets.custom.sql.
import { sql } from "drizzle-orm";
import {
  check,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import {
  businessDate,
  idrColumn,
  outletIdColumn,
  tenantIdColumn,
} from "../columns";
import { outlets, tenants } from "./platform-org";

export const salesTargets = pgTable(
  "sales_targets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    /** Outlet business date the target applies to. */
    targetDate: businessDate("target_date").notNull(),
    /** Whole rupiah, never negative. */
    targetIdr: idrColumn("target_idr").notNull(),
    /** Better Auth user id of the last writer. */
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("sales_targets_key").on(
      table.tenantId,
      table.outletId,
      table.targetDate,
    ),
    check("sales_targets_target_idr_check", sql`${table.targetIdr} >= 0`),
  ],
);

// Switchover counts of a failover window (1271 F3, CTO decision 27 Nov;
// docs/briefs/1271-edge-failover-cards.md D2).
//
// When the cloud opens a device's first failover shift, the cashier's blind
// count of the drawer (C1) is the opening float of that shift AND the forced
// count of the interrupted edge shift. The failover shift's own `counts`
// column only holds the closing count (C2), so C1 is kept here until the
// window-closing event carries it to the edge. One row per window and device;
// cloud-only (never edge-bound), append-only (no update, no delete), tenant +
// outlet RLS (edge-failover-switchover.custom.sql).
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { idrColumn, outletIdColumn, tenantIdColumn } from "../columns.ts";
import { outletFailoverWindows } from "./edge-failover.ts";
import { outlets, tenants } from "./platform-org.ts";
import { posShifts } from "./pos-shift.ts";
import { user } from "./user.ts";

export const outletFailoverSwitchoverCounts = pgTable(
  "outlet_failover_switchover_counts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    windowId: uuid("window_id").notNull(),
    deviceId: uuid("device_id").notNull(),
    /** The failover shift opened with this count as its float. */
    shiftId: uuid("shift_id").notNull(),
    cashierId: text("cashier_id")
      .notNull()
      .references(() => user.id),
    countedAt: timestamp("counted_at", { withTimezone: true }).notNull(),
    /** The blind count sheet as submitted: [{denominationIdr, quantity}]. */
    counts: jsonb("counts")
      .$type<Array<{ denominationIdr: number; quantity: number }>>()
      .notNull(),
    totalIdr: idrColumn("total_idr").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // One switchover count per device and window (the edge closes one shift).
    unique("outlet_failover_switchover_counts_device_key").on(
      table.tenantId,
      table.windowId,
      table.deviceId,
    ),
    unique("outlet_failover_switchover_counts_shift_key").on(
      table.tenantId,
      table.shiftId,
    ),
    foreignKey({
      name: "outlet_failover_switchover_counts_window_fk",
      columns: [table.tenantId, table.outletId, table.windowId],
      foreignColumns: [
        outletFailoverWindows.tenantId,
        outletFailoverWindows.outletId,
        outletFailoverWindows.id,
      ],
    }),
    foreignKey({
      name: "outlet_failover_switchover_counts_shift_fk",
      columns: [table.tenantId, table.shiftId],
      foreignColumns: [posShifts.tenantId, posShifts.id],
    }),
    foreignKey({
      name: "outlet_failover_switchover_counts_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    check(
      "outlet_failover_switchover_counts_total_check",
      sql`${table.totalIdr} >= 0`,
    ),
    check(
      "outlet_failover_switchover_counts_counts_check",
      sql`jsonb_typeof(${table.counts}) = 'array' AND jsonb_array_length(${table.counts}) >= 1`,
    ),
  ],
);

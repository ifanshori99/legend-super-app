// What a tablet printer was already asked to print (P3, legend-wasr7.4). A
// kitchen ticket printed twice without a mark means the kitchen cooks twice,
// so the cloud, not the tablet, remembers: the first GET print of a kitchen
// ticket or a shift report inserts the row, every later one finds it and the
// bytes carry "CETAK ULANG" whatever the page asked. One row per (tenant, kind,
// ref); `ref_id` is the id as the app knows it (ULID or UUID text).
import { sql } from "drizzle-orm";
import {
  check,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { outletIdColumn, tenantIdColumn } from "../columns.ts";
import { outlets, tenants } from "./platform-org.ts";

export type TabletPrintKind = "kds_ticket" | "shift_report";

export const tabletPrintMarks = pgTable(
  "tablet_print_marks",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    kind: varchar("kind", { length: 16 }).$type<TabletPrintKind>().notNull(),
    refId: varchar("ref_id", { length: 40 }).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    /** User id of whoever asked for the first print. */
    firstPrintedBy: text("first_printed_by").notNull(),
    firstPrintedAt: timestamp("first_printed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastPrintedAt: timestamp("last_printed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    printCount: integer("print_count").notNull().default(1),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.kind, table.refId] }),
    check(
      "tablet_print_marks_kind_check",
      sql`${table.kind} IN ('kds_ticket', 'shift_report')`,
    ),
    check("tablet_print_marks_count_check", sql`${table.printCount} > 0`),
  ],
);

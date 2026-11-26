// O2 offline batch ingest (bead legend-wasr7.6; docs/design/cloud-only-release.md
// §2, "Keputusan CTO O2" (d): source `offline_tablet`, its own ledger, apart
// from the edge's `edge_order_ingests`).
//
//   pos_offline_sales  every offline sale event the cloud stored: one row per
//                      (tenant, event id), the replay key. The event id is the
//                      cloud order id. `ingested` = a normal cloud order exists
//                      (refunds take the normal cloud path); `held` = stored,
//                      no order, `reason` says why (finance settles it). The
//                      payload is kept as sent: it is the only record of a
//                      held sale. (sequence_id, sequence_number) is unique, so
//                      one offline receipt number is never two sales.
//                      Append-only (custom SQL).
//
// (T, O) rules: tenant_id + outlet_id NOT NULL, children reference parents
// through composite (tenant_id, id) keys, tenant + outlet RLS.
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { OfflineSaleEvent, OfflineSaleFlag } from "@starter/shared/pos";
import {
  businessDate,
  outletIdColumn,
  tenantIdColumn,
  ulidInUuid,
} from "../columns.ts";
import { outlets, tenants } from "./platform-org.ts";
import { posOfflineKits } from "./pos-offline.ts";
import { receiptSequences } from "./pos-receipt.ts";
import { posShifts } from "./pos-shift.ts";
import { user } from "./user.ts";

export type PosOfflineSaleState = "ingested" | "held";

export const posOfflineSales = pgTable(
  "pos_offline_sales",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    /** The sale event id (ULID); also the cloud order id when ingested. */
    eventId: ulidInUuid("event_id").notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    deviceId: uuid("device_id").notNull(),
    kitId: uuid("kit_id").notNull(),
    /** The kit's shift: the drawer the offline cash went into. */
    shiftId: uuid("shift_id").notNull(),
    sequenceId: uuid("sequence_id").notNull(),
    sequenceNumber: integer("sequence_number").notNull(),
    state: varchar("state", { length: 10 })
      .$type<PosOfflineSaleState>()
      .notNull(),
    /** Why a `held` sale did not become an order; null when ingested. */
    reason: varchar("reason", { length: 100 }),
    /** "Perlu dicek" flags of an ingested sale (contract OFFLINE_SALE_FLAGS). */
    flags: jsonb("flags").$type<OfflineSaleFlag[]>().notNull().default([]),
    /** The event exactly as the tablet sent it. */
    payload: jsonb("payload").$type<OfflineSaleEvent>().notNull(),
    receivedBy: text("received_by")
      .notNull()
      .references(() => user.id),
    /** Late sale (CTO O2): the closed day it was sold on, and the day used. */
    originalBusinessDate: businessDate("original_business_date"),
    lateBusinessDate: businessDate("late_business_date"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "pos_offline_sales_pkey",
      columns: [table.tenantId, table.eventId],
    }),
    unique("pos_offline_sales_sequence_number_key").on(
      table.tenantId,
      table.sequenceId,
      table.sequenceNumber,
    ),
    index("pos_offline_sales_outlet_idx").on(
      table.tenantId,
      table.outletId,
      table.state,
      table.createdAt,
    ),
    foreignKey({
      name: "pos_offline_sales_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "pos_offline_sales_kit_fk",
      columns: [table.tenantId, table.kitId],
      foreignColumns: [posOfflineKits.tenantId, posOfflineKits.id],
    }),
    foreignKey({
      name: "pos_offline_sales_shift_fk",
      columns: [table.tenantId, table.shiftId],
      foreignColumns: [posShifts.tenantId, posShifts.id],
    }),
    foreignKey({
      name: "pos_offline_sales_sequence_fk",
      columns: [table.tenantId, table.sequenceId],
      foreignColumns: [receiptSequences.tenantId, receiptSequences.id],
    }),
    check(
      "pos_offline_sales_state_check",
      sql`${table.state} IN ('ingested', 'held')`,
    ),
    check(
      "pos_offline_sales_reason_check",
      sql`(${table.state} = 'held') = (${table.reason} IS NOT NULL)`,
    ),
    check(
      "pos_offline_sales_sequence_number_check",
      sql`${table.sequenceNumber} BETWEEN 1 AND 999999999`,
    ),
    check(
      "pos_offline_sales_flags_check",
      sql`jsonb_typeof(${table.flags}) = 'array'`,
    ),
    check(
      "pos_offline_sales_late_check",
      sql`(${table.lateBusinessDate} IS NULL) = (${table.originalBusinessDate} IS NULL)
        AND (${table.lateBusinessDate} IS NULL OR ${table.lateBusinessDate} > ${table.originalBusinessDate})`,
    ),
  ],
);

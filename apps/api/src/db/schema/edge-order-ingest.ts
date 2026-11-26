// Cloud-side ledger of edge-paid POS orders the cloud ingested, cancelled,
// voided or refused (design docs/design/edge-order-ingest.md, "Table
// `edge_order_ingests`"). One row per (tenant, order): the replay guard of the
// `order.paid` ingest (same `paid_event_id` = no-op) and the record of why an
// order was refused. No FK to `orders`: a refused order has no cloud row.
//
// Tenant + outlet owned: the migration must call `app.enforce_tenant_rls(...)`
// and then `app.enforce_outlet_rls(...)` for this table
// (edge-order-ingest.custom.sql).
import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import {
  businessDate,
  outletIdColumn,
  tenantIdColumn,
  ulidInUuid,
} from "../columns.ts";
import { outlets, tenants } from "./platform-org.ts";

export type EdgeOrderIngestState =
  "ingested" | "cancelled" | "voided" | "refused";

export type EdgeOrderIngestTaxFlag = "tax_missing" | "tax_mismatch";

export const edgeOrderIngests = pgTable(
  "edge_order_ingests",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    orderId: ulidInUuid("order_id").notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    /** The `order.paid` event this row was created from (replay guard). */
    paidEventId: ulidInUuid("paid_event_id").notNull(),
    state: varchar("state", { length: 20 })
      .$type<EdgeOrderIngestState>()
      .notNull(),
    /** Refusal reason code (`aggregate_mismatch`, `db_error:<sqlstate>`, ...). */
    reason: text("reason"),
    /** The `order.voided` event that voided the order, once applied. */
    voidEventId: ulidInUuid("void_event_id"),
    /**
     * Why the order's tax rows were not snapshotted (legend finance
     * exceptions); NULL for a usable payload and for rows before 0354.
     */
    taxFlag: varchar("tax_flag", {
      length: 20,
    }).$type<EdgeOrderIngestTaxFlag>(),
    /** legend-k0i8: business date of a late sale as the edge recorded it. */
    originalBusinessDate: businessDate("original_business_date"),
    /**
     * legend-k0i8: the open business date a late sale was posted to, because
     * its own day was already closed in the cloud. NULL when not late.
     */
    lateBusinessDate: businessDate("late_business_date"),
    /** legend-k0i8: the same for the void of the sale. */
    lateVoidBusinessDate: businessDate("late_void_business_date"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.orderId] }),
    check(
      "edge_order_ingests_state_check",
      sql`${table.state} IN ('ingested', 'cancelled', 'voided', 'refused')`,
    ),
    check(
      "edge_order_ingests_tax_flag_check",
      sql`${table.taxFlag} IS NULL OR ${table.taxFlag} IN ('tax_missing', 'tax_mismatch')`,
    ),
    check(
      "edge_order_ingests_late_check",
      sql`(${table.lateBusinessDate} IS NULL) = (${table.originalBusinessDate} IS NULL)
        AND (${table.lateBusinessDate} IS NULL OR ${table.lateBusinessDate} > ${table.originalBusinessDate})`,
    ),
    index("edge_order_ingests_outlet_idx").on(
      table.tenantId,
      table.outletId,
      table.createdAt,
    ),
  ],
);

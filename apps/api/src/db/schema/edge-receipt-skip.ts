// Receipts skipped by the cloud receipt-run applier (bead legend-n1fzg). A
// receipt of an order the cloud permanently refused to ingest can never merge,
// so the applier skips it and records it here: one row per (tenant, outlet,
// order, receipt number, reason). The unique key makes a redelivery or a
// re-sent run idempotent, and the table (not a conflict detail, which holds
// 500 chars) is the memory that later chunks read to treat the number as
// accounted for, however many receipts are skipped. Append-only evidence.
//
// Tenant + outlet owned: the migration must call `app.enforce_tenant_rls(...)`
// and then `app.enforce_outlet_rls(...)` for this table (0353).
import {
  index,
  pgTable,
  primaryKey,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { outletIdColumn, tenantIdColumn, ulidInUuid } from "../columns.ts";
import { outlets, tenants } from "./platform-org.ts";

export const edgeReceiptSkips = pgTable(
  "edge_receipt_skips",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    orderId: ulidInUuid("order_id").notNull(),
    receiptNumber: varchar("receipt_number", { length: 64 }).notNull(),
    /**
     * Permanent ingest refusal (`order_exists`, `legacy_payload`) or
     * `link_dead_lettered` (the edge dead-lettered the order's paid
     * event, legend-n2d3g).
     */
    reason: varchar("reason", { length: 40 }).notNull(),
    /** The `receipt_run.reported` event that first recorded the skip. */
    eventId: ulidInUuid("event_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.tenantId,
        table.outletId,
        table.orderId,
        table.receiptNumber,
        table.reason,
      ],
    }),
    index("edge_receipt_skips_event_idx").on(table.tenantId, table.eventId),
  ],
);

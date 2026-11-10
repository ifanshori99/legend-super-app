// Remake / comp / complaint log of the kitchen (bead legend-4b5; PRD v1.7 §6 C
// `order_issues`, F41 "Remake & Comp", KDS-07, R25; contract
// @starter/shared/kitchen `orderIssueSchema`).
//
// One row = one issue about one order line, with the station and staff member
// that produced it and the ingredient cost (whole rupiah, computed by the API
// from the recipe, never client input). The recipe consumer draws the stock of
// a remake/comp through the `order_issue.recorded` event; this table is the
// record and the report source.
//
// (T) rules: tenant_id and outlet_id NOT NULL (enforced tenant + outlet RLS in
// kds-issues.custom.sql), unique constraints include tenant_id, and parents
// are referenced through composite (tenant_id, id) keys. The cross-field rules
// of the contract are repeated as CHECKs so a writer that skips the API cannot
// store a manual refund without approver or a remake without staff.

import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import {
  idrColumn,
  outletIdColumn,
  tenantIdColumn,
  ulidInUuid,
} from "../columns";
import { stations } from "./menu";
import { outlets, tenants } from "./platform-org";
import { orderItems, orders } from "./qr-order";
import { user } from "./user";

/** `order_issues` (T, O): one remake, comp, complaint or unfulfillable line. */
export const orderIssues = pgTable(
  "order_issues",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    orderId: ulidInUuid("order_id").notNull(),
    orderItemId: ulidInUuid("order_item_id").notNull(),
    type: varchar("type", { length: 20 }).notNull(),
    reason: varchar("reason", { length: 20 }).notNull(),
    reasonNote: varchar("reason_note", { length: 500 }).notNull(),
    stationId: uuid("station_id"),
    employeeId: text("employee_id").references(() => user.id),
    reportedBy: text("reported_by")
      .notNull()
      .references(() => user.id),
    resolution: varchar("resolution", { length: 20 }),
    replacementItemId: uuid("replacement_item_id"),
    /** Order line created by a swap; at most one issue points at a line. */
    replacementOrderItemId: ulidInUuid("replacement_order_item_id"),
    voucherId: uuid("voucher_id"),
    /** Positive: the guest pays the difference; negative: credited. */
    priceDifferenceIdr: idrColumn("price_difference_idr"),
    approvedBy: text("approved_by").references(() => user.id),
    /** Approval request that allowed a manual refund (ORD-09, legend-4qu). */
    approvalRequestId: uuid("approval_request_id"),
    /** Ingredient cost, whole rupiah, server-computed (KDS-07). */
    costIdr: idrColumn("cost_idr").notNull(),
    /** Client retry key: a resend returns the stored row (unique per tenant). */
    idempotencyKey: varchar("idempotency_key", { length: 100 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [
    unique("order_issues_tenant_id_id_key").on(table.tenantId, table.id),
    unique("order_issues_tenant_idempotency_key").on(
      table.tenantId,
      table.idempotencyKey,
    ),
    // One live comp per order line, even under concurrent reports.
    uniqueIndex("order_issues_comp_once_idx")
      .on(table.tenantId, table.orderItemId)
      .where(sql`${table.type} = 'comp' AND ${table.status} <> 'cancelled'`),
    // One settled unfulfillable report per order line (legend-4qu): two
    // concurrent resolutions cannot both win.
    uniqueIndex("order_issues_resolved_item_once_idx")
      .on(table.tenantId, table.orderItemId)
      .where(
        sql`${table.type} = 'unfulfillable' AND ${table.resolution} IS NOT NULL AND ${table.status} <> 'cancelled'`,
      ),
    // One voucher settles at most one issue.
    uniqueIndex("order_issues_voucher_once_idx")
      .on(table.tenantId, table.voucherId)
      .where(sql`${table.voucherId} IS NOT NULL`),
    foreignKey({
      name: "order_issues_order_fk",
      columns: [table.tenantId, table.orderId],
      foreignColumns: [orders.tenantId, orders.id],
    }),
    foreignKey({
      name: "order_issues_order_item_fk",
      columns: [table.tenantId, table.orderItemId],
      foreignColumns: [orderItems.tenantId, orderItems.id],
    }),
    // A replacement line is the result of exactly one swap.
    uniqueIndex("order_issues_replacement_item_once_idx")
      .on(table.tenantId, table.replacementOrderItemId)
      .where(sql`${table.replacementOrderItemId} IS NOT NULL`),
    foreignKey({
      name: "order_issues_replacement_order_item_fk",
      columns: [table.tenantId, table.replacementOrderItemId],
      foreignColumns: [orderItems.tenantId, orderItems.id],
    }),
    foreignKey({
      name: "order_issues_station_fk",
      columns: [table.tenantId, table.stationId],
      foreignColumns: [stations.tenantId, stations.id],
    }),
    foreignKey({
      name: "order_issues_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    index("order_issues_outlet_created_idx").on(
      table.tenantId,
      table.outletId,
      table.createdAt,
      table.id,
    ),
    index("order_issues_order_item_idx").on(table.tenantId, table.orderItemId),
    check(
      "order_issues_type_check",
      sql`${table.type} IN ('unfulfillable', 'remake', 'comp', 'complaint')`,
    ),
    check(
      "order_issues_reason_check",
      sql`${table.reason} IN ('wrong_order', 'quality', 'late', 'complaint', 'out_of_stock', 'other')`,
    ),
    check(
      "order_issues_resolution_check",
      sql`${table.resolution} IS NULL OR ${table.resolution} IN ('swap', 'voucher', 'manual_refund')`,
    ),
    check(
      "order_issues_status_check",
      sql`${table.status} IN ('open', 'resolved', 'cancelled')`,
    ),
    check("order_issues_cost_check", sql`${table.costIdr} >= 0`),
    check(
      "order_issues_staff_check",
      sql`${table.type} NOT IN ('remake', 'comp') OR ${table.employeeId} IS NOT NULL`,
    ),
    check(
      "order_issues_refund_approval_check",
      sql`${table.resolution} IS DISTINCT FROM 'manual_refund' OR (${table.approvedBy} IS NOT NULL AND length(btrim(${table.reasonNote})) >= 10)`,
    ),
    check(
      "order_issues_voucher_check",
      sql`${table.resolution} IS DISTINCT FROM 'voucher' OR ${table.voucherId} IS NOT NULL`,
    ),
    check(
      "order_issues_swap_check",
      sql`${table.resolution} IS DISTINCT FROM 'swap' OR ${table.replacementItemId} IS NOT NULL`,
    ),
    check(
      "order_issues_swap_approval_check",
      sql`${table.resolution} IS DISTINCT FROM 'swap' OR ${table.priceDifferenceIdr} IS NULL OR ${table.priceDifferenceIdr} <= 0 OR ${table.approvalRequestId} IS NOT NULL`,
    ),
    check(
      "order_issues_replacement_order_item_check",
      sql`${table.replacementOrderItemId} IS NULL OR ${table.resolution} = 'swap'`,
    ),
    check(
      "order_issues_resolved_check",
      sql`(${table.status} = 'resolved') = (${table.resolvedAt} IS NOT NULL)`,
    ),
  ],
);

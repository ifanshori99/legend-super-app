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
import { paymentIntents, paymentLinks } from "./payment";
import { orderItems, orders } from "./qr-order";
import { tableSessions } from "./floor";
import { cashMovements } from "./pos-shift";
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
    /** Replacement unit catalogue price at resolve time (swap only). */
    replacementUnitPriceIdr: idrColumn("replacement_unit_price_idr"),
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
    /**
     * A manual refund of this issue was rejected (final, legend-wumm8): the
     * guest got nothing back, so the line may be reported again as a new issue.
     */
    refundRejectedAt: timestamp("refund_rejected_at", { withTimezone: true }),
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
    // concurrent resolutions cannot both win. An issue whose refund was
    // rejected gave nothing back and is not counted (legend-wumm8).
    uniqueIndex("order_issues_resolved_item_once_idx")
      .on(table.tenantId, table.orderItemId)
      .where(
        sql`${table.type} = 'unfulfillable' AND ${table.resolution} IS NOT NULL AND ${table.status} <> 'cancelled' AND ${table.refundRejectedAt} IS NULL`,
      ),
    // A line is manually refunded at most once, whatever the issue type
    // (legend-uyw0v, migration 0450). A cancelled issue and a rejected refund
    // gave nothing back and are not counted, same as the index above.
    uniqueIndex("order_issues_manual_refund_once_idx")
      .on(table.tenantId, table.orderItemId)
      .where(
        sql`${table.resolution} = 'manual_refund' AND ${table.status} <> 'cancelled' AND ${table.refundRejectedAt} IS NULL`,
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
      "order_issues_replacement_unit_price_check",
      sql`${table.replacementUnitPriceIdr} IS NULL OR ${table.resolution} = 'swap'`,
    ),
    check(
      "order_issues_refund_rejected_check",
      sql`${table.refundRejectedAt} IS NULL OR ${table.resolution} = 'manual_refund'`,
    ),
    check(
      "order_issues_resolved_check",
      sql`(${table.status} = 'resolved') = (${table.resolvedAt} IS NOT NULL)`,
    ),
  ],
);

/**
 * `order_issue_charges` (T, O): the dearer-swap difference of one failed-item
 * issue, owed by the guest (legend-i83ls). One row per issue. `route`:
 * `qr_link` is paid through its own payment link (never the order's: the order
 * is already paid), `pos` is a cashier bill the cashier charges. Revenue is
 * recognised when the money arrives (`order_issue.charge_paid`), so a charge
 * that is waived or expires has no journal.
 */
export const orderIssueCharges = pgTable(
  "order_issue_charges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    orderIssueId: uuid("order_issue_id").notNull(),
    orderId: ulidInUuid("order_id").notNull(),
    /** QR charges ride on the table session (bill, session close). */
    tableSessionId: uuid("table_session_id"),
    route: varchar("route", { length: 10 }).notNull(),
    status: varchar("status", { length: 12 }).notNull().default("open"),
    /** Price difference of the swap line (before service charge and PBJT). */
    differenceIdr: idrColumn("difference_idr").notNull(),
    grossSalesIdr: idrColumn("gross_sales_idr").notNull(),
    serviceChargeIdr: idrColumn("service_charge_idr").notNull(),
    pbjtIdr: idrColumn("pbjt_idr").notNull(),
    /** gross + service + pbjt: what the guest pays. */
    amountIdr: idrColumn("amount_idr").notNull(),
    paymentLinkId: uuid("payment_link_id"),
    /** Link token, sealed like `orders.payment_link_token_sealed`. */
    paymentLinkTokenSealed: text("payment_link_token_sealed"),
    paymentIntentId: uuid("payment_intent_id"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    /** Paid in cash at the till (legend-800h1): the shift's cash_in movement. */
    cashMovementId: uuid("cash_movement_id"),
    /** The cashier who collected it at the till. */
    paidBy: text("paid_by").references(() => user.id),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedBy: text("closed_by").references(() => user.id),
    closeReason: varchar("close_reason", { length: 500 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("order_issue_charges_tenant_id_id_key").on(table.tenantId, table.id),
    // One charge per issue, even when the event is replayed or concurrent.
    uniqueIndex("order_issue_charges_issue_once_idx").on(
      table.tenantId,
      table.orderIssueId,
    ),
    uniqueIndex("order_issue_charges_link_once_idx")
      .on(table.tenantId, table.paymentLinkId)
      .where(sql`${table.paymentLinkId} IS NOT NULL`),
    uniqueIndex("order_issue_charges_cash_movement_once_idx")
      .on(table.tenantId, table.cashMovementId)
      .where(sql`${table.cashMovementId} IS NOT NULL`),
    index("order_issue_charges_session_open_idx")
      .on(table.tenantId, table.tableSessionId)
      .where(sql`${table.status} = 'open'`),
    foreignKey({
      name: "order_issue_charges_issue_fk",
      columns: [table.tenantId, table.orderIssueId],
      foreignColumns: [orderIssues.tenantId, orderIssues.id],
    }),
    foreignKey({
      name: "order_issue_charges_order_fk",
      columns: [table.tenantId, table.orderId],
      foreignColumns: [orders.tenantId, orders.id],
    }),
    foreignKey({
      name: "order_issue_charges_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "order_issue_charges_session_fk",
      columns: [table.tenantId, table.tableSessionId],
      foreignColumns: [tableSessions.tenantId, tableSessions.id],
    }),
    foreignKey({
      name: "order_issue_charges_link_fk",
      columns: [table.tenantId, table.paymentLinkId],
      foreignColumns: [paymentLinks.tenantId, paymentLinks.id],
    }),
    foreignKey({
      name: "order_issue_charges_intent_fk",
      columns: [table.tenantId, table.paymentIntentId],
      foreignColumns: [paymentIntents.tenantId, paymentIntents.id],
    }),
    foreignKey({
      name: "order_issue_charges_cash_movement_fk",
      columns: [table.tenantId, table.cashMovementId],
      foreignColumns: [cashMovements.tenantId, cashMovements.id],
    }),
    check(
      "order_issue_charges_cash_paid_check",
      sql`${table.cashMovementId} IS NULL OR (${table.status} = 'paid' AND ${table.paymentIntentId} IS NULL)`,
    ),
    check(
      "order_issue_charges_link_token_check",
      sql`(${table.paymentLinkId} IS NULL) = (${table.paymentLinkTokenSealed} IS NULL)`,
    ),
    check(
      "order_issue_charges_route_check",
      sql`${table.route} IN ('qr_link', 'pos')`,
    ),
    check(
      "order_issue_charges_status_check",
      sql`${table.status} IN ('open', 'paid', 'routed_pos', 'waived', 'expired')`,
    ),
    check(
      "order_issue_charges_amount_check",
      sql`${table.differenceIdr} > 0 AND ${table.grossSalesIdr} >= 0 AND ${table.serviceChargeIdr} >= 0 AND ${table.pbjtIdr} >= 0 AND ${table.amountIdr} > 0 AND ${table.amountIdr} = ${table.grossSalesIdr} + ${table.serviceChargeIdr} + ${table.pbjtIdr}`,
    ),
    check(
      "order_issue_charges_state_check",
      sql`(${table.status} = 'paid') = (${table.paidAt} IS NOT NULL) AND (${table.status} IN ('waived', 'expired')) = (${table.closedAt} IS NOT NULL) AND (${table.status} <> 'waived' OR (${table.closedBy} IS NOT NULL AND ${table.closeReason} IS NOT NULL))`,
    ),
    check(
      "order_issue_charges_route_status_check",
      sql`(${table.route} = 'pos') = (${table.status} = 'routed_pos') OR ${table.status} IN ('paid', 'waived', 'expired')`,
    ),
  ],
);

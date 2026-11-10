// Supplier returns (PRD INV-05 / §3.18; bead legend-65mgw).
//
// A purchase return sends accepted goods of one goods receipt back to the
// supplier: stock leaves the ledger at the receipt cost and the value reduces
// the receipt liability (GRNI). Returns are immutable history (the RLS
// migration revokes UPDATE/DELETE/TRUNCATE from the app role). Both tables are
// tenant-owned AND outlet-owned: tenant_id / outlet_id NOT NULL, unique
// constraints include tenant_id, composite (tenant_id, ...) foreign keys keep
// every reference in one tenant. Money columns are whole rupiah; quantities and
// unit costs are NUMERIC(14,4) decimal strings in the item base unit.

import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import {
  businessDate,
  decimal4Column,
  idrColumn,
  tenantIdColumn,
} from "../columns.ts";
import { goodsReceiptLines, goodsReceipts } from "./inventory-receiving.ts";
import { inventoryItems, stockBatches, stockLocations } from "./inventory.ts";
import { outlets, tenants } from "./platform-org.ts";
import { purchaseOrderLines, purchaseOrders, suppliers } from "./purchasing.ts";
import { user } from "./user.ts";

/**
 * `purchase_returns` (T, outlet-owned): header of one return against a goods
 * receipt. The number `RT/<YYYYMM>/<0001>` comes from
 * `purchasing_document_sequences` (kind 'RT'). `returned_on` is the outlet
 * business date. `value_idr` is the sum of the line values, split into the
 * part not yet invoiced by the supplier and the part already invoiced (with
 * its PPN); until supplier invoices exist the whole value is uninvoiced.
 */
export const purchaseReturns = pgTable(
  "purchase_returns",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: uuid("outlet_id").notNull(),
    id: uuid("id").defaultRandom().primaryKey(),
    goodsReceiptId: uuid("goods_receipt_id").notNull(),
    purchaseOrderId: uuid("purchase_order_id").notNull(),
    supplierId: uuid("supplier_id").notNull(),
    number: varchar("number", { length: 40 }).notNull(),
    reason: varchar("reason", { length: 20 }).notNull(),
    returnedOn: businessDate("returned_on").notNull(),
    returnedAt: timestamp("returned_at", { withTimezone: true }).notNull(),
    returnedBy: text("returned_by")
      .notNull()
      .references(() => user.id),
    valueIdr: idrColumn("value_idr").notNull(),
    uninvoicedValueIdr: idrColumn("uninvoiced_value_idr").notNull(),
    invoicedValueIdr: idrColumn("invoiced_value_idr").notNull(),
    ppnIdr: idrColumn("ppn_idr").notNull(),
    note: varchar("note", { length: 300 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("purchase_returns_tenant_id_id_key").on(table.tenantId, table.id),
    // Parent key for rows that must stay inside one tenant AND outlet.
    unique("purchase_returns_tenant_outlet_id_key").on(
      table.tenantId,
      table.outletId,
      table.id,
    ),
    unique("purchase_returns_tenant_number_key").on(
      table.tenantId,
      table.number,
    ),
    foreignKey({
      name: "purchase_returns_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "purchase_returns_receipt_fk",
      columns: [table.tenantId, table.outletId, table.goodsReceiptId],
      foreignColumns: [
        goodsReceipts.tenantId,
        goodsReceipts.outletId,
        goodsReceipts.id,
      ],
    }),
    foreignKey({
      name: "purchase_returns_order_fk",
      columns: [table.tenantId, table.purchaseOrderId],
      foreignColumns: [purchaseOrders.tenantId, purchaseOrders.id],
    }),
    foreignKey({
      name: "purchase_returns_supplier_fk",
      columns: [table.tenantId, table.supplierId],
      foreignColumns: [suppliers.tenantId, suppliers.id],
    }),
    index("purchase_returns_tenant_outlet_returned_idx").on(
      table.tenantId,
      table.outletId,
      table.returnedAt,
      table.id,
    ),
    index("purchase_returns_tenant_receipt_idx").on(
      table.tenantId,
      table.goodsReceiptId,
    ),
    check(
      "purchase_returns_reason_check",
      sql`${table.reason} IN ('damaged', 'wrong_item', 'expired', 'quality_reject', 'over_delivery', 'other')`,
    ),
    check(
      "purchase_returns_amounts_check",
      sql`${table.valueIdr} >= 0
        AND ${table.uninvoicedValueIdr} >= 0
        AND ${table.invoicedValueIdr} >= 0
        AND ${table.ppnIdr} >= 0`,
    ),
    check(
      "purchase_returns_split_check",
      sql`${table.valueIdr} = ${table.uninvoicedValueIdr} + ${table.invoicedValueIdr}`,
    ),
    check(
      "purchase_returns_ppn_check",
      sql`${table.ppnIdr} = 0 OR ${table.invoicedValueIdr} > 0`,
    ),
  ],
);

/**
 * `purchase_return_lines` (T, outlet-owned): one row per goods receipt line
 * returned. `quantity` is in the item base unit (the stock ledger unit, same as
 * `goods_receipt_lines.accepted_base_quantity`); `unit_cost_idr` is the receipt
 * cost per base unit. `line_value_idr` is the cumulative-rounded value, so a
 * full return clears the receipt line value exactly.
 */
export const purchaseReturnLines = pgTable(
  "purchase_return_lines",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: uuid("outlet_id").notNull(),
    id: uuid("id").defaultRandom().primaryKey(),
    purchaseReturnId: uuid("purchase_return_id").notNull(),
    goodsReceiptLineId: uuid("goods_receipt_line_id").notNull(),
    purchaseOrderLineId: uuid("purchase_order_line_id").notNull(),
    inventoryItemId: uuid("inventory_item_id").notNull(),
    locationId: uuid("location_id").notNull(),
    batchId: uuid("batch_id"),
    batchCode: varchar("batch_code", { length: 40 }),
    quantity: decimal4Column("quantity").notNull(),
    unitCostIdr: decimal4Column("unit_cost_idr").notNull(),
    lineValueIdr: idrColumn("line_value_idr").notNull(),
    lineNo: integer("line_no").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("purchase_return_lines_tenant_id_id_key").on(
      table.tenantId,
      table.id,
    ),
    unique("purchase_return_lines_return_receipt_line_key").on(
      table.tenantId,
      table.purchaseReturnId,
      table.goodsReceiptLineId,
    ),
    unique("purchase_return_lines_return_line_no_key").on(
      table.tenantId,
      table.purchaseReturnId,
      table.lineNo,
    ),
    foreignKey({
      name: "purchase_return_lines_return_fk",
      columns: [table.tenantId, table.outletId, table.purchaseReturnId],
      foreignColumns: [
        purchaseReturns.tenantId,
        purchaseReturns.outletId,
        purchaseReturns.id,
      ],
    }),
    foreignKey({
      name: "purchase_return_lines_receipt_line_fk",
      columns: [table.tenantId, table.goodsReceiptLineId],
      foreignColumns: [goodsReceiptLines.tenantId, goodsReceiptLines.id],
    }),
    foreignKey({
      name: "purchase_return_lines_po_line_fk",
      columns: [table.tenantId, table.purchaseOrderLineId],
      foreignColumns: [purchaseOrderLines.tenantId, purchaseOrderLines.id],
    }),
    foreignKey({
      name: "purchase_return_lines_item_fk",
      columns: [table.tenantId, table.inventoryItemId],
      foreignColumns: [inventoryItems.tenantId, inventoryItems.id],
    }),
    foreignKey({
      name: "purchase_return_lines_location_fk",
      columns: [table.tenantId, table.locationId],
      foreignColumns: [stockLocations.tenantId, stockLocations.id],
    }),
    foreignKey({
      name: "purchase_return_lines_batch_fk",
      columns: [table.tenantId, table.batchId],
      foreignColumns: [stockBatches.tenantId, stockBatches.id],
    }),
    index("purchase_return_lines_tenant_receipt_line_idx").on(
      table.tenantId,
      table.goodsReceiptLineId,
    ),
    check("purchase_return_lines_quantity_check", sql`${table.quantity} > 0`),
    check(
      "purchase_return_lines_unit_cost_check",
      sql`${table.unitCostIdr} >= 0`,
    ),
    check("purchase_return_lines_value_check", sql`${table.lineValueIdr} >= 0`),
    check("purchase_return_lines_line_no_check", sql`${table.lineNo} > 0`),
  ],
);

// Goods receipts (PRD INV-05, §3.18, §4 Alur I step 3; bead legend-o1o4s).
//
// A goods receipt records what physically arrived against one purchase order:
// partial deliveries, QC rejects and photos. Receipts are immutable (the RLS
// migration revokes UPDATE/DELETE/TRUNCATE from the app role); a correction is
// a later receipt or a stock adjustment. All three tables are tenant-owned AND
// outlet-owned: tenant_id / outlet_id NOT NULL, unique constraints include
// tenant_id, and composite (tenant_id, …) foreign keys keep every reference in
// one tenant. Quantities and per-unit prices are NUMERIC(14,4) decimal strings.

import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { businessDate, decimal4Column, tenantIdColumn } from "../columns.ts";
import { coreStorageObjects } from "./core-storage.ts";
import {
  inventoryItems,
  stockBatches,
  stockLocations,
  uoms,
} from "./inventory.ts";
import { outlets, tenants } from "./platform-org.ts";
import { purchaseOrderLines, purchaseOrders, suppliers } from "./purchasing.ts";
import { user } from "./user.ts";

/**
 * `goods_receipts` (T, outlet-owned): header of one receipt against a purchase
 * order. The number `GR/<YYYYMM>/<0001>` comes from
 * `purchasing_document_sequences` (kind 'GR'). `received_on` is the outlet
 * business date; `received_at` the instant it was recorded.
 */
export const goodsReceipts = pgTable(
  "goods_receipts",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: uuid("outlet_id").notNull(),
    id: uuid("id").defaultRandom().primaryKey(),
    purchaseOrderId: uuid("purchase_order_id").notNull(),
    supplierId: uuid("supplier_id").notNull(),
    number: varchar("number", { length: 40 }).notNull(),
    receivedBy: text("received_by")
      .notNull()
      .references(() => user.id),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    receivedOn: businessDate("received_on").notNull(),
    qcNotes: varchar("qc_notes", { length: 500 }),
    note: varchar("note", { length: 300 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("goods_receipts_tenant_id_id_key").on(table.tenantId, table.id),
    // Parent key for rows that must stay inside one tenant AND outlet.
    unique("goods_receipts_tenant_outlet_id_key").on(
      table.tenantId,
      table.outletId,
      table.id,
    ),
    unique("goods_receipts_tenant_number_key").on(table.tenantId, table.number),
    foreignKey({
      name: "goods_receipts_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "goods_receipts_order_fk",
      columns: [table.tenantId, table.purchaseOrderId],
      foreignColumns: [purchaseOrders.tenantId, purchaseOrders.id],
    }),
    foreignKey({
      name: "goods_receipts_supplier_fk",
      columns: [table.tenantId, table.supplierId],
      foreignColumns: [suppliers.tenantId, suppliers.id],
    }),
    index("goods_receipts_tenant_outlet_received_idx").on(
      table.tenantId,
      table.outletId,
      table.receivedAt,
      table.id,
    ),
    index("goods_receipts_tenant_order_idx").on(
      table.tenantId,
      table.purchaseOrderId,
    ),
  ],
);

/**
 * `goods_receipt_lines` (T, outlet-owned): one row per purchase order line
 * received. `quantity_received` / `quantity_rejected` are in the PO line unit
 * (`uom_id`); `accepted_base_quantity` is the accepted part converted to the
 * item base unit (what was posted to the stock ledger). `unit_cost_idr` is the
 * PO unit price per purchase unit.
 */
export const goodsReceiptLines = pgTable(
  "goods_receipt_lines",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: uuid("outlet_id").notNull(),
    id: uuid("id").defaultRandom().primaryKey(),
    goodsReceiptId: uuid("goods_receipt_id").notNull(),
    purchaseOrderLineId: uuid("purchase_order_line_id").notNull(),
    inventoryItemId: uuid("inventory_item_id").notNull(),
    locationId: uuid("location_id").notNull(),
    uomId: uuid("uom_id").notNull(),
    quantityReceived: decimal4Column("quantity_received").notNull(),
    quantityRejected: decimal4Column("quantity_rejected").notNull(),
    acceptedBaseQuantity: decimal4Column("accepted_base_quantity").notNull(),
    unitCostIdr: decimal4Column("unit_cost_idr").notNull(),
    batchCode: varchar("batch_code", { length: 40 }),
    expiresOn: businessDate("expires_on"),
    batchId: uuid("batch_id"),
    lineNo: integer("line_no").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("goods_receipt_lines_tenant_id_id_key").on(table.tenantId, table.id),
    unique("goods_receipt_lines_receipt_po_line_key").on(
      table.tenantId,
      table.goodsReceiptId,
      table.purchaseOrderLineId,
    ),
    unique("goods_receipt_lines_receipt_line_no_key").on(
      table.tenantId,
      table.goodsReceiptId,
      table.lineNo,
    ),
    foreignKey({
      name: "goods_receipt_lines_receipt_fk",
      columns: [table.tenantId, table.outletId, table.goodsReceiptId],
      foreignColumns: [
        goodsReceipts.tenantId,
        goodsReceipts.outletId,
        goodsReceipts.id,
      ],
    }),
    foreignKey({
      name: "goods_receipt_lines_po_line_fk",
      columns: [table.tenantId, table.purchaseOrderLineId],
      foreignColumns: [purchaseOrderLines.tenantId, purchaseOrderLines.id],
    }),
    foreignKey({
      name: "goods_receipt_lines_item_fk",
      columns: [table.tenantId, table.inventoryItemId],
      foreignColumns: [inventoryItems.tenantId, inventoryItems.id],
    }),
    foreignKey({
      name: "goods_receipt_lines_location_fk",
      columns: [table.tenantId, table.locationId],
      foreignColumns: [stockLocations.tenantId, stockLocations.id],
    }),
    foreignKey({
      name: "goods_receipt_lines_uom_fk",
      columns: [table.tenantId, table.uomId],
      foreignColumns: [uoms.tenantId, uoms.id],
    }),
    foreignKey({
      name: "goods_receipt_lines_batch_fk",
      columns: [table.tenantId, table.batchId],
      foreignColumns: [stockBatches.tenantId, stockBatches.id],
    }),
    index("goods_receipt_lines_tenant_po_line_idx").on(
      table.tenantId,
      table.purchaseOrderLineId,
    ),
    check(
      "goods_receipt_lines_received_check",
      sql`${table.quantityReceived} > 0`,
    ),
    check(
      "goods_receipt_lines_rejected_check",
      sql`${table.quantityRejected} >= 0
        AND ${table.quantityRejected} <= ${table.quantityReceived}`,
    ),
    check(
      "goods_receipt_lines_accepted_base_check",
      sql`${table.acceptedBaseQuantity} >= 0`,
    ),
    check(
      "goods_receipt_lines_unit_cost_check",
      sql`${table.unitCostIdr} >= 0`,
    ),
    check(
      "goods_receipt_lines_expiry_batch_check",
      sql`${table.expiresOn} IS NULL OR ${table.batchCode} IS NOT NULL`,
    ),
    check("goods_receipt_lines_line_no_check", sql`${table.lineNo} > 0`),
  ],
);

/**
 * `goods_receipt_media` (T, outlet-owned): photos attached to a receipt, kept
 * in `core_storage_objects` (purpose 'receipt'). `position` orders them 0..9.
 */
export const goodsReceiptMedia = pgTable(
  "goods_receipt_media",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: uuid("outlet_id").notNull(),
    goodsReceiptId: uuid("goods_receipt_id").notNull(),
    storageObjectId: uuid("storage_object_id").notNull(),
    position: smallint("position").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      name: "goods_receipt_media_pkey",
      columns: [table.tenantId, table.goodsReceiptId, table.storageObjectId],
    }),
    unique("goods_receipt_media_receipt_position_key").on(
      table.tenantId,
      table.goodsReceiptId,
      table.position,
    ),
    foreignKey({
      name: "goods_receipt_media_receipt_fk",
      columns: [table.tenantId, table.outletId, table.goodsReceiptId],
      foreignColumns: [
        goodsReceipts.tenantId,
        goodsReceipts.outletId,
        goodsReceipts.id,
      ],
    }),
    foreignKey({
      name: "goods_receipt_media_storage_object_fk",
      columns: [table.tenantId, table.storageObjectId],
      foreignColumns: [coreStorageObjects.tenantId, coreStorageObjects.id],
    }),
    check(
      "goods_receipt_media_position_check",
      sql`${table.position} BETWEEN 0 AND 9`,
    ),
  ],
);

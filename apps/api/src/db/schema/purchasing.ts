// Purchasing tables (PRD v1.7 §3 "Supplier", "Purchase Request & Purchase
// Order", §6 E `suppliers`, `purchase_orders`; bead legend-9yz).
//
// Suppliers, their contacts and the price history are tenant-owned (a supplier
// serves every outlet of the tenant). Purchase requests, purchase orders and
// everything that hangs off them are tenant-owned AND outlet-owned: tenant_id /
// outlet_id NOT NULL, RLS in `purchasing.custom.sql`, unique constraints always
// include tenant_id, and composite (tenant_id, …) foreign keys keep every
// reference inside one tenant (and one outlet for outlet-owned children).
// Quantities and per-unit prices are NUMERIC(14,4) decimal strings, document
// totals are BIGINT rupiah (D-CORE-2).

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type {
  PurchaseOrderSource,
  PurchaseOrderStatus,
  PurchaseRequestStatus,
  SupplierInvoiceStatus,
  ThreeWayMatch,
} from "@starter/shared/inventory";
import {
  businessDate,
  decimal4Column,
  idrColumn,
  tenantIdColumn,
} from "../columns.ts";
import { inventoryItems, uoms } from "./inventory.ts";
import { journalEntries } from "./accounting.ts";
import { legalEntities, outlets, tenants } from "./platform-org.ts";
import { user } from "./user.ts";

/**
 * `suppliers` (T): vendor master data. The name is unique per tenant ignoring
 * case; a supplier is deactivated (`is_active`), never deleted, so documents
 * keep their history.
 */
export const suppliers = pgTable(
  "suppliers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    name: varchar("name", { length: 150 }).notNull(),
    kind: varchar("kind", { length: 20, enum: ["goods", "maintenance"] })
      .default("goods")
      .notNull(),
    legalName: varchar("legal_name", { length: 200 }),
    /** NPWP as the supplier states it (digits, dots and dashes); optional. */
    npwp: varchar("npwp", { length: 20 }),
    contactName: varchar("contact_name", { length: 150 }),
    phone: varchar("phone", { length: 16 }),
    email: varchar("email", { length: 254 }),
    address: varchar("address", { length: 300 }),
    paymentTermsDays: integer("payment_terms_days").notNull(),
    rating: smallint("rating"),
    isActive: boolean("is_active").default(true).notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("suppliers_tenant_id_id_key").on(table.tenantId, table.id),
    uniqueIndex("suppliers_tenant_lower_name_idx").on(
      table.tenantId,
      sql`lower(${table.name})`,
    ),
    index("suppliers_tenant_active_name_idx").on(
      table.tenantId,
      table.isActive,
      table.name,
      table.id,
    ),
    check("suppliers_payment_terms_check", sql`${table.paymentTermsDays} >= 0`),
    check(
      "suppliers_kind_check",
      sql`${table.kind} IN ('goods', 'maintenance')`,
    ),
    check(
      "suppliers_rating_check",
      sql`${table.rating} IS NULL OR ${table.rating} BETWEEN 1 AND 5`,
    ),
  ],
);

/**
 * `supplier_invoices` (T): the structured record of an AP supplier invoice
 * (legend-v4v7c, 538-G3 slice D), written in the same transaction as its
 * payable open item (`id` = the open item id). `dpp_idr` is the tax base
 * (goods + price variance + services); the PPN input and the PPh 23 withheld
 * are the amounts the invoice journal booked. `npwp_snapshot` keeps the
 * supplier NPWP at the time of the invoice, so a later edit of the supplier
 * never rewrites a filed tax line.
 */
export const supplierInvoices = pgTable(
  "supplier_invoices",
  {
    id: uuid("id").primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    legalEntityId: uuid("legal_entity_id").notNull(),
    supplierId: uuid("supplier_id").notNull(),
    invoiceNumber: varchar("invoice_number", { length: 60 }).notNull(),
    invoiceDate: businessDate("invoice_date").notNull(),
    dppIdr: idrColumn("dpp_idr").notNull(),
    ppnIdr: idrColumn("ppn_idr").notNull(),
    pph23Idr: idrColumn("pph23_idr").notNull(),
    payableIdr: idrColumn("payable_idr").notNull(),
    journalEntryId: uuid("journal_entry_id"),
    npwpSnapshot: varchar("npwp_snapshot", { length: 20 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("supplier_invoices_tenant_id_id_key").on(table.tenantId, table.id),
    unique("supplier_invoices_tenant_supplier_number_key").on(
      table.tenantId,
      table.supplierId,
      table.invoiceNumber,
    ),
    foreignKey({
      name: "supplier_invoices_supplier_fk",
      columns: [table.tenantId, table.supplierId],
      foreignColumns: [suppliers.tenantId, suppliers.id],
    }),
    foreignKey({
      name: "supplier_invoices_legal_entity_fk",
      columns: [table.tenantId, table.legalEntityId],
      foreignColumns: [legalEntities.tenantId, legalEntities.id],
    }),
    foreignKey({
      name: "supplier_invoices_journal_fk",
      columns: [table.tenantId, table.journalEntryId],
      foreignColumns: [journalEntries.tenantId, journalEntries.id],
    }),
    check(
      "supplier_invoices_amounts_check",
      sql`${table.dppIdr} >= 0 AND ${table.ppnIdr} >= 0 AND ${table.pph23Idr} >= 0 AND ${table.payableIdr} > 0`,
    ),
    check(
      "supplier_invoices_number_check",
      sql`length(btrim(${table.invoiceNumber})) > 0`,
    ),
    index("supplier_invoices_period_idx").on(
      table.tenantId,
      table.legalEntityId,
      table.invoiceDate,
    ),
  ],
);

/**
 * `purchase_invoices` (T, outlet-owned): the WS-06 supplier invoice document
 * and its three-way match. `id` equals the `supplier_invoices` tax record and
 * the payable open item when the payable is booked (status `matched` or
 * `released`); a `held` or `rejected` invoice has neither, so it cannot be
 * paid. `price_variance_idr` is signed. `goods_idr` is at the PO price.
 * `tolerance_bp` is the tenant policy the match used. The DB keeps the
 * separation of duties (`decided_by <> recorded_by`) and the state shape.
 * Only the status/decision/match columns can change (`purchasing.custom.sql`).
 */
export const purchaseInvoices = pgTable(
  "purchase_invoices",
  {
    id: uuid("id").primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: uuid("outlet_id").notNull(),
    legalEntityId: uuid("legal_entity_id").notNull(),
    supplierId: uuid("supplier_id").notNull(),
    purchaseOrderId: uuid("purchase_order_id").notNull(),
    number: varchar("number", { length: 60 }).notNull(),
    invoiceDate: businessDate("invoice_date").notNull(),
    dueDate: businessDate("due_date").notNull(),
    goodsIdr: idrColumn("goods_idr").notNull(),
    priceVarianceIdr: idrColumn("price_variance_idr").notNull(),
    servicesIdr: idrColumn("services_idr").notNull(),
    ppnIdr: idrColumn("ppn_idr").notNull(),
    pph23Idr: idrColumn("pph23_idr").notNull(),
    totalIdr: idrColumn("total_idr").notNull(),
    payableIdr: idrColumn("payable_idr").notNull(),
    toleranceBp: integer("tolerance_bp").notNull(),
    matchResult: varchar("match_result", { length: 12 })
      .$type<"matched" | "discrepancy">()
      .notNull(),
    matchSnapshot: jsonb("match_snapshot").$type<ThreeWayMatch>().notNull(),
    matchNote: varchar("match_note", { length: 500 }),
    status: varchar("status", { length: 12 })
      .$type<SupplierInvoiceStatus>()
      .notNull(),
    recordedBy: text("recorded_by")
      .notNull()
      .references(() => user.id),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    decidedBy: text("decided_by").references(() => user.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionNote: varchar("decision_note", { length: 500 }),
    journalEntryId: uuid("journal_entry_id"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("purchase_invoices_tenant_id_id_key").on(table.tenantId, table.id),
    unique("purchase_invoices_tenant_outlet_id_key").on(
      table.tenantId,
      table.outletId,
      table.id,
    ),
    // Two live invoices with one number are two ways to pay once; a rejected
    // invoice frees its number.
    uniqueIndex("purchase_invoices_supplier_number_key")
      .on(table.tenantId, table.supplierId, sql`lower(btrim(${table.number}))`)
      .where(sql`${table.status} <> 'rejected'`),
    foreignKey({
      name: "purchase_invoices_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "purchase_invoices_order_fk",
      columns: [table.tenantId, table.outletId, table.purchaseOrderId],
      foreignColumns: [
        purchaseOrders.tenantId,
        purchaseOrders.outletId,
        purchaseOrders.id,
      ],
    }),
    foreignKey({
      name: "purchase_invoices_supplier_fk",
      columns: [table.tenantId, table.supplierId],
      foreignColumns: [suppliers.tenantId, suppliers.id],
    }),
    foreignKey({
      name: "purchase_invoices_legal_entity_fk",
      columns: [table.tenantId, table.legalEntityId],
      foreignColumns: [legalEntities.tenantId, legalEntities.id],
    }),
    foreignKey({
      name: "purchase_invoices_journal_fk",
      columns: [table.tenantId, table.journalEntryId],
      foreignColumns: [journalEntries.tenantId, journalEntries.id],
    }),
    index("purchase_invoices_order_status_idx").on(
      table.tenantId,
      table.purchaseOrderId,
      table.status,
    ),
    check(
      "purchase_invoices_amounts_check",
      sql`${table.goodsIdr} >= 0 AND ${table.servicesIdr} >= 0
        AND ${table.ppnIdr} >= 0 AND ${table.pph23Idr} >= 0
        AND ${table.totalIdr} >= 0 AND ${table.payableIdr} > 0
        AND ${table.totalIdr} = ${table.goodsIdr} + ${table.priceVarianceIdr}
          + ${table.servicesIdr} + ${table.ppnIdr}
        AND ${table.payableIdr} = ${table.totalIdr} - ${table.pph23Idr}`,
    ),
    check(
      "purchase_invoices_dates_check",
      sql`${table.dueDate} >= ${table.invoiceDate}`,
    ),
    check(
      "purchase_invoices_tolerance_check",
      sql`${table.toleranceBp} BETWEEN 0 AND 1000`,
    ),
    check(
      "purchase_invoices_number_check",
      sql`length(btrim(${table.number})) > 0`,
    ),
    check(
      "purchase_invoices_status_check",
      sql`${table.status} IN ('matched', 'held', 'released', 'rejected')`,
    ),
    check(
      "purchase_invoices_match_result_check",
      sql`${table.matchResult} IN ('matched', 'discrepancy')`,
    ),
    // A payable (journal) exists exactly when the invoice is matched/released.
    check(
      "purchase_invoices_journal_state_check",
      sql`(${table.status} IN ('matched', 'released')) = (${table.journalEntryId} IS NOT NULL)`,
    ),
    check(
      "purchase_invoices_decision_state_check",
      sql`(${table.status} IN ('released', 'rejected')) = (${table.decidedBy} IS NOT NULL)
        AND (${table.decidedBy} IS NULL) = (${table.decidedAt} IS NULL)`,
    ),
    check(
      "purchase_invoices_match_state_check",
      sql`(${table.status} <> 'matched' OR ${table.matchResult} = 'matched')
        AND (${table.status} NOT IN ('held', 'released') OR ${table.matchResult} = 'discrepancy')`,
    ),
    // Separation of duties: whoever recorded the invoice never decides it.
    check(
      "purchase_invoices_decider_check",
      sql`${table.decidedBy} IS NULL OR ${table.decidedBy} <> ${table.recordedBy}`,
    ),
  ],
);

/** `purchase_invoice_lines` (T, outlet-owned, append-only): invoiced lines. */
export const purchaseInvoiceLines = pgTable(
  "purchase_invoice_lines",
  {
    id: uuid("id").primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: uuid("outlet_id").notNull(),
    purchaseInvoiceId: uuid("purchase_invoice_id").notNull(),
    lineNo: smallint("line_no").notNull(),
    purchaseOrderLineId: uuid("purchase_order_line_id"),
    kind: varchar("kind", { length: 8 }).$type<"goods" | "service">().notNull(),
    description: varchar("description", { length: 200 }).notNull(),
    quantity: decimal4Column("quantity").notNull(),
    unitPriceIdr: decimal4Column("unit_price_idr").notNull(),
    lineTotalIdr: idrColumn("line_total_idr").notNull(),
  },
  (table) => [
    unique("purchase_invoice_lines_tenant_id_id_key").on(
      table.tenantId,
      table.id,
    ),
    unique("purchase_invoice_lines_invoice_line_no_key").on(
      table.tenantId,
      table.purchaseInvoiceId,
      table.lineNo,
    ),
    foreignKey({
      name: "purchase_invoice_lines_invoice_fk",
      columns: [table.tenantId, table.outletId, table.purchaseInvoiceId],
      foreignColumns: [
        purchaseInvoices.tenantId,
        purchaseInvoices.outletId,
        purchaseInvoices.id,
      ],
    }),
    foreignKey({
      name: "purchase_invoice_lines_order_line_fk",
      columns: [table.tenantId, table.purchaseOrderLineId],
      foreignColumns: [purchaseOrderLines.tenantId, purchaseOrderLines.id],
    }),
    index("purchase_invoice_lines_order_line_idx").on(
      table.tenantId,
      table.purchaseOrderLineId,
    ),
    check("purchase_invoice_lines_line_no_check", sql`${table.lineNo} > 0`),
    check(
      "purchase_invoice_lines_kind_check",
      sql`${table.kind} IN ('goods', 'service')`,
    ),
    check(
      "purchase_invoice_lines_goods_line_check",
      sql`${table.kind} = 'service' OR ${table.purchaseOrderLineId} IS NOT NULL`,
    ),
    check(
      "purchase_invoice_lines_amounts_check",
      sql`${table.quantity} > 0 AND ${table.unitPriceIdr} >= 0 AND ${table.lineTotalIdr} >= 0`,
    ),
  ],
);

/**
 * `purchasing_policies` (T): one row per tenant. A tenant without a row uses
 * the default three-way match tolerance (0 bp, exact). Finance loosens it, up
 * to 10%, with `expected_updated_at` guarding concurrent edits.
 */
export const purchasingPolicies = pgTable(
  "purchasing_policies",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    threeWayMatchToleranceBp: integer("three_way_match_tolerance_bp").notNull(),
    updatedBy: text("updated_by")
      .notNull()
      .references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      name: "purchasing_policies_pkey",
      columns: [table.tenantId],
    }),
    check(
      "purchasing_policies_tolerance_check",
      sql`${table.threeWayMatchToleranceBp} BETWEEN 0 AND 1000`,
    ),
  ],
);

/** `supplier_contacts` (T): people at a supplier; at most one primary each. */
export const supplierContacts = pgTable(
  "supplier_contacts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    supplierId: uuid("supplier_id").notNull(),
    name: varchar("name", { length: 150 }).notNull(),
    role: varchar("role", { length: 60 }),
    phone: varchar("phone", { length: 16 }).notNull(),
    email: varchar("email", { length: 254 }),
    isPrimary: boolean("is_primary").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("supplier_contacts_tenant_id_id_key").on(table.tenantId, table.id),
    foreignKey({
      name: "supplier_contacts_supplier_fk",
      columns: [table.tenantId, table.supplierId],
      foreignColumns: [suppliers.tenantId, suppliers.id],
    }),
    uniqueIndex("supplier_contacts_primary_idx")
      .on(table.tenantId, table.supplierId)
      .where(sql`${table.isPrimary}`),
    index("supplier_contacts_tenant_supplier_idx").on(
      table.tenantId,
      table.supplierId,
      table.id,
    ),
  ],
);

/**
 * `supplier_prices` (T): the price history of an item per supplier and
 * purchase unit. Append-only: a new price is a new row that supersedes the
 * older ones from its `effective_from`; only `is_active` may change (the
 * application login has no other UPDATE and no DELETE).
 */
export const supplierPrices = pgTable(
  "supplier_prices",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    supplierId: uuid("supplier_id").notNull(),
    inventoryItemId: uuid("inventory_item_id").notNull(),
    purchaseUomId: uuid("purchase_uom_id").notNull(),
    priceIdr: decimal4Column("price_idr").notNull(),
    effectiveFrom: businessDate("effective_from").notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("supplier_prices_tenant_id_id_key").on(table.tenantId, table.id),
    foreignKey({
      name: "supplier_prices_supplier_fk",
      columns: [table.tenantId, table.supplierId],
      foreignColumns: [suppliers.tenantId, suppliers.id],
    }),
    foreignKey({
      name: "supplier_prices_item_fk",
      columns: [table.tenantId, table.inventoryItemId],
      foreignColumns: [inventoryItems.tenantId, inventoryItems.id],
    }),
    foreignKey({
      name: "supplier_prices_uom_fk",
      columns: [table.tenantId, table.purchaseUomId],
      foreignColumns: [uoms.tenantId, uoms.id],
    }),
    index("supplier_prices_lookup_idx").on(
      table.tenantId,
      table.supplierId,
      table.inventoryItemId,
      table.effectiveFrom,
      table.createdAt,
    ),
    index("supplier_prices_item_idx").on(
      table.tenantId,
      table.inventoryItemId,
      table.effectiveFrom,
    ),
    check("supplier_prices_price_check", sql`${table.priceIdr} >= 0`),
  ],
);

/**
 * `purchase_requests` (T, outlet-owned): an outlet's request to buy items
 * (PRD §4 Alur I). Status moves only through the contract transition table.
 * `approval_chain_id` is the generic approval request opened on submit, when
 * a policy requires one.
 */
export const purchaseRequests = pgTable(
  "purchase_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: uuid("outlet_id").notNull(),
    requestedBy: text("requested_by")
      .notNull()
      .references(() => user.id),
    status: varchar("status", { length: 20 })
      .$type<PurchaseRequestStatus>()
      .notNull()
      .default("draft"),
    neededBy: businessDate("needed_by").notNull(),
    note: varchar("note", { length: 300 }),
    decidedBy: text("decided_by").references(() => user.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionNote: varchar("decision_note", { length: 300 }),
    approvalChainId: uuid("approval_chain_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("purchase_requests_tenant_id_id_key").on(table.tenantId, table.id),
    unique("purchase_requests_tenant_outlet_id_key").on(
      table.tenantId,
      table.outletId,
      table.id,
    ),
    foreignKey({
      name: "purchase_requests_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    index("purchase_requests_tenant_outlet_created_idx").on(
      table.tenantId,
      table.outletId,
      table.createdAt,
      table.id,
    ),
    index("purchase_requests_tenant_outlet_status_idx").on(
      table.tenantId,
      table.outletId,
      table.status,
    ),
    check(
      "purchase_requests_status_check",
      sql`${table.status} IN ('draft', 'pending_approval', 'approved', 'rejected', 'converted', 'cancelled')`,
    ),
  ],
);

/** `purchase_request_lines` (T, outlet-owned): one wanted item per line. */
export const purchaseRequestLines = pgTable(
  "purchase_request_lines",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: uuid("outlet_id").notNull(),
    purchaseRequestId: uuid("purchase_request_id").notNull(),
    inventoryItemId: uuid("inventory_item_id").notNull(),
    quantity: decimal4Column("quantity").notNull(),
    uomId: uuid("uom_id").notNull(),
  },
  (table) => [
    unique("purchase_request_lines_tenant_id_id_key").on(
      table.tenantId,
      table.id,
    ),
    foreignKey({
      name: "purchase_request_lines_request_fk",
      columns: [table.tenantId, table.outletId, table.purchaseRequestId],
      foreignColumns: [
        purchaseRequests.tenantId,
        purchaseRequests.outletId,
        purchaseRequests.id,
      ],
    }),
    foreignKey({
      name: "purchase_request_lines_item_fk",
      columns: [table.tenantId, table.inventoryItemId],
      foreignColumns: [inventoryItems.tenantId, inventoryItems.id],
    }),
    foreignKey({
      name: "purchase_request_lines_uom_fk",
      columns: [table.tenantId, table.uomId],
      foreignColumns: [uoms.tenantId, uoms.id],
    }),
    index("purchase_request_lines_request_idx").on(
      table.tenantId,
      table.outletId,
      table.purchaseRequestId,
    ),
    check("purchase_request_lines_quantity_check", sql`${table.quantity} > 0`),
  ],
);

/**
 * `purchase_orders` (T, outlet-owned): an order placed with one supplier. The
 * number `PO/<YYYYMM>/<0001>` comes from `purchasing_document_sequences`.
 * `total_idr = subtotal_idr + tax_idr` is enforced here as well as in the
 * service.
 */
export const purchaseOrders = pgTable(
  "purchase_orders",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: uuid("outlet_id").notNull(),
    supplierId: uuid("supplier_id").notNull(),
    number: varchar("number", { length: 40 }).notNull(),
    purchaseRequestId: uuid("purchase_request_id"),
    status: varchar("status", { length: 20 })
      .$type<PurchaseOrderStatus>()
      .notNull()
      .default("draft"),
    expectedDate: businessDate("expected_date").notNull(),
    subtotalIdr: idrColumn("subtotal_idr").notNull(),
    taxIdr: idrColumn("tax_idr").notNull(),
    totalIdr: idrColumn("total_idr").notNull(),
    source: varchar("source", { length: 10 })
      .$type<PurchaseOrderSource>()
      .notNull()
      .default("user"),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id),
    approvedBy: text("approved_by").references(() => user.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    sentTo: varchar("sent_to", { length: 254 }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    note: varchar("note", { length: 300 }),
    approvalChainId: uuid("approval_chain_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("purchase_orders_tenant_id_id_key").on(table.tenantId, table.id),
    unique("purchase_orders_tenant_outlet_id_key").on(
      table.tenantId,
      table.outletId,
      table.id,
    ),
    unique("purchase_orders_tenant_number_key").on(
      table.tenantId,
      table.number,
    ),
    foreignKey({
      name: "purchase_orders_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "purchase_orders_supplier_fk",
      columns: [table.tenantId, table.supplierId],
      foreignColumns: [suppliers.tenantId, suppliers.id],
    }),
    foreignKey({
      name: "purchase_orders_request_fk",
      columns: [table.tenantId, table.outletId, table.purchaseRequestId],
      foreignColumns: [
        purchaseRequests.tenantId,
        purchaseRequests.outletId,
        purchaseRequests.id,
      ],
    }),
    index("purchase_orders_tenant_outlet_created_idx").on(
      table.tenantId,
      table.outletId,
      table.createdAt,
      table.id,
    ),
    index("purchase_orders_tenant_outlet_status_idx").on(
      table.tenantId,
      table.outletId,
      table.status,
    ),
    index("purchase_orders_tenant_supplier_idx").on(
      table.tenantId,
      table.supplierId,
    ),
    check(
      "purchase_orders_status_check",
      sql`${table.status} IN ('draft', 'pending_approval', 'approved', 'sent', 'partially_received', 'received', 'closed', 'cancelled')`,
    ),
    check(
      "purchase_orders_source_check",
      sql`${table.source} IN ('user', 'ai', 'mcp')`,
    ),
    check(
      "purchase_orders_totals_check",
      sql`${table.subtotalIdr} >= 0 AND ${table.taxIdr} >= 0
        AND ${table.totalIdr} >= 0
        AND ${table.totalIdr} = ${table.subtotalIdr} + ${table.taxIdr}`,
    ),
  ],
);

/** `purchase_order_lines` (T, outlet-owned): priced lines of one order. */
export const purchaseOrderLines = pgTable(
  "purchase_order_lines",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: uuid("outlet_id").notNull(),
    purchaseOrderId: uuid("purchase_order_id").notNull(),
    inventoryItemId: uuid("inventory_item_id").notNull(),
    quantity: decimal4Column("quantity").notNull(),
    uomId: uuid("uom_id").notNull(),
    unitPriceIdr: decimal4Column("unit_price_idr").notNull(),
    lineTotalIdr: idrColumn("line_total_idr").notNull(),
    lineNo: smallint("line_no").notNull(),
  },
  (table) => [
    unique("purchase_order_lines_tenant_id_id_key").on(
      table.tenantId,
      table.id,
    ),
    unique("purchase_order_lines_order_line_no_key").on(
      table.tenantId,
      table.purchaseOrderId,
      table.lineNo,
    ),
    foreignKey({
      name: "purchase_order_lines_order_fk",
      columns: [table.tenantId, table.outletId, table.purchaseOrderId],
      foreignColumns: [
        purchaseOrders.tenantId,
        purchaseOrders.outletId,
        purchaseOrders.id,
      ],
    }),
    foreignKey({
      name: "purchase_order_lines_item_fk",
      columns: [table.tenantId, table.inventoryItemId],
      foreignColumns: [inventoryItems.tenantId, inventoryItems.id],
    }),
    foreignKey({
      name: "purchase_order_lines_uom_fk",
      columns: [table.tenantId, table.uomId],
      foreignColumns: [uoms.tenantId, uoms.id],
    }),
    index("purchase_order_lines_order_idx").on(
      table.tenantId,
      table.outletId,
      table.purchaseOrderId,
    ),
    check("purchase_order_lines_quantity_check", sql`${table.quantity} > 0`),
    check(
      "purchase_order_lines_price_check",
      sql`${table.unitPriceIdr} >= 0 AND ${table.lineTotalIdr} >= 0`,
    ),
    check("purchase_order_lines_line_no_check", sql`${table.lineNo} > 0`),
  ],
);

/**
 * `purchasing_document_sequences` (T): the last used number per tenant, kind
 * and month. The service bumps it with `INSERT ... ON CONFLICT DO UPDATE ...
 * RETURNING`, so concurrent orders never share a number.
 */
export const purchasingDocumentSequences = pgTable(
  "purchasing_document_sequences",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    kind: varchar("kind", { length: 10 }).notNull(),
    period: varchar("period", { length: 6 }).notNull(),
    lastValue: integer("last_value").notNull(),
  },
  (table) => [
    primaryKey({
      name: "purchasing_document_sequences_pkey",
      columns: [table.tenantId, table.kind, table.period],
    }),
    check(
      "purchasing_document_sequences_kind_check",
      sql`${table.kind} IN ('PO', 'GR', 'RT')`,
    ),
    check(
      "purchasing_document_sequences_period_check",
      sql`${table.period} ~ '^[0-9]{6}$'`,
    ),
    check(
      "purchasing_document_sequences_value_check",
      sql`${table.lastValue} >= 0`,
    ),
  ],
);

/**
 * `purchase_order_share_links` (T, outlet-owned): a public link to the PO PDF.
 * Only the SHA-256 hex of the token is stored; the token itself is shown once.
 */
export const purchaseOrderShareLinks = pgTable(
  "purchase_order_share_links",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: uuid("outlet_id").notNull(),
    purchaseOrderId: uuid("purchase_order_id").notNull(),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("purchase_order_share_links_tenant_id_id_key").on(
      table.tenantId,
      table.id,
    ),
    unique("purchase_order_share_links_token_hash_key").on(table.tokenHash),
    foreignKey({
      name: "purchase_order_share_links_order_fk",
      columns: [table.tenantId, table.outletId, table.purchaseOrderId],
      foreignColumns: [
        purchaseOrders.tenantId,
        purchaseOrders.outletId,
        purchaseOrders.id,
      ],
    }),
    index("purchase_order_share_links_order_idx").on(
      table.tenantId,
      table.outletId,
      table.purchaseOrderId,
    ),
    check(
      "purchase_order_share_links_hash_check",
      sql`${table.tokenHash} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);

/**
 * `purchase_order_email_deliveries` (T, outlet-owned): one queued email of a
 * PO PDF. `last_error` is a short reason and never contains the address.
 */
export const purchaseOrderEmailDeliveries = pgTable(
  "purchase_order_email_deliveries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: uuid("outlet_id").notNull(),
    purchaseOrderId: uuid("purchase_order_id").notNull(),
    recipientEmail: varchar("recipient_email", { length: 254 }).notNull(),
    status: varchar("status", { length: 12 }).notNull().default("queued"),
    attempts: smallint("attempts").default(0).notNull(),
    lastError: varchar("last_error", { length: 200 }),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    /** Earliest time the worker may try again; null means now. */
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    /**
     * Set (committed) before the provider is called, cleared when the outcome
     * is recorded. Still set when the row is claimed again = the worker died
     * mid-send and the provider may hold the email: never resent blindly.
     */
    sendStartedAt: timestamp("send_started_at", { withTimezone: true }),
  },
  (table) => [
    unique("purchase_order_email_deliveries_tenant_id_id_key").on(
      table.tenantId,
      table.id,
    ),
    foreignKey({
      name: "purchase_order_email_deliveries_order_fk",
      columns: [table.tenantId, table.outletId, table.purchaseOrderId],
      foreignColumns: [
        purchaseOrders.tenantId,
        purchaseOrders.outletId,
        purchaseOrders.id,
      ],
    }),
    index("purchase_order_email_deliveries_order_idx").on(
      table.tenantId,
      table.outletId,
      table.purchaseOrderId,
      table.createdAt,
    ),
    check(
      "purchase_order_email_deliveries_status_check",
      sql`${table.status} IN ('queued', 'sent', 'failed')`,
    ),
    check(
      "purchase_order_email_deliveries_attempts_check",
      sql`${table.attempts} >= 0`,
    ),
  ],
);

/**
 * `purchasing_idempotency` (T): retry guard for purchasing writes. Same shape
 * as `inventory_ops_idempotency`, but `outlet_id` is nullable because suppliers
 * are tenant-level, so only the tenant RLS policy applies.
 */
export const purchasingIdempotency = pgTable(
  "purchasing_idempotency",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: uuid("outlet_id"),
    operation: varchar("operation", { length: 60 }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 100 }).notNull(),
    requestFingerprint: varchar("request_fingerprint", {
      length: 64,
    }).notNull(),
    /** The first response; null only inside the claiming transaction. */
    response: jsonb("response"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      name: "purchasing_idempotency_pkey",
      columns: [table.tenantId, table.operation, table.idempotencyKey],
    }),
    foreignKey({
      name: "purchasing_idempotency_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    check(
      "purchasing_idempotency_fingerprint_check",
      sql`${table.requestFingerprint} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);

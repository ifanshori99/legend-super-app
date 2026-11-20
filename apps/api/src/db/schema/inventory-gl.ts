// Inventory -> GL bridge tracking (PRD v1.7 §3.19 Jurnal Otomatis, Alur J.4;
// bead legend-w1vo).
//
// One row per `stock_ledger` row that the `stock.moved` consumer has handled,
// plus `inventory_gl_blocked` for sources that wait on an accounting fix.
// `journal_entry_id` is null when the value of the consumed batch was zero and
// no journal was needed. Tenant-owned and outlet-owned (RLS in the custom
// migration after this table). Foreign keys are limited to the tenant: the
// ledger and journal rows are referenced by id only, so the table never needs
// the FORCE RLS lift of 0074 and stays a pure consumer ledger.

import {
  bigint,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { StockSourceType } from "@starter/shared/inventory";
import { decimal4Column, tenantIdColumn, ulidInUuid } from "../columns.ts";
import { tenants } from "./platform-org.ts";

/**
 * Source types the GL bridge tracks: every stock ledger source plus
 * `negative_stock_revaluation` (bead 1214), the revaluation of a receipt that
 * landed on a negative balance. It is not a stock movement (no quantity), so it
 * never appears in `stock_ledger`.
 */
export type InventoryGlSourceType =
  StockSourceType | "negative_stock_revaluation";

/**
 * `inventory_gl_postings` (T, outlet-owned): a stock ledger row that already
 * went through the GL bridge. `value_idr` is this row's signed stock effect
 * (quantity x the row's unit cost, half_up, whole rupiah; positive = stock in).
 * It is an audit trail, not the journal amount: waste rounds once over the
 * whole log and COGS posts the opposite sign, so summing `value_idr` per
 * journal can differ from the journal by rounding and sign. Nothing updates a
 * row after insert.
 */
export const inventoryGlPostings = pgTable(
  "inventory_gl_postings",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    ledgerEntryId: ulidInUuid("ledger_entry_id").notNull(),
    outletId: uuid("outlet_id").notNull(),
    sourceType: varchar("source_type", { length: 30 })
      .$type<InventoryGlSourceType>()
      .notNull(),
    sourceId: text("source_id").notNull(),
    journalEntryId: uuid("journal_entry_id"),
    valueIdr: bigint("value_idr", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // Bead legend-slssv (1232): one ledger row can feed two GL sources (an
    // order return or a count gain and its negative-balance revaluation).
    unique("inventory_gl_postings_tenant_source_ledger_entry_key").on(
      table.tenantId,
      table.sourceType,
      table.ledgerEntryId,
    ),
    index("inventory_gl_postings_source_idx").on(
      table.tenantId,
      table.sourceType,
      table.sourceId,
    ),
  ],
);

/**
 * `inventory_gl_blocked` (T, outlet-owned): a stock source whose journal could
 * not post for an expected accounting reason (closed period, missing or
 * unusable account mapping). The consumer records it instead of failing the
 * outbox consumption, and `retryBlockedInventoryGl` retries it; the row is
 * deleted once the source posts. `source_id` is the domain form (ULID text for
 * orders, D-CORE-1).
 */
export const inventoryGlBlocked = pgTable(
  "inventory_gl_blocked",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: uuid("outlet_id").notNull(),
    sourceType: varchar("source_type", { length: 30 })
      .$type<InventoryGlSourceType>()
      .notNull(),
    sourceId: text("source_id").notNull(),
    errorCode: varchar("error_code", { length: 60 }).notNull(),
    attempts: integer("attempts").notNull().default(1),
    firstFailedAt: timestamp("first_failed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastFailedAt: timestamp("last_failed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("inventory_gl_blocked_tenant_source_key").on(
      table.tenantId,
      table.sourceType,
      table.sourceId,
    ),
    index("inventory_gl_blocked_retry_idx").on(
      table.tenantId,
      table.firstFailedAt,
    ),
  ],
);

/**
 * `stock_negative_revaluations` (T, outlet-owned; bead 1214): one row per
 * receipt ledger row that landed on a negative balance. The sale ran ahead of
 * the receipt at the old average and the receipt reset the average to its own
 * cost, so the stock card value is `value_idr` away from the receipt journal:
 * `prior_quantity x (unit_cost_idr - prior_avg_cost_idr)`, half_up to whole
 * rupiah (negative = the card is lower than the books, Dr HPP / Cr inventory).
 * Written in the same transaction as the receipt row, under its balance lock;
 * the GL bridge posts it as source `negative_stock_revaluation` keyed by the
 * goods receipt. `ledger_entry_id` is the receipt row. Append-only.
 */
export const stockNegativeRevaluations = pgTable(
  "stock_negative_revaluations",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    ledgerEntryId: ulidInUuid("ledger_entry_id").notNull(),
    outletId: uuid("outlet_id").notNull(),
    locationId: uuid("location_id").notNull(),
    inventoryItemId: uuid("inventory_item_id").notNull(),
    sourceId: uuid("source_id").notNull(),
    priorQuantity: decimal4Column("prior_quantity").notNull(),
    priorAvgCostIdr: decimal4Column("prior_avg_cost_idr").notNull(),
    unitCostIdr: decimal4Column("unit_cost_idr").notNull(),
    valueIdr: bigint("value_idr", { mode: "number" }).notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("stock_negative_revaluations_tenant_ledger_entry_key").on(
      table.tenantId,
      table.ledgerEntryId,
    ),
    index("stock_negative_revaluations_source_idx").on(
      table.tenantId,
      table.sourceId,
    ),
  ],
);

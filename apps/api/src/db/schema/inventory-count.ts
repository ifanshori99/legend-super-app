// Stock count (stok opname) tables (PRD v1.7 §3 F16 "Stok Opname", INV-03;
// §4 Alur J; bead legend-j5x).
//
// A count is for ONE stock location. Both tables are tenant-owned and
// outlet-owned: tenant_id / outlet_id NOT NULL, `app.enforce_tenant_rls` +
// `app.enforce_outlet_rls` in `inventory-count.custom.sql`, unique constraints
// always include tenant_id and composite (tenant_id, outlet_id, …) foreign keys
// keep every reference inside one tenant AND outlet. Quantities and unit costs
// are NUMERIC(14,4) decimal strings, money is BIGINT rupiah (D-CORE-2). User
// ids are Better Auth text ids, like every other `*_by` column.

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type {
  StockCountStatus,
  StockCountType,
} from "@starter/shared/inventory";
import {
  businessDate,
  decimal4Column,
  idrColumn,
  tenantIdColumn,
} from "../columns.ts";
import { inventoryItems, stockLocations } from "./inventory.ts";
import { tenants } from "./platform-org.ts";
import { user } from "./user.ts";

/**
 * `stock_counts` (T, outlet-owned): one opname session for one location.
 * `counted_by` is the creator (counter); `counter_ids` is the append-only set
 * of everyone who entered a line; `decider_ids` the append-only set of everyone
 * who decided an approval level. Approval runs through
 * `approval_requests`: `approval_chain_id` / `approval_version` / `lines_hash`
 * bind the approval to the exact counted lines (`count_version` is bumped on
 * every line edit). At most one open count per location (partial unique index).
 */
export const stockCounts = pgTable(
  "stock_counts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: uuid("outlet_id").notNull(),
    locationId: uuid("location_id").notNull(),
    type: varchar("type", { length: 20 }).$type<StockCountType>().notNull(),
    status: varchar("status", { length: 30 })
      .$type<StockCountStatus>()
      .notNull(),
    blind: boolean("blind").notNull(),
    businessDate: businessDate("business_date").notNull(),
    note: text("note"),
    countedBy: text("counted_by")
      .notNull()
      .references(() => user.id),
    // Everyone who ever entered a quantity (creator included); only appended,
    // so a recount that clears the line counters keeps the second-person rule.
    counterIds: text("counter_ids")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    // Everyone who approved or rejected a level of this count's chains; only
    // appended. A decider can never enter a line afterwards.
    deciderIds: text("decider_ids")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    countVersion: integer("count_version").notNull().default(0),
    snapshotAt: timestamp("snapshot_at", { withTimezone: true }),
    countedAt: timestamp("counted_at", { withTimezone: true }),
    approvalChainId: uuid("approval_chain_id"),
    approvalVersion: integer("approval_version"),
    linesHash: varchar("lines_hash", { length: 64 }),
    totalVarianceIdr: idrColumn("total_variance_idr"),
    grossVarianceIdr: idrColumn("gross_variance_idr"),
    approvedBy: text("approved_by").references(() => user.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    createIdempotencyKey: varchar("create_idempotency_key").notNull(),
    createFingerprint: varchar("create_fingerprint", { length: 64 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("stock_counts_tenant_id_id_key").on(table.tenantId, table.id),
    unique("stock_counts_tenant_outlet_id_key").on(
      table.tenantId,
      table.outletId,
      table.id,
    ),
    unique("stock_counts_tenant_create_idempotency_key").on(
      table.tenantId,
      table.createIdempotencyKey,
    ),
    foreignKey({
      name: "stock_counts_location_fk",
      columns: [table.tenantId, table.outletId, table.locationId],
      foreignColumns: [
        stockLocations.tenantId,
        stockLocations.outletId,
        stockLocations.id,
      ],
    }),
    // INV-03: one open count per location.
    uniqueIndex("stock_counts_open_location_idx")
      .on(table.tenantId, table.locationId)
      .where(
        sql`${table.status} IN ('draft', 'counting', 'pending_approval', 'approved')`,
      ),
    index("stock_counts_tenant_outlet_created_idx").on(
      table.tenantId,
      table.outletId,
      table.createdAt,
      table.id,
    ),
    check("stock_counts_type_check", sql`${table.type} IN ('full', 'cycle')`),
    check(
      "stock_counts_status_check",
      sql`${table.status} IN ('draft', 'counting', 'pending_approval', 'approved', 'posted', 'cancelled')`,
    ),
    check("stock_counts_version_check", sql`${table.countVersion} >= 0`),
    check(
      "stock_counts_approved_check",
      sql`${table.status} NOT IN ('approved', 'posted') OR (${table.approvedBy} IS NOT NULL AND ${table.approvedAt} IS NOT NULL)`,
    ),
    check(
      "stock_counts_posted_check",
      sql`${table.status} <> 'posted' OR ${table.postedAt} IS NOT NULL`,
    ),
    check(
      "stock_counts_approval_bound_check",
      sql`${table.status} NOT IN ('pending_approval', 'approved', 'posted') OR (${table.approvalChainId} IS NOT NULL AND ${table.approvalVersion} IS NOT NULL AND ${table.linesHash} IS NOT NULL AND ${table.countedAt} IS NOT NULL)`,
    ),
  ],
);

/**
 * `stock_count_lines` (T, outlet-owned): one item of a count. `system_qty` and
 * `unit_cost_idr` are provisional at start and REFRESHED each time the line is
 * entered (stock and cost at that moment); `counted_by` is the last user who
 * entered the line.
 */
export const stockCountLines = pgTable(
  "stock_count_lines",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: uuid("outlet_id").notNull(),
    stockCountId: uuid("stock_count_id").notNull(),
    inventoryItemId: uuid("inventory_item_id").notNull(),
    systemQty: decimal4Column("system_qty").notNull(),
    unitCostIdr: decimal4Column("unit_cost_idr").notNull(),
    countedQty: decimal4Column("counted_qty"),
    varianceQty: decimal4Column("variance_qty"),
    varianceIdr: idrColumn("variance_idr"),
    countedBy: text("counted_by").references(() => user.id),
    countedAt: timestamp("counted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("stock_count_lines_tenant_id_id_key").on(table.tenantId, table.id),
    unique("stock_count_lines_tenant_count_item_key").on(
      table.tenantId,
      table.stockCountId,
      table.inventoryItemId,
    ),
    foreignKey({
      name: "stock_count_lines_count_fk",
      columns: [table.tenantId, table.outletId, table.stockCountId],
      foreignColumns: [
        stockCounts.tenantId,
        stockCounts.outletId,
        stockCounts.id,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "stock_count_lines_item_fk",
      columns: [table.tenantId, table.inventoryItemId],
      foreignColumns: [inventoryItems.tenantId, inventoryItems.id],
    }),
    index("stock_count_lines_tenant_count_idx").on(
      table.tenantId,
      table.stockCountId,
    ),
    check(
      "stock_count_lines_counted_check",
      sql`${table.countedQty} IS NULL OR ${table.countedQty} >= 0`,
    ),
    check(
      "stock_count_lines_counter_check",
      sql`(${table.countedBy} IS NULL) = (${table.countedAt} IS NULL)`,
    ),
  ],
);

// Inventory operations tables (PRD v1.7 §3 F16 "Batch & Kedaluwarsa", "Par
// Level & Saran Pembelian", "Waste & Spoilage"; §3 F17 "Produksi Batch"; §6 E
// `production_orders`, `waste_logs`; bead legend-ugo).
//
// New tables only: locations, items, ledger, balances, batches and the transfer
// document live in `inventory.ts` (legend-98t); par levels and tenant settings
// in `inventory-setup.ts` (legend-gjmk). Every table here is tenant-owned and
// outlet-owned: tenant_id / outlet_id NOT NULL, `app.enforce_tenant_rls` +
// `app.enforce_outlet_rls` in `inventory-ops.custom.sql`, unique constraints
// always include tenant_id, and composite (tenant_id, outlet_id, …) foreign
// keys keep every reference inside one tenant AND outlet. Quantities and unit
// costs are NUMERIC(14,4) decimal strings, money is BIGINT rupiah (D-CORE-2).

import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type {
  ProductionOrderStatus,
  WasteReason,
  WasteTargetType,
} from "@starter/shared/inventory";
import {
  businessDate,
  decimal4Column,
  idrColumn,
  tenantIdColumn,
} from "../columns.ts";
import { inventoryItems, stockBatches, stockLocations } from "./inventory.ts";
import { outlets, tenants } from "./platform-org.ts";
import { recipes } from "./recipe.ts";
import { user } from "./user.ts";

/**
 * `production_orders` (T, outlet-owned): one batch of a semi-finished recipe
 * (PRD §17 "Produksi Batch", §6 E). `location_id` is where the components are
 * drawn and the output is put away; `output_item_id` is the recipe's output
 * snapshotted at creation, so completion cannot post into a different item.
 * `recipe_id` references `recipes` per tenant (legend-tk7i, migration 0172).
 */
export const productionOrders = pgTable(
  "production_orders",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: uuid("outlet_id").notNull(),
    locationId: uuid("location_id").notNull(),
    recipeId: uuid("recipe_id").notNull(),
    outputItemId: uuid("output_item_id").notNull(),
    plannedQty: decimal4Column("planned_qty").notNull(),
    actualQty: decimal4Column("actual_qty"),
    status: varchar("status", { length: 20 })
      .$type<ProductionOrderStatus>()
      .notNull()
      .default("draft"),
    costIdr: idrColumn("cost_idr"),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("production_orders_tenant_id_id_key").on(table.tenantId, table.id),
    unique("production_orders_tenant_outlet_id_key").on(
      table.tenantId,
      table.outletId,
      table.id,
    ),
    foreignKey({
      name: "production_orders_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "production_orders_location_fk",
      columns: [table.tenantId, table.outletId, table.locationId],
      foreignColumns: [
        stockLocations.tenantId,
        stockLocations.outletId,
        stockLocations.id,
      ],
    }),
    foreignKey({
      name: "production_orders_recipe_fk",
      columns: [table.tenantId, table.recipeId],
      foreignColumns: [recipes.tenantId, recipes.id],
    }),
    foreignKey({
      name: "production_orders_output_item_fk",
      columns: [table.tenantId, table.outputItemId],
      foreignColumns: [inventoryItems.tenantId, inventoryItems.id],
    }),
    index("production_orders_tenant_outlet_created_idx").on(
      table.tenantId,
      table.outletId,
      table.createdAt,
      table.id,
    ),
    check(
      "production_orders_status_check",
      sql`${table.status} IN ('draft', 'in_progress', 'completed', 'cancelled')`,
    ),
    check("production_orders_planned_check", sql`${table.plannedQty} > 0`),
    check(
      "production_orders_cost_check",
      sql`${table.costIdr} IS NULL OR ${table.costIdr} >= 0`,
    ),
    // Contract `productionOrderSchema`: a completed batch has a positive actual
    // output, its cost and its completion time; nothing else is completed.
    check(
      "production_orders_completed_check",
      sql`(${table.status} = 'completed') = (${table.completedAt} IS NOT NULL)
        AND (${table.status} <> 'completed' OR (${table.actualQty} > 0 AND ${table.costIdr} IS NOT NULL))`,
    ),
  ],
);

/**
 * `waste_logs` (T, outlet-owned): an ingredient or a finished menu portion
 * thrown away, with a standard reason, optional photo and the loss value
 * (PRD §16 "Waste & Spoilage", §6 E). `value_idr` is quantity x the server's
 * moving-average cost, never client input. `target_id` is an inventory item or
 * a menu item depending on `target_type`, so it is checked by the service.
 */
export const wasteLogs = pgTable(
  "waste_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: uuid("outlet_id").notNull(),
    locationId: uuid("location_id").notNull(),
    targetType: varchar("target_type", { length: 20 })
      .$type<WasteTargetType>()
      .notNull(),
    targetId: uuid("target_id").notNull(),
    quantity: decimal4Column("quantity").notNull(),
    reason: varchar("reason", { length: 30 }).$type<WasteReason>().notNull(),
    mediaId: uuid("media_id"),
    valueIdr: idrColumn("value_idr").notNull(),
    loggedBy: text("logged_by")
      .notNull()
      .references(() => user.id),
    /** When the waste happened (reported); the ledger posts at record time. */
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("waste_logs_tenant_id_id_key").on(table.tenantId, table.id),
    foreignKey({
      name: "waste_logs_location_fk",
      columns: [table.tenantId, table.outletId, table.locationId],
      foreignColumns: [
        stockLocations.tenantId,
        stockLocations.outletId,
        stockLocations.id,
      ],
    }),
    index("waste_logs_tenant_outlet_occurred_idx").on(
      table.tenantId,
      table.outletId,
      table.occurredAt,
      table.id,
    ),
    check("waste_logs_quantity_check", sql`${table.quantity} > 0`),
    check("waste_logs_value_check", sql`${table.valueIdr} >= 0`),
    check(
      "waste_logs_target_type_check",
      sql`${table.targetType} IN ('inventory_item', 'menu_item')`,
    ),
    check(
      "waste_logs_reason_check",
      sql`${table.reason} IN ('expired', 'spoiled', 'dropped', 'prep_error', 'overproduction', 'quality_reject', 'other')`,
    ),
  ],
);

/** Alert kinds: a par breach per location/item, or an expiry stage per batch. */
export type InventoryStockAlertKind =
  "par_critical" | "expiring_soon" | "expired";

/**
 * `inventory_stock_alerts` (T, outlet-owned): open and resolved stock alerts
 * (PRD §16 "peringatan stok kritis", "peringatan menjelang kedaluwarsa").
 * Dedupe lives in the database: at most one OPEN par alert per location/item
 * and one OPEN alert per batch and expiry stage (partial unique indexes), so
 * a re-evaluation never raises the same alert twice; it is raised again only
 * after it was resolved (stock recovered / batch used up).
 */
export const inventoryStockAlerts = pgTable(
  "inventory_stock_alerts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: uuid("outlet_id").notNull(),
    locationId: uuid("location_id").notNull(),
    inventoryItemId: uuid("inventory_item_id").notNull(),
    batchId: uuid("batch_id"),
    kind: varchar("kind", { length: 20 })
      .$type<InventoryStockAlertKind>()
      .notNull(),
    /** Quantity on hand (par) or left in the batch (expiry) when raised. */
    quantity: decimal4Column("quantity").notNull(),
    /** Effective par minimum for a par alert; null for expiry alerts. */
    parMin: decimal4Column("par_min"),
    expiresOn: businessDate("expires_on"),
    raisedAt: timestamp("raised_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [
    unique("inventory_stock_alerts_tenant_id_id_key").on(
      table.tenantId,
      table.id,
    ),
    uniqueIndex("inventory_stock_alerts_open_par_idx")
      .on(table.tenantId, table.locationId, table.inventoryItemId)
      .where(
        sql`${table.kind} = 'par_critical' AND ${table.resolvedAt} IS NULL`,
      ),
    uniqueIndex("inventory_stock_alerts_open_batch_idx")
      .on(table.tenantId, table.batchId, table.kind)
      .where(
        sql`${table.kind} <> 'par_critical' AND ${table.resolvedAt} IS NULL`,
      ),
    foreignKey({
      name: "inventory_stock_alerts_location_fk",
      columns: [table.tenantId, table.outletId, table.locationId],
      foreignColumns: [
        stockLocations.tenantId,
        stockLocations.outletId,
        stockLocations.id,
      ],
    }),
    foreignKey({
      name: "inventory_stock_alerts_item_fk",
      columns: [table.tenantId, table.inventoryItemId],
      foreignColumns: [inventoryItems.tenantId, inventoryItems.id],
    }),
    foreignKey({
      name: "inventory_stock_alerts_batch_fk",
      columns: [table.tenantId, table.outletId, table.batchId],
      foreignColumns: [
        stockBatches.tenantId,
        stockBatches.outletId,
        stockBatches.id,
      ],
    }),
    index("inventory_stock_alerts_tenant_outlet_open_idx").on(
      table.tenantId,
      table.outletId,
      table.resolvedAt,
      table.raisedAt,
    ),
    check(
      "inventory_stock_alerts_kind_check",
      sql`${table.kind} IN ('par_critical', 'expiring_soon', 'expired')`,
    ),
    // A par alert names a location/item and its par; an expiry alert a batch.
    check(
      "inventory_stock_alerts_shape_check",
      sql`(${table.kind} = 'par_critical' AND ${table.batchId} IS NULL AND ${table.parMin} IS NOT NULL)
        OR (${table.kind} <> 'par_critical' AND ${table.batchId} IS NOT NULL AND ${table.expiresOn} IS NOT NULL)`,
    ),
    check(
      "inventory_stock_alerts_resolved_check",
      sql`${table.resolvedAt} IS NULL OR ${table.resolvedAt} >= ${table.raisedAt}`,
    ),
  ],
);

/**
 * `inventory_ops_idempotency` (T, outlet-owned): retry guard for the
 * operation writes (waste, transfer, production create/transition). The key
 * is claimed in the same transaction as the work and bound to a SHA-256
 * fingerprint of the request + actor. A replay with the same fingerprint
 * returns the stored response; a different request under the same key is
 * IDEMPOTENCY_KEY_REUSED (409). A concurrent retry waits on the primary key
 * until the first transaction commits, then replays it.
 */
export const inventoryOpsIdempotency = pgTable(
  "inventory_ops_idempotency",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: uuid("outlet_id").notNull(),
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
      name: "inventory_ops_idempotency_pkey",
      columns: [table.tenantId, table.operation, table.idempotencyKey],
    }),
    foreignKey({
      name: "inventory_ops_idempotency_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    check(
      "inventory_ops_idempotency_fingerprint_check",
      sql`${table.requestFingerprint} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);

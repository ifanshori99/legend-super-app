// Inventory & warehouse tables (PRD v1.7 §6 E, §16 "Inventori & Gudang";
// bead legend-98t, INV-01).
//
// Scope of this bead: storage locations, inventory items, UOM conversions,
// the append-only stock ledger, derived balances with a moving average per
// location, batches/expiry and the transfer document that pairs
// `transfer_out`/`transfer_in` rows. Par levels, stock counts, waste, recipes,
// production orders and purchasing documents belong to the beads that own
// those features and are added there.
//
// Every table is tenant-owned (T): tenant_id UUID NOT NULL, RLS via
// `app.enforce_tenant_rls` in the inventory RLS migration, and unique
// constraints always include tenant_id. Outlet-owned tables carry outlet_id.
// Parents expose (tenant_id, id) — and locations (tenant_id, outlet_id, id) —
// composite keys so a row can never reference another tenant's or outlet's
// parent. Quantities and unit costs are NUMERIC(14,4) decimal strings
// (D-CORE-2); the ledger id is a ULID stored in a uuid column (D-CORE-1).

import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
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
  InventoryItemType,
  StockLocationType,
  StockMovementType,
  StockSourceType,
} from "@starter/shared/inventory";
import {
  businessDate,
  decimal4Column,
  tenantIdColumn,
  ulidInUuid,
} from "../columns";
import { outlets, tenants } from "./platform-org";
import { syncTxidColumn } from "./sync-txid";
import { user } from "./user";

/**
 * `uoms` (T): tenant-wide unit catalog (PRD §6 E `uoms.code` / `name`).
 * Standard units are provisioned with `is_system = true` (read-only); tenants
 * add custom units through `POST /api/inventory/uoms` and read them through
 * `GET /api/inventory/uoms`.
 */
export const uoms = pgTable(
  "uoms",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    code: varchar("code", { length: 10 }).notNull(),
    name: varchar("name", { length: 150 }).notNull(),
    isSystem: boolean("is_system").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("uoms_tenant_code_key").on(table.tenantId, table.code),
    unique("uoms_tenant_id_id_key").on(table.tenantId, table.id),
  ],
);

/**
 * `inventory_items` (T): raw materials and semi-finished goods (PRD §6 E).
 * Tenant-wide master data (the contract has no outlet column); par defaults
 * live on the item, per-location overrides belong to a later bead.
 */
export const inventoryItems = pgTable(
  "inventory_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    name: varchar("name", { length: 150 }).notNull(),
    category: varchar("category", { length: 50 }).notNull(),
    type: varchar("type", { length: 20 })
      .$type<InventoryItemType>()
      .notNull()
      .default("raw_material"),
    baseUomId: uuid("base_uom_id").notNull(),
    isPerishable: boolean("is_perishable").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    parMin: decimal4Column("par_min"),
    parMax: decimal4Column("par_max"),
    /** Create-item idempotency (contract `idempotencyKey`). */
    idempotencyKey: varchar("idempotency_key", { length: 255 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    syncTxid: syncTxidColumn(),
  },
  (table) => [
    unique("inventory_items_tenant_id_id_key").on(table.tenantId, table.id),
    index("inventory_items_sync_txid_idx").on(
      table.tenantId,
      table.syncTxid,
      table.id,
    ),
    uniqueIndex("inventory_items_tenant_idempotency_key")
      .on(table.tenantId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
    foreignKey({
      name: "inventory_items_base_uom_fk",
      columns: [table.tenantId, table.baseUomId],
      foreignColumns: [uoms.tenantId, uoms.id],
    }),
    index("inventory_items_tenant_name_idx").on(
      table.tenantId,
      table.name,
      table.id,
    ),
    index("inventory_items_tenant_category_idx").on(
      table.tenantId,
      table.category,
      table.name,
    ),
    check(
      "inventory_items_type_check",
      sql`${table.type} IN ('raw_material', 'semi_finished')`,
    ),
    check(
      "inventory_items_par_check",
      sql`(${table.parMin} IS NULL OR ${table.parMin} >= 0) AND (${table.parMax} IS NULL OR ${table.parMax} >= 0) AND (${table.parMin} IS NULL OR ${table.parMax} IS NULL OR ${table.parMax} >= ${table.parMin})`,
    ),
  ],
);

/**
 * `uom_conversions` (T): per-item unit conversion (PRD §6 E). `factor` is how
 * many `to_uom` one `from_uom` contains (1 kg -> 1000 g); `convertQuantity`
 * walks the reverse direction, so only purchase -> base is stored.
 */
export const uomConversions = pgTable(
  "uom_conversions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    inventoryItemId: uuid("inventory_item_id").notNull(),
    fromUomId: uuid("from_uom_id").notNull(),
    toUomId: uuid("to_uom_id").notNull(),
    factor: decimal4Column("factor").notNull(),
  },
  (table) => [
    unique("uom_conversions_tenant_id_id_key").on(table.tenantId, table.id),
    unique("uom_conversions_tenant_item_pair_key").on(
      table.tenantId,
      table.inventoryItemId,
      table.fromUomId,
      table.toUomId,
    ),
    foreignKey({
      name: "uom_conversions_item_fk",
      columns: [table.tenantId, table.inventoryItemId],
      foreignColumns: [inventoryItems.tenantId, inventoryItems.id],
    }),
    foreignKey({
      name: "uom_conversions_from_uom_fk",
      columns: [table.tenantId, table.fromUomId],
      foreignColumns: [uoms.tenantId, uoms.id],
    }),
    foreignKey({
      name: "uom_conversions_to_uom_fk",
      columns: [table.tenantId, table.toUomId],
      foreignColumns: [uoms.tenantId, uoms.id],
    }),
    check(
      "uom_conversions_factor_check",
      sql`${table.factor} > 0 AND ${table.fromUomId} <> ${table.toUomId}`,
    ),
  ],
);

/**
 * `stock_locations` (T, outlet-owned): warehouse, chiller, freezer, bar,
 * kitchen and pastry per outlet (PRD §16 "Lokasi Stok").
 */
export const stockLocations = pgTable(
  "stock_locations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: uuid("outlet_id").notNull(),
    name: varchar("name", { length: 150 }).notNull(),
    type: varchar("type", { length: 20 }).$type<StockLocationType>().notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("stock_locations_tenant_id_id_key").on(table.tenantId, table.id),
    // Parent key for rows that must stay inside one tenant AND outlet.
    unique("stock_locations_tenant_outlet_id_key").on(
      table.tenantId,
      table.outletId,
      table.id,
    ),
    foreignKey({
      name: "stock_locations_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    index("stock_locations_tenant_outlet_name_idx").on(
      table.tenantId,
      table.outletId,
      table.name,
    ),
    check(
      "stock_locations_type_check",
      sql`${table.type} IN ('warehouse', 'chiller', 'freezer', 'bar', 'kitchen', 'pastry')`,
    ),
  ],
);

/**
 * `stock_batches` (T, outlet-owned): batch code and expiry for perishables
 * (PRD §16 "Batch & Kedaluwarsa"). A non-perishable batch may have no expiry.
 */
export const stockBatches = pgTable(
  "stock_batches",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: uuid("outlet_id").notNull(),
    locationId: uuid("location_id").notNull(),
    inventoryItemId: uuid("inventory_item_id").notNull(),
    batchCode: varchar("batch_code", { length: 40 }).notNull(),
    expiresOn: businessDate("expires_on"),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("stock_batches_tenant_id_id_key").on(table.tenantId, table.id),
    unique("stock_batches_tenant_outlet_id_key").on(
      table.tenantId,
      table.outletId,
      table.id,
    ),
    foreignKey({
      name: "stock_batches_location_fk",
      columns: [table.tenantId, table.outletId, table.locationId],
      foreignColumns: [
        stockLocations.tenantId,
        stockLocations.outletId,
        stockLocations.id,
      ],
    }),
    foreignKey({
      name: "stock_batches_item_fk",
      columns: [table.tenantId, table.inventoryItemId],
      foreignColumns: [inventoryItems.tenantId, inventoryItems.id],
    }),
    index("stock_batches_tenant_outlet_received_idx").on(
      table.tenantId,
      table.outletId,
      table.receivedAt,
      table.id,
    ),
    index("stock_batches_tenant_outlet_expiry_idx").on(
      table.tenantId,
      table.outletId,
      table.expiresOn,
    ),
  ],
);

/**
 * `stock_ledger` (T, outlet-owned): append-only stock card (PRD §6 E
 * `stock_ledger`, §16 "Kartu Stok Append-only", INV-01). There is no update
 * path: the RLS migration installs a trigger that rejects UPDATE and DELETE
 * for every role, including the table owner. Corrections are new `adjustment`
 * rows sourced from an approved stock count. `quantity` is positive for stock
 * in and negative for stock out; `source_id` is a UUID or a ULID converted at
 * this boundary (D-CORE-1).
 */
export const stockLedger = pgTable(
  "stock_ledger",
  {
    id: ulidInUuid("id").primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: uuid("outlet_id").notNull(),
    locationId: uuid("location_id").notNull(),
    inventoryItemId: uuid("inventory_item_id").notNull(),
    movementType: varchar("movement_type", { length: 20 })
      .$type<StockMovementType>()
      .notNull(),
    quantity: decimal4Column("quantity").notNull(),
    unitCostIdr: decimal4Column("unit_cost_idr").notNull(),
    batchId: uuid("batch_id"),
    sourceType: varchar("source_type", { length: 30 })
      .$type<StockSourceType>()
      .notNull(),
    sourceId: uuid("source_id").notNull(),
    /**
     * Retry guard (pre-review :779): the caller's key for this posting plus a
     * fingerprint of the request. The unique index makes a second insert with
     * the same key a no-op; the service replays the first row when the
     * fingerprint matches and answers IDEMPOTENCY_KEY_REUSED otherwise.
     */
    idempotencyKey: varchar("idempotency_key", { length: 255 }),
    requestFingerprint: varchar("request_fingerprint", { length: 64 }),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /**
     * Insertion sequence (legend-bsw9). `recordStockMovementInTransaction`
     * inserts the row while it holds the location advisory lock and the
     * balance row lock, so for one (location, item) this order is exactly the
     * order the live moving average was applied. `rebuildStockBalances` folds
     * by it, so a repair equals the live balance even when a caller posts a
     * past `occurred_at` (EOD deduction, opname, import). Rows that existed
     * before the column were numbered by (occurred_at, id) in the migration.
     */
    postingSeq: bigint("posting_seq", { mode: "number" })
      .generatedAlwaysAsIdentity()
      .notNull(),
  },
  (table) => [
    // NULL keys stay distinct, so postings without a key are never deduped.
    uniqueIndex("stock_ledger_tenant_idempotency_key_idx").on(
      table.tenantId,
      table.idempotencyKey,
    ),
    check(
      "stock_ledger_idempotency_pair_check",
      sql`(${table.idempotencyKey} IS NULL) = (${table.requestFingerprint} IS NULL)`,
    ),
    foreignKey({
      name: "stock_ledger_location_fk",
      columns: [table.tenantId, table.outletId, table.locationId],
      foreignColumns: [
        stockLocations.tenantId,
        stockLocations.outletId,
        stockLocations.id,
      ],
    }),
    foreignKey({
      name: "stock_ledger_item_fk",
      columns: [table.tenantId, table.inventoryItemId],
      foreignColumns: [inventoryItems.tenantId, inventoryItems.id],
    }),
    foreignKey({
      name: "stock_ledger_batch_fk",
      columns: [table.tenantId, table.outletId, table.batchId],
      foreignColumns: [
        stockBatches.tenantId,
        stockBatches.outletId,
        stockBatches.id,
      ],
    }),
    // Stock-card reads and the balance rebuild walk (location, item) in time.
    index("stock_ledger_tenant_location_item_idx").on(
      table.tenantId,
      table.locationId,
      table.inventoryItemId,
      table.occurredAt,
      table.id,
    ),
    // The balance rebuild reads one outlet's rows in posting order.
    index("stock_ledger_tenant_outlet_seq_idx").on(
      table.tenantId,
      table.outletId,
      table.postingSeq,
    ),
    // The GL bridge reads every ledger row of one source document.
    index("stock_ledger_tenant_source_idx").on(
      table.tenantId,
      table.sourceType,
      table.sourceId,
    ),
    index("stock_ledger_tenant_outlet_occurred_idx").on(
      table.tenantId,
      table.outletId,
      table.occurredAt,
      table.id,
    ),
    // referenceUnitCost: latest positive unit cost of one item, any location.
    index("stock_ledger_tenant_item_cost_idx")
      .on(table.tenantId, table.inventoryItemId, table.occurredAt, table.id)
      .where(sql`${table.unitCostIdr} > 0`),
    check("stock_ledger_quantity_check", sql`${table.quantity} <> 0`),
    check("stock_ledger_unit_cost_check", sql`${table.unitCostIdr} >= 0`),
    check(
      "stock_ledger_movement_type_check",
      sql`${table.movementType} IN ('receipt', 'sale', 'production_in', 'production_out', 'transfer_in', 'transfer_out', 'waste', 'adjustment', 'duty_meal', 'return')`,
    ),
    check(
      "stock_ledger_source_type_check",
      sql`${table.sourceType} IN ('goods_receipt', 'order', 'production_order', 'stock_transfer', 'stock_count', 'waste_log', 'purchase_return', 'duty_meal')`,
    ),
    // The movement/document pair from @starter/shared/inventory.
    check(
      "stock_ledger_source_pair_check",
      sql`(${table.movementType}, ${table.sourceType}) IN (
        ('receipt', 'goods_receipt'),
        ('sale', 'order'),
        ('production_in', 'production_order'),
        ('production_out', 'production_order'),
        ('transfer_in', 'stock_transfer'),
        ('transfer_out', 'stock_transfer'),
        ('waste', 'waste_log'),
        ('adjustment', 'stock_count'),
        ('duty_meal', 'duty_meal'),
        ('return', 'purchase_return'),
        ('return', 'order')
      )`,
    ),
    // Direction is carried by the sign (contract STOCK_MOVEMENT_DIRECTION).
    check(
      "stock_ledger_direction_check",
      sql`(
        (${table.movementType} IN ('receipt', 'production_in', 'transfer_in') AND ${table.quantity} > 0)
        OR (${table.movementType} IN ('sale', 'production_out', 'transfer_out', 'waste', 'duty_meal') AND ${table.quantity} < 0)
        OR (${table.movementType} = 'adjustment')
        OR (${table.movementType} = 'return' AND ${table.sourceType} = 'purchase_return' AND ${table.quantity} < 0)
        OR (${table.movementType} = 'return' AND ${table.sourceType} = 'order' AND ${table.quantity} > 0)
      )`,
    ),
  ],
);

/**
 * `stock_balances` (T, outlet-owned): derived balance per location/item with
 * the moving-average unit cost (PRD §16 "Metode Biaya", INV-01). Never the
 * source of truth: `rebuildStockBalances` can recreate every row from
 * `stock_ledger`. The composite primary key lets the movement service lock one
 * row (`FOR UPDATE`) and keeps concurrent movements serialised.
 */
export const stockBalances = pgTable(
  "stock_balances",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: uuid("outlet_id").notNull(),
    locationId: uuid("location_id").notNull(),
    inventoryItemId: uuid("inventory_item_id").notNull(),
    quantity: decimal4Column("quantity").notNull(),
    avgCostIdr: decimal4Column("avg_cost_idr").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      name: "stock_balances_pkey",
      columns: [table.tenantId, table.locationId, table.inventoryItemId],
    }),
    foreignKey({
      name: "stock_balances_location_fk",
      columns: [table.tenantId, table.outletId, table.locationId],
      foreignColumns: [
        stockLocations.tenantId,
        stockLocations.outletId,
        stockLocations.id,
      ],
    }),
    foreignKey({
      name: "stock_balances_item_fk",
      columns: [table.tenantId, table.inventoryItemId],
      foreignColumns: [inventoryItems.tenantId, inventoryItems.id],
    }),
    index("stock_balances_tenant_outlet_item_idx").on(
      table.tenantId,
      table.outletId,
      table.inventoryItemId,
    ),
    check("stock_balances_avg_cost_check", sql`${table.avgCostIdr} >= 0`),
  ],
);

/**
 * `stock_transfers` (T, outlet-owned): document behind the paired
 * `transfer_out` + `transfer_in` ledger rows (PRD §16 "transfer antarlokasi").
 * The contract's transfer carries its lines inline; the database keeps them in
 * a child table so the pair is auditable and referencable by `source_id`.
 */
export const stockTransfers = pgTable(
  "stock_transfers",
  {
    id: ulidInUuid("id").primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: uuid("outlet_id").notNull(),
    fromLocationId: uuid("from_location_id").notNull(),
    toLocationId: uuid("to_location_id").notNull(),
    movedBy: text("moved_by")
      .notNull()
      .references(() => user.id),
    /** Retry guard: a replayed transfer returns the first document (pre-review :779). */
    idempotencyKey: varchar("idempotency_key", { length: 100 }),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    note: text("note"),
  },
  (table) => [
    unique("stock_transfers_tenant_id_id_key").on(table.tenantId, table.id),
    uniqueIndex("stock_transfers_tenant_idempotency_key_idx").on(
      table.tenantId,
      table.idempotencyKey,
    ),
    unique("stock_transfers_tenant_outlet_id_key").on(
      table.tenantId,
      table.outletId,
      table.id,
    ),
    foreignKey({
      name: "stock_transfers_from_location_fk",
      columns: [table.tenantId, table.outletId, table.fromLocationId],
      foreignColumns: [
        stockLocations.tenantId,
        stockLocations.outletId,
        stockLocations.id,
      ],
    }),
    foreignKey({
      name: "stock_transfers_to_location_fk",
      columns: [table.tenantId, table.outletId, table.toLocationId],
      foreignColumns: [
        stockLocations.tenantId,
        stockLocations.outletId,
        stockLocations.id,
      ],
    }),
    index("stock_transfers_tenant_outlet_occurred_idx").on(
      table.tenantId,
      table.outletId,
      table.occurredAt,
      table.id,
    ),
    check(
      "stock_transfers_locations_check",
      sql`${table.fromLocationId} <> ${table.toLocationId}`,
    ),
  ],
);

export const stockTransferLines = pgTable(
  "stock_transfer_lines",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: uuid("outlet_id").notNull(),
    transferId: ulidInUuid("transfer_id").notNull(),
    inventoryItemId: uuid("inventory_item_id").notNull(),
    quantity: decimal4Column("quantity").notNull(),
  },
  (table) => [
    unique("stock_transfer_lines_tenant_pair_key").on(
      table.tenantId,
      table.transferId,
      table.inventoryItemId,
    ),
    foreignKey({
      name: "stock_transfer_lines_transfer_fk",
      columns: [table.tenantId, table.outletId, table.transferId],
      foreignColumns: [
        stockTransfers.tenantId,
        stockTransfers.outletId,
        stockTransfers.id,
      ],
    }),
    foreignKey({
      name: "stock_transfer_lines_item_fk",
      columns: [table.tenantId, table.inventoryItemId],
      foreignColumns: [inventoryItems.tenantId, inventoryItems.id],
    }),
    check("stock_transfer_lines_quantity_check", sql`${table.quantity} > 0`),
  ],
);

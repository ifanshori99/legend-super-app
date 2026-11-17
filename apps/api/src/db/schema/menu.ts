// Menu master data (PRD v1.7 §6 C "Menu, Meja & Order": menu_items (#7) and
// the supporting tables, §3 F8 "Master Menu & Harga"). Every table is marked
// (T, E) in the PRD: tenant owned and replicated to the outlet edge node.
//
// (T) rules: tenant_id UUID NOT NULL, enforced RLS in the `menu_rls` migration
// (`app.enforce_tenant_rls`), every unique constraint includes tenant_id, and
// children reference their parent through composite (tenant_id, id) keys so a
// row can never point at another tenant's brand, outlet, category or item.
// Outlet-owned tables (stations, price lists, availability) carry outlet_id.
//
// (E) edge replication flags: every table carries `updated_at` (the incremental
// down-sync cursor, WS-02 legend-97p) and a nullable `deleted_at` tombstone.
// A delete is a soft delete so the edge learns about it; reads filter
// `deleted_at IS NULL`, and "unique per scope" constraints are partial on the
// live rows. Cloud remains the source of truth for master data (PRD §5
// "Pembagian Sumber Kebenaran", cloud wins).
//
// Tables not owned by this bead yet (tax_rules, devices) are plain UUID columns
// without a foreign key; their beads add the composite keys. `recipe_id` on
// menu_items, item_variants and modifiers references recipes (legend-3kdd).

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type {
  Availability,
  MenuChannel,
  MenuSchedule,
} from "@starter/shared/menu";
import { idrColumn, businessDate } from "../columns";
import { idr } from "@starter/shared/core";
import { brands, outlets, tenants } from "./platform-org";
import { recipes } from "./recipe";
import { syncTxidColumn } from "./sync-txid";

/** PRD §6 C: timestamps are TIMESTAMPTZ. */
const createdAt = timestamp("created_at", { withTimezone: true })
  .notNull()
  .defaultNow();

/** Edge replication flag (E): incremental down-sync cursor. */
const updatedAt = timestamp("updated_at", { withTimezone: true })
  .notNull()
  .defaultNow();

/** Edge replication flag (E): soft-delete tombstone; null = live row. */
const deletedAt = timestamp("deleted_at", { withTimezone: true });

const tenantId = uuid("tenant_id")
  .notNull()
  .references(() => tenants.id);

/** `brands` (T): category display order and item catalogue. */
export const menuCategories = pgTable(
  "menu_categories",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId,
    brandId: uuid("brand_id").notNull(),
    name: varchar("name", { length: 150 }).notNull(),
    parentId: uuid("parent_id"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt,
    updatedAt,
    deletedAt,
    syncTxid: syncTxidColumn(),
  },
  (table) => [
    index("menu_categories_sync_txid_idx").on(
      table.tenantId,
      table.syncTxid,
      table.id,
    ),
    unique("menu_categories_tenant_id_id_key").on(table.tenantId, table.id),
    foreignKey({
      name: "menu_categories_brand_fk",
      columns: [table.tenantId, table.brandId],
      foreignColumns: [brands.tenantId, brands.id],
    }),
    foreignKey({
      name: "menu_categories_parent_fk",
      columns: [table.tenantId, table.parentId],
      foreignColumns: [table.tenantId, table.id],
    }),
    index("menu_categories_brand_order_idx").on(
      table.tenantId,
      table.brandId,
      table.sortOrder,
      table.id,
    ),
    index("menu_categories_replication_idx").on(
      table.tenantId,
      table.updatedAt,
      table.id,
    ),
    check(
      "menu_categories_not_own_parent_check",
      sql`${table.parentId} IS NULL OR ${table.parentId} <> ${table.id}`,
    ),
  ],
);

/** `stations` (T, E): production routing per outlet (PRD §6 C support table). */
export const stations = pgTable(
  "stations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId,
    outletId: uuid("outlet_id").notNull(),
    name: varchar("name", { length: 150 }).notNull(),
    type: varchar("type", { length: 20 }).notNull(),
    /** Print agent target (WS-02 devices); plain UUID until that table lands. */
    printerDeviceId: uuid("printer_device_id"),
    targetSeconds: integer("target_seconds"),
    /** KDS tab order, left to right (legend-bopi2). */
    displayOrder: integer("display_order").notNull().default(0),
    /** An inactive station has no KDS tab; at least one per outlet stays active. */
    isActive: boolean("is_active").notNull().default(true),
    /** F12 "Fallback Cetak": print automatically when the tablet stops answering. */
    autoPrintFallback: boolean("auto_print_fallback").notNull().default(false),
    createdAt,
    updatedAt,
    deletedAt,
    syncTxid: syncTxidColumn(),
  },
  (table) => [
    index("stations_sync_txid_idx").on(
      table.tenantId,
      table.syncTxid,
      table.id,
    ),
    unique("stations_tenant_id_id_key").on(table.tenantId, table.id),
    foreignKey({
      name: "stations_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    uniqueIndex("stations_outlet_name_key")
      .on(table.tenantId, table.outletId, table.name)
      .where(sql`${table.deletedAt} IS NULL`),
    index("stations_outlet_idx").on(table.tenantId, table.outletId, table.id),
    index("stations_replication_idx").on(
      table.tenantId,
      table.updatedAt,
      table.id,
    ),
    check("stations_display_order_check", sql`${table.displayOrder} >= 0`),
    check(
      "stations_type_check",
      sql`${table.type} IN ('coffee_bar', 'beverage_bar', 'hot_kitchen', 'cold_kitchen', 'pastry')`,
    ),
    check(
      "stations_target_seconds_check",
      sql`${table.targetSeconds} IS NULL OR ${table.targetSeconds} > 0`,
    ),
  ],
);

/** `menu_items` (T, E): item yang dijual (PRD §6 C #7). */
export const menuItems = pgTable(
  "menu_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId,
    brandId: uuid("brand_id").notNull(),
    categoryId: uuid("category_id").notNull(),
    name: varchar("name", { length: 150 }).notNull(),
    description: text("description").notNull().default(""),
    type: varchar("type", { length: 20 }).notNull().default("single"),
    /** Default station routing (PRD §6 C #7 "Stasiun produksi"). */
    stationId: uuid("station_id"),
    /**
     * Station TYPE this item is made at (brand-level); KDS routing resolves it
     * to a station per outlet. `stationId` stays as a per-outlet override.
     */
    stationType: varchar("station_type", { length: 20 }),
    course: varchar("course", { length: 20 }),
    /** WS-06 recipes (HPP and stock deduction). */
    recipeId: uuid("recipe_id"),
    /** WS-05 tax rules; table not on main yet. */
    taxRuleId: uuid("tax_rule_id"),
    labels: text("labels")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    allergens: text("allergens")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** WS-00 storage object (menu_photo purpose). */
    mediaId: uuid("media_id"),
    isActive: boolean("is_active").notNull().default(true),
    /** legend-lgyfh: only flagged items appear in the breakfast flow. */
    isBreakfast: boolean("is_breakfast").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt,
    updatedAt,
    deletedAt,
    syncTxid: syncTxidColumn(),
  },
  (table) => [
    index("menu_items_sync_txid_idx").on(
      table.tenantId,
      table.syncTxid,
      table.id,
    ),
    unique("menu_items_tenant_id_id_key").on(table.tenantId, table.id),
    foreignKey({
      name: "menu_items_brand_fk",
      columns: [table.tenantId, table.brandId],
      foreignColumns: [brands.tenantId, brands.id],
    }),
    foreignKey({
      name: "menu_items_category_fk",
      columns: [table.tenantId, table.categoryId],
      foreignColumns: [menuCategories.tenantId, menuCategories.id],
    }),
    foreignKey({
      name: "menu_items_station_fk",
      columns: [table.tenantId, table.stationId],
      foreignColumns: [stations.tenantId, stations.id],
    }),
    foreignKey({
      name: "menu_items_recipe_fk",
      columns: [table.tenantId, table.recipeId],
      foreignColumns: [recipes.tenantId, recipes.id],
    }),
    index("menu_items_category_order_idx").on(
      table.tenantId,
      table.categoryId,
      table.sortOrder,
      table.id,
    ),
    index("menu_items_brand_order_idx").on(
      table.tenantId,
      table.brandId,
      table.sortOrder,
      table.id,
    ),
    index("menu_items_station_idx").on(table.tenantId, table.stationId),
    index("menu_items_replication_idx").on(
      table.tenantId,
      table.updatedAt,
      table.id,
    ),
    check("menu_items_type_check", sql`${table.type} IN ('single', 'combo')`),
    check(
      "menu_items_station_type_check",
      sql`${table.stationType} IS NULL OR ${table.stationType} IN ('coffee_bar', 'beverage_bar', 'hot_kitchen', 'cold_kitchen', 'pastry')`,
    ),
    check("menu_items_sort_order_check", sql`${table.sortOrder} >= 0`),
  ],
);

/** `item_variants` (T, E): size or temperature variants. */
export const itemVariants = pgTable(
  "item_variants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId,
    menuItemId: uuid("menu_item_id").notNull(),
    name: varchar("name", { length: 150 }).notNull(),
    recipeId: uuid("recipe_id"),
    createdAt,
    updatedAt,
    deletedAt,
    syncTxid: syncTxidColumn(),
  },
  (table) => [
    index("item_variants_sync_txid_idx").on(
      table.tenantId,
      table.syncTxid,
      table.id,
    ),
    unique("item_variants_tenant_id_id_key").on(table.tenantId, table.id),
    foreignKey({
      name: "item_variants_item_fk",
      columns: [table.tenantId, table.menuItemId],
      foreignColumns: [menuItems.tenantId, menuItems.id],
    }),
    foreignKey({
      name: "item_variants_recipe_fk",
      columns: [table.tenantId, table.recipeId],
      foreignColumns: [recipes.tenantId, recipes.id],
    }),
    uniqueIndex("item_variants_item_name_key")
      .on(table.tenantId, table.menuItemId, table.name)
      .where(sql`${table.deletedAt} IS NULL`),
    index("item_variants_item_idx").on(table.tenantId, table.menuItemId),
    index("item_variants_replication_idx").on(
      table.tenantId,
      table.updatedAt,
      table.id,
    ),
  ],
);

/** `modifier_groups` (T, E): min/max selection rules. */
export const modifierGroups = pgTable(
  "modifier_groups",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId,
    name: varchar("name", { length: 150 }).notNull(),
    minSelect: integer("min_select").notNull().default(0),
    maxSelect: integer("max_select").notNull().default(1),
    createdAt,
    updatedAt,
    deletedAt,
    syncTxid: syncTxidColumn(),
  },
  (table) => [
    index("modifier_groups_sync_txid_idx").on(
      table.tenantId,
      table.syncTxid,
      table.id,
    ),
    unique("modifier_groups_tenant_id_id_key").on(table.tenantId, table.id),
    index("modifier_groups_name_idx").on(table.tenantId, table.name, table.id),
    index("modifier_groups_replication_idx").on(
      table.tenantId,
      table.updatedAt,
      table.id,
    ),
    check(
      "modifier_groups_min_max_check",
      sql`${table.minSelect} >= 0 AND ${table.maxSelect} >= ${table.minSelect} AND ${table.maxSelect} <= 50`,
    ),
  ],
);

/** `modifiers` (T, E): one option of a group, with its recipe impact. */
export const modifiers = pgTable(
  "modifiers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId,
    groupId: uuid("group_id").notNull(),
    name: varchar("name", { length: 150 }).notNull(),
    priceIdr: idrColumn("price_idr").notNull().default(idr(0)),
    recipeId: uuid("recipe_id"),
    stationId: uuid("station_id"),
    createdAt,
    updatedAt,
    deletedAt,
    syncTxid: syncTxidColumn(),
  },
  (table) => [
    index("modifiers_sync_txid_idx").on(
      table.tenantId,
      table.syncTxid,
      table.id,
    ),
    unique("modifiers_tenant_id_id_key").on(table.tenantId, table.id),
    foreignKey({
      name: "modifiers_group_fk",
      columns: [table.tenantId, table.groupId],
      foreignColumns: [modifierGroups.tenantId, modifierGroups.id],
    }),
    foreignKey({
      name: "modifiers_station_fk",
      columns: [table.tenantId, table.stationId],
      foreignColumns: [stations.tenantId, stations.id],
    }),
    foreignKey({
      name: "modifiers_recipe_fk",
      columns: [table.tenantId, table.recipeId],
      foreignColumns: [recipes.tenantId, recipes.id],
    }),
    uniqueIndex("modifiers_group_name_key")
      .on(table.tenantId, table.groupId, table.name)
      .where(sql`${table.deletedAt} IS NULL`),
    index("modifiers_group_idx").on(table.tenantId, table.groupId, table.id),
    index("modifiers_replication_idx").on(
      table.tenantId,
      table.updatedAt,
      table.id,
    ),
    check("modifiers_price_check", sql`${table.priceIdr} >= 0`),
  ],
);

/**
 * Item ↔ modifier-group link, in display order. The contract carries it
 * (`setItemModifierGroups`); PRD §6 C names the groups per item but no join
 * table, so this is its implementation.
 */
export const menuItemModifierGroups = pgTable(
  "menu_item_modifier_groups",
  {
    tenantId,
    menuItemId: uuid("menu_item_id").notNull(),
    groupId: uuid("group_id").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt,
    updatedAt,
    deletedAt,
    syncTxid: syncTxidColumn(),
  },
  (table) => [
    index("menu_item_modifier_groups_sync_txid_idx").on(
      table.tenantId,
      table.syncTxid,
      table.menuItemId,
      table.groupId,
    ),
    unique("menu_item_modifier_groups_tenant_item_group_key").on(
      table.tenantId,
      table.menuItemId,
      table.groupId,
    ),
    foreignKey({
      name: "menu_item_modifier_groups_item_fk",
      columns: [table.tenantId, table.menuItemId],
      foreignColumns: [menuItems.tenantId, menuItems.id],
    }),
    foreignKey({
      name: "menu_item_modifier_groups_group_fk",
      columns: [table.tenantId, table.groupId],
      foreignColumns: [modifierGroups.tenantId, modifierGroups.id],
    }),
    index("menu_item_modifier_groups_item_idx").on(
      table.tenantId,
      table.menuItemId,
      table.sortOrder,
    ),
    index("menu_item_modifier_groups_replication_idx").on(
      table.tenantId,
      table.updatedAt,
    ),
    check("menu_item_modifier_groups_sort_check", sql`${table.sortOrder} >= 0`),
  ],
);

/** `combos` (T, E): the combo header of one `combo` type menu item. */
export const combos = pgTable(
  "combos",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId,
    comboItemId: uuid("combo_item_id").notNull(),
    createdAt,
    updatedAt,
    deletedAt,
  },
  (table) => [
    unique("combos_tenant_id_id_key").on(table.tenantId, table.id),
    foreignKey({
      name: "combos_item_fk",
      columns: [table.tenantId, table.comboItemId],
      foreignColumns: [menuItems.tenantId, menuItems.id],
    }),
    uniqueIndex("combos_item_key")
      .on(table.tenantId, table.comboItemId)
      .where(sql`${table.deletedAt} IS NULL`),
    index("combos_replication_idx").on(
      table.tenantId,
      table.updatedAt,
      table.id,
    ),
  ],
);

/**
 * `combo_components` (T, E): contents of a combo and the revenue split
 * (PRD §6 C; basis points, 10,000 = 100%, so `allocateIdr` sums exactly).
 */
export const comboComponents = pgTable(
  "combo_components",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId,
    comboId: uuid("combo_id").notNull(),
    menuItemId: uuid("menu_item_id").notNull(),
    /** Allowed replacement item ids ("options" in the PRD). */
    options: uuid("options")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    revenueAllocationBp: integer("revenue_allocation_bp").notNull(),
    createdAt,
    updatedAt,
    deletedAt,
  },
  (table) => [
    unique("combo_components_tenant_id_id_key").on(table.tenantId, table.id),
    foreignKey({
      name: "combo_components_combo_fk",
      columns: [table.tenantId, table.comboId],
      foreignColumns: [combos.tenantId, combos.id],
    }),
    foreignKey({
      name: "combo_components_item_fk",
      columns: [table.tenantId, table.menuItemId],
      foreignColumns: [menuItems.tenantId, menuItems.id],
    }),
    index("combo_components_combo_idx").on(table.tenantId, table.comboId),
    index("combo_components_replication_idx").on(
      table.tenantId,
      table.updatedAt,
      table.id,
    ),
    check(
      "combo_components_allocation_check",
      sql`${table.revenueAllocationBp} >= 0 AND ${table.revenueAllocationBp} <= 10000`,
    ),
  ],
);

/** `price_lists` (T, E): channel price version per outlet. */
export const priceLists = pgTable(
  "price_lists",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId,
    outletId: uuid("outlet_id").notNull(),
    channel: varchar("channel", { length: 20 }).$type<MenuChannel>().notNull(),
    effectiveFrom: businessDate("effective_from").notNull(),
    createdAt,
    updatedAt,
    deletedAt,
    syncTxid: syncTxidColumn(),
  },
  (table) => [
    index("price_lists_sync_txid_idx").on(
      table.tenantId,
      table.syncTxid,
      table.id,
    ),
    unique("price_lists_tenant_id_id_key").on(table.tenantId, table.id),
    foreignKey({
      name: "price_lists_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    uniqueIndex("price_lists_outlet_channel_date_key")
      .on(table.tenantId, table.outletId, table.channel, table.effectiveFrom)
      .where(sql`${table.deletedAt} IS NULL`),
    index("price_lists_outlet_idx").on(
      table.tenantId,
      table.outletId,
      table.channel,
      table.effectiveFrom,
    ),
    index("price_lists_replication_idx").on(
      table.tenantId,
      table.updatedAt,
      table.id,
    ),
    check(
      "price_lists_channel_check",
      sql`${table.channel} IN ('dine_in', 'takeaway', 'gofood', 'grabfood', 'shopeefood', 'reservation')`,
    ),
  ],
);

/** `price_list_items` (T, E): the price grid of one list. */
export const priceListItems = pgTable(
  "price_list_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId,
    priceListId: uuid("price_list_id").notNull(),
    itemId: uuid("item_id").notNull(),
    variantId: uuid("variant_id"),
    priceIdr: idrColumn("price_idr").notNull(),
    createdAt,
    updatedAt,
    deletedAt,
  },
  (table) => [
    unique("price_list_items_tenant_id_id_key").on(table.tenantId, table.id),
    foreignKey({
      name: "price_list_items_list_fk",
      columns: [table.tenantId, table.priceListId],
      foreignColumns: [priceLists.tenantId, priceLists.id],
    }),
    foreignKey({
      name: "price_list_items_item_fk",
      columns: [table.tenantId, table.itemId],
      foreignColumns: [menuItems.tenantId, menuItems.id],
    }),
    foreignKey({
      name: "price_list_items_variant_fk",
      columns: [table.tenantId, table.variantId],
      foreignColumns: [itemVariants.tenantId, itemVariants.id],
    }),
    // One live price per item, or per variant when one is named. Two partial
    // indexes because NULL variant ids never compare equal.
    uniqueIndex("price_list_items_plain_key")
      .on(table.tenantId, table.priceListId, table.itemId)
      .where(sql`${table.variantId} IS NULL AND ${table.deletedAt} IS NULL`),
    uniqueIndex("price_list_items_variant_key")
      .on(table.tenantId, table.priceListId, table.itemId, table.variantId)
      .where(
        sql`${table.variantId} IS NOT NULL AND ${table.deletedAt} IS NULL`,
      ),
    index("price_list_items_list_idx").on(
      table.tenantId,
      table.priceListId,
      table.id,
    ),
    index("price_list_items_replication_idx").on(
      table.tenantId,
      table.updatedAt,
      table.id,
    ),
    check("price_list_items_price_check", sql`${table.priceIdr} >= 0`),
  ],
);

/** `item_availability` (T, E): schedule, daily limit and 86 status. */
export const itemAvailability = pgTable(
  "item_availability",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId,
    outletId: uuid("outlet_id").notNull(),
    menuItemId: uuid("menu_item_id").notNull(),
    schedule: jsonb("schedule").$type<MenuSchedule[]>().notNull().default([]),
    dailyLimit: integer("daily_limit"),
    soldOutUntil: timestamp("sold_out_until", { withTimezone: true }),
    status: varchar("status", { length: 20 })
      .$type<Availability["status"]>()
      .notNull()
      .default("available"),
    /** Who placed the 86 (`sold_out`): staff, or the equipment breakdown. */
    source: varchar("source", { length: 10 }).$type<"staff" | "auto">(),
    createdAt,
    updatedAt,
    deletedAt,
  },
  (table) => [
    unique("item_availability_tenant_id_id_key").on(table.tenantId, table.id),
    foreignKey({
      name: "item_availability_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "item_availability_item_fk",
      columns: [table.tenantId, table.menuItemId],
      foreignColumns: [menuItems.tenantId, menuItems.id],
    }),
    uniqueIndex("item_availability_outlet_item_key")
      .on(table.tenantId, table.outletId, table.menuItemId)
      .where(sql`${table.deletedAt} IS NULL`),
    index("item_availability_outlet_status_idx").on(
      table.tenantId,
      table.outletId,
      table.status,
      table.id,
    ),
    index("item_availability_replication_idx").on(
      table.tenantId,
      table.updatedAt,
      table.id,
    ),
    check(
      "item_availability_status_check",
      sql`${table.status} IN ('available', 'sold_out')`,
    ),
    check(
      "item_availability_source_check",
      sql`${table.source} IS NULL OR ${table.source} IN ('staff', 'auto')`,
    ),
    check(
      "item_availability_limit_check",
      sql`${table.dailyLimit} IS NULL OR ${table.dailyLimit} >= 0`,
    ),
    check(
      "item_availability_schedule_check",
      sql`jsonb_typeof(${table.schedule}) = 'array'`,
    ),
  ],
);

/**
 * `menu_item_daily_usage` (T, O): quantity sold per item and outlet business
 * date (PRD §8 "Ketersediaan" — batas stok menu harian, bead legend-h2a).
 *
 * The counter is the race-safe side of `item_availability.daily_limit`: order
 * lines reserve through one atomic upsert, so concurrent orders can never
 * oversell. It is operational, not replicated to the edge (the edge node owns
 * its own offline counters and reconciles on sync), so it has no tombstone.
 */
export const menuItemDailyUsage = pgTable(
  "menu_item_daily_usage",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId,
    outletId: uuid("outlet_id").notNull(),
    menuItemId: uuid("menu_item_id").notNull(),
    businessDate: businessDate("business_date").notNull(),
    quantity: integer("quantity").notNull().default(0),
    createdAt,
    updatedAt,
  },
  (table) => [
    unique("menu_item_daily_usage_tenant_id_id_key").on(
      table.tenantId,
      table.id,
    ),
    foreignKey({
      name: "menu_item_daily_usage_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "menu_item_daily_usage_item_fk",
      columns: [table.tenantId, table.menuItemId],
      foreignColumns: [menuItems.tenantId, menuItems.id],
    }),
    uniqueIndex("menu_item_daily_usage_key").on(
      table.tenantId,
      table.outletId,
      table.menuItemId,
      table.businessDate,
    ),
    index("menu_item_daily_usage_outlet_date_idx").on(
      table.tenantId,
      table.outletId,
      table.businessDate,
    ),
    check("menu_item_daily_usage_quantity_check", sql`${table.quantity} >= 0`),
  ],
);

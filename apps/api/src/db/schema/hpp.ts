// HPP (cost of goods) read model and its recompute queue (bead legend-2qq;
// PRD v1.7 §17 "HPP Menu" and "Kelengkapan Resep"). Both tables are tenant
// owned AND outlet owned: tenant_id / outlet_id NOT NULL, unique constraints
// include tenant_id, composite (tenant_id, ...) foreign keys keep every
// reference in one tenant. RLS: hpp.custom.sql.
//
// - `menu_costs`: one row per outlet and menu item (variant NULL, modifier
//   NULL), per variant, or per modifier of an attached menu item. A cost is
//   never understated: a recipe with any ingredient of unknown or zero average
//   cost is `recipe_complete = false` and its cost and margin are NULL, never 0.
//   Rebuilt incrementally from `hpp_recompute_queue` (hpp-recompute.service.ts).
// - `hpp_recompute_queue`: inventory items whose average cost changed at an
//   outlet. One row per item (a second change only refreshes enqueued_at), so a
//   burst of receipts costs one recompute. Written in the same transaction as
//   the `stock_balances` write; drained by the worker job.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  decimal4Column,
  idrColumn,
  outletIdColumn,
  tenantIdColumn,
} from "../columns.ts";
import { inventoryItems } from "./inventory.ts";
import { itemVariants, menuItems, modifiers } from "./menu.ts";
import { outlets, tenants } from "./platform-org.ts";
import { recipes } from "./recipe.ts";

/** All-zero uuid: stands in for NULL inside the unique index. */
const NIL_UUID = sql`'00000000-0000-0000-0000-000000000000'::uuid`;

export const menuCosts = pgTable(
  "menu_costs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    menuItemId: uuid("menu_item_id").notNull(),
    variantId: uuid("variant_id"),
    modifierId: uuid("modifier_id"),
    recipeId: uuid("recipe_id"),
    recipeComplete: boolean("recipe_complete").notNull(),
    /** Cost of one portion in whole rupiah, as Decimal4; NULL = unknown. */
    theoreticalCostIdr: decimal4Column("theoretical_cost_idr"),
    /** Outlet default price; 0 when no price list entry exists. */
    priceIdr: idrColumn("price_idr").notNull(),
    grossMarginBp: integer("gross_margin_bp"),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    unique("menu_costs_tenant_id_id_key").on(table.tenantId, table.id),
    foreignKey({
      name: "menu_costs_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "menu_costs_item_fk",
      columns: [table.tenantId, table.menuItemId],
      foreignColumns: [menuItems.tenantId, menuItems.id],
    }),
    foreignKey({
      name: "menu_costs_variant_fk",
      columns: [table.tenantId, table.variantId],
      foreignColumns: [itemVariants.tenantId, itemVariants.id],
    }),
    foreignKey({
      name: "menu_costs_modifier_fk",
      columns: [table.tenantId, table.modifierId],
      foreignColumns: [modifiers.tenantId, modifiers.id],
    }),
    foreignKey({
      name: "menu_costs_recipe_fk",
      columns: [table.tenantId, table.recipeId],
      foreignColumns: [recipes.tenantId, recipes.id],
    }),
    uniqueIndex("menu_costs_target_key").on(
      table.tenantId,
      table.outletId,
      table.menuItemId,
      sql`coalesce(${table.variantId}, ${NIL_UUID})`,
      sql`coalesce(${table.modifierId}, ${NIL_UUID})`,
    ),
    index("menu_costs_recipe_idx").on(
      table.tenantId,
      table.outletId,
      table.recipeId,
    ),
    check(
      "menu_costs_cost_check",
      sql`${table.theoreticalCostIdr} IS NULL OR ${table.theoreticalCostIdr} >= 0`,
    ),
    check("menu_costs_price_check", sql`${table.priceIdr} >= 0`),
    check(
      "menu_costs_complete_check",
      sql`(${table.recipeComplete} AND ${table.recipeId} IS NOT NULL AND ${table.theoreticalCostIdr} IS NOT NULL AND ${table.grossMarginBp} IS NOT NULL)
        OR (NOT ${table.recipeComplete} AND ${table.theoreticalCostIdr} IS NULL AND ${table.grossMarginBp} IS NULL)`,
    ),
  ],
);

export const hppRecomputeQueue = pgTable(
  "hpp_recompute_queue",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    itemId: uuid("item_id").notNull(),
    enqueuedAt: timestamp("enqueued_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      name: "hpp_recompute_queue_pkey",
      columns: [table.tenantId, table.outletId, table.itemId],
    }),
    foreignKey({
      name: "hpp_recompute_queue_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "hpp_recompute_queue_item_fk",
      columns: [table.tenantId, table.itemId],
      foreignColumns: [inventoryItems.tenantId, inventoryItems.id],
    }),
    index("hpp_recompute_queue_enqueued_idx").on(
      table.tenantId,
      table.enqueuedAt,
    ),
  ],
);

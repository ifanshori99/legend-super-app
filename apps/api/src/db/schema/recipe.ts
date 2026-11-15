// Recipe / BOM tables (PRD v1.7 §3 F16 "Resep & BOM", "Pemotongan Otomatis";
// §6 E `recipes`, `recipe_lines`; bead legend-db6).
//
// Recipes and their lines are brand-level master data (tenant-owned), the
// per-outlet deduction settings and the deduction journal are outlet-owned.
// Every table: tenant_id NOT NULL, `app.enforce_tenant_rls` (plus
// `app.enforce_outlet_rls` on the outlet-owned ones) in `recipe.custom.sql`,
// unique constraints always include tenant_id, and composite (tenant_id, …)
// foreign keys keep every reference inside one tenant. Quantities and unit
// costs are NUMERIC(14,4) decimal strings, money is BIGINT rupiah (D-CORE-2).
// `menu_items.recipe_id`, `item_variants.recipe_id` and `modifiers.recipe_id`
// reference `recipes (tenant_id, id)` (menu.ts, legend-3kdd).

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type {
  ModifierRecipeRuleAction,
  RecipeComponentType,
  RecipeDeductionKind,
  RecipeDeductionMode,
  RecipeDeductionSkipReason,
  RecipeDeductionSourceType,
  RecipeDeductionStatus,
  RecipeDeductionReversalReason,
} from "@starter/shared/inventory";
import {
  businessDate,
  decimal4Column,
  idrColumn,
  tenantIdColumn,
} from "../columns.ts";
import { inventoryItems, stockLocations, uoms } from "./inventory.ts";
import { modifiers } from "./menu.ts";
import { brands, outlets, tenants } from "./platform-org.ts";
import { syncTxidColumn } from "./sync-txid.ts";
import { user } from "./user.ts";

/**
 * `recipes` (T): header of a recipe / BOM. `output_item_id` marks a
 * semi-finished recipe (stocked by production); without it the recipe is
 * exploded inline into its lines. `yield_quantity` is in `yield_uom_id`;
 * one sale unit consumes one yield unit. `theoretical_cost_idr` is a cached
 * NUMERIC(14,4) rupiah figure refreshed on write.
 */
export const recipes = pgTable(
  "recipes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    brandId: uuid("brand_id").notNull(),
    name: varchar("name", { length: 150 }).notNull(),
    outputItemId: uuid("output_item_id"),
    yieldQuantity: decimal4Column("yield_quantity").notNull(),
    yieldUomId: uuid("yield_uom_id").notNull(),
    version: integer("version").notNull().default(1),
    isActive: boolean("is_active").notNull().default(true),
    theoreticalCostIdr: decimal4Column("theoretical_cost_idr")
      .notNull()
      .default(sql`'0'`),
    /**
     * Nullable (bead legend-24318): the cloud always fills it, but an outlet
     * edge copy keeps null when the author (an HQ user) is not in the edge's
     * `user` table, so a recipe page never stalls the catalog checkpoint.
     */
    updatedBy: text("updated_by").references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    syncTxid: syncTxidColumn(),
  },
  (table) => [
    unique("recipes_tenant_id_id_key").on(table.tenantId, table.id),
    index("recipes_sync_txid_idx").on(table.tenantId, table.syncTxid, table.id),
    foreignKey({
      name: "recipes_brand_fk",
      columns: [table.tenantId, table.brandId],
      foreignColumns: [brands.tenantId, brands.id],
    }),
    foreignKey({
      name: "recipes_output_item_fk",
      columns: [table.tenantId, table.outputItemId],
      foreignColumns: [inventoryItems.tenantId, inventoryItems.id],
    }),
    foreignKey({
      name: "recipes_yield_uom_fk",
      columns: [table.tenantId, table.yieldUomId],
      foreignColumns: [uoms.tenantId, uoms.id],
    }),
    index("recipes_tenant_brand_name_idx").on(
      table.tenantId,
      table.brandId,
      table.name,
      table.id,
    ),
    check("recipes_yield_check", sql`${table.yieldQuantity} > 0`),
    check("recipes_version_check", sql`${table.version} >= 1`),
    check("recipes_cost_check", sql`${table.theoreticalCostIdr} >= 0`),
  ],
);

/**
 * `recipe_lines` (T): one component of a recipe, an inventory item or a
 * nested recipe. `waste_pct_bp` is the trim/waste in basis points (gross =
 * net / (1 - waste)). `component_id` is polymorphic, so it has no foreign
 * key; the service validates it.
 */
export const recipeLines = pgTable(
  "recipe_lines",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    recipeId: uuid("recipe_id").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    componentType: varchar("component_type", { length: 10 })
      .$type<RecipeComponentType>()
      .notNull(),
    componentId: uuid("component_id").notNull(),
    quantity: decimal4Column("quantity").notNull(),
    uomId: uuid("uom_id").notNull(),
    wastePctBp: integer("waste_pct_bp").notNull().default(0),
    // legend-89zm: stock location this line is drawn from; NULL = the outlet
    // sale location. A leaf line resolves to
    // `deduction_location_id ?? sale_location_id`.
    deductionLocationId: uuid("deduction_location_id"),
  },
  (table) => [
    unique("recipe_lines_tenant_id_id_key").on(table.tenantId, table.id),
    foreignKey({
      name: "recipe_lines_deduction_location_fk",
      columns: [table.tenantId, table.deductionLocationId],
      foreignColumns: [stockLocations.tenantId, stockLocations.id],
    }),
    foreignKey({
      name: "recipe_lines_recipe_fk",
      columns: [table.tenantId, table.recipeId],
      foreignColumns: [recipes.tenantId, recipes.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "recipe_lines_uom_fk",
      columns: [table.tenantId, table.uomId],
      foreignColumns: [uoms.tenantId, uoms.id],
    }),
    index("recipe_lines_tenant_recipe_idx").on(
      table.tenantId,
      table.recipeId,
      table.sortOrder,
    ),
    check(
      "recipe_lines_component_type_check",
      sql`${table.componentType} IN ('item', 'recipe')`,
    ),
    check("recipe_lines_quantity_check", sql`${table.quantity} > 0`),
    check(
      "recipe_lines_waste_check",
      sql`${table.wastePctBp} BETWEEN 0 AND 9999`,
    ),
  ],
);

/**
 * `modifier_recipe_rules` (T): how a selected modifier changes the base
 * recipe. `add` appends a component; `remove` drops the matching top-level
 * base line; `replace` is remove + add. Shape mirrors the shared
 * `modifierRecipeRuleSchema` refine.
 */
export const modifierRecipeRules = pgTable(
  "modifier_recipe_rules",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    modifierId: uuid("modifier_id").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    action: varchar("action", { length: 10 })
      .$type<ModifierRecipeRuleAction>()
      .notNull(),
    targetComponentType: varchar("target_component_type", {
      length: 10,
    }).$type<RecipeComponentType>(),
    targetComponentId: uuid("target_component_id"),
    componentType: varchar("component_type", {
      length: 10,
    }).$type<RecipeComponentType>(),
    componentId: uuid("component_id"),
    quantity: decimal4Column("quantity"),
    uomId: uuid("uom_id"),
    wastePctBp: integer("waste_pct_bp").notNull().default(0),
  },
  (table) => [
    unique("modifier_recipe_rules_tenant_id_id_key").on(
      table.tenantId,
      table.id,
    ),
    foreignKey({
      name: "modifier_recipe_rules_modifier_fk",
      columns: [table.tenantId, table.modifierId],
      foreignColumns: [modifiers.tenantId, modifiers.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "modifier_recipe_rules_uom_fk",
      columns: [table.tenantId, table.uomId],
      foreignColumns: [uoms.tenantId, uoms.id],
    }),
    index("modifier_recipe_rules_tenant_modifier_idx").on(
      table.tenantId,
      table.modifierId,
      table.sortOrder,
    ),
    check(
      "modifier_recipe_rules_action_check",
      sql`${table.action} IN ('add', 'replace', 'remove')`,
    ),
    check(
      "modifier_recipe_rules_types_check",
      sql`(${table.targetComponentType} IS NULL OR ${table.targetComponentType} IN ('item', 'recipe'))
        AND (${table.componentType} IS NULL OR ${table.componentType} IN ('item', 'recipe'))`,
    ),
    check(
      "modifier_recipe_rules_quantity_check",
      sql`${table.quantity} IS NULL OR ${table.quantity} > 0`,
    ),
    check(
      "modifier_recipe_rules_waste_check",
      sql`${table.wastePctBp} BETWEEN 0 AND 9999`,
    ),
    // add: component set, target null; replace: both set; remove: target only.
    check(
      "modifier_recipe_rules_shape_check",
      sql`(
        ${table.action} = 'add'
        AND ${table.targetComponentType} IS NULL AND ${table.targetComponentId} IS NULL
        AND ${table.componentType} IS NOT NULL AND ${table.componentId} IS NOT NULL
        AND ${table.quantity} IS NOT NULL AND ${table.uomId} IS NOT NULL
      ) OR (
        ${table.action} = 'replace'
        AND ${table.targetComponentType} IS NOT NULL AND ${table.targetComponentId} IS NOT NULL
        AND ${table.componentType} IS NOT NULL AND ${table.componentId} IS NOT NULL
        AND ${table.quantity} IS NOT NULL AND ${table.uomId} IS NOT NULL
      ) OR (
        ${table.action} = 'remove'
        AND ${table.targetComponentType} IS NOT NULL AND ${table.targetComponentId} IS NOT NULL
        AND ${table.componentType} IS NULL AND ${table.componentId} IS NULL
        AND ${table.quantity} IS NULL AND ${table.uomId} IS NULL
      )`,
    ),
  ],
);

/**
 * `outlet_inventory_settings` (T, outlet-owned): per-outlet override of the
 * tenant deduction mode (NULL inherits `inventory_settings`) and the stock
 * location every sale draws from. The composite FK keeps the location inside
 * the row's tenant AND outlet.
 */
export const outletInventorySettings = pgTable(
  "outlet_inventory_settings",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: uuid("outlet_id").notNull(),
    recipeDeductionMode: varchar("recipe_deduction_mode", {
      length: 20,
    }).$type<RecipeDeductionMode>(),
    saleLocationId: uuid("sale_location_id"),
    updatedBy: text("updated_by").references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      name: "outlet_inventory_settings_pkey",
      columns: [table.tenantId, table.outletId],
    }),
    foreignKey({
      name: "outlet_inventory_settings_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "outlet_inventory_settings_location_fk",
      columns: [table.tenantId, table.outletId, table.saleLocationId],
      foreignColumns: [
        stockLocations.tenantId,
        stockLocations.outletId,
        stockLocations.id,
      ],
    }),
    check(
      "outlet_inventory_settings_mode_check",
      sql`${table.recipeDeductionMode} IS NULL OR ${table.recipeDeductionMode} IN ('real_time', 'close_of_day')`,
    ),
  ],
);

/**
 * `recipe_deductions` (T, outlet-owned): one automatic stock deduction for a
 * sale, remake, comp or duty meal. `idempotency_key` makes re-delivery of the
 * source event return the existing row. `pending` (close_of_day mode) is
 * posted on `day.closed`; `skipped` records why nothing was drawn.
 */
export const recipeDeductions = pgTable(
  "recipe_deductions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: uuid("outlet_id").notNull(),
    kind: varchar("kind", { length: 20 })
      .$type<RecipeDeductionKind>()
      .notNull(),
    status: varchar("status", { length: 20 })
      .$type<RecipeDeductionStatus>()
      .notNull(),
    mode: varchar("mode", { length: 20 })
      .$type<RecipeDeductionMode>()
      .notNull(),
    sourceType: varchar("source_type", { length: 20 })
      .$type<RecipeDeductionSourceType>()
      .notNull(),
    // ULID (order) or UUID (order issue / duty meal), so text.
    sourceId: text("source_id").notNull(),
    businessDate: businessDate("business_date").notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 120 }).notNull(),
    costIdr: idrColumn("cost_idr"),
    skipReason: varchar("skip_reason", {
      length: 30,
    }).$type<RecipeDeductionSkipReason>(),
    reason: varchar("reason", { length: 200 }),
    recordedBy: text("recorded_by").references(() => user.id),
    // Who ate the duty meal (kind = duty_meal); null for other kinds.
    beneficiaryUserId: text("beneficiary_user_id").references(() => user.id),
    shiftId: uuid("shift_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    // legend-9w46: a sale deduction is reversed once when its order is voided
    // after payment or fully refunded. A posted one gets `return` movements
    // back at its own line costs (posted_at stays); a pending one is never
    // posted; a reversal that arrives first leaves a line-less tombstone so
    // the late `order.paid` finds the key and draws nothing.
    reversedAt: timestamp("reversed_at", { withTimezone: true }),
    reversalReason: varchar("reversal_reason", {
      length: 20,
    }).$type<RecipeDeductionReversalReason>(),
    // Void id or refund id that reversed it (UUID or ULID, so text).
    reversalSourceId: text("reversal_source_id"),
    // Set when a reversal of a posted deduction was refused by a stock rule:
    // the row stays `posted` with reason/source kept, and `day.closed` retries
    // it (cleared once the reversal posts). legend-nzbi8: on a `remake` row
    // (reason `swap`, source = the swap issue id) it parks the refused return of
    // the swapped-away line; the row keeps its own status.
    reversalFailedAt: timestamp("reversal_failed_at", { withTimezone: true }),
  },
  (table) => [
    unique("recipe_deductions_tenant_id_id_key").on(table.tenantId, table.id),
    unique("recipe_deductions_tenant_outlet_id_key").on(
      table.tenantId,
      table.outletId,
      table.id,
    ),
    unique("recipe_deductions_tenant_idempotency_key").on(
      table.tenantId,
      table.idempotencyKey,
    ),
    foreignKey({
      name: "recipe_deductions_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    index("recipe_deductions_tenant_outlet_status_date_idx").on(
      table.tenantId,
      table.outletId,
      table.status,
      table.businessDate,
    ),
    index("recipe_deductions_tenant_outlet_occurred_idx").on(
      table.tenantId,
      table.outletId,
      table.occurredAt,
      table.id,
    ),
    check(
      "recipe_deductions_kind_check",
      sql`${table.kind} IN ('sale', 'remake', 'comp', 'duty_meal')`,
    ),
    check(
      "recipe_deductions_status_check",
      sql`${table.status} IN ('pending', 'posted', 'skipped', 'reversed')`,
    ),
    check(
      "recipe_deductions_mode_check",
      sql`${table.mode} IN ('real_time', 'close_of_day')`,
    ),
    check(
      "recipe_deductions_source_type_check",
      sql`${table.sourceType} IN ('order', 'order_issue', 'duty_meal')`,
    ),
    check(
      "recipe_deductions_skip_reason_check",
      sql`${table.skipReason} IS NULL OR ${table.skipReason} IN ('no_recipe', 'no_sale_location', 'recipe_inactive', 'recipe_error')`,
    ),
    check(
      "recipe_deductions_cost_check",
      sql`${table.costIdr} IS NULL OR ${table.costIdr} >= 0`,
    ),
    check(
      "recipe_deductions_posted_check",
      sql`(${table.status} = 'posted' AND ${table.postedAt} IS NOT NULL) OR (${table.status} IN ('pending', 'skipped') AND ${table.postedAt} IS NULL) OR ${table.status} = 'reversed'`,
    ),
    check(
      "recipe_deductions_reversed_check",
      sql`(${table.status} = 'reversed') = (${table.reversedAt} IS NOT NULL)`,
    ),
    check(
      "recipe_deductions_reversal_source_check",
      sql`(${table.reversedAt} IS NOT NULL OR ${table.reversalFailedAt} IS NOT NULL) = (${table.reversalReason} IS NOT NULL AND ${table.reversalSourceId} IS NOT NULL)`,
    ),
    check(
      "recipe_deductions_reversal_failed_check",
      sql`${table.reversalFailedAt} IS NULL OR ${table.status} <> 'reversed'`,
    ),
    check(
      "recipe_deductions_reversal_reason_check",
      sql`${table.reversalReason} IS NULL OR ${table.reversalReason} IN ('void', 'swap')`,
    ),
    check(
      "recipe_deductions_skipped_check",
      sql`${table.status} <> 'skipped' OR ${table.skipReason} IS NOT NULL`,
    ),
  ],
);

/**
 * `recipe_deduction_lines` (T, outlet-owned): consumed quantity per item,
 * always in the item's base UOM. `unit_cost_idr` and `ledger_entry_id` are
 * filled when the deduction is posted to the stock ledger.
 */
export const recipeDeductionLines = pgTable(
  "recipe_deduction_lines",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: uuid("outlet_id").notNull(),
    deductionId: uuid("deduction_id").notNull(),
    inventoryItemId: uuid("inventory_item_id").notNull(),
    locationId: uuid("location_id").notNull(),
    quantity: decimal4Column("quantity").notNull(),
    unitCostIdr: decimal4Column("unit_cost_idr"),
    ledgerEntryId: uuid("ledger_entry_id"),
  },
  (table) => [
    unique("recipe_deduction_lines_tenant_deduction_item_location_key").on(
      table.tenantId,
      table.deductionId,
      table.inventoryItemId,
      table.locationId,
    ),
    foreignKey({
      name: "recipe_deduction_lines_deduction_fk",
      columns: [table.tenantId, table.outletId, table.deductionId],
      foreignColumns: [
        recipeDeductions.tenantId,
        recipeDeductions.outletId,
        recipeDeductions.id,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "recipe_deduction_lines_item_fk",
      columns: [table.tenantId, table.inventoryItemId],
      foreignColumns: [inventoryItems.tenantId, inventoryItems.id],
    }),
    foreignKey({
      name: "recipe_deduction_lines_location_fk",
      columns: [table.tenantId, table.outletId, table.locationId],
      foreignColumns: [
        stockLocations.tenantId,
        stockLocations.outletId,
        stockLocations.id,
      ],
    }),
    check("recipe_deduction_lines_quantity_check", sql`${table.quantity} > 0`),
    check(
      "recipe_deduction_lines_unit_cost_check",
      sql`${table.unitCostIdr} IS NULL OR ${table.unitCostIdr} >= 0`,
    ),
  ],
);

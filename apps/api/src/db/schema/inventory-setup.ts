// Inventory setup tables (PRD v1.7 §16 "Lokasi Stok", "Item Bahan & Satuan",
// "Par Level & Saran Pembelian", "Pemotongan Otomatis", "Batch & Kedaluwarsa";
// bead legend-gjmk).
//
// New tables only; locations, items and UOM conversions live in `inventory.ts`.
// Every table is tenant-owned: tenant_id UUID NOT NULL, RLS via
// `app.enforce_tenant_rls` (and `app.enforce_outlet_rls` for the outlet-owned
// `par_levels`) in `inventory-setup.custom.sql`, and unique constraints always
// include tenant_id. Quantities are NUMERIC(14,4) decimal strings (D-CORE-2).

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
import type { RecipeDeductionMode } from "@starter/shared/inventory";
import { decimal4Column, tenantIdColumn } from "../columns";
import { inventoryItems, stockLocations } from "./inventory";
import { tenants } from "./platform-org";
import { user } from "./user";

/**
 * `inventory_settings` (T): one row per tenant. A tenant without a row reads
 * the contract defaults (real_time, 7 days). PRD §16 "Pemotongan Otomatis" and
 * "Batch & Kedaluwarsa".
 */
export const inventorySettings = pgTable(
  "inventory_settings",
  {
    tenantId: tenantIdColumn(() => tenants.id)
      .primaryKey()
      .notNull(),
    recipeDeductionMode: varchar("recipe_deduction_mode", { length: 20 })
      .$type<RecipeDeductionMode>()
      .notNull()
      .default("real_time"),
    expiryWarningDays: integer("expiry_warning_days").notNull().default(7),
    updatedBy: text("updated_by").references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      "inventory_settings_mode_check",
      sql`${table.recipeDeductionMode} IN ('real_time', 'close_of_day')`,
    ),
    check(
      "inventory_settings_expiry_days_check",
      sql`${table.expiryWarningDays} BETWEEN 1 AND 365`,
    ),
  ],
);

/**
 * `par_levels` (T, outlet-owned): per-location override of the item par
 * defaults (PRD §16 "Par Level & Saran Pembelian"). One level per location and
 * item; the composite FK keeps the location inside the row's tenant AND outlet.
 */
export const parLevels = pgTable(
  "par_levels",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: uuid("outlet_id").notNull(),
    locationId: uuid("location_id").notNull(),
    inventoryItemId: uuid("inventory_item_id").notNull(),
    parMin: decimal4Column("par_min").notNull(),
    parMax: decimal4Column("par_max").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("par_levels_tenant_id_id_key").on(table.tenantId, table.id),
    unique("par_levels_tenant_location_item_key").on(
      table.tenantId,
      table.locationId,
      table.inventoryItemId,
    ),
    foreignKey({
      name: "par_levels_location_fk",
      columns: [table.tenantId, table.outletId, table.locationId],
      foreignColumns: [
        stockLocations.tenantId,
        stockLocations.outletId,
        stockLocations.id,
      ],
    }),
    foreignKey({
      name: "par_levels_item_fk",
      columns: [table.tenantId, table.inventoryItemId],
      foreignColumns: [inventoryItems.tenantId, inventoryItems.id],
    }),
    index("par_levels_tenant_outlet_idx").on(
      table.tenantId,
      table.outletId,
      table.id,
    ),
    check(
      "par_levels_range_check",
      sql`${table.parMin} >= 0 AND ${table.parMax} >= ${table.parMin}`,
    ),
  ],
);

/**
 * `inventory_item_alternates` (T): substitute ingredient ("bahan alternatif",
 * PRD §16 "Item Bahan & Satuan"). Tenant-wide master data; lower priority wins.
 */
export const inventoryItemAlternates = pgTable(
  "inventory_item_alternates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    inventoryItemId: uuid("inventory_item_id").notNull(),
    alternateItemId: uuid("alternate_item_id").notNull(),
    priority: integer("priority").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("inventory_item_alternates_tenant_id_id_key").on(
      table.tenantId,
      table.id,
    ),
    unique("inventory_item_alternates_tenant_pair_key").on(
      table.tenantId,
      table.inventoryItemId,
      table.alternateItemId,
    ),
    foreignKey({
      name: "inventory_item_alternates_item_fk",
      columns: [table.tenantId, table.inventoryItemId],
      foreignColumns: [inventoryItems.tenantId, inventoryItems.id],
    }),
    foreignKey({
      name: "inventory_item_alternates_alternate_fk",
      columns: [table.tenantId, table.alternateItemId],
      foreignColumns: [inventoryItems.tenantId, inventoryItems.id],
    }),
    check(
      "inventory_item_alternates_check",
      sql`${table.inventoryItemId} <> ${table.alternateItemId} AND ${table.priority} >= 0`,
    ),
  ],
);

/**
 * `inventory_setup_idempotency` (T): the caller's key for a setup create/PUT,
 * bound to a fingerprint of the request. `locations` and `uom_conversions`
 * belong to `inventory.ts`, so their retry guard lives here instead of on the
 * row. A replay with the same fingerprint returns the first resource; a
 * different request under the same key is IDEMPOTENCY_KEY_REUSED.
 */
export const inventorySetupIdempotency = pgTable(
  "inventory_setup_idempotency",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 255 }).notNull(),
    operation: varchar("operation", { length: 40 }).notNull(),
    requestFingerprint: varchar("request_fingerprint", {
      length: 64,
    }).notNull(),
    resourceId: uuid("resource_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("inventory_setup_idempotency_tenant_key").on(
      table.tenantId,
      table.idempotencyKey,
    ),
  ],
);

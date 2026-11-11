// AI-01 menu recommendation rules: one settings row per outlet plus per-item
// overrides (block, daily time window). Co-occurrence is computed live from
// order_items, so nothing here is materialised. Tenant + outlet RLS is applied
// in the 0254_menu_recommendations migration.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  integer,
  pgTable,
  smallint,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { outletIdColumn, tenantIdColumn, ulidInUuid } from "../columns";
import { menuItems } from "./menu";
import { outlets, tenants } from "./platform-org";

/** `menu_recommendation_rules`: one row per (tenant, outlet). */
export const menuRecommendationRules = pgTable(
  "menu_recommendation_rules",
  {
    id: ulidInUuid("id").primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    /** Minimum margin in basis points; a candidate below it is dropped. */
    minMarginBps: integer("min_margin_bps").notNull().default(2000),
    excludeOutOfStock: boolean("exclude_out_of_stock").notNull().default(true),
    maxSuggestions: integer("max_suggestions").notNull().default(5),
    /** k-anonymity: a pair must occur in at least this many distinct orders. */
    minPairSupport: integer("min_pair_support").notNull().default(3),
    lookbackDays: integer("lookback_days").notNull().default(90),
    memberHistoryEnabled: boolean("member_history_enabled")
      .notNull()
      .default(true),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("menu_recommendation_rules_key").on(table.tenantId, table.outletId),
    foreignKey({
      name: "menu_recommendation_rules_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    check(
      "menu_recommendation_rules_min_margin_bps_check",
      sql`${table.minMarginBps} BETWEEN 0 AND 10000`,
    ),
    check(
      "menu_recommendation_rules_max_suggestions_check",
      sql`${table.maxSuggestions} BETWEEN 1 AND 20`,
    ),
    check(
      "menu_recommendation_rules_min_pair_support_check",
      sql`${table.minPairSupport} >= 2`,
    ),
    check(
      "menu_recommendation_rules_lookback_days_check",
      sql`${table.lookbackDays} BETWEEN 7 AND 365`,
    ),
  ],
);

/**
 * `menu_recommendation_item_rules`: per-item override. The hour window is in
 * outlet local hours 0-23, [hour_from, hour_to), and may wrap past midnight;
 * both null means all day.
 */
export const menuRecommendationItemRules = pgTable(
  "menu_recommendation_item_rules",
  {
    id: ulidInUuid("id").primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    menuItemId: uuid("menu_item_id").notNull(),
    blocked: boolean("blocked").notNull().default(false),
    hourFrom: smallint("hour_from"),
    hourTo: smallint("hour_to"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("menu_recommendation_item_rules_key").on(
      table.tenantId,
      table.outletId,
      table.menuItemId,
    ),
    foreignKey({
      name: "menu_recommendation_item_rules_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "menu_recommendation_item_rules_item_fk",
      columns: [table.tenantId, table.menuItemId],
      foreignColumns: [menuItems.tenantId, menuItems.id],
    }),
    check(
      "menu_recommendation_item_rules_hours_check",
      sql`(${table.hourFrom} IS NULL AND ${table.hourTo} IS NULL) OR (${table.hourFrom} IS NOT NULL AND ${table.hourTo} IS NOT NULL AND ${table.hourFrom} BETWEEN 0 AND 23 AND ${table.hourTo} BETWEEN 0 AND 23)`,
    ),
  ],
);

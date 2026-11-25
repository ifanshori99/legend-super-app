// Versioned tax and service-charge configuration plus the per-source tax
// snapshot the PBJT recap aggregates (PRD v1.7 §3 F11/F14, §6.C `tax_rules` /
// `service_charge_rules`, D13; bead legend-559).
//
// A rule is identified by (outlet_id | tenant-wide, code); every change is a
// new version row with its own effective business date. Published versions are
// immutable, so the PBJT recap can always reproduce the rate a sale was taxed
// at (PRD R21). Tenant RLS is installed in the generated migration.
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
import type { Idr, RoundingMode, UserId } from "@starter/shared/core";
import { calculationOrderSchema } from "@starter/shared/tax";
import type {
  ItemTaxClass,
  PackageAllocationMethod,
  RuleVersionStatus,
  ServiceChargeRuleId,
  TaxAppliesTo,
  TaxChannel,
  TaxRuleId,
  TaxSettingsId,
  TaxType,
} from "@starter/shared/tax";
import type { z } from "zod";

/** The contract exports the schema but no inferred alias for this one. */
type CalculationOrder = z.infer<typeof calculationOrderSchema>;
import {
  businessDate,
  idrColumn,
  outletIdColumn,
  tenantIdColumn,
} from "../columns";
import { outlets, tenants } from "./platform-org";
import { syncTxidColumn } from "./sync-txid";

/** One version of a tax rule (§6.C `tax_rules`, D13 PBJT default). */
export const taxRules = pgTable(
  "tax_rules",
  {
    id: uuid("id").defaultRandom().primaryKey().$type<TaxRuleId>(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    /** Null = tenant-wide; an outlet version overrides the tenant-wide code. */
    outletId: outletIdColumn(() => outlets.id),
    code: varchar("code", { length: 40 }).notNull(),
    name: varchar("name", { length: 150 }).notNull(),
    taxType: varchar("tax_type", { length: 20 }).$type<TaxType>().notNull(),
    rateBp: integer("rate_bp").notNull(),
    /** Null = every region; otherwise `ID-<province>[-<BPS code>]`. */
    regionCode: varchar("region_code", { length: 20 }),
    channels: jsonb("channels").$type<TaxChannel[]>().notNull(),
    appliesTo: jsonb("applies_to").$type<TaxAppliesTo>().notNull(),
    priceIncludesTax: boolean("price_includes_tax").notNull(),
    includeServiceInBase: boolean("include_service_in_base").notNull(),
    /** false = tombstone version that ends this code from effectiveFrom. */
    isActive: boolean("is_active").notNull(),
    version: integer("version").notNull(),
    effectiveFrom: businessDate("effective_from").notNull(),
    status: varchar("status", { length: 20 })
      .$type<RuleVersionStatus>()
      .notNull()
      .default("draft"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    // Actor reference without a foreign key: history must survive a deleted or
    // anonymised account (same choice as audit_logs.actor_id).
    publishedBy: text("published_by").$type<UserId>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    syncTxid: syncTxidColumn(),
  },
  (table) => [
    index("tax_rules_sync_txid_idx").on(
      table.tenantId,
      table.syncTxid,
      table.id,
    ),
    // Parent key for tax_snapshots' composite foreign key (TEN-01).
    unique("tax_rules_tenant_id_id_key").on(table.tenantId, table.id),
    // One version number per (outlet | tenant-wide) + code. PostgreSQL treats
    // NULLs as distinct, so tenant-wide and outlet rows need separate indexes.
    uniqueIndex("tax_rules_tenant_outlet_code_version_key")
      .on(table.tenantId, table.outletId, table.code, table.version)
      .where(sql`${table.outletId} IS NOT NULL`),
    uniqueIndex("tax_rules_tenant_code_version_key")
      .on(table.tenantId, table.code, table.version)
      .where(sql`${table.outletId} IS NULL`),
    foreignKey({
      name: "tax_rules_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    index("tax_rules_lookup_idx").on(
      table.tenantId,
      table.outletId,
      table.status,
      table.effectiveFrom,
    ),
    check(
      "tax_rules_tax_type_check",
      sql`${table.taxType} IN ('pbjt', 'ppn', 'other')`,
    ),
    check("tax_rules_rate_bp_check", sql`${table.rateBp} BETWEEN 0 AND 10000`),
    check("tax_rules_version_check", sql`${table.version} > 0`),
    check(
      "tax_rules_status_check",
      sql`${table.status} IN ('draft', 'published', 'archived')`,
    ),
    // publishedAt/publishedBy are set exactly when the version is published
    // (shared contract checkPublishedMeta).
    check(
      "tax_rules_published_meta_check",
      sql`(${table.status} = 'published') = (${table.publishedAt} IS NOT NULL)
        AND (${table.status} = 'published') = (${table.publishedBy} IS NOT NULL)`,
    ),
    check(
      "tax_rules_channels_array_check",
      sql`jsonb_typeof(${table.channels}) = 'array'`,
    ),
    check(
      "tax_rules_applies_to_object_check",
      sql`jsonb_typeof(${table.appliesTo}) = 'object'`,
    ),
  ],
);

/** One version of a service-charge rule: percentage per zone or order type. */
export const serviceChargeRules = pgTable(
  "service_charge_rules",
  {
    id: uuid("id").defaultRandom().primaryKey().$type<ServiceChargeRuleId>(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id),
    code: varchar("code", { length: 40 }).notNull(),
    name: varchar("name", { length: 150 }).notNull(),
    rateBp: integer("rate_bp").notNull(),
    /** WS-03 floor zone; null = any zone. The zones table lands with WS-03. */
    zoneId: uuid("zone_id"),
    orderTypes: jsonb("order_types").$type<TaxChannel[]>().notNull(),
    itemClasses: jsonb("item_classes").$type<ItemTaxClass[]>().notNull(),
    isActive: boolean("is_active").notNull(),
    version: integer("version").notNull(),
    effectiveFrom: businessDate("effective_from").notNull(),
    status: varchar("status", { length: 20 })
      .$type<RuleVersionStatus>()
      .notNull()
      .default("draft"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    // Actor reference without a foreign key: history must survive a deleted or
    // anonymised account (same choice as audit_logs.actor_id).
    publishedBy: text("published_by").$type<UserId>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    syncTxid: syncTxidColumn(),
  },
  (table) => [
    index("service_charge_rules_sync_txid_idx").on(
      table.tenantId,
      table.syncTxid,
      table.id,
    ),
    unique("service_charge_rules_tenant_id_id_key").on(
      table.tenantId,
      table.id,
    ),
    uniqueIndex("service_charge_rules_tenant_outlet_code_version_key")
      .on(table.tenantId, table.outletId, table.code, table.version)
      .where(sql`${table.outletId} IS NOT NULL`),
    uniqueIndex("service_charge_rules_tenant_code_version_key")
      .on(table.tenantId, table.code, table.version)
      .where(sql`${table.outletId} IS NULL`),
    foreignKey({
      name: "service_charge_rules_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    index("service_charge_rules_lookup_idx").on(
      table.tenantId,
      table.outletId,
      table.status,
      table.effectiveFrom,
    ),
    check(
      "service_charge_rules_rate_bp_check",
      sql`${table.rateBp} BETWEEN 0 AND 10000`,
    ),
    check("service_charge_rules_version_check", sql`${table.version} > 0`),
    check(
      "service_charge_rules_status_check",
      sql`${table.status} IN ('draft', 'published', 'archived')`,
    ),
    check(
      "service_charge_rules_published_meta_check",
      sql`(${table.status} = 'published') = (${table.publishedAt} IS NOT NULL)
        AND (${table.status} = 'published') = (${table.publishedBy} IS NOT NULL)`,
    ),
    check(
      "service_charge_rules_order_types_array_check",
      sql`jsonb_typeof(${table.orderTypes}) = 'array'`,
    ),
    check(
      "service_charge_rules_item_classes_array_check",
      sql`jsonb_typeof(${table.itemClasses}) = 'array'
        AND jsonb_array_length(${table.itemClasses}) > 0`,
    ),
  ],
);

/**
 * Versioned calculation options (PRD §3.14 "Opsi Perhitungan"): calculation
 * order, exclusive/inclusive price mode, rounding modes, cash rounding and the
 * mixed-package allocation method. One published version in force per
 * tenant/outlet at a time; the engine fails closed without one.
 */
export const taxSettings = pgTable(
  "tax_settings",
  {
    id: uuid("id").defaultRandom().primaryKey().$type<TaxSettingsId>(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id),
    calculationOrder: varchar("calculation_order", { length: 30 })
      .$type<CalculationOrder>()
      .notNull(),
    /** Owner decision 2026-11-01: false — menu prices exclude tax + service. */
    pricesIncludeTax: boolean("prices_include_tax").notNull(),
    serviceRoundingMode: varchar("service_rounding_mode", { length: 20 })
      .$type<RoundingMode>()
      .notNull(),
    taxRoundingMode: varchar("tax_rounding_mode", { length: 20 })
      .$type<RoundingMode>()
      .notNull(),
    inclusiveBaseRoundingMode: varchar("inclusive_base_rounding_mode", {
      length: 20,
    })
      .$type<RoundingMode>()
      .notNull(),
    /** orders.rounding_idr configuration; null = no cash rounding. */
    billRounding: jsonb("bill_rounding").$type<{
      incrementIdr: Idr;
      mode: RoundingMode;
    } | null>(),
    packageAllocation: varchar("package_allocation", { length: 30 })
      .$type<PackageAllocationMethod>()
      .notNull(),
    version: integer("version").notNull(),
    effectiveFrom: businessDate("effective_from").notNull(),
    status: varchar("status", { length: 20 })
      .$type<RuleVersionStatus>()
      .notNull()
      .default("draft"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    // Actor reference without a foreign key: history must survive a deleted or
    // anonymised account (same choice as audit_logs.actor_id).
    publishedBy: text("published_by").$type<UserId>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    syncTxid: syncTxidColumn(),
  },
  (table) => [
    index("tax_settings_sync_txid_idx").on(
      table.tenantId,
      table.syncTxid,
      table.id,
    ),
    unique("tax_settings_tenant_id_id_key").on(table.tenantId, table.id),
    uniqueIndex("tax_settings_tenant_outlet_version_key")
      .on(table.tenantId, table.outletId, table.version)
      .where(sql`${table.outletId} IS NOT NULL`),
    uniqueIndex("tax_settings_tenant_version_key")
      .on(table.tenantId, table.version)
      .where(sql`${table.outletId} IS NULL`),
    foreignKey({
      name: "tax_settings_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    index("tax_settings_lookup_idx").on(
      table.tenantId,
      table.outletId,
      table.status,
      table.effectiveFrom,
    ),
    check(
      "tax_settings_calculation_order_check",
      sql`${table.calculationOrder} IN ('discount_service_tax')`,
    ),
    check(
      "tax_settings_service_rounding_check",
      sql`${table.serviceRoundingMode} IN ('half_up', 'half_even', 'down', 'floor', 'ceil')`,
    ),
    check(
      "tax_settings_tax_rounding_check",
      sql`${table.taxRoundingMode} IN ('half_up', 'half_even', 'down', 'floor', 'ceil')`,
    ),
    check(
      "tax_settings_inclusive_rounding_check",
      sql`${table.inclusiveBaseRoundingMode} IN ('half_up', 'half_even', 'down', 'floor', 'ceil')`,
    ),
    check(
      "tax_settings_package_allocation_check",
      sql`${table.packageAllocation} IN ('fixed_bp', 'standalone_price_ratio')`,
    ),
    check(
      "tax_settings_bill_rounding_check",
      sql`${table.billRounding} IS NULL OR jsonb_typeof(${table.billRounding}) = 'object'`,
    ),
    check("tax_settings_version_check", sql`${table.version} > 0`),
    check(
      "tax_settings_status_check",
      sql`${table.status} IN ('draft', 'published', 'archived')`,
    ),
    check(
      "tax_settings_published_meta_check",
      sql`(${table.status} = 'published') = (${table.publishedAt} IS NOT NULL)
        AND (${table.status} = 'published') = (${table.publishedBy} IS NOT NULL)`,
    ),
  ],
);

/** One row per tax rule applied to a persisted sale (order, POS sale, facility
 * ticket, event pre-order). Written in the sale's own transaction by the tax
 * service; the PBJT monthly recap aggregates it. Amounts are the ones the
 * server calculated, so a re-quote can update the same source row. */
export const taxSnapshots = pgTable(
  "tax_snapshots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    /** "order" today; other sale sources use their own kind. */
    sourceType: varchar("source_type", { length: 20 }).notNull(),
    /** Order/ticket id (UUID, ULID-in-uuid for operational rows). */
    sourceId: uuid("source_id").notNull(),
    /** Outlet-local business date of the sale (PBJT period). */
    businessDate: businessDate("business_date").notNull(),
    taxRuleId: uuid("tax_rule_id").$type<TaxRuleId>().notNull(),
    taxRuleCode: varchar("tax_rule_code", { length: 40 }).notNull(),
    taxRuleVersion: integer("tax_rule_version").notNull(),
    taxType: varchar("tax_type", { length: 20 }).$type<TaxType>().notNull(),
    rateBp: integer("rate_bp").notNull(),
    priceIncludesTax: boolean("price_includes_tax").notNull(),
    /** Menu-priced amount before discounts, as in the PBJT recap. */
    grossIdr: idrColumn("gross_idr").notNull(),
    taxBaseIdr: idrColumn("tax_base_idr").notNull(),
    serviceChargeIdr: idrColumn("service_charge_idr").notNull(),
    taxIdr: idrColumn("tax_idr").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // One row per rule per sale: a re-quote updates it instead of duplicating,
    // so the period total never counts the same bill twice.
    unique("tax_snapshots_source_rule_key").on(
      table.tenantId,
      table.sourceType,
      table.sourceId,
      table.taxRuleId,
    ),
    foreignKey({
      name: "tax_snapshots_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "tax_snapshots_rule_fk",
      columns: [table.tenantId, table.taxRuleId],
      foreignColumns: [taxRules.tenantId, taxRules.id],
    }),
    index("tax_snapshots_recap_idx").on(
      table.tenantId,
      table.outletId,
      table.businessDate,
    ),
    check(
      "tax_snapshots_source_type_check",
      sql`${table.sourceType} IN ('order', 'pos_sale', 'facility_ticket', 'preorder')`,
    ),
    check(
      "tax_snapshots_amounts_check",
      sql`${table.grossIdr} >= 0 AND ${table.taxBaseIdr} >= 0
        AND ${table.serviceChargeIdr} >= 0 AND ${table.taxIdr} >= 0`,
    ),
    check(
      "tax_snapshots_rate_bp_check",
      sql`${table.rateBp} BETWEEN 0 AND 10000`,
    ),
    check("tax_snapshots_version_check", sql`${table.taxRuleVersion} > 0`),
  ],
);

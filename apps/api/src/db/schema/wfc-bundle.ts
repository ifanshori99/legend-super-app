// WFC bundles, e.g. "Pagi Produktif" = shower single + WFC day pass (PRD v1.7
// §3 F25/F39; bead legend-bz9h; money rules M1-M4).
//
// - `wfc_bundles` + `wfc_bundle_items`: the offer. An item is a facility
//   product xor a subscription plan of the same outlet. The bundle price is a
//   discount only (> 0 and <= sum of component list prices); the service
//   enforces it because the list prices live in other tables.
// - `wfc_bundle_purchases`: one paid purchase. `payment_ref` is unique per
//   tenant, so a replayed payment never sells twice.
// - `wfc_bundle_purchase_allocations`: the price paid split over the items
//   (largest remainder, written once at purchase; the service guarantees the
//   rows sum to `price_paid_idr`). The allocation id is the `source_ref` of
//   the entitlement grant of that item, so a refund can tell which items were
//   already redeemed.
// All tables are tenant and outlet owned; RLS is installed in
// wfc-bundle.custom.sql. `customer_profile_id` has no FK, same as
// `entitlement_ledger` (the profile belongs to WS-08).
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type {
  WfcBundlePurchaseStatus,
  WfcBundleStatus,
} from "@starter/shared/wfc";
import { idrColumn, outletIdColumn, tenantIdColumn } from "../columns.ts";
import {
  facilities,
  facilityProducts,
  facilitySubscriptionPlans,
} from "./facility.ts";
import { outlets, tenants } from "./platform-org.ts";

const createdAt = timestamp("created_at", { withTimezone: true })
  .notNull()
  .defaultNow();

export const wfcBundles = pgTable(
  "wfc_bundles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    name: varchar("name", { length: 150 }).notNull(),
    priceIdr: idrColumn("price_idr").notNull(),
    /** Days the entitlements of a purchase stay valid. */
    validityDays: integer("validity_days").notNull().default(1),
    status: varchar("status", { length: 10 })
      .$type<WfcBundleStatus>()
      .notNull()
      .default("active"),
    createdAt,
  },
  (table) => [
    unique("wfc_bundles_tenant_id_id_key").on(table.tenantId, table.id),
    unique("wfc_bundles_tenant_outlet_id_key").on(
      table.tenantId,
      table.outletId,
      table.id,
    ),
    foreignKey({
      name: "wfc_bundles_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    index("wfc_bundles_outlet_idx").on(
      table.tenantId,
      table.outletId,
      table.status,
    ),
    check(
      "wfc_bundles_status_check",
      sql`${table.status} IN ('active', 'inactive')`,
    ),
    check(
      "wfc_bundles_amount_check",
      sql`${table.priceIdr} > 0 AND ${table.validityDays} BETWEEN 1 AND 366`,
    ),
  ],
);

export const wfcBundleItems = pgTable(
  "wfc_bundle_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    bundleId: uuid("bundle_id").notNull(),
    facilityId: uuid("facility_id").notNull(),
    /** A single-ticket product xor a subscription plan. */
    productId: uuid("product_id"),
    planId: uuid("plan_id"),
    quantity: integer("quantity").notNull(),
    createdAt,
  },
  (table) => [
    unique("wfc_bundle_items_tenant_id_id_key").on(table.tenantId, table.id),
    unique("wfc_bundle_items_tenant_outlet_id_key").on(
      table.tenantId,
      table.outletId,
      table.id,
    ),
    foreignKey({
      name: "wfc_bundle_items_bundle_fk",
      columns: [table.tenantId, table.outletId, table.bundleId],
      foreignColumns: [wfcBundles.tenantId, wfcBundles.outletId, wfcBundles.id],
    }),
    foreignKey({
      name: "wfc_bundle_items_facility_fk",
      columns: [table.tenantId, table.outletId, table.facilityId],
      foreignColumns: [facilities.tenantId, facilities.outletId, facilities.id],
    }),
    foreignKey({
      name: "wfc_bundle_items_product_fk",
      columns: [table.tenantId, table.outletId, table.productId],
      foreignColumns: [
        facilityProducts.tenantId,
        facilityProducts.outletId,
        facilityProducts.id,
      ],
    }),
    foreignKey({
      name: "wfc_bundle_items_plan_fk",
      columns: [table.tenantId, table.outletId, table.planId],
      foreignColumns: [
        facilitySubscriptionPlans.tenantId,
        facilitySubscriptionPlans.outletId,
        facilitySubscriptionPlans.id,
      ],
    }),
    index("wfc_bundle_items_bundle_idx").on(table.tenantId, table.bundleId),
    check(
      "wfc_bundle_items_component_check",
      sql`(${table.productId} IS NULL) <> (${table.planId} IS NULL)`,
    ),
    check(
      "wfc_bundle_items_quantity_check",
      sql`${table.quantity} BETWEEN 1 AND 100`,
    ),
  ],
);

export const wfcBundlePurchases = pgTable(
  "wfc_bundle_purchases",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    bundleId: uuid("bundle_id").notNull(),
    /** Customer profile (WS-08); no FK, same as `entitlement_ledger`. */
    customerProfileId: uuid("customer_profile_id").notNull(),
    /** Snapshot of the bundle price at purchase (M1: read server-side). */
    pricePaidIdr: idrColumn("price_paid_idr").notNull(),
    refundedIdr: idrColumn("refunded_idr")
      .notNull()
      .default(sql`0`),
    status: varchar("status", { length: 10 })
      .$type<WfcBundlePurchaseStatus>()
      .notNull()
      .default("paid"),
    paymentRef: varchar("payment_ref", { length: 64 }).notNull(),
    createdAt,
  },
  (table) => [
    unique("wfc_bundle_purchases_tenant_id_id_key").on(
      table.tenantId,
      table.id,
    ),
    unique("wfc_bundle_purchases_tenant_outlet_id_key").on(
      table.tenantId,
      table.outletId,
      table.id,
    ),
    unique("wfc_bundle_purchases_payment_ref_key").on(
      table.tenantId,
      table.paymentRef,
    ),
    foreignKey({
      name: "wfc_bundle_purchases_bundle_fk",
      columns: [table.tenantId, table.outletId, table.bundleId],
      foreignColumns: [wfcBundles.tenantId, wfcBundles.outletId, wfcBundles.id],
    }),
    index("wfc_bundle_purchases_customer_idx").on(
      table.tenantId,
      table.customerProfileId,
    ),
    check(
      "wfc_bundle_purchases_status_check",
      sql`${table.status} IN ('paid', 'refunded')`,
    ),
    // M2: never refund more than was paid.
    check(
      "wfc_bundle_purchases_amount_check",
      sql`${table.pricePaidIdr} > 0 AND ${table.refundedIdr} >= 0 AND ${table.refundedIdr} <= ${table.pricePaidIdr}`,
    ),
  ],
);

export const wfcBundlePurchaseAllocations = pgTable(
  "wfc_bundle_purchase_allocations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    purchaseId: uuid("purchase_id").notNull(),
    itemId: uuid("item_id").notNull(),
    allocatedIdr: idrColumn("allocated_idr").notNull(),
    createdAt,
  },
  (table) => [
    unique("wfc_bundle_purchase_allocations_tenant_id_id_key").on(
      table.tenantId,
      table.id,
    ),
    unique("wfc_bundle_purchase_allocations_item_key").on(
      table.tenantId,
      table.purchaseId,
      table.itemId,
    ),
    foreignKey({
      name: "wfc_bundle_purchase_allocations_purchase_fk",
      columns: [table.tenantId, table.outletId, table.purchaseId],
      foreignColumns: [
        wfcBundlePurchases.tenantId,
        wfcBundlePurchases.outletId,
        wfcBundlePurchases.id,
      ],
    }),
    foreignKey({
      name: "wfc_bundle_purchase_allocations_item_fk",
      columns: [table.tenantId, table.outletId, table.itemId],
      foreignColumns: [
        wfcBundleItems.tenantId,
        wfcBundleItems.outletId,
        wfcBundleItems.id,
      ],
    }),
    check(
      "wfc_bundle_purchase_allocations_amount_check",
      sql`${table.allocatedIdr} >= 0`,
    ),
  ],
);

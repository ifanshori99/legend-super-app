// Simple petty purchases and their spend limit (PRD §3.18; bead legend-65mgw).
//
// A petty purchase records a small cash spend at the market with a mandatory
// receipt photo. It is not a stock document. Rows are immutable history (the
// RLS migration revokes UPDATE/DELETE/TRUNCATE from the app role); the photo
// is one `core_storage_objects` row (source kind 'petty_purchase') used by at
// most one purchase. The limit policy is editable (audited) but never deleted;
// `outlet_id` NULL is the tenant default, an outlet row overrides it.

import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { businessDate, idrColumn, tenantIdColumn } from "../columns.ts";
import { coreStorageObjects } from "./core-storage.ts";
import { outlets, tenants } from "./platform-org.ts";
import { user } from "./user.ts";

/**
 * `petty_purchases` (T, outlet-owned): one cash purchase. `business_date` is
 * the outlet business date of `paid_at`; `limit_idr_applied` is the effective
 * limit that allowed it (evidence for later audit).
 */
export const pettyPurchases = pgTable(
  "petty_purchases",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: uuid("outlet_id").notNull(),
    id: uuid("id").defaultRandom().primaryKey(),
    vendorName: varchar("vendor_name", { length: 150 }).notNull(),
    description: varchar("description", { length: 200 }).notNull(),
    amountIdr: idrColumn("amount_idr").notNull(),
    photoObjectId: uuid("photo_object_id").notNull(),
    paidBy: text("paid_by")
      .notNull()
      .references(() => user.id),
    paidAt: timestamp("paid_at", { withTimezone: true }).notNull(),
    businessDate: businessDate("business_date").notNull(),
    limitIdrApplied: idrColumn("limit_idr_applied").notNull(),
    note: varchar("note", { length: 300 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("petty_purchases_tenant_id_id_key").on(table.tenantId, table.id),
    unique("petty_purchases_tenant_photo_key").on(
      table.tenantId,
      table.photoObjectId,
    ),
    foreignKey({
      name: "petty_purchases_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "petty_purchases_photo_fk",
      columns: [table.tenantId, table.photoObjectId],
      foreignColumns: [coreStorageObjects.tenantId, coreStorageObjects.id],
    }),
    index("petty_purchases_tenant_outlet_date_idx").on(
      table.tenantId,
      table.outletId,
      table.businessDate,
      table.id,
    ),
    check("petty_purchases_amount_check", sql`${table.amountIdr} > 0`),
    check("petty_purchases_limit_check", sql`${table.limitIdrApplied} > 0`),
  ],
);

/**
 * `petty_purchase_policies` (T): the spend limit per purchase. `outlet_id`
 * NULL is the tenant default; an outlet row wins over it. One row per tenant
 * default and one per outlet (two partial unique indexes). Updated in place
 * (audited), never deleted.
 */
export const pettyPurchasePolicies = pgTable(
  "petty_purchase_policies",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    id: uuid("id").defaultRandom().primaryKey(),
    outletId: uuid("outlet_id"),
    limitIdr: idrColumn("limit_idr").notNull(),
    updatedBy: text("updated_by")
      .notNull()
      .references(() => user.id),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("petty_purchase_policies_tenant_id_id_key").on(
      table.tenantId,
      table.id,
    ),
    foreignKey({
      name: "petty_purchase_policies_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    uniqueIndex("petty_purchase_policies_tenant_default_key")
      .on(table.tenantId)
      .where(sql`${table.outletId} IS NULL`),
    uniqueIndex("petty_purchase_policies_tenant_outlet_key")
      .on(table.tenantId, table.outletId)
      .where(sql`${table.outletId} IS NOT NULL`),
    check("petty_purchase_policies_limit_check", sql`${table.limitIdr} > 0`),
  ],
);

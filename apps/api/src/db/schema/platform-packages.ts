// `platform_packages` (global, PRD v1.7 §6 A `tenants.plan` + §3 F4 "Feature
// Flag & Paket"). Packages are data, never an enum in code: a new package is a
// row, so TEN-06 (create tenants without a deploy) holds for plans too.
// Super Admin assigns a package key to `tenants.plan`; the tenant's own
// `feature_flags` decide which of the package's modules are switched on.

import { sql } from "drizzle-orm";
import { check, jsonb, pgTable, timestamp, varchar } from "drizzle-orm/pg-core";
import type {
  ModuleKey,
  TenantLimits,
  PlatformPackage,
} from "@starter/shared/platform";

export const platformPackages = pgTable(
  "platform_packages",
  {
    key: varchar("key", { length: 30 }).primaryKey(),
    name: varchar("name", { length: 100 }).notNull(),
    /** Modules the package may switch on (`platformPackageSchema.modules`). */
    modules: jsonb("modules").$type<ModuleKey[]>().notNull(),
    /** Default quotas and cost caps a new tenant starts with. */
    defaultLimits: jsonb("default_limits").$type<TenantLimits>().notNull(),
    status: varchar("status", { length: 20 })
      .$type<PlatformPackage["status"]>()
      .notNull()
      .default("active"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    check(
      "platform_packages_status_check",
      sql`${table.status} IN ('active', 'retired')`,
    ),
  ],
);

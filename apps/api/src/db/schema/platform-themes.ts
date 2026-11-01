// `tenant_themes` (T, PRD v1.7 §6 A, TEN-10 "Whitelabel"). Versioned Tenant
// Theme per brand; at most one `active` version per brand, which the partial
// unique index enforces at the database level. Contrast is re-checked on the
// server at activation time (`activateTheme`), never trusted from the stored
// cache column.

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
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
import type { ThemeStatus, ThemeTokens } from "@starter/shared/platform";
import { brands, tenants } from "./platform-org";

export const tenantThemes = pgTable(
  "tenant_themes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    brandId: uuid("brand_id").notNull(),
    /** 1, 2, 3 … per brand; a new draft never overwrites an active version. */
    version: integer("version").notNull(),
    /** Token overrides for light and dark mode (`themeTokensSchema`). */
    tokens: jsonb("tokens").$type<ThemeTokens>().notNull(),
    logoMediaId: uuid("logo_media_id"),
    fontFamily: varchar("font_family", { length: 40 }).notNull(),
    corners: varchar("corners", { length: 20 }).notNull(),
    /** Editor cache only; activation re-runs the WCAG check (TEN-10). */
    contrastCheckPassed: boolean("contrast_check_passed")
      .notNull()
      .default(false),
    status: varchar("status", { length: 20 })
      .$type<ThemeStatus>()
      .notNull()
      .default("draft"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
  },
  (table) => [
    unique("tenant_themes_brand_version_key").on(
      table.tenantId,
      table.brandId,
      table.version,
    ),
    // One active theme per brand (a tenant may run several brands).
    uniqueIndex("tenant_themes_active_brand_key")
      .on(table.tenantId, table.brandId)
      .where(sql`${table.status} = 'active'`),
    foreignKey({
      name: "tenant_themes_brand_fk",
      columns: [table.tenantId, table.brandId],
      foreignColumns: [brands.tenantId, brands.id],
    }),
    check(
      "tenant_themes_status_check",
      sql`${table.status} IN ('draft', 'archived', 'active')`,
    ),
    check("tenant_themes_version_check", sql`${table.version} > 0`),
    check(
      "tenant_themes_active_contrast_check",
      sql`${table.status} <> 'active' OR ${table.contrastCheckPassed}`,
    ),
    check(
      "tenant_themes_activated_at_check",
      sql`(${table.status} = 'draft') = (${table.activatedAt} IS NULL)`,
    ),
  ],
);

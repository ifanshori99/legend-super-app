// `brand_websites` (T, PRD v1.7 §3 F21 / §3.24 "Website Publik per Brand").
// One row per (tenant, brand): the staff-written content of the public site
// plus the featured outlet. `content` is validated by
// `brandWebsiteContentSchema` on write and on read. `published_at` null means
// the site is a draft and `GET /api/public/site` answers 404. Tenant RLS
// (ENABLE + FORCE) is installed in the RLS migration that follows the
// generated one.
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import type { UserId } from "@starter/shared/core";
import type { BrandWebsiteContent } from "@starter/shared/website";
import { tenantIdColumn } from "../columns.ts";
import { brands, outlets, tenants } from "./platform-org.ts";

export const brandWebsites = pgTable(
  "brand_websites",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    brandId: uuid("brand_id").notNull(),
    /** The outlet the site features (address, hours, reservations). */
    outletId: uuid("outlet_id").notNull(),
    content: jsonb("content").$type<BrandWebsiteContent>().notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    // Actor reference without a foreign key, like audit_logs.actor_id.
    updatedBy: text("updated_by").$type<UserId>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("brand_websites_tenant_brand_key").on(table.tenantId, table.brandId),
    foreignKey({
      name: "brand_websites_brand_fk",
      columns: [table.tenantId, table.brandId],
      foreignColumns: [brands.tenantId, brands.id],
    }),
    foreignKey({
      name: "brand_websites_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    check(
      "brand_websites_content_object_check",
      sql`jsonb_typeof(${table.content}) = 'object'`,
    ),
  ],
);

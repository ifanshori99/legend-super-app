// Platform & organisation tables (PRD v1.7 §6 A "Platform & Organisasi",
// TEN-06). Column names and status values follow the PRD; timestamps are
// TIMESTAMPTZ and every id is a UUID.
//
// (T) tables carry tenant_id NOT NULL and get enforced RLS in the
// `platform_org_rls` migration (`app.enforce_tenant_rls`). Their unique
// constraints always include tenant_id, and children reference their parent
// through (tenant_id, id) composite keys so a row can never point at another
// tenant's brand, legal entity or outlet.
//
// (global) tables are not tenant-owned: they get explicit GRANTs to
// legend_app in the same migration (least privilege, none by default).
//
// user_id columns are text: the current identity store is Better Auth's
// `user` table (text id, now UUID-valued, see lib/auth.ts). The Legend `users`
// table of PRD §6 B replaces it in the WS-01 identity bead; no FK is declared
// across that boundary yet.

import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type {
  FeatureFlags,
  Geofence,
  OpeningHours,
  TenantLimits,
  TenantStatus,
  DeploymentMode,
  OutletStatus,
} from "@starter/shared/platform";

/** `tenants` (global). Created from the platform panel, never by a deploy. */
export const tenants = pgTable(
  "tenants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    slug: varchar("slug", { length: 60 }).notNull().unique(),
    name: varchar("name", { length: 150 }).notNull(),
    plan: varchar("plan", { length: 30 }).notNull(),
    status: varchar("status", { length: 20 })
      .$type<TenantStatus>()
      .notNull()
      .default("active"),
    deploymentMode: varchar("deployment_mode", { length: 20 })
      .$type<DeploymentMode>()
      .notNull(),
    /** PRD §6 A `feature_flags`: `{ modules: [], integrationProviders: [] }`. */
    featureFlags: jsonb("feature_flags")
      .$type<FeatureFlags>()
      .notNull()
      .default({ modules: [], integrationProviders: [] }),
    /** PRD §6 A `limits`: quotas and monthly cost caps (A17, R18). */
    limits: jsonb("limits").$type<TenantLimits>().notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      "tenants_status_check",
      sql`${table.status} IN ('active', 'suspended', 'archived')`,
    ),
    check(
      "tenants_deployment_mode_check",
      sql`${table.deploymentMode} IN ('dedicated', 'shared')`,
    ),
    // Platform panel list: newest first, keyset on (created_at, id).
    index("tenants_created_id_idx").on(table.createdAt.desc(), table.id.desc()),
    index("tenants_status_idx").on(table.status),
  ],
);

/** `regions` (global): administrative regions for outlet addresses. */
export const regions = pgTable(
  "regions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    code: varchar("code", { length: 13 }).notNull().unique(),
    name: varchar("name", { length: 150 }).notNull(),
    type: varchar("type", { length: 20 }).notNull(),
    parentId: uuid("parent_id").references((): AnyPgColumn => regions.id),
  },
  (table) => [
    check(
      "regions_type_check",
      sql`${table.type} IN ('province', 'regency', 'city', 'district', 'village')`,
    ),
    check("regions_code_check", sql`${table.code} ~ '^[0-9.]{2,13}$'`),
  ],
);

/** `platform_admins` (global): the Super Admin and one break-glass account. */
export const platformAdmins = pgTable(
  "platform_admins",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    isBreakGlass: boolean("is_break_glass").notNull().default(false),
    grantedAt: timestamp("granted_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    // One live grant per user; a revoked row may be granted again.
    uniqueIndex("platform_admins_active_user_key")
      .on(table.userId)
      .where(sql`${table.revokedAt} IS NULL`),
    // PRD §3 F4: exactly one break-glass account, active at a time.
    uniqueIndex("platform_admins_break_glass_key")
      .on(table.isBreakGlass)
      .where(sql`${table.isBreakGlass} AND ${table.revokedAt} IS NULL`),
  ],
);

/** `brands` (T). The brand a tenant's outlets and themes belong to. */
export const brands = pgTable(
  "brands",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    slug: varchar("slug", { length: 60 }).notNull(),
    name: varchar("name", { length: 150 }).notNull(),
    logoMediaId: uuid("logo_media_id"),
    /** Active Tenant Theme; set when a draft is activated. */
    themeId: uuid("theme_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("brands_tenant_slug_key").on(table.tenantId, table.slug),
    // Parent key for children that must stay inside the same tenant.
    unique("brands_tenant_id_id_key").on(table.tenantId, table.id),
  ],
);

/** `legal_entities` (T): tax/responsibility entity per NPWP. */
export const legalEntities = pgTable(
  "legal_entities",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    name: varchar("name", { length: 150 }).notNull(),
    /** Sealed NPWP (AES-256-GCM, base64; lib/secrets.ts). Never read by DTOs:
     * the wire shape carries `npwpLast4` only. */
    npwpEncrypted: text("npwp_encrypted"),
    npwpLast4: varchar("npwp_last4", { length: 4 }),
    /** HMAC blind index over the normalized NPWP: uniqueness without plaintext. */
    npwpHash: varchar("npwp_hash", { length: 64 }),
    isPkp: boolean("is_pkp").notNull().default(false),
    address: text("address"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("legal_entities_tenant_id_id_key").on(table.tenantId, table.id),
    // One legal entity per NPWP inside a tenant; null NPWPs are not compared.
    uniqueIndex("legal_entities_tenant_npwp_key")
      .on(table.tenantId, table.npwpHash)
      .where(sql`${table.npwpHash} IS NOT NULL`),
    check(
      "legal_entities_npwp_last4_check",
      sql`${table.npwpLast4} IS NULL OR ${table.npwpLast4} ~ '^[0-9]{4}$'`,
    ),
    check(
      "legal_entities_npwp_pair_check",
      sql`(${table.npwpEncrypted} IS NULL) = (${table.npwpLast4} IS NULL)`,
    ),
  ],
);

/** `outlets` (T): a physical cafe. The outlet every operational row names. */
export const outlets = pgTable(
  "outlets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    brandId: uuid("brand_id").notNull(),
    legalEntityId: uuid("legal_entity_id").notNull(),
    code: varchar("code", { length: 20 }).notNull(),
    name: varchar("name", { length: 150 }).notNull(),
    address: text("address").notNull(),
    regionId: uuid("region_id").references(() => regions.id),
    geofence: jsonb("geofence").$type<Geofence>(),
    timezone: varchar("timezone", { length: 40 })
      .notNull()
      .default("Asia/Jakarta"),
    /** Owner Q39: business day starts here ("HH:mm", 00:00..11:59). */
    businessDayCutoff: varchar("business_day_cutoff", { length: 5 })
      .notNull()
      .default("04:00"),
    openingHours: jsonb("opening_hours").$type<OpeningHours>().notNull(),
    /** Active edge node (WS-02); the registry itself is a later bead. */
    edgeNodeId: uuid("edge_node_id"),
    status: varchar("status", { length: 20 })
      .$type<OutletStatus>()
      .notNull()
      .default("preopening"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("outlets_tenant_code_key").on(table.tenantId, table.code),
    unique("outlets_tenant_id_id_key").on(table.tenantId, table.id),
    // Composite keys keep an outlet inside its tenant's brand and entity.
    foreignKey({
      name: "outlets_brand_fk",
      columns: [table.tenantId, table.brandId],
      foreignColumns: [brands.tenantId, brands.id],
    }),
    foreignKey({
      name: "outlets_legal_entity_fk",
      columns: [table.tenantId, table.legalEntityId],
      foreignColumns: [legalEntities.tenantId, legalEntities.id],
    }),
    index("outlets_brand_idx").on(table.tenantId, table.brandId),
    index("outlets_status_idx").on(table.tenantId, table.status),
    check(
      "outlets_code_check",
      sql`${table.code} ~ '^[A-Z0-9][A-Z0-9-]{0,19}$'`,
    ),
    check(
      "outlets_business_day_cutoff_check",
      sql`${table.businessDayCutoff} ~ '^(0[0-9]|1[01]):[0-5][0-9]$'`,
    ),
    check(
      "outlets_status_check",
      sql`${table.status} IN ('preopening', 'active', 'closed')`,
    ),
  ],
);

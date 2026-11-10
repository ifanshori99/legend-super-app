// Tenant configuration export/import storage (PRD v1.7 TEN-09, bead legend-34c).
//
// - `config_templates` (G) is the platform's library of reusable configuration
//   bundles. Global like `platform_packages`: a template is not owned by one
//   tenant, so there is no RLS. `source_tenant_id` only records where it was
//   exported from (SET NULL if that tenant row ever goes away). `payload` is a
//   `configBundleSchema` document: keys only, never ids, secrets or PII. A new
//   version of the same name is a new row (unique name + version).
// - `config_imports` (T) is the per-tenant record of one import run, written
//   by the orchestrator: `applying` inside the import transaction, then
//   `applied`; a failed run rolls that transaction back and a separate
//   transaction records the `failed` row. Tenant RLS is installed in
//   platform-config-rls (migration).

import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { tenants } from "./platform-org.ts";

export type ConfigImportStatus =
  "validating" | "applying" | "applied" | "failed";

/** `config_templates` (global). */
export const configTemplates = pgTable(
  "config_templates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: varchar("name", { length: 120 }).notNull(),
    version: integer("version").notNull(),
    sourceTenantId: uuid("source_tenant_id").references(() => tenants.id, {
      onDelete: "set null",
    }),
    /** A `configBundleSchema` document (`@starter/shared/platform`). */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    /** Platform admin user id; plain text like other audit columns. */
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("config_templates_name_version_key").on(table.name, table.version),
    check("config_templates_version_check", sql`${table.version} >= 1`),
  ],
);

/** `config_imports` (T). One row per import attempt into a tenant. */
export const configImports = pgTable(
  "config_imports",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    /** Null for an uploaded bundle that is not a stored template. */
    templateId: uuid("template_id").references(() => configTemplates.id),
    status: varchar("status", { length: 20 })
      .$type<ConfigImportStatus>()
      .notNull(),
    /** Sections written, e.g. `["roles", "zones"]`. */
    appliedSections: jsonb("applied_sections")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    errors: jsonb("errors")
      .$type<unknown[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    warnings: jsonb("warnings")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Platform admin user id. */
    startedBy: text("started_by").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    unique("config_imports_tenant_id_key").on(table.tenantId, table.id),
    index("config_imports_tenant_started_idx").on(
      table.tenantId,
      table.startedAt,
    ),
    check(
      "config_imports_status_check",
      sql`${table.status} IN ('validating', 'applying', 'applied', 'failed')`,
    ),
  ],
);

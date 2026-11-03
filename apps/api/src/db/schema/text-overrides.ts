// `text_overrides` (T, PRD v1.7 §3 F4 "Teks & Kamus Istilah", §6 A). One row
// per (tenant, locale, catalog key); every change bumps `version` so the term
// editor and the audit log can tell edits apart. Clearing an override deletes
// the row (the contract never stores an empty string).

import { sql } from "drizzle-orm";
import {
  check,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { tenants } from "./platform-org.ts";

export const textOverrides = pgTable(
  "text_overrides",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    locale: varchar("locale", { length: 5 }).notNull(),
    /** Text catalog key, e.g. `terms.wfcZone`; validated against the catalog. */
    key: varchar("key", { length: 120 }).notNull(),
    value: varchar("value", { length: 500 }).notNull(),
    version: integer("version").notNull().default(1),
    updatedBy: text("updated_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("text_overrides_tenant_locale_key_key").on(
      table.tenantId,
      table.locale,
      table.key,
    ),
    check("text_overrides_locale_check", sql`${table.locale} IN ('id', 'en')`),
    check("text_overrides_version_check", sql`${table.version} > 0`),
    check("text_overrides_value_check", sql`length(btrim(${table.value})) > 0`),
  ],
);

// Menu bulk import + printable menu (bead legend-dmi; PRD v1.7 §3 F8 "Impor
// Massal" and "Menu Cetak Otomatis", §7 HTML -> PDF).
//
// Both tables are (T) tables owned by an outlet: tenant_id NOT NULL, unique
// constraints include tenant_id, composite FKs to outlets, and enforced tenant
// + outlet RLS installed in the migration (see the SQL the squad lead adds:
//   SELECT app.enforce_tenant_rls('public.menu_import_jobs'::regclass);
//   SELECT app.enforce_outlet_rls('public.menu_import_jobs'::regclass);
//   SELECT app.enforce_tenant_rls('public.printable_menu_renders'::regclass);
//   SELECT app.enforce_outlet_rls('public.printable_menu_renders'::regclass);
// ). Neither table is replicated to the edge, so there are no (E) flags.

import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
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
import { outlets, tenants } from "./platform-org.ts";

const createdAt = timestamp("created_at", { withTimezone: true })
  .notNull()
  .defaultNow();
const updatedAt = timestamp("updated_at", { withTimezone: true })
  .notNull()
  .defaultNow();
const tenantId = uuid("tenant_id")
  .notNull()
  .references(() => tenants.id);

/**
 * `menu_import_jobs` (T): one row per committed import. The idempotency key is
 * unique per tenant and bound to a request fingerprint (file hash + options),
 * so a retry replays the stored result and a reused key with another file is a
 * conflict. No row data is stored, only counts.
 */
export const menuImportJobs = pgTable(
  "menu_import_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId,
    outletId: uuid("outlet_id").notNull(),
    brandId: uuid("brand_id").notNull(),
    actorUserId: varchar("actor_user_id", { length: 64 }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 100 }).notNull(),
    /** sha256 of the uploaded bytes. */
    fileHash: varchar("file_hash", { length: 64 }).notNull(),
    /** sha256 of file hash + brand + outlet + options. */
    requestFingerprint: varchar("request_fingerprint", {
      length: 64,
    }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("committed"),
    rowCount: integer("row_count").notNull(),
    /** Counts only (created / updated items, created categories, prices). */
    result: jsonb("result").$type<Record<string, number | string>>().notNull(),
    createdAt,
  },
  (table) => [
    unique("menu_import_jobs_tenant_id_id_key").on(table.tenantId, table.id),
    unique("menu_import_jobs_tenant_idempotency_key").on(
      table.tenantId,
      table.idempotencyKey,
    ),
    foreignKey({
      name: "menu_import_jobs_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    index("menu_import_jobs_outlet_idx").on(
      table.tenantId,
      table.outletId,
      table.createdAt,
    ),
    check(
      "menu_import_jobs_status_check",
      sql`${table.status} IN ('committed')`,
    ),
    check("menu_import_jobs_row_count_check", sql`${table.rowCount} >= 0`),
  ],
);

/**
 * `printable_menu_renders` (T): the latest printable menu PDF of one outlet and
 * its debounce state. `dirty_since` is set by the outbox consumer when a price
 * or availability change arrives; `refresh_after` is the trailing-debounce
 * deadline; the sweep job renders once per due outlet and clears the flag.
 */
export const printableMenuRenders = pgTable(
  "printable_menu_renders",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId,
    outletId: uuid("outlet_id").notNull(),
    /** core_storage_objects id of the latest PDF (purpose `document`). */
    objectId: uuid("object_id"),
    /** sha256 of the printable payload; an unchanged payload is not re-stored. */
    contentHash: varchar("content_hash", { length: 64 }),
    itemCount: integer("item_count").notNull().default(0),
    generatedAt: timestamp("generated_at", { withTimezone: true }),
    dirtySince: timestamp("dirty_since", { withTimezone: true }),
    refreshAfter: timestamp("refresh_after", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    /** Generic failure marker only; never provider detail or PII. */
    lastError: text("last_error"),
    createdAt,
    updatedAt,
  },
  (table) => [
    unique("printable_menu_renders_tenant_id_id_key").on(
      table.tenantId,
      table.id,
    ),
    unique("printable_menu_renders_tenant_outlet_key").on(
      table.tenantId,
      table.outletId,
    ),
    foreignKey({
      name: "printable_menu_renders_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    index("printable_menu_renders_due_idx").on(
      table.tenantId,
      table.refreshAfter,
    ),
    check(
      "printable_menu_renders_item_count_check",
      sql`${table.itemCount} >= 0`,
    ),
  ],
);

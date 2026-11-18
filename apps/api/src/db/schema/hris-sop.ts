// HRIS SOP library (PRD v1.7 §3 F32 "SOP, Pelatihan & Pengumuman"; bead
// legend-7df1). Contract: `@starter/shared/hris` (performance.ts
// `sopDocumentSchema`, `sopAcknowledgementSchema`).
//
// - Every SOP version is its own immutable row: a new version inserts a row
//   with `supersedes_id` pointing at the previous one; nothing is updated or
//   deleted (hris-sop.custom.sql revokes UPDATE/DELETE from `legend_app` and a
//   trigger rejects UPDATE for every role).
// - `lineage_id` is the id of version 1 and groups all versions of one SOP.
//   The partial unique index on `(tenant_id, supersedes_id)` lets only one
//   successor exist, so concurrent publishes collide instead of forking.
// - Tenant master data (no `outlet_id`): outlet reach is enforced by the
//   service through the station outlet / employee home outlet, like
//   `employees` (hris.ts).
// - `body` text + `metadata` jsonb only: the AI knowledge base reads this table
//   later; no embedding columns here.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { UserId } from "@starter/shared/core";
import { businessDate, tenantIdColumn } from "../columns.ts";
import { coreStorageObjects } from "./core-storage.ts";
import { employees, positions } from "./hris.ts";
import { stations } from "./menu.ts";
import { tenants } from "./platform-org.ts";
import { user } from "./user.ts";

const createdAt = timestamp("created_at", { withTimezone: true })
  .notNull()
  .defaultNow();

/** PRD F32 SOP document version (T): one immutable row per version. */
export const sopDocuments = pgTable(
  "sop_documents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    /** Id of version 1; groups every version of one SOP. */
    lineageId: uuid("lineage_id").notNull(),
    version: integer("version").notNull(),
    supersedesId: uuid("supersedes_id"),
    stationId: uuid("station_id"),
    positionId: uuid("position_id"),
    title: varchar("title", { length: 200 }).notNull(),
    body: text("body").notNull(),
    /** `core_storage_objects` ids (images / video); checked by the service. */
    mediaIds: uuid("media_ids")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    requiresAcknowledgement: boolean("requires_acknowledgement").notNull(),
    effectiveFrom: businessDate("effective_from").notNull(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    publishedBy: text("published_by")
      .$type<UserId>()
      .notNull()
      .references(() => user.id),
    publishedAt: timestamp("published_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt,
  },
  (table) => [
    unique("sop_documents_tenant_id_id_key").on(table.tenantId, table.id),
    unique("sop_documents_tenant_id_id_version_key").on(
      table.tenantId,
      table.id,
      table.version,
    ),
    unique("sop_documents_tenant_lineage_version_key").on(
      table.tenantId,
      table.lineageId,
      table.version,
    ),
    uniqueIndex("sop_documents_tenant_supersedes_key")
      .on(table.tenantId, table.supersedesId)
      .where(sql`${table.supersedesId} IS NOT NULL`),
    foreignKey({
      name: "sop_documents_supersedes_fk",
      columns: [table.tenantId, table.supersedesId],
      foreignColumns: [table.tenantId, table.id],
    }),
    foreignKey({
      name: "sop_documents_station_fk",
      columns: [table.tenantId, table.stationId],
      foreignColumns: [stations.tenantId, stations.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "sop_documents_position_fk",
      columns: [table.tenantId, table.positionId],
      foreignColumns: [positions.tenantId, positions.id],
    }).onDelete("restrict"),
    index("sop_documents_tenant_station_idx").on(
      table.tenantId,
      table.stationId,
    ),
    index("sop_documents_tenant_position_idx").on(
      table.tenantId,
      table.positionId,
    ),
    check("sop_documents_version_check", sql`${table.version} > 0`),
    check(
      "sop_documents_lineage_check",
      sql`(${table.version} = 1 AND ${table.supersedesId} IS NULL AND ${table.lineageId} = ${table.id}) OR (${table.version} > 1 AND ${table.supersedesId} IS NOT NULL)`,
    ),
  ],
);

/**
 * Media of one SOP version (legend-m7yeb): one immutable row per (version,
 * media object), written with the version. `sop_documents.media_ids` stays the
 * list the API returns; this table is the foreign-keyed binding to
 * `core_storage_objects`. `legacy` marks an object that predates the
 * `sop_document` source kind (no source kind of its own): it is carried to a
 * new version as it is and is never relinked. Versions published before this
 * table have no rows here and keep reading `media_ids`.
 */
export const sopDocumentMedia = pgTable(
  "sop_document_media",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    sopDocumentId: uuid("sop_document_id").notNull(),
    mediaId: uuid("media_id").notNull(),
    sortOrder: integer("sort_order").notNull(),
    legacy: boolean("legacy").notNull().default(false),
    createdAt,
  },
  (table) => [
    primaryKey({
      name: "sop_document_media_pk",
      columns: [table.tenantId, table.sopDocumentId, table.mediaId],
    }),
    foreignKey({
      name: "sop_document_media_document_fk",
      columns: [table.tenantId, table.sopDocumentId],
      foreignColumns: [sopDocuments.tenantId, sopDocuments.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "sop_document_media_object_fk",
      columns: [table.tenantId, table.mediaId],
      foreignColumns: [coreStorageObjects.tenantId, coreStorageObjects.id],
    }).onDelete("restrict"),
    index("sop_document_media_tenant_media_idx").on(
      table.tenantId,
      table.mediaId,
    ),
    check("sop_document_media_sort_check", sql`${table.sortOrder} >= 0`),
  ],
);

/** PRD F32 acknowledgement (T): bound to the document version that was read. */
export const sopAcknowledgements = pgTable(
  "sop_acknowledgements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    sopDocumentId: uuid("sop_document_id").notNull(),
    documentVersion: integer("document_version").notNull(),
    employeeId: uuid("employee_id").notNull(),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    idempotencyKey: varchar("idempotency_key", { length: 100 }).notNull(),
    createdAt,
  },
  (table) => [
    unique("sop_acknowledgements_tenant_doc_employee_key").on(
      table.tenantId,
      table.sopDocumentId,
      table.employeeId,
    ),
    foreignKey({
      name: "sop_acknowledgements_document_fk",
      columns: [table.tenantId, table.sopDocumentId, table.documentVersion],
      foreignColumns: [
        sopDocuments.tenantId,
        sopDocuments.id,
        sopDocuments.version,
      ],
    }),
    foreignKey({
      name: "sop_acknowledgements_employee_fk",
      columns: [table.tenantId, table.employeeId],
      foreignColumns: [employees.tenantId, employees.id],
    }),
    index("sop_acknowledgements_tenant_employee_idx").on(
      table.tenantId,
      table.employeeId,
    ),
  ],
);

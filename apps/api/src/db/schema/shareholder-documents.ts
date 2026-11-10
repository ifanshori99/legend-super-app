// Shareholder documents (PRD §3.35 Dokumen, §6 I `shareholder_documents`,
// SH-01; bead legend-69yq).
//
// Contract: `@starter/shared/accounting` (`shareholderDocumentSchema`,
// `shareholderDocumentFileSchema`). Both tables are (T): tenant_id NOT NULL
// with app.enforce_tenant_rls (drizzle/0069_shareholder_documents_rls.sql).
//
// `profit_entity_id` has a composite (tenant_id, profit_entity_id) foreign key
// to profit_entities(tenant_id, id) on both tables; legend-2ljb added it in
// drizzle/0219_profit_share.sql.
//
// A document's (tenant, entity, file key) must match an uploaded file row, so
// a document can only point at a file uploaded for the same entity.
//
// - `shareholder_document_files`: PDFs uploaded by management, not yet (or
//   already) attached to a document. The key is server-chosen.
// - `shareholder_documents`: one file is one document (UNIQUE tenant, file).
//   Publish is one way: once `published_at` is set a trigger blocks every
//   change and every delete.

import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { profitEntities } from "./accounting-profit-share.ts";
import { tenants } from "./platform-org.ts";

/** `shareholder_document_files` (T): an uploaded PDF awaiting attachment. */
export const shareholderDocumentFiles = pgTable(
  "shareholder_document_files",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    id: uuid("id").notNull().defaultRandom(),
    profitEntityId: uuid("profit_entity_id").notNull(),
    fileKey: text("file_key").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    uploadedBy: text("uploaded_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    foreignKey({
      name: "shareholder_document_files_profit_entity_fk",
      columns: [table.tenantId, table.profitEntityId],
      foreignColumns: [profitEntities.tenantId, profitEntities.id],
    }),
    unique("shareholder_document_files_tenant_file_key").on(
      table.tenantId,
      table.fileKey,
    ),
    unique("shareholder_document_files_tenant_entity_file_key").on(
      table.tenantId,
      table.profitEntityId,
      table.fileKey,
    ),
    check(
      "shareholder_document_files_content_type_check",
      sql`${table.contentType} = 'application/pdf'`,
    ),
    check("shareholder_document_files_size_check", sql`${table.sizeBytes} > 0`),
  ],
);

/** `shareholder_documents` (T): a report or minutes shown to shareholders. */
export const shareholderDocuments = pgTable(
  "shareholder_documents",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    id: uuid("id").notNull().defaultRandom(),
    profitEntityId: uuid("profit_entity_id").notNull(),
    kind: text("kind")
      .$type<"monthly_report" | "general_meeting_minutes" | "other">()
      .notNull(),
    title: text("title").notNull(),
    fileKey: text("file_key").notNull(),
    visibility: text("visibility")
      .$type<"shareholders" | "management">()
      .notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    publishedBy: text("published_by"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    foreignKey({
      name: "shareholder_documents_profit_entity_fk",
      columns: [table.tenantId, table.profitEntityId],
      foreignColumns: [profitEntities.tenantId, profitEntities.id],
    }),
    unique("shareholder_documents_tenant_file_key").on(
      table.tenantId,
      table.fileKey,
    ),
    foreignKey({
      name: "shareholder_documents_file_fk",
      columns: [table.tenantId, table.profitEntityId, table.fileKey],
      foreignColumns: [
        shareholderDocumentFiles.tenantId,
        shareholderDocumentFiles.profitEntityId,
        shareholderDocumentFiles.fileKey,
      ],
    }),
    index("shareholder_documents_entity_created_idx").on(
      table.tenantId,
      table.profitEntityId,
      table.createdAt.desc(),
      table.id,
    ),
    check(
      "shareholder_documents_kind_check",
      sql`${table.kind} IN ('monthly_report', 'general_meeting_minutes', 'other')`,
    ),
    check(
      "shareholder_documents_visibility_check",
      sql`${table.visibility} IN ('shareholders', 'management')`,
    ),
    check(
      "shareholder_documents_published_check",
      sql`(${table.publishedAt} IS NULL) = (${table.publishedBy} IS NULL)`,
    ),
  ],
);

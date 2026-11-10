// Tax reports (bead legend-gmww, WS-07; PRD v1.7 §3.19 "Pajak [P0]"; §6 F
// `tax_reports`). Persists the `taxReportSchema` contract in
// packages/shared/src/accounting/tax.ts: one row per generated recap with its
// lines, the finalize stamps and the export stamps.
//
// - `lines` is a jsonb array of `taxReportLineSchema`. A line is only ever
//   read and written with its report (never queried alone), so a child table
//   would add joins without adding a rule.
// - The status and stamp checks mirror the contract's `superRefine`: a draft
//   carries no stamps, a final report carries finalized_by/at, an exported one
//   also carries export_format, file_key and exported_at.
// - Sum of line tax = amount_idr is checked by the service (a jsonb sum in a
//   CHECK would not be indexable and the contract already enforces it).
// - At most one draft per (entity, type, period): regenerate overwrites it.
//   Final and exported reports of the same period may sit beside a newer
//   draft after a reopen.
//
// RLS lives in accounting-tax.custom.sql (shipped in 0235).

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
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { TaxReportLine } from "@starter/shared/accounting";
import { idrColumn } from "../columns";
import { legalEntities, tenants } from "./platform-org";

export const taxReports = pgTable(
  "tax_reports",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    legalEntityId: uuid("legal_entity_id").notNull(),
    type: varchar("type", { length: 10 }).notNull(),
    /** Calendar month `YYYY-MM`, same key as `fiscal_periods.period`. */
    period: varchar("period", { length: 7 }).notNull(),
    amountIdr: idrColumn("amount_idr").notNull(),
    lines: jsonb("lines").$type<TaxReportLine[]>().notNull().default([]),
    status: varchar("status", { length: 10 }).notNull().default("draft"),
    exportFormat: varchar("export_format", { length: 20 }),
    /** Object storage key of the export file (tenant-prefixed). */
    fileKey: varchar("file_key", { length: 500 }),
    generatedBy: text("generated_by").notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finalizedBy: text("finalized_by"),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    exportedAt: timestamp("exported_at", { withTimezone: true }),
    /** +1 on every regenerate, finalize and export (optimistic concurrency). */
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("tax_reports_tenant_id_key").on(t.tenantId, t.id),
    foreignKey({
      name: "tax_reports_legal_entity_fk",
      columns: [t.tenantId, t.legalEntityId],
      foreignColumns: [legalEntities.tenantId, legalEntities.id],
    }),
    uniqueIndex("tax_reports_draft_key")
      .on(t.tenantId, t.legalEntityId, t.type, t.period)
      .where(sql`${t.status} = 'draft'`),
    index("tax_reports_period_idx").on(
      t.tenantId,
      t.legalEntityId,
      t.period,
      t.type,
    ),
    check(
      "tax_reports_type_check",
      sql`${t.type} IN ('pbjt','pph21','pph23','ppn')`,
    ),
    check(
      "tax_reports_period_check",
      sql`${t.period} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`,
    ),
    check("tax_reports_amount_check", sql`${t.amountIdr} >= 0`),
    check("tax_reports_lines_check", sql`jsonb_typeof(${t.lines}) = 'array'`),
    check(
      "tax_reports_status_check",
      sql`${t.status} IN ('draft','final','exported')`,
    ),
    check(
      "tax_reports_export_format_check",
      sql`${t.exportFormat} IS NULL OR ${t.exportFormat} = 'coretax_xml'`,
    ),
    check("tax_reports_file_key_check", sql`char_length(${t.fileKey}) >= 1`),
    // Finalize stamps come as a pair and are set exactly once final.
    check(
      "tax_reports_finalized_check",
      sql`(${t.finalizedBy} IS NULL) = (${t.finalizedAt} IS NULL) AND (${t.status} <> 'draft') = (${t.finalizedBy} IS NOT NULL)`,
    ),
    // Export stamps are set exactly when exported.
    check(
      "tax_reports_exported_check",
      sql`(${t.status} = 'exported') = (${t.exportFormat} IS NOT NULL AND ${t.fileKey} IS NOT NULL AND ${t.exportedAt} IS NOT NULL) AND (${t.exportFormat} IS NULL) = (${t.fileKey} IS NULL) AND (${t.fileKey} IS NULL) = (${t.exportedAt} IS NULL)`,
    ),
    check("tax_reports_version_check", sql`${t.version} >= 1`),
  ],
);

export type TaxReportRow = typeof taxReports.$inferSelect;

// EDC settlement CSV per bank (X2 legend-wasr7.11, cloud-only release §3).
// Finance uploads the bank's settlement export; each line is matched to an
// EDC sale by terminal + RRN + amount. The import never changes an amount or
// a payment status: a matching line only clears the "perlu dicek" flag of a
// sale already approved and booked (through resolveEdcReconciliation), and a
// difference raises the X1 mismatch alert. Append-only for the app role.
//
// Idempotent per file (sha256 of bank and text, per outlet) and per line (a
// line key of bank, kind, terminal, RRN and amount, per outlet): a re-export
// that repeats matched or mismatched lines records only its new lines; an
// unmatched line is looked at again.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { idrColumn, outletIdColumn, tenantIdColumn } from "../columns.ts";
import { outlets, tenants } from "./platform-org.ts";

export type EdcSettlementRowStatus = "matched" | "mismatch" | "unmatched";

export const edcSettlementFiles = pgTable(
  "edc_settlement_files",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    bank: varchar("bank", { length: 20 }).notNull(),
    fileName: varchar("file_name", { length: 200 }).notNull(),
    fileHash: varchar("file_hash", { length: 64 }).notNull(),
    rowCount: integer("row_count").notNull(),
    matchedCount: integer("matched_count").notNull(),
    clearedCount: integer("cleared_count").notNull(),
    mismatchCount: integer("mismatch_count").notNull(),
    unmatchedCount: integer("unmatched_count").notNull(),
    duplicateCount: integer("duplicate_count").notNull(),
    importedBy: text("imported_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    unique("edc_settlement_files_tenant_id_key").on(t.tenantId, t.id),
    unique("edc_settlement_files_tenant_id_outlet_key").on(
      t.tenantId,
      t.id,
      t.outletId,
    ),
    // One file once per outlet: the same bytes again is a replay.
    unique("edc_settlement_files_hash_key").on(
      t.tenantId,
      t.outletId,
      t.fileHash,
    ),
    foreignKey({
      name: "edc_settlement_files_outlet_fk",
      columns: [t.tenantId, t.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    check(
      "edc_settlement_files_bank_check",
      sql`${t.bank} IN ('bca','mandiri','bni','bjb')`,
    ),
    check(
      "edc_settlement_files_count_check",
      sql`${t.rowCount} >= 0 AND ${t.matchedCount} >= 0 AND ${t.clearedCount} >= 0 AND ${t.clearedCount} <= ${t.matchedCount} AND ${t.mismatchCount} >= 0 AND ${t.unmatchedCount} >= 0 AND ${t.duplicateCount} >= 0 AND ${t.matchedCount} + ${t.mismatchCount} + ${t.unmatchedCount} + ${t.duplicateCount} = ${t.rowCount}`,
    ),
  ],
);

export const edcSettlementRows = pgTable(
  "edc_settlement_rows",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    fileId: uuid("file_id").notNull(),
    lineNo: integer("line_no").notNull(),
    /** sha256 of bank, terminal code, RRN and amount (normalised). */
    rowKey: varchar("row_key", { length: 64 }).notNull(),
    bank: varchar("bank", { length: 20 }).notNull(),
    terminalCode: varchar("terminal_code", { length: 32 }).notNull(),
    /** The outlet's registered terminal the code names; null when none. */
    terminalId: uuid("terminal_id"),
    rrn: varchar("rrn", { length: 24 }).notNull(),
    approvalCode: varchar("approval_code", { length: 12 }),
    batchNo: varchar("batch_no", { length: 20 }),
    amountIdr: idrColumn("amount_idr").notNull(),
    matchStatus: varchar("match_status", { length: 20 })
      .$type<EdcSettlementRowStatus>()
      .notNull(),
    matchedEdcTransactionId: uuid("matched_edc_transaction_id"),
    /** True when this line cleared the sale's reconciliation flag. */
    clearedFlag: boolean("cleared_flag").notNull().default(false),
    reason: varchar("reason", { length: 300 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    unique("edc_settlement_rows_tenant_id_key").on(t.tenantId, t.id),
    // One bank line once per outlet, whichever file carried it. An unmatched
    // line may come again (the sale was keyed later) and is matched then.
    uniqueIndex("edc_settlement_rows_row_key")
      .on(t.tenantId, t.outletId, t.rowKey)
      .where(sql`${t.matchStatus} <> 'unmatched'`),
    // One sale is confirmed by one bank line.
    uniqueIndex("edc_settlement_rows_matched_txn_key")
      .on(t.tenantId, t.matchedEdcTransactionId)
      .where(sql`${t.matchStatus} = 'matched'`),
    index("edc_settlement_rows_txn_idx").on(
      t.tenantId,
      t.matchedEdcTransactionId,
    ),
    foreignKey({
      name: "edc_settlement_rows_file_fk",
      columns: [t.tenantId, t.fileId, t.outletId],
      foreignColumns: [
        edcSettlementFiles.tenantId,
        edcSettlementFiles.id,
        edcSettlementFiles.outletId,
      ],
    }),
    foreignKey({
      name: "edc_settlement_rows_outlet_fk",
      columns: [t.tenantId, t.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    check(
      "edc_settlement_rows_status_check",
      sql`${t.matchStatus} IN ('matched','mismatch','unmatched')`,
    ),
    check("edc_settlement_rows_amount_check", sql`${t.amountIdr} > 0`),
    check(
      "edc_settlement_rows_link_check",
      sql`(${t.matchStatus} = 'matched') <= (${t.matchedEdcTransactionId} IS NOT NULL) AND (${t.matchStatus} = 'unmatched') <= (${t.matchedEdcTransactionId} IS NULL)`,
    ),
    check(
      "edc_settlement_rows_cleared_check",
      sql`NOT ${t.clearedFlag} OR ${t.matchStatus} = 'matched'`,
    ),
  ],
);

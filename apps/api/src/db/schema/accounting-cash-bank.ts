// Cash & bank (bead legend-fnxl, WS-07; PRD v1.7 §3.19 "Kas & Bank [P0]";
// §6 F `bank_accounts`, `bank_statement_lines`, `cash_deposits`,
// `reconciliation_cases`; ACC-04, ACC-05). Wire shapes:
// `@starter/shared/accounting` banking.ts. Design: docs/DECISIONS.md
// "WS-07 cash & bank reconciliation".
//
// - `bank_accounts`: the account number is sealed (lib/secrets.ts AES-GCM,
//   AAD bound to tenant + row + field + key version), indexed by a
//   tenant-separated HMAC for uniqueness, and only its last 4 digits are kept
//   in clear for the mask. `csv_mapping` is the last CSV mapping used (tenant
//   data, saved per account).
// - `bank_statement_lines`: UNIQUE (tenant, bank account, dedupe_key), so a
//   re-uploaded file adds nothing. The line points at its import through
//   (tenant, bank account, import) so it cannot hang under another account.
// - `bank_statement_line_matches`: one row per matched document. UNIQUE
//   (tenant, ref_type, ref_id) makes "a document matches at most one line" a
//   database rule, not a convention; unmatch deletes the rows.
// - `cash_deposits`: outlet-owned (outlet RLS). The bank account must belong to
//   the same legal entity (composite FK).
// - Cash collections are not stored: they come from closed `pos_shifts`.
// - `bank_reconciliation_cases` + `bank_reconciliation_case_events`: every
//   difference becomes a case with a PIC; every action is one append-only
//   event row (the app role cannot UPDATE or DELETE events).
//
// RLS lives in accounting-cash-bank.custom.sql (shipped in 0191).

import { sql } from "drizzle-orm";
import {
  boolean,
  char,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type {
  BankCsvMapping,
  ReconciliationRef,
} from "@starter/shared/accounting";
import type { OutletId } from "@starter/shared/core";
import {
  businessDate,
  idrColumn,
  outletIdColumn,
  tenantIdColumn,
} from "../columns.ts";
import { chartOfAccounts, journalEntries } from "./accounting.ts";
import { legalEntities, outlets, tenants } from "./platform-org.ts";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

const HMAC_FORMAT = "'^[a-f0-9]{64}$'";
const SHA256_FORMAT = "'^[a-f0-9]{64}$'";

export const MATCH_STATUS_SQL =
  "'unmatched','auto_matched','manually_matched','in_case','excluded'";
export const MATCH_REF_TYPE_SQL =
  "'journal_entry','cash_deposit','gateway_settlement','edc_settlement','supplier_payment','bank_statement_line'";

// ------------------------------------------------------------ bank accounts

export const bankAccounts = pgTable(
  "bank_accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    legalEntityId: uuid("legal_entity_id").notNull(),
    bank: varchar("bank", { length: 50 }).notNull(),
    accountName: varchar("account_name", { length: 150 }).notNull(),
    accountNumberEncrypted: bytea("account_number_encrypted").notNull(),
    accountNumberHmac: varchar("account_number_hmac", { length: 64 }).notNull(),
    /** Blind-index key version of `accountNumberHmac` (lib/blind-index.ts,
     * legend-baxdx). Rows before 0267 are version 1. */
    accountNumberHmacVersion: smallint("account_number_hmac_version")
      .notNull()
      .default(1),
    accountNumberLast4: char("account_number_last4", { length: 4 }).notNull(),
    accountNumberKeyVersion: integer("account_number_key_version").notNull(),
    glAccountId: uuid("gl_account_id").notNull(),
    csvMapping: jsonb("csv_mapping").$type<BankCsvMapping>(),
    isActive: boolean("is_active").notNull().default(true),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("bank_accounts_tenant_id_key").on(t.tenantId, t.id),
    unique("bank_accounts_tenant_entity_id_key").on(
      t.tenantId,
      t.legalEntityId,
      t.id,
    ),
    unique("bank_accounts_number_key").on(
      t.tenantId,
      t.legalEntityId,
      t.accountNumberHmac,
    ),
    foreignKey({
      name: "bank_accounts_legal_entity_fk",
      columns: [t.tenantId, t.legalEntityId],
      foreignColumns: [legalEntities.tenantId, legalEntities.id],
    }),
    // Same-entity CoA account: (tenant, entity, id) is unique on the CoA.
    foreignKey({
      name: "bank_accounts_gl_account_fk",
      columns: [t.tenantId, t.legalEntityId, t.glAccountId],
      foreignColumns: [
        chartOfAccounts.tenantId,
        chartOfAccounts.legalEntityId,
        chartOfAccounts.id,
      ],
    }),
    check(
      "bank_accounts_last4_check",
      sql`${t.accountNumberLast4} ~ '^[0-9]{4}$'`,
    ),
    check(
      "bank_accounts_hmac_check",
      sql`${t.accountNumberHmac} ~ ${sql.raw(HMAC_FORMAT)}`,
    ),
    check(
      "bank_accounts_account_number_hmac_version_check",
      sql`${t.accountNumberHmacVersion} IN (1, 2)`,
    ),
    check(
      "bank_accounts_key_version_check",
      sql`${t.accountNumberKeyVersion} >= 1`,
    ),
    check(
      "bank_accounts_text_check",
      sql`char_length(btrim(${t.bank})) >= 2 AND char_length(btrim(${t.accountName})) >= 1`,
    ),
  ],
);

// -------------------------------------------------------- statement imports

export const bankStatementImports = pgTable(
  "bank_statement_imports",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    bankAccountId: uuid("bank_account_id").notNull(),
    fileName: varchar("file_name", { length: 150 }).notNull(),
    fileSha256: varchar("file_sha256", { length: 64 }).notNull(),
    importedBy: text("imported_by").notNull(),
    importedAt: timestamp("imported_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lineCount: integer("line_count").notNull(),
    duplicateCount: integer("duplicate_count").notNull(),
    autoMatchedCount: integer("auto_matched_count").notNull(),
    postedFrom: businessDate("posted_from"),
    postedTo: businessDate("posted_to"),
  },
  (t) => [
    unique("bank_statement_imports_tenant_id_key").on(t.tenantId, t.id),
    unique("bank_statement_imports_account_id_key").on(
      t.tenantId,
      t.bankAccountId,
      t.id,
    ),
    foreignKey({
      name: "bank_statement_imports_account_fk",
      columns: [t.tenantId, t.bankAccountId],
      foreignColumns: [bankAccounts.tenantId, bankAccounts.id],
    }),
    index("bank_statement_imports_account_idx").on(
      t.tenantId,
      t.bankAccountId,
      t.importedAt,
    ),
    check(
      "bank_statement_imports_counts_check",
      sql`${t.lineCount} >= 0 AND ${t.duplicateCount} >= 0 AND ${t.autoMatchedCount} >= 0 AND ${t.autoMatchedCount} <= ${t.lineCount}`,
    ),
    check(
      "bank_statement_imports_range_check",
      sql`(${t.postedFrom} IS NULL) = (${t.postedTo} IS NULL) AND (${t.postedFrom} IS NULL OR ${t.postedFrom} <= ${t.postedTo})`,
    ),
    check(
      "bank_statement_imports_sha_check",
      sql`${t.fileSha256} ~ ${sql.raw(SHA256_FORMAT)}`,
    ),
  ],
);

// ------------------------------------------------------ reconciliation cases

export const bankReconciliationCases = pgTable(
  "bank_reconciliation_cases",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    legalEntityId: uuid("legal_entity_id").notNull(),
    /** Null = entity-level case (service enforces outlet reach). */
    outletId: uuid("outlet_id").$type<OutletId>(),
    type: varchar("type", { length: 30 }).notNull(),
    differenceIdr: idrColumn("difference_idr").notNull(),
    ownerId: text("owner_id").notNull(),
    status: varchar("status", { length: 20 }).notNull().default("open"),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    refs: jsonb("refs").$type<ReconciliationRef[]>().notNull(),
    openedBy: text("opened_by").notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    resolvedBy: text("resolved_by"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolutionNote: varchar("resolution_note", { length: 500 }),
    adjustmentJournalEntryId: uuid("adjustment_journal_entry_id"),
    version: integer("version").notNull().default(1),
    idempotencyKey: varchar("idempotency_key", { length: 100 }),
  },
  (t) => [
    unique("bank_reconciliation_cases_tenant_id_key").on(t.tenantId, t.id),
    foreignKey({
      name: "bank_reconciliation_cases_legal_entity_fk",
      columns: [t.tenantId, t.legalEntityId],
      foreignColumns: [legalEntities.tenantId, legalEntities.id],
    }),
    foreignKey({
      name: "bank_reconciliation_cases_outlet_fk",
      columns: [t.tenantId, t.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "bank_reconciliation_cases_adjustment_fk",
      columns: [t.tenantId, t.adjustmentJournalEntryId],
      foreignColumns: [journalEntries.tenantId, journalEntries.id],
    }),
    // One adjustment journal books one case's write-off.
    uniqueIndex("bank_reconciliation_cases_adjustment_key")
      .on(t.tenantId, t.adjustmentJournalEntryId)
      .where(sql`${t.adjustmentJournalEntryId} IS NOT NULL`),
    index("bank_reconciliation_cases_status_idx").on(
      t.tenantId,
      t.legalEntityId,
      t.status,
      t.openedAt,
    ),
    check(
      "bank_reconciliation_cases_type_check",
      sql`${t.type} IN ('bank_statement','gateway_settlement','edc_settlement','cash_deposit')`,
    ),
    check(
      "bank_reconciliation_cases_status_check",
      sql`${t.status} IN ('open','in_progress','resolved','written_off')`,
    ),
    check(
      "bank_reconciliation_cases_difference_check",
      sql`${t.differenceIdr} <> 0`,
    ),
    check(
      "bank_reconciliation_cases_refs_check",
      sql`jsonb_typeof(${t.refs}) = 'array' AND jsonb_array_length(${t.refs}) BETWEEN 1 AND 50`,
    ),
    check(
      "bank_reconciliation_cases_resolution_check",
      sql`(${t.status} IN ('resolved','written_off')) = (${t.resolvedBy} IS NOT NULL AND ${t.resolvedAt} IS NOT NULL AND ${t.resolutionNote} IS NOT NULL)`,
    ),
    check(
      "bank_reconciliation_cases_write_off_check",
      sql`(${t.status} = 'written_off') = (${t.adjustmentJournalEntryId} IS NOT NULL)`,
    ),
    check("bank_reconciliation_cases_version_check", sql`${t.version} >= 1`),
  ],
);

/** Append-only action log: one row per open/start/reassign/resolve/write_off. */
export const bankReconciliationCaseEvents = pgTable(
  "bank_reconciliation_case_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    caseId: uuid("case_id").notNull(),
    seq: integer("seq").notNull(),
    action: varchar("action", { length: 20 }).notNull(),
    actorId: text("actor_id").notNull(),
    fromStatus: varchar("from_status", { length: 20 }),
    toStatus: varchar("to_status", { length: 20 }).notNull(),
    fromOwnerId: text("from_owner_id"),
    toOwnerId: text("to_owner_id").notNull(),
    note: varchar("note", { length: 500 }),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("bank_reconciliation_case_events_seq_key").on(
      t.tenantId,
      t.caseId,
      t.seq,
    ),
    foreignKey({
      name: "bank_reconciliation_case_events_case_fk",
      columns: [t.tenantId, t.caseId],
      foreignColumns: [
        bankReconciliationCases.tenantId,
        bankReconciliationCases.id,
      ],
    }),
    check(
      "bank_reconciliation_case_events_action_check",
      sql`${t.action} IN ('open','start','reassign','resolve','write_off')`,
    ),
    check(
      "bank_reconciliation_case_events_seq_check",
      sql`${t.seq} >= 1 AND ((${t.action} = 'open') = (${t.seq} = 1)) AND ((${t.action} = 'open') = (${t.fromStatus} IS NULL))`,
    ),
  ],
);

// ---------------------------------------------------------- statement lines

export const bankStatementLines = pgTable(
  "bank_statement_lines",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    bankAccountId: uuid("bank_account_id").notNull(),
    importId: uuid("import_id").notNull(),
    postedOn: businessDate("posted_on").notNull(),
    amountIdr: idrColumn("amount_idr").notNull(),
    description: varchar("description", { length: 255 }).notNull(),
    externalRef: varchar("external_ref", { length: 100 }),
    dedupeKey: varchar("dedupe_key", { length: 400 }).notNull(),
    matchStatus: varchar("match_status", { length: 20 })
      .notNull()
      .default("unmatched"),
    reconciliationCaseId: uuid("reconciliation_case_id"),
    excludedReason: varchar("excluded_reason", { length: 200 }),
    statusChangedBy: text("status_changed_by"),
    statusChangedAt: timestamp("status_changed_at", { withTimezone: true }),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("bank_statement_lines_tenant_id_key").on(t.tenantId, t.id),
    unique("bank_statement_lines_account_id_key").on(
      t.tenantId,
      t.bankAccountId,
      t.id,
    ),
    unique("bank_statement_lines_dedupe_key").on(
      t.tenantId,
      t.bankAccountId,
      t.dedupeKey,
    ),
    foreignKey({
      name: "bank_statement_lines_import_fk",
      columns: [t.tenantId, t.bankAccountId, t.importId],
      foreignColumns: [
        bankStatementImports.tenantId,
        bankStatementImports.bankAccountId,
        bankStatementImports.id,
      ],
    }),
    foreignKey({
      name: "bank_statement_lines_case_fk",
      columns: [t.tenantId, t.reconciliationCaseId],
      foreignColumns: [
        bankReconciliationCases.tenantId,
        bankReconciliationCases.id,
      ],
    }),
    index("bank_statement_lines_account_posted_idx").on(
      t.tenantId,
      t.bankAccountId,
      t.postedOn,
      t.id,
    ),
    index("bank_statement_lines_status_idx").on(
      t.tenantId,
      t.bankAccountId,
      t.matchStatus,
    ),
    check("bank_statement_lines_amount_check", sql`${t.amountIdr} <> 0`),
    check(
      "bank_statement_lines_status_check",
      sql`${t.matchStatus} IN (${sql.raw(MATCH_STATUS_SQL)})`,
    ),
    check(
      "bank_statement_lines_excluded_check",
      sql`(${t.matchStatus} = 'excluded') = (${t.excludedReason} IS NOT NULL)`,
    ),
    check(
      "bank_statement_lines_case_check",
      sql`(${t.matchStatus} = 'in_case') = (${t.reconciliationCaseId} IS NOT NULL)`,
    ),
    check(
      "bank_statement_lines_text_check",
      sql`char_length(btrim(${t.description})) >= 1 AND char_length(${t.dedupeKey}) >= 1`,
    ),
    check("bank_statement_lines_version_check", sql`${t.version} >= 1`),
  ],
);

/** One row per document matched to a line (ACC-04). */
export const bankStatementLineMatches = pgTable(
  "bank_statement_line_matches",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    bankAccountId: uuid("bank_account_id").notNull(),
    lineId: uuid("line_id").notNull(),
    refType: varchar("ref_type", { length: 30 }).notNull(),
    refId: uuid("ref_id").notNull(),
    /** Signed document amount at match time (money in > 0). */
    amountIdr: idrColumn("amount_idr").notNull(),
    source: varchar("source", { length: 10 }).notNull(),
    matchedBy: text("matched_by").notNull(),
    matchedAt: timestamp("matched_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /**
     * Set when the matched journal is reversed (legend-fnxl.10): the match is
     * kept as is but no longer counts as a clean match; a reconciliation case
     * is opened for a person to decide. Null = a live match.
     */
    staleAt: timestamp("stale_at", { withTimezone: true }),
    /** The reversal journal that made this match stale (set with `stale_at`). */
    staleByReversalEntryId: uuid("stale_by_reversal_entry_id"),
  },
  (t) => [
    // A document is matched to at most one line, ever, until unmatched.
    unique("bank_statement_line_matches_ref_key").on(
      t.tenantId,
      t.refType,
      t.refId,
    ),
    foreignKey({
      name: "bank_statement_line_matches_line_fk",
      columns: [t.tenantId, t.bankAccountId, t.lineId],
      foreignColumns: [
        bankStatementLines.tenantId,
        bankStatementLines.bankAccountId,
        bankStatementLines.id,
      ],
    }).onDelete("cascade"),
    index("bank_statement_line_matches_line_idx").on(t.tenantId, t.lineId),
    check(
      "bank_statement_line_matches_ref_type_check",
      sql`${t.refType} IN (${sql.raw(MATCH_REF_TYPE_SQL)})`,
    ),
    check(
      "bank_statement_line_matches_source_check",
      sql`${t.source} IN ('auto','manual')`,
    ),
    foreignKey({
      name: "bank_statement_line_matches_stale_reversal_fk",
      columns: [t.tenantId, t.staleByReversalEntryId],
      foreignColumns: [journalEntries.tenantId, journalEntries.id],
    }),
    check(
      "bank_statement_line_matches_stale_check",
      sql`(${t.staleAt} IS NULL) = (${t.staleByReversalEntryId} IS NULL)`,
    ),
  ],
);

/**
 * A (line, document) pair a person unmatched. Automatic matching never pairs
 * them again (ACC-04: no guessing twice); a manual match of the same pair is
 * still allowed and clears the row. Deleted with the line.
 */
export const bankStatementMatchRejections = pgTable(
  "bank_statement_match_rejections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    bankAccountId: uuid("bank_account_id").notNull(),
    lineId: uuid("line_id").notNull(),
    refType: varchar("ref_type", { length: 30 }).notNull(),
    refId: uuid("ref_id").notNull(),
    rejectedBy: text("rejected_by").notNull(),
    rejectedAt: timestamp("rejected_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("bank_statement_match_rejections_pair_key").on(
      t.tenantId,
      t.lineId,
      t.refType,
      t.refId,
    ),
    foreignKey({
      name: "bank_statement_match_rejections_line_fk",
      columns: [t.tenantId, t.bankAccountId, t.lineId],
      foreignColumns: [
        bankStatementLines.tenantId,
        bankStatementLines.bankAccountId,
        bankStatementLines.id,
      ],
    }).onDelete("cascade"),
    check(
      "bank_statement_match_rejections_ref_type_check",
      sql`${t.refType} IN (${sql.raw(MATCH_REF_TYPE_SQL)})`,
    ),
  ],
);

export type BankStatementMatchRejectionRow =
  typeof bankStatementMatchRejections.$inferSelect;

// ------------------------------------------------------------ cash deposits

export const cashDeposits = pgTable(
  "cash_deposits",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    legalEntityId: uuid("legal_entity_id").notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    bankAccountId: uuid("bank_account_id").notNull(),
    amountIdr: idrColumn("amount_idr").notNull(),
    coversFrom: businessDate("covers_from").notNull(),
    coversTo: businessDate("covers_to").notNull(),
    depositedAt: timestamp("deposited_at", { withTimezone: true }).notNull(),
    depositedBy: text("deposited_by").notNull(),
    slipReference: varchar("slip_reference", { length: 60 }),
    bankStatementLineId: uuid("bank_statement_line_id"),
    reconciliationCaseId: uuid("reconciliation_case_id"),
    journalEntryId: uuid("journal_entry_id"),
    status: varchar("status", { length: 20 }).notNull().default("recorded"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("cash_deposits_tenant_id_key").on(t.tenantId, t.id),
    foreignKey({
      name: "cash_deposits_outlet_fk",
      columns: [t.tenantId, t.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    // Bank account of the same legal entity.
    foreignKey({
      name: "cash_deposits_bank_account_fk",
      columns: [t.tenantId, t.legalEntityId, t.bankAccountId],
      foreignColumns: [
        bankAccounts.tenantId,
        bankAccounts.legalEntityId,
        bankAccounts.id,
      ],
    }),
    // Statement line of the same bank account.
    foreignKey({
      name: "cash_deposits_statement_line_fk",
      columns: [t.tenantId, t.bankAccountId, t.bankStatementLineId],
      foreignColumns: [
        bankStatementLines.tenantId,
        bankStatementLines.bankAccountId,
        bankStatementLines.id,
      ],
    }),
    foreignKey({
      name: "cash_deposits_case_fk",
      columns: [t.tenantId, t.reconciliationCaseId],
      foreignColumns: [
        bankReconciliationCases.tenantId,
        bankReconciliationCases.id,
      ],
    }),
    foreignKey({
      name: "cash_deposits_journal_fk",
      columns: [t.tenantId, t.journalEntryId],
      foreignColumns: [journalEntries.tenantId, journalEntries.id],
    }),
    uniqueIndex("cash_deposits_journal_key")
      .on(t.tenantId, t.journalEntryId)
      .where(sql`${t.journalEntryId} IS NOT NULL`),
    index("cash_deposits_outlet_idx").on(
      t.tenantId,
      t.legalEntityId,
      t.outletId,
      t.depositedAt,
    ),
    index("cash_deposits_account_status_idx").on(
      t.tenantId,
      t.bankAccountId,
      t.status,
    ),
    check("cash_deposits_amount_check", sql`${t.amountIdr} > 0`),
    check("cash_deposits_covers_check", sql`${t.coversFrom} <= ${t.coversTo}`),
    check(
      "cash_deposits_status_check",
      sql`${t.status} IN ('recorded','matched','discrepancy')`,
    ),
    check(
      "cash_deposits_matched_check",
      sql`(${t.status} = 'matched') = (${t.bankStatementLineId} IS NOT NULL)`,
    ),
    check(
      "cash_deposits_discrepancy_check",
      sql`(${t.status} = 'discrepancy') = (${t.reconciliationCaseId} IS NOT NULL)`,
    ),
    check("cash_deposits_version_check", sql`${t.version} >= 1`),
  ],
);

export type BankAccountRow = typeof bankAccounts.$inferSelect;
export type BankStatementImportRow = typeof bankStatementImports.$inferSelect;
export type BankStatementLineRow = typeof bankStatementLines.$inferSelect;
export type BankStatementLineMatchRow =
  typeof bankStatementLineMatches.$inferSelect;
export type CashDepositRow = typeof cashDeposits.$inferSelect;
export type BankReconciliationCaseRow =
  typeof bankReconciliationCases.$inferSelect;
export type BankReconciliationCaseEventRow =
  typeof bankReconciliationCaseEvents.$inferSelect;

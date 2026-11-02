// Accounting core tables (PRD v1.7 §3.19 Akuntansi & Keuangan, §6 F
// `chart_of_accounts`, `account_mappings`, `journal_entries`, `journal_lines`,
// `fiscal_periods`; ACC-01/ACC-02; bead legend-kwxj).
//
// (T) tables: tenant_id NOT NULL with app.enforce_tenant_rls in
// 0025_accounting_invariants. Unique keys include tenant_id and children reach
// their parents through (tenant_id, …) composite keys, so a privileged writer
// cannot point a row at another tenant's legal entity, account or entry.
//
// Invariants live in the database, not only in TypeScript (ACC-01):
// - journal_entries and journal_lines are append-only (triggers reject
//   UPDATE/DELETE);
// - every entry balances, has at least two lines, and each line carries
//   exactly one positive side (deferred constraint trigger at commit);
// - a line's account belongs to the entry's legal entity and is active
//   (trigger) — only leaf accounts post, checked by the service;
// - an entry is reversed at most once and a reversal is never reversed again
//   (unique index + trigger).
//
// journal_entries carries `idempotency_key` next to the §6 columns: the
// posting API is the one path every module uses, and a retried delivery must
// return the entry it already posted instead of posting twice (bead decision;
// documented in the bead report). `posted_by` is TEXT like every user
// reference in this codebase (Better Auth `user` id, now UUID-valued).

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
import type {
  AccountType,
  FiscalPeriodStatus,
  JournalSourceType,
  PostingAccountRole,
  ReportGroup,
} from "@starter/shared/accounting";
import { businessDate, idrColumn } from "../columns";
import { legalEntities, outlets, tenants } from "./platform-org";

/** `chart_of_accounts` (T): one chart per legal entity, editable by the tenant. */
export const chartOfAccounts = pgTable(
  "chart_of_accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    legalEntityId: uuid("legal_entity_id").notNull(),
    code: varchar("code", { length: 20 }).notNull(),
    name: varchar("name", { length: 150 }).notNull(),
    type: varchar("type", { length: 20 }).$type<AccountType>().notNull(),
    /** Statement section (contract column next to the §6 columns). */
    reportGroup: varchar("report_group", { length: 40 })
      .$type<ReportGroup>()
      .notNull(),
    /** Same entity and type as the child; header accounts are derived. */
    parentId: uuid("parent_id"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("chart_of_accounts_tenant_entity_code_key").on(
      table.tenantId,
      table.legalEntityId,
      table.code,
    ),
    // Parent key for the self-reference: a child never crosses an entity.
    unique("chart_of_accounts_tenant_entity_id_key").on(
      table.tenantId,
      table.legalEntityId,
      table.id,
    ),
    // Journal lines and mappings reference an account by (tenant_id, id).
    unique("chart_of_accounts_tenant_id_key").on(table.tenantId, table.id),
    foreignKey({
      name: "chart_of_accounts_legal_entity_fk",
      columns: [table.tenantId, table.legalEntityId],
      foreignColumns: [legalEntities.tenantId, legalEntities.id],
    }),
    foreignKey({
      name: "chart_of_accounts_parent_fk",
      columns: [table.tenantId, table.legalEntityId, table.parentId],
      foreignColumns: [table.tenantId, table.legalEntityId, table.id],
    }),
    check(
      "chart_of_accounts_type_check",
      sql`${table.type} IN ('asset', 'liability', 'equity', 'revenue', 'expense')`,
    ),
    check(
      "chart_of_accounts_report_group_check",
      sql`${table.reportGroup} IN ('cash_and_equivalents', 'current_asset', 'non_current_asset', 'current_liability', 'non_current_liability', 'equity', 'revenue', 'other_income', 'cogs', 'operating_expense', 'other_expense')`,
    ),
    // REPORT_GROUPS: the statement section fixes the account type.
    check(
      "chart_of_accounts_report_group_type_check",
      sql`(${table.reportGroup} IN ('cash_and_equivalents', 'current_asset', 'non_current_asset') AND ${table.type} = 'asset') OR (${table.reportGroup} IN ('current_liability', 'non_current_liability') AND ${table.type} = 'liability') OR (${table.reportGroup} = 'equity' AND ${table.type} = 'equity') OR (${table.reportGroup} IN ('revenue', 'other_income') AND ${table.type} = 'revenue') OR (${table.reportGroup} IN ('cogs', 'operating_expense', 'other_expense') AND ${table.type} = 'expense')`,
    ),
    check(
      "chart_of_accounts_code_check",
      sql`${table.code} ~ '^[0-9]{1,10}([.-][0-9]{1,10}){0,4}$'`,
    ),
    // An account is not its own parent (the service also rejects cycles).
    check(
      "chart_of_accounts_parent_check",
      sql`${table.parentId} IS NULL OR ${table.parentId} <> ${table.id}`,
    ),
    index("chart_of_accounts_entity_idx").on(
      table.tenantId,
      table.legalEntityId,
      table.code,
    ),
  ],
);

/** `account_mappings` (T): posting role → account, per legal entity. */
export const accountMappings = pgTable(
  "account_mappings",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    legalEntityId: uuid("legal_entity_id").notNull(),
    role: varchar("role", { length: 40 }).$type<PostingAccountRole>().notNull(),
    accountId: uuid("account_id").notNull(),
  },
  (table) => [
    unique("account_mappings_tenant_entity_role_key").on(
      table.tenantId,
      table.legalEntityId,
      table.role,
    ),
    foreignKey({
      name: "account_mappings_legal_entity_fk",
      columns: [table.tenantId, table.legalEntityId],
      foreignColumns: [legalEntities.tenantId, legalEntities.id],
    }),
    foreignKey({
      name: "account_mappings_account_fk",
      columns: [table.tenantId, table.legalEntityId, table.accountId],
      foreignColumns: [
        chartOfAccounts.tenantId,
        chartOfAccounts.legalEntityId,
        chartOfAccounts.id,
      ],
    }),
    index("account_mappings_account_idx").on(table.tenantId, table.accountId),
  ],
);

/** `fiscal_periods` (T): one calendar month per legal entity. */
export const fiscalPeriods = pgTable(
  "fiscal_periods",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    legalEntityId: uuid("legal_entity_id").notNull(),
    period: varchar("period", { length: 7 }).notNull(),
    status: varchar("status", { length: 10 })
      .$type<FiscalPeriodStatus>()
      .notNull()
      .default("open"),
    /** +1 on every close and reopen (optimistic concurrency token). */
    version: integer("version").notNull().default(1),
    closedBy: text("closed_by"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    reopenedReason: varchar("reopened_reason", { length: 500 }),
    reopenedBy: text("reopened_by"),
    reopenedAt: timestamp("reopened_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("fiscal_periods_tenant_entity_period_key").on(
      table.tenantId,
      table.legalEntityId,
      table.period,
    ),
    unique("fiscal_periods_tenant_id_key").on(table.tenantId, table.id),
    foreignKey({
      name: "fiscal_periods_legal_entity_fk",
      columns: [table.tenantId, table.legalEntityId],
      foreignColumns: [legalEntities.tenantId, legalEntities.id],
    }),
    check(
      "fiscal_periods_period_check",
      sql`${table.period} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`,
    ),
    check(
      "fiscal_periods_status_check",
      sql`${table.status} IN ('open', 'closed')`,
    ),
    check("fiscal_periods_version_check", sql`${table.version} >= 1`),
    check(
      "fiscal_periods_closed_check",
      sql`(${table.status} = 'closed') = (${table.closedBy} IS NOT NULL AND ${table.closedAt} IS NOT NULL)`,
    ),
    check(
      "fiscal_periods_reopened_check",
      sql`(${table.reopenedReason} IS NULL) = (${table.reopenedBy} IS NULL) AND (${table.reopenedBy} IS NULL) = (${table.reopenedAt} IS NULL)`,
    ),
  ],
);

/** `journal_entries` (T): append-only, posted entries only (ACC-01). */
export const journalEntries = pgTable(
  "journal_entries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    legalEntityId: uuid("legal_entity_id").notNull(),
    /** Main outlet; null for entity-level entries (payroll, depreciation). */
    outletId: uuid("outlet_id"),
    entryDate: businessDate("entry_date").notNull(),
    fiscalPeriodId: uuid("fiscal_period_id").notNull(),
    sourceType: varchar("source_type", { length: 30 })
      .$type<JournalSourceType>()
      .notNull(),
    /** Source aggregate: ULID text for orders, UUID otherwise (D-CORE-1). */
    sourceId: varchar("source_id", { length: 64 }),
    description: varchar("description", { length: 255 }).notNull(),
    reversalOf: uuid("reversal_of"),
    postedBy: text("posted_by"),
    postedAt: timestamp("posted_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /** Retry key of the posting API: one business fact posts once. */
    idempotencyKey: varchar("idempotency_key", { length: 100 }).notNull(),
    /**
     * sha256 of the canonical request the key was first used for. A replay must
     * present the same payload, else IDEMPOTENCY_KEY_REUSED (409).
     */
    requestFingerprint: varchar("request_fingerprint", {
      length: 64,
    }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("journal_entries_tenant_idempotency_key").on(
      table.tenantId,
      table.idempotencyKey,
    ),
    unique("journal_entries_tenant_id_key").on(table.tenantId, table.id),
    // ACC-01: one reversal per entry.
    uniqueIndex("journal_entries_reversal_once_key")
      .on(table.tenantId, table.reversalOf)
      .where(sql`${table.reversalOf} IS NOT NULL`),
    foreignKey({
      name: "journal_entries_legal_entity_fk",
      columns: [table.tenantId, table.legalEntityId],
      foreignColumns: [legalEntities.tenantId, legalEntities.id],
    }),
    foreignKey({
      name: "journal_entries_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "journal_entries_fiscal_period_fk",
      columns: [table.tenantId, table.fiscalPeriodId],
      foreignColumns: [fiscalPeriods.tenantId, fiscalPeriods.id],
    }),
    foreignKey({
      name: "journal_entries_reversal_fk",
      columns: [table.tenantId, table.reversalOf],
      foreignColumns: [table.tenantId, table.id],
    }),
    check(
      "journal_entries_source_type_check",
      sql`${table.sourceType} IN ('sale', 'refund', 'gateway_settlement', 'edc_settlement', 'cogs', 'stock_adjustment', 'purchase', 'supplier_invoice', 'supplier_payment', 'production', 'payroll', 'loyalty', 'depreciation', 'asset_acquisition', 'asset_disposal', 'asset_revaluation', 'dividend', 'cash_deposit', 'cashier_shift', 'opening_balance', 'manual', 'recurring', 'reversal')`,
    ),
    // Contract/journal.ts: reversalOf is set exactly when sourceType is reversal.
    check(
      "journal_entries_reversal_check",
      sql`(${table.sourceType} = 'reversal') = (${table.reversalOf} IS NOT NULL)`,
    ),
    check(
      "journal_entries_description_check",
      sql`length(btrim(${table.description})) > 0`,
    ),
    check(
      "journal_entries_source_id_check",
      sql`${table.sourceId} IS NULL OR ${table.sourceId} ~ '^[0-9A-HJKMNP-TV-Z]{26}$' OR ${table.sourceId} ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`,
    ),
    // Journal list: entity + date descending, keyset on (entry_date, id).
    index("journal_entries_entity_date_idx").on(
      table.tenantId,
      table.legalEntityId,
      table.entryDate.desc(),
      table.id.desc(),
    ),
    index("journal_entries_source_idx").on(
      table.tenantId,
      table.sourceType,
      table.sourceId,
    ),
    index("journal_entries_outlet_date_idx").on(
      table.tenantId,
      table.outletId,
      table.entryDate.desc(),
    ),
  ],
);

/** `journal_lines` (T): debit XOR credit in whole rupiah, append-only. */
export const journalLines = pgTable(
  "journal_lines",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    entryId: uuid("entry_id").notNull(),
    accountId: uuid("account_id").notNull(),
    /** Display order of the lines as posted (1-based). */
    lineNo: integer("line_no").notNull(),
    debitIdr: idrColumn("debit_idr")
      .notNull()
      .default(sql`0`),
    creditIdr: idrColumn("credit_idr")
      .notNull()
      .default(sql`0`),
    /** Lines may carry different outlets (outlet P&L, ACC-03). */
    outletId: uuid("outlet_id"),
    costCenter: varchar("cost_center", { length: 30 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: "journal_lines_entry_fk",
      columns: [table.tenantId, table.entryId],
      foreignColumns: [journalEntries.tenantId, journalEntries.id],
    }),
    foreignKey({
      name: "journal_lines_account_fk",
      columns: [table.tenantId, table.accountId],
      foreignColumns: [chartOfAccounts.tenantId, chartOfAccounts.id],
    }),
    foreignKey({
      name: "journal_lines_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    check(
      "journal_lines_amounts_check",
      sql`${table.debitIdr} >= 0 AND ${table.creditIdr} >= 0`,
    ),
    // Exactly one side is positive (a zero line is dropped before posting).
    check(
      "journal_lines_side_check",
      sql`(${table.debitIdr} > 0 AND ${table.creditIdr} = 0) OR (${table.creditIdr} > 0 AND ${table.debitIdr} = 0)`,
    ),
    unique("journal_lines_tenant_entry_line_key").on(
      table.tenantId,
      table.entryId,
      table.lineNo,
    ),
    check("journal_lines_line_no_check", sql`${table.lineNo} >= 1`),
    index("journal_lines_entry_idx").on(table.tenantId, table.entryId),
    index("journal_lines_account_idx").on(table.tenantId, table.accountId),
    index("journal_lines_outlet_idx").on(table.tenantId, table.outletId),
  ],
);

/** Parent lookup used by the account service (same entity chart). */
export type ChartOfAccountsRow = typeof chartOfAccounts.$inferSelect;
/** Used by the posting service to build an entry. */
export type JournalEntryRow = typeof journalEntries.$inferSelect;
export type JournalLineRow = typeof journalLines.$inferSelect;
export type FiscalPeriodRow = typeof fiscalPeriods.$inferSelect;

// AP/AR open items, fixed assets + depreciation, budgets (PRD v1.7 §3.19
// "Utang & Piutang", "Aset Tetap", "Anggaran"; §6 F `fixed_assets`,
// `depreciation_runs`, `budgets`; bead legend-hpgo).
//
// Contract: `@starter/shared/accounting` (payables.ts, assets.ts,
// budgets.ts). Every table is (T): tenant_id NOT NULL with
// app.enforce_tenant_rls (accounting-ap-fa.custom.sql). None is outlet-owned:
// `outlet_id` is nullable everywhere (contract: null = whole legal entity), so
// outlet reach is enforced by the services (contracts.md "TEN-03 outlet
// isolation layers"), like the accounting core tables.
//
// Unique keys include tenant_id and children reach their parents through
// (tenant_id, …) composite foreign keys, so a row can never point at another
// tenant's legal entity, outlet, account, asset or journal entry.
//
// - `accounting_open_items`: the AP/AR sub-ledger (kartu utang / piutang).
//   The id is the source document id (supplier invoice, AR invoice), so one
//   document is one open item. `settled_idr` is the running total of
//   `accounting_open_item_settlements`; CHECKs keep 0 <= settled <= original.
// - `fixed_assets` + `fixed_asset_depreciations`: the per asset+period ledger
//   (UNIQUE tenant, asset, period) makes depreciation idempotent per asset and
//   period even if a run is retried or a disposal caught a month up.
// - `depreciation_runs`: one run per legal entity and period (UNIQUE), the
//   journal it posted, and the contract invariant "a run with an amount posts
//   exactly one journal" as a CHECK.
// - `fixed_asset_revaluations`: append-only history of each revaluation and
//   the asset parameters it replaced.
// - `budgets`: UNIQUE NULLS NOT DISTINCT (tenant, entity, outlet, account,
//   period) so the entity-level row (outlet NULL) is unique too.
// - `accounting_command_idempotency`: idempotency key → request fingerprint +
//   stored response for the commands of this bead.

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
import type { OutletId } from "@starter/shared/core";
import { businessDate, idrColumn, tenantIdColumn } from "../columns.ts";
import { chartOfAccounts, journalEntries } from "./accounting.ts";
import { legalEntities, outlets, tenants } from "./platform-org.ts";

const PERIOD_FORMAT = "'^[0-9]{4}-(0[1-9]|1[0-2])$'";
const FINGERPRINT_FORMAT = "'^[a-f0-9]{64}$'";

// ------------------------------------------------------------- AP / AR

/** Kartu utang / piutang row (contract payables.ts `openItemSchema`). */
export const accountingOpenItems = pgTable(
  "accounting_open_items",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    kind: varchar("kind", { length: 12 })
      .$type<"payable" | "receivable">()
      .notNull(),
    /** Source document id (supplier invoice, AR invoice). */
    id: uuid("id").notNull(),
    legalEntityId: uuid("legal_entity_id").notNull(),
    outletId: uuid("outlet_id").$type<OutletId>(),
    counterpartyType: varchar("counterparty_type", { length: 20 })
      .$type<"supplier" | "corporate_account" | "event_customer" | "employee">()
      .notNull(),
    counterpartyId: uuid("counterparty_id").notNull(),
    counterpartyName: varchar("counterparty_name", { length: 150 }).notNull(),
    documentNumber: varchar("document_number", { length: 60 }).notNull(),
    documentDate: businessDate("document_date").notNull(),
    dueOn: businessDate("due_on").notNull(),
    originalIdr: idrColumn("original_idr").notNull(),
    settledIdr: idrColumn("settled_idr")
      .notNull()
      .default(sql`0`),
    /** Journal the source posted for the document (AP: supplier_invoice). */
    journalEntryId: uuid("journal_entry_id"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.kind, table.id] }),
    foreignKey({
      name: "accounting_open_items_legal_entity_fk",
      columns: [table.tenantId, table.legalEntityId],
      foreignColumns: [legalEntities.tenantId, legalEntities.id],
    }),
    foreignKey({
      name: "accounting_open_items_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "accounting_open_items_journal_fk",
      columns: [table.tenantId, table.journalEntryId],
      foreignColumns: [journalEntries.tenantId, journalEntries.id],
    }),
    check(
      "accounting_open_items_kind_check",
      sql`${table.kind} IN ('payable', 'receivable')`,
    ),
    // §3.19: utang = supplier; piutang = event dan corporate account; plus the
    // employee PPh 21 receivable (legend-itph).
    check(
      "accounting_open_items_counterparty_check",
      sql`(${table.kind} = 'payable' AND ${table.counterpartyType} = 'supplier') OR (${table.kind} = 'receivable' AND ${table.counterpartyType} IN ('corporate_account', 'event_customer', 'employee'))`,
    ),
    check(
      "accounting_open_items_amounts_check",
      sql`${table.originalIdr} > 0 AND ${table.settledIdr} >= 0 AND ${table.settledIdr} <= ${table.originalIdr}`,
    ),
    check(
      "accounting_open_items_due_check",
      sql`${table.dueOn} >= ${table.documentDate}`,
    ),
    check(
      "accounting_open_items_text_check",
      sql`length(btrim(${table.counterpartyName})) > 0 AND length(btrim(${table.documentNumber})) > 0`,
    ),
    // Aging: entity + kind, oldest due first.
    index("accounting_open_items_aging_idx").on(
      table.tenantId,
      table.legalEntityId,
      table.kind,
      table.dueOn,
    ),
    index("accounting_open_items_outlet_idx").on(
      table.tenantId,
      table.outletId,
    ),
  ],
);

/** One payment / receipt / write-off allocated to an open item. */
export const accountingOpenItemSettlements = pgTable(
  "accounting_open_item_settlements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    kind: varchar("kind", { length: 12 })
      .$type<"payable" | "receivable">()
      .notNull(),
    openItemId: uuid("open_item_id").notNull(),
    method: varchar("method", { length: 12 })
      .$type<"payment" | "write_off" | "debit_note" | "reversal">()
      .notNull(),
    /**
     * A `reversal` row cancels the `payment` it names (legend-2ln9t): the
     * ledger is append-only for legend_app, so an undone settlement is
     * cancelled by a new row, never deleted. Readers count it as negative.
     */
    reversalOf: uuid("reversal_of"),
    /** Source document (supplier payment, AR receipt) when there is one. */
    sourceId: uuid("source_id"),
    settledOn: businessDate("settled_on").notNull(),
    amountIdr: idrColumn("amount_idr").notNull(),
    journalEntryId: uuid("journal_entry_id"),
    reason: varchar("reason", { length: 200 }),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("accounting_open_item_settlements_tenant_id_key").on(
      table.tenantId,
      table.id,
    ),
    foreignKey({
      name: "accounting_open_item_settlements_item_fk",
      columns: [table.tenantId, table.kind, table.openItemId],
      foreignColumns: [
        accountingOpenItems.tenantId,
        accountingOpenItems.kind,
        accountingOpenItems.id,
      ],
    }),
    foreignKey({
      name: "accounting_open_item_settlements_journal_fk",
      columns: [table.tenantId, table.journalEntryId],
      foreignColumns: [journalEntries.tenantId, journalEntries.id],
    }),
    foreignKey({
      name: "accounting_open_item_settlements_reversal_of_fk",
      columns: [table.tenantId, table.reversalOf],
      foreignColumns: [table.tenantId, table.id],
    }),
    check(
      "accounting_open_item_settlements_amount_check",
      sql`${table.amountIdr} > 0`,
    ),
    check(
      "accounting_open_item_settlements_method_check",
      sql`${table.method} IN ('payment', 'write_off', 'debit_note', 'reversal')`,
    ),
    // A reversal names the payment it cancels, and only a reversal does; one
    // payment is cancelled at most once.
    check(
      "accounting_open_item_settlements_reversal_check",
      sql`(${table.method} = 'reversal') = (${table.reversalOf} IS NOT NULL)`,
    ),
    uniqueIndex("accounting_open_item_settlements_reversal_key")
      .on(table.tenantId, table.reversalOf)
      .where(sql`${table.reversalOf} IS NOT NULL`),
    // A debit note is the supplier-return credit: it always names the return
    // document, and one return reduces one open item at most once.
    check(
      "accounting_open_item_settlements_debit_note_source_check",
      sql`${table.method} <> 'debit_note' OR ${table.sourceId} IS NOT NULL`,
    ),
    uniqueIndex("accounting_open_item_settlements_debit_note_key")
      .on(table.tenantId, table.kind, table.openItemId, table.sourceId)
      .where(sql`${table.method} = 'debit_note'`),
    // A write-off is a judgement call: it always carries its reason.
    check(
      "accounting_open_item_settlements_reason_check",
      sql`${table.method} <> 'write_off' OR length(btrim(coalesce(${table.reason}, ''))) > 0`,
    ),
    index("accounting_open_item_settlements_item_idx").on(
      table.tenantId,
      table.kind,
      table.openItemId,
      table.settledOn,
    ),
  ],
);

// -------------------------------------------------------- asset categories

/**
 * Tenant list of fixed asset categories (legend-dux2: "kategori aset" of the
 * aset-tetap register). A name is unique per tenant ignoring case.
 */
export const assetCategories = pgTable(
  "asset_categories",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    name: varchar("name", { length: 80 }).notNull(),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("asset_categories_tenant_id_key").on(table.tenantId, table.id),
    uniqueIndex("asset_categories_tenant_name_key").on(
      table.tenantId,
      sql`lower(${table.name})`,
    ),
    check("asset_categories_name_check", sql`length(btrim(${table.name})) > 0`),
  ],
);

// -------------------------------------------------------- fixed assets

/** §6 F `fixed_assets` (contract assets.ts `fixedAssetSchema`). */
export const fixedAssets = pgTable(
  "fixed_assets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    legalEntityId: uuid("legal_entity_id").notNull(),
    outletId: uuid("outlet_id").$type<OutletId>(),
    /** Register number, unique per tenant + legal entity (legend-dux2). */
    code: varchar("code", { length: 40 }).notNull(),
    /** Tenant category (`asset_categories`); null = uncategorised. */
    categoryId: uuid("category_id"),
    name: varchar("name", { length: 150 }).notNull(),
    acquiredOn: businessDate("acquired_on").notNull(),
    /** Gross carrying basis; restated by a revaluation (elimination method). */
    costIdr: idrColumn("cost_idr").notNull(),
    residualValueIdr: idrColumn("residual_value_idr")
      .notNull()
      .default(sql`0`),
    /** Months of the current schedule (remaining life after a revaluation). */
    usefulLifeMonths: integer("useful_life_months").notNull(),
    method: varchar("method", { length: 20 })
      .$type<"straight_line">()
      .notNull()
      .default("straight_line"),
    depreciationStartPeriod: varchar("depreciation_start_period", {
      length: 7,
    }).notNull(),
    sourceDocumentId: uuid("source_document_id"),
    /** Accumulated since the current basis (reset by a revaluation). */
    accumulatedDepreciationIdr: idrColumn("accumulated_depreciation_idr")
      .notNull()
      .default(sql`0`),
    status: varchar("status", { length: 20 })
      .$type<"active" | "fully_depreciated" | "disposed">()
      .notNull()
      .default("active"),
    disposedOn: businessDate("disposed_on"),
    disposalProceedsIdr: idrColumn("disposal_proceeds_idr"),
    acquisitionJournalEntryId: uuid("acquisition_journal_entry_id"),
    disposalJournalEntryId: uuid("disposal_journal_entry_id"),
    disposalReason: varchar("disposal_reason", { length: 200 }),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("fixed_assets_tenant_id_key").on(table.tenantId, table.id),
    unique("fixed_assets_tenant_entity_id_key").on(
      table.tenantId,
      table.legalEntityId,
      table.id,
    ),
    unique("fixed_assets_tenant_entity_code_key").on(
      table.tenantId,
      table.legalEntityId,
      table.code,
    ),
    foreignKey({
      name: "fixed_assets_category_fk",
      columns: [table.tenantId, table.categoryId],
      foreignColumns: [assetCategories.tenantId, assetCategories.id],
    }),
    foreignKey({
      name: "fixed_assets_legal_entity_fk",
      columns: [table.tenantId, table.legalEntityId],
      foreignColumns: [legalEntities.tenantId, legalEntities.id],
    }),
    foreignKey({
      name: "fixed_assets_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "fixed_assets_acquisition_journal_fk",
      columns: [table.tenantId, table.acquisitionJournalEntryId],
      foreignColumns: [journalEntries.tenantId, journalEntries.id],
    }),
    foreignKey({
      name: "fixed_assets_disposal_journal_fk",
      columns: [table.tenantId, table.disposalJournalEntryId],
      foreignColumns: [journalEntries.tenantId, journalEntries.id],
    }),
    check(
      "fixed_assets_amounts_check",
      sql`${table.costIdr} > 0 AND ${table.residualValueIdr} >= 0 AND ${table.residualValueIdr} < ${table.costIdr} AND ${table.accumulatedDepreciationIdr} >= 0 AND ${table.accumulatedDepreciationIdr} <= ${table.costIdr} - ${table.residualValueIdr}`,
    ),
    check(
      "fixed_assets_life_check",
      sql`${table.usefulLifeMonths} BETWEEN 1 AND 600`,
    ),
    check("fixed_assets_method_check", sql`${table.method} = 'straight_line'`),
    check(
      "fixed_assets_status_check",
      sql`${table.status} IN ('active', 'fully_depreciated', 'disposed')`,
    ),
    check(
      "fixed_assets_period_check",
      sql`${table.depreciationStartPeriod} ~ ${sql.raw(PERIOD_FORMAT)}`,
    ),
    // Contract: disposal fields are set exactly when disposed.
    check(
      "fixed_assets_disposal_check",
      sql`(${table.status} = 'disposed') = (${table.disposedOn} IS NOT NULL AND ${table.disposalProceedsIdr} IS NOT NULL) AND (${table.disposalProceedsIdr} IS NULL OR ${table.disposalProceedsIdr} >= 0) AND (${table.disposedOn} IS NULL OR ${table.disposedOn} >= ${table.acquiredOn})`,
    ),
    check("fixed_assets_name_check", sql`length(btrim(${table.name})) > 0`),
    check("fixed_assets_code_check", sql`length(btrim(${table.code})) > 0`),
    index("fixed_assets_entity_idx").on(
      table.tenantId,
      table.legalEntityId,
      table.status,
    ),
  ],
);

/** §6 F `depreciation_runs` (period, amount_idr): one run per entity+period. */
export const depreciationRuns = pgTable(
  "depreciation_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    legalEntityId: uuid("legal_entity_id").notNull(),
    period: varchar("period", { length: 7 }).notNull(),
    amountIdr: idrColumn("amount_idr").notNull(),
    journalEntryId: uuid("journal_entry_id"),
    /** Null when the scheduled job posted it (system actor). */
    postedBy: text("posted_by"),
    postedAt: timestamp("posted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("depreciation_runs_tenant_entity_period_key").on(
      table.tenantId,
      table.legalEntityId,
      table.period,
    ),
    unique("depreciation_runs_tenant_id_key").on(table.tenantId, table.id),
    foreignKey({
      name: "depreciation_runs_legal_entity_fk",
      columns: [table.tenantId, table.legalEntityId],
      foreignColumns: [legalEntities.tenantId, legalEntities.id],
    }),
    foreignKey({
      name: "depreciation_runs_journal_fk",
      columns: [table.tenantId, table.journalEntryId],
      foreignColumns: [journalEntries.tenantId, journalEntries.id],
    }),
    check(
      "depreciation_runs_period_check",
      sql`${table.period} ~ ${sql.raw(PERIOD_FORMAT)}`,
    ),
    // Contract: a run with an amount posts exactly one journal.
    check(
      "depreciation_runs_journal_check",
      sql`${table.amountIdr} >= 0 AND (${table.amountIdr} > 0) = (${table.journalEntryId} IS NOT NULL)`,
    ),
  ],
);

/**
 * Depreciation ledger: one active row per asset and schedule period
 * (idempotent per asset+period). `run_id` is null for the month a disposal or
 * revaluation caught up before the monthly run. Append-only: a row taken back
 * by a backdated event has a row in `fixed_asset_depreciation_reversals`, and
 * the month is then depreciated again as the next `generation` (trigger
 * `fixed_asset_depreciations_generation`, migration 0269).
 */
export const fixedAssetDepreciations = pgTable(
  "fixed_asset_depreciations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    fixedAssetId: uuid("fixed_asset_id").notNull(),
    period: varchar("period", { length: 7 }).notNull(),
    amountIdr: idrColumn("amount_idr").notNull(),
    generation: integer("generation").notNull().default(1),
    runId: uuid("run_id"),
    journalEntryId: uuid("journal_entry_id").notNull(),
    /**
     * Set once the row is taken back (only by
     * `app.record_depreciation_reversal`, migration 0271); null = active.
     */
    reversedAt: timestamp("reversed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // One active row per asset and month: the last word on concurrent runs.
    uniqueIndex("fixed_asset_depreciations_active_key")
      .on(table.tenantId, table.fixedAssetId, table.period)
      .where(sql`${table.reversedAt} IS NULL`),
    unique("fixed_asset_depreciations_asset_period_generation_key").on(
      table.tenantId,
      table.fixedAssetId,
      table.period,
      table.generation,
    ),
    unique("fixed_asset_depreciations_tenant_id_key").on(
      table.tenantId,
      table.id,
    ),
    foreignKey({
      name: "fixed_asset_depreciations_asset_fk",
      columns: [table.tenantId, table.fixedAssetId],
      foreignColumns: [fixedAssets.tenantId, fixedAssets.id],
    }),
    foreignKey({
      name: "fixed_asset_depreciations_run_fk",
      columns: [table.tenantId, table.runId],
      foreignColumns: [depreciationRuns.tenantId, depreciationRuns.id],
    }),
    foreignKey({
      name: "fixed_asset_depreciations_journal_fk",
      columns: [table.tenantId, table.journalEntryId],
      foreignColumns: [journalEntries.tenantId, journalEntries.id],
    }),
    check(
      "fixed_asset_depreciations_amount_check",
      sql`${table.amountIdr} > 0`,
    ),
    check(
      "fixed_asset_depreciations_period_check",
      sql`${table.period} ~ ${sql.raw(PERIOD_FORMAT)}`,
    ),
    check(
      "fixed_asset_depreciations_generation_check",
      sql`${table.generation} >= 1`,
    ),
    index("fixed_asset_depreciations_run_idx").on(table.tenantId, table.runId),
  ],
);

/**
 * Append-only: a depreciation row taken back by a backdated disposal or
 * revaluation (bead legend-i5kc). `journal_entry_id` is the correcting journal
 * (debit/credit mirrored, dated in the original month); one journal may take
 * back several rows of one asset. legend_app cannot INSERT here: rows come only
 * from `app.record_depreciation_reversal` (migration 0271), which validates the
 * journal and stamps `fixed_asset_depreciations.reversed_at`.
 */
export const fixedAssetDepreciationReversals = pgTable(
  "fixed_asset_depreciation_reversals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    depreciationId: uuid("depreciation_id").notNull(),
    journalEntryId: uuid("journal_entry_id").notNull(),
    reason: varchar("reason", { length: 200 }).notNull(),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("fixed_asset_depreciation_reversals_depreciation_key").on(
      table.tenantId,
      table.depreciationId,
    ),
    foreignKey({
      name: "fixed_asset_depreciation_reversals_depreciation_fk",
      columns: [table.tenantId, table.depreciationId],
      foreignColumns: [
        fixedAssetDepreciations.tenantId,
        fixedAssetDepreciations.id,
      ],
    }),
    foreignKey({
      name: "fixed_asset_depreciation_reversals_journal_fk",
      columns: [table.tenantId, table.journalEntryId],
      foreignColumns: [journalEntries.tenantId, journalEntries.id],
    }),
    check(
      "fixed_asset_depreciation_reversals_reason_check",
      sql`length(btrim(${table.reason})) > 0`,
    ),
    index("fixed_asset_depreciation_reversals_journal_idx").on(
      table.tenantId,
      table.journalEntryId,
    ),
  ],
);

/**
 * Claim on a correcting journal (migration 0274). One row per correcting
 * journal that was taken into the depreciation ledger or reversed by hand:
 * `claimed_idr` is what the linked depreciation rows took back through it
 * (never more than the journal debits), `reversed` means a manual reversal
 * journal exists. The two exclude each other. Written only by SECURITY DEFINER
 * functions; the row update is what makes two REPEATABLE READ writers conflict.
 */
export const fixedAssetCorrectionClaims = pgTable(
  "fixed_asset_correction_claims",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    journalEntryId: uuid("journal_entry_id").notNull(),
    claimedIdr: idrColumn("claimed_idr")
      .notNull()
      .default(sql`0`),
    reversed: boolean("reversed").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.journalEntryId] }),
    foreignKey({
      name: "fixed_asset_correction_claims_journal_fk",
      columns: [table.tenantId, table.journalEntryId],
      foreignColumns: [journalEntries.tenantId, journalEntries.id],
    }),
    check(
      "fixed_asset_correction_claims_claimed_check",
      sql`${table.claimedIdr} >= 0`,
    ),
  ],
);

/** Append-only revaluation history (§3.19 Aset Tetap "revaluasi"). */
export const fixedAssetRevaluations = pgTable(
  "fixed_asset_revaluations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    fixedAssetId: uuid("fixed_asset_id").notNull(),
    revaluedOn: businessDate("revalued_on").notNull(),
    previousCostIdr: idrColumn("previous_cost_idr").notNull(),
    previousAccumulatedIdr: idrColumn("previous_accumulated_idr").notNull(),
    previousUsefulLifeMonths: integer("previous_useful_life_months").notNull(),
    previousStartPeriod: varchar("previous_start_period", {
      length: 7,
    }).notNull(),
    newCarryingAmountIdr: idrColumn("new_carrying_amount_idr").notNull(),
    journalEntryId: uuid("journal_entry_id").notNull(),
    reason: varchar("reason", { length: 200 }).notNull(),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "fixed_asset_revaluations_asset_fk",
      columns: [table.tenantId, table.fixedAssetId],
      foreignColumns: [fixedAssets.tenantId, fixedAssets.id],
    }),
    foreignKey({
      name: "fixed_asset_revaluations_journal_fk",
      columns: [table.tenantId, table.journalEntryId],
      foreignColumns: [journalEntries.tenantId, journalEntries.id],
    }),
    check(
      "fixed_asset_revaluations_amount_check",
      sql`${table.newCarryingAmountIdr} > 0 AND ${table.previousCostIdr} > 0 AND ${table.previousAccumulatedIdr} >= 0`,
    ),
    check(
      "fixed_asset_revaluations_reason_check",
      sql`length(btrim(${table.reason})) > 0`,
    ),
    index("fixed_asset_revaluations_asset_idx").on(
      table.tenantId,
      table.fixedAssetId,
    ),
  ],
);

// -------------------------------------------------------- finance policy

/**
 * Per-tenant finance policy (legend-pxcs): the bank matching date tolerance
 * and ACC-05 "batas hari" for cash left undeposited. One row per tenant; no
 * row means the shared defaults (2 days / 2 days).
 */
export const financePolicies = pgTable(
  "finance_policies",
  {
    tenantId: tenantIdColumn(() => tenants.id)
      .primaryKey()
      .notNull(),
    bankMatchingDateToleranceDays: integer("bank_matching_date_tolerance_days")
      .notNull()
      .default(2),
    maxDaysUndeposited: integer("max_days_undeposited").notNull().default(2),
    /** Reconciliation case due-days (legend-fnxl.9); 1..60, default 7. */
    reconCaseDueDays: integer("recon_case_due_days").notNull().default(7),
    /** Cash-out approval limit (Rp, founder Q7); NULL = the default Rp5.000.000. */
    cashOutApprovalLimitIdr: idrColumn("cash_out_approval_limit_idr"),
    updatedBy: text("updated_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "finance_policies_tolerance_check",
      sql`${table.bankMatchingDateToleranceDays} BETWEEN 0 AND 14`,
    ),
    check(
      "finance_policies_undeposited_check",
      sql`${table.maxDaysUndeposited} BETWEEN 0 AND 30`,
    ),
    check(
      "finance_policies_recon_case_due_days_check",
      sql`${table.reconCaseDueDays} BETWEEN 1 AND 60`,
    ),
    check(
      "finance_policies_cash_out_limit_check",
      sql`${table.cashOutApprovalLimitIdr} IS NULL OR ${table.cashOutApprovalLimitIdr} BETWEEN 1 AND 100000000000`,
    ),
  ],
);

// -------------------------------------------------------------- budgets

/** §6 F `budgets`: legal_entity_id, outlet_id, account_id, period, amount_idr. */
export const budgets = pgTable(
  "budgets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    legalEntityId: uuid("legal_entity_id").notNull(),
    /** null = whole legal entity. */
    outletId: uuid("outlet_id").$type<OutletId>(),
    accountId: uuid("account_id").notNull(),
    period: varchar("period", { length: 7 }).notNull(),
    amountIdr: idrColumn("amount_idr").notNull(),
    updatedBy: text("updated_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("budgets_tenant_entity_outlet_account_period_key")
      .on(
        table.tenantId,
        table.legalEntityId,
        table.outletId,
        table.accountId,
        table.period,
      )
      .nullsNotDistinct(),
    foreignKey({
      name: "budgets_legal_entity_fk",
      columns: [table.tenantId, table.legalEntityId],
      foreignColumns: [legalEntities.tenantId, legalEntities.id],
    }),
    foreignKey({
      name: "budgets_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    // The account belongs to the budget's legal entity.
    foreignKey({
      name: "budgets_account_fk",
      columns: [table.tenantId, table.legalEntityId, table.accountId],
      foreignColumns: [
        chartOfAccounts.tenantId,
        chartOfAccounts.legalEntityId,
        chartOfAccounts.id,
      ],
    }),
    check("budgets_amount_check", sql`${table.amountIdr} >= 0`),
    check(
      "budgets_period_check",
      sql`${table.period} ~ ${sql.raw(PERIOD_FORMAT)}`,
    ),
    index("budgets_entity_period_idx").on(
      table.tenantId,
      table.legalEntityId,
      table.period,
    ),
  ],
);

// ---------------------------------------------------------- idempotency

/** Idempotency key → request fingerprint + stored response (this bead's commands). */
export const accountingCommandIdempotency = pgTable(
  "accounting_command_idempotency",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    key: varchar("key", { length: 100 }).notNull(),
    operation: varchar("operation", { length: 60 }).notNull(),
    fingerprint: varchar("fingerprint", { length: 64 }).notNull(),
    response: jsonb("response").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.key] }),
    check(
      "accounting_command_idempotency_fingerprint_check",
      sql`${table.fingerprint} ~ ${sql.raw(FINGERPRINT_FORMAT)}`,
    ),
  ],
);

export type OpenItemRow = typeof accountingOpenItems.$inferSelect;
export type OpenItemSettlementRow =
  typeof accountingOpenItemSettlements.$inferSelect;
export type FixedAssetRow = typeof fixedAssets.$inferSelect;
export type DepreciationRunRow = typeof depreciationRuns.$inferSelect;
export type FixedAssetDepreciationRow =
  typeof fixedAssetDepreciations.$inferSelect;
export type BudgetRow = typeof budgets.$inferSelect;

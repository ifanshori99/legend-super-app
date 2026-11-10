// Profit share & dividends (WS-07, bead legend-2ljb; PRD v1.7 §3.37 "Bagi
// Hasil & Dividen", §4 P, §6 I; SH-03, SH-04).
//
// Contract: `@starter/shared/accounting` (`profit-share.ts`). Every table is
// (T): tenant_id NOT NULL with app.enforce_tenant_rls, and every reference is a
// composite (tenant_id, id) foreign key so a row can never point into another
// tenant. The custom part of the migration (accounting-profit-share.custom.sql)
// adds what a CHECK cannot express:
//
// - SH-03: a version's shares can only change while it is a draft, and a
//   version can only reach pending_approval/approved when its shares sum to
//   exactly 10,000 bp (deferred constraint trigger, re-checked at commit).
// - Version status moves only along the contract state machine; approved,
//   rejected-then-cancelled and cancelled versions are frozen.
// - A distribution run can only be created for a CLOSED fiscal period and an
//   APPROVED share version.
// - SH-04: from `approved` on, a run's amounts, lines and references are
//   frozen. Only approved → paid (+ paid_at), journal ids being set once, a
//   line being paid once and a paid line's statement key being set once are
//   allowed. Nothing is ever deleted once submitted.
//
// Money is whole rupiah (bigint). NPWP and payout account numbers are sealed
// with lib/secrets.ts (`sealSecret`), only the last four digits are kept clear.

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { idr } from "@starter/shared/core";
import { businessDate, idrColumn } from "../columns.ts";
import { fiscalPeriods, journalEntries } from "./accounting.ts";
import { legalEntities, outlets, tenants } from "./platform-org.ts";

/** `profit_entities` (T): a legal entity or one outlet, plus its policy. */
export const profitEntities = pgTable(
  "profit_entities",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    id: uuid("id").notNull().defaultRandom(),
    name: text("name").notNull(),
    type: text("type").$type<"legal_entity" | "outlet">().notNull(),
    legalEntityId: uuid("legal_entity_id"),
    outletId: uuid("outlet_id"),
    basis: text("basis")
      .$type<"closed_period_net_profit">()
      .notNull()
      .default("closed_period_net_profit"),
    reserveBp: integer("reserve_bp").notNull(),
    frequency: text("frequency")
      .$type<"monthly" | "quarterly" | "semi_annual" | "annual">()
      .notNull(),
    taxWithholdingBp: integer("tax_withholding_bp").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    foreignKey({
      name: "profit_entities_legal_entity_fk",
      columns: [table.tenantId, table.legalEntityId],
      foreignColumns: [legalEntities.tenantId, legalEntities.id],
    }),
    foreignKey({
      name: "profit_entities_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    uniqueIndex("profit_entities_tenant_legal_entity_key")
      .on(table.tenantId, table.legalEntityId)
      .where(sql`${table.type} = 'legal_entity'`),
    uniqueIndex("profit_entities_tenant_outlet_key")
      .on(table.tenantId, table.outletId)
      .where(sql`${table.type} = 'outlet'`),
    check(
      "profit_entities_type_check",
      sql`(${table.type} = 'legal_entity' AND ${table.legalEntityId} IS NOT NULL AND ${table.outletId} IS NULL) OR (${table.type} = 'outlet' AND ${table.outletId} IS NOT NULL AND ${table.legalEntityId} IS NULL)`,
    ),
    check(
      "profit_entities_basis_check",
      sql`${table.basis} = 'closed_period_net_profit'`,
    ),
    check(
      "profit_entities_frequency_check",
      sql`${table.frequency} IN ('monthly', 'quarterly', 'semi_annual', 'annual')`,
    ),
    check(
      "profit_entities_bp_check",
      sql`${table.reserveBp} BETWEEN 0 AND 10000 AND ${table.taxWithholdingBp} BETWEEN 0 AND 10000`,
    ),
    check(
      "profit_entities_name_check",
      sql`length(btrim(${table.name})) BETWEEN 1 AND 150`,
    ),
  ],
);

/** `shareholders` (T): a person or company that may hold shares. */
export const shareholders = pgTable(
  "shareholders",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    id: uuid("id").notNull().defaultRandom(),
    /** Login that sees the shareholder dashboard (SH-01); null when none. */
    userId: text("user_id"),
    name: text("name").notNull(),
    type: text("type").$type<"person" | "company">().notNull(),
    status: text("status")
      .$type<"active" | "inactive">()
      .notNull()
      .default("active"),
    npwpSealed: text("npwp_sealed"),
    npwpLast4: varchar("npwp_last4", { length: 4 }),
    payoutBank: text("payout_bank"),
    payoutAccountSealed: text("payout_account_sealed"),
    payoutAccountLast4: varchar("payout_account_last4", { length: 4 }),
    payoutAccountHolder: text("payout_account_holder"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    uniqueIndex("shareholders_tenant_user_key")
      .on(table.tenantId, table.userId)
      .where(sql`${table.userId} IS NOT NULL`),
    check(
      "shareholders_type_check",
      sql`${table.type} IN ('person', 'company')`,
    ),
    check(
      "shareholders_status_check",
      sql`${table.status} IN ('active', 'inactive')`,
    ),
    check(
      "shareholders_name_check",
      sql`length(btrim(${table.name})) BETWEEN 1 AND 150`,
    ),
    check(
      "shareholders_npwp_check",
      sql`(${table.npwpSealed} IS NULL) = (${table.npwpLast4} IS NULL) AND (${table.npwpLast4} IS NULL OR ${table.npwpLast4} ~ '^[0-9]{4}$')`,
    ),
    check(
      "shareholders_payout_check",
      sql`((${table.payoutBank} IS NULL AND ${table.payoutAccountSealed} IS NULL AND ${table.payoutAccountLast4} IS NULL AND ${table.payoutAccountHolder} IS NULL) OR (${table.payoutBank} IS NOT NULL AND ${table.payoutAccountSealed} IS NOT NULL AND ${table.payoutAccountLast4} ~ '^[0-9]{4}$' AND ${table.payoutAccountHolder} IS NOT NULL))`,
    ),
  ],
);

/** `share_allocation_versions` (T): one approval unit of an entity's register. */
export const shareAllocationVersions = pgTable(
  "share_allocation_versions",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    profitEntityId: uuid("profit_entity_id").notNull(),
    version: integer("version").notNull(),
    effectiveFrom: businessDate("effective_from").notNull(),
    status: text("status")
      .$type<
        "draft" | "pending_approval" | "approved" | "rejected" | "cancelled"
      >()
      .notNull()
      .default("draft"),
    requestedBy: text("requested_by").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionNote: text("decision_note"),
    idempotencyKey: text("idempotency_key").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.profitEntityId, table.version],
    }),
    foreignKey({
      name: "share_allocation_versions_entity_fk",
      columns: [table.tenantId, table.profitEntityId],
      foreignColumns: [profitEntities.tenantId, profitEntities.id],
    }),
    unique("share_allocation_versions_tenant_idempotency_key").on(
      table.tenantId,
      table.idempotencyKey,
    ),
    // At most one approved version per entity and effective date.
    uniqueIndex("share_allocation_versions_approved_effective_key")
      .on(table.tenantId, table.profitEntityId, table.effectiveFrom)
      .where(sql`${table.status} = 'approved'`),
    check(
      "share_allocation_versions_version_check",
      sql`${table.version} >= 1`,
    ),
    check(
      "share_allocation_versions_status_check",
      sql`${table.status} IN ('draft', 'pending_approval', 'approved', 'rejected', 'cancelled')`,
    ),
    check(
      "share_allocation_versions_decided_check",
      sql`(${table.status} IN ('approved', 'rejected')) = (${table.decidedBy} IS NOT NULL AND ${table.decidedAt} IS NOT NULL)`,
    ),
    check(
      "share_allocation_versions_note_check",
      sql`(${table.status} <> 'rejected' OR ${table.decisionNote} IS NOT NULL) AND (${table.status} IN ('approved', 'rejected') OR ${table.decisionNote} IS NULL)`,
    ),
    check(
      "share_allocation_versions_four_eyes_check",
      sql`${table.decidedBy} IS NULL OR ${table.decidedBy} <> ${table.requestedBy}`,
    ),
  ],
);

/** `share_allocations` (T): one shareholder's share in one version. */
export const shareAllocations = pgTable(
  "share_allocations",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    id: uuid("id").notNull().defaultRandom(),
    profitEntityId: uuid("profit_entity_id").notNull(),
    version: integer("version").notNull(),
    shareholderId: uuid("shareholder_id").notNull(),
    shareBp: integer("share_bp").notNull(),
    /** Display order as the admin entered it. */
    position: integer("position").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    foreignKey({
      name: "share_allocations_version_fk",
      columns: [table.tenantId, table.profitEntityId, table.version],
      foreignColumns: [
        shareAllocationVersions.tenantId,
        shareAllocationVersions.profitEntityId,
        shareAllocationVersions.version,
      ],
    }),
    foreignKey({
      name: "share_allocations_shareholder_fk",
      columns: [table.tenantId, table.shareholderId],
      foreignColumns: [shareholders.tenantId, shareholders.id],
    }),
    unique("share_allocations_version_shareholder_key").on(
      table.tenantId,
      table.profitEntityId,
      table.version,
      table.shareholderId,
    ),
    index("share_allocations_shareholder_idx").on(
      table.tenantId,
      table.shareholderId,
    ),
    check(
      "share_allocations_share_bp_check",
      sql`${table.shareBp} > 0 AND ${table.shareBp} <= 10000`,
    ),
    check("share_allocations_position_check", sql`${table.position} >= 0`),
  ],
);

/** `distribution_runs` (T): one regular distribution or one adjustment. */
export const distributionRuns = pgTable(
  "distribution_runs",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    id: uuid("id").notNull().defaultRandom(),
    profitEntityId: uuid("profit_entity_id").notNull(),
    fiscalPeriodId: uuid("fiscal_period_id").notNull(),
    /** `fiscal_periods.version` when the run was calculated; a reopen bumps it
     * and approval refuses a run whose period changed (PERIOD_CHANGED). */
    fiscalPeriodVersion: integer("fiscal_period_version").notNull(),
    period: varchar("period", { length: 7 }).notNull(),
    type: text("type").$type<"regular" | "adjustment">().notNull(),
    basis: text("basis")
      .$type<"closed_period_net_profit" | "approved_run_adjustment">()
      .notNull(),
    status: text("status")
      .$type<"draft" | "pending_approval" | "approved" | "paid" | "cancelled">()
      .notNull()
      .default("draft"),
    shareVersion: integer("share_version").notNull(),
    periodNetProfitIdr: idrColumn("period_net_profit_idr"),
    reserveIdr: idrColumn("reserve_idr").notNull(),
    distributableIdr: idrColumn("distributable_idr").notNull(),
    totalGrossIdr: idrColumn("total_gross_idr").notNull(),
    totalTaxWithheldIdr: idrColumn("total_tax_withheld_idr").notNull(),
    totalNetIdr: idrColumn("total_net_idr").notNull(),
    /** Claw-back rest no shareholder's paid gross could absorb (Q83). */
    unabsorbedIdr: idrColumn("unabsorbed_idr").notNull().default(idr(0)),
    /** Policy rate frozen with the run, so a later policy edit changes nothing. */
    taxWithholdingBp: integer("tax_withholding_bp").notNull(),
    requestedBy: text("requested_by").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    cancelledBy: text("cancelled_by"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelReason: text("cancel_reason"),
    adjustsRunId: uuid("adjusts_run_id"),
    adjustmentReason: text("adjustment_reason"),
    /** Journal posted when the run completes (regular, or positive adjustment). */
    journalEntryId: uuid("journal_entry_id"),
    /** SH-04: the reversing journal of a negative (claw-back) adjustment. */
    reversalJournalEntryId: uuid("reversal_journal_entry_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    foreignKey({
      name: "distribution_runs_entity_fk",
      columns: [table.tenantId, table.profitEntityId],
      foreignColumns: [profitEntities.tenantId, profitEntities.id],
    }),
    foreignKey({
      name: "distribution_runs_version_fk",
      columns: [table.tenantId, table.profitEntityId, table.shareVersion],
      foreignColumns: [
        shareAllocationVersions.tenantId,
        shareAllocationVersions.profitEntityId,
        shareAllocationVersions.version,
      ],
    }),
    foreignKey({
      name: "distribution_runs_fiscal_period_fk",
      columns: [table.tenantId, table.fiscalPeriodId],
      foreignColumns: [fiscalPeriods.tenantId, fiscalPeriods.id],
    }),
    foreignKey({
      name: "distribution_runs_adjusts_fk",
      columns: [table.tenantId, table.adjustsRunId],
      foreignColumns: [table.tenantId, table.id],
    }),
    foreignKey({
      name: "distribution_runs_journal_fk",
      columns: [table.tenantId, table.journalEntryId],
      foreignColumns: [journalEntries.tenantId, journalEntries.id],
    }),
    foreignKey({
      name: "distribution_runs_reversal_journal_fk",
      columns: [table.tenantId, table.reversalJournalEntryId],
      foreignColumns: [journalEntries.tenantId, journalEntries.id],
    }),
    unique("distribution_runs_tenant_idempotency_key").on(
      table.tenantId,
      table.idempotencyKey,
    ),
    // One live regular run per entity and closed period (coordinator 1 Nov 2026).
    uniqueIndex("distribution_runs_regular_period_key")
      .on(table.tenantId, table.profitEntityId, table.fiscalPeriodId)
      .where(sql`${table.type} = 'regular' AND ${table.status} <> 'cancelled'`),
    index("distribution_runs_entity_requested_idx").on(
      table.tenantId,
      table.profitEntityId,
      table.requestedAt.desc(),
      table.id,
    ),
    check(
      "distribution_runs_status_check",
      sql`${table.status} IN ('draft', 'pending_approval', 'approved', 'paid', 'cancelled')`,
    ),
    check(
      "distribution_runs_type_basis_check",
      sql`(${table.type} = 'regular' AND ${table.basis} = 'closed_period_net_profit') OR (${table.type} = 'adjustment' AND ${table.basis} = 'approved_run_adjustment')`,
    ),
    check(
      "distribution_runs_period_check",
      sql`${table.period} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`,
    ),
    check(
      "distribution_runs_regular_check",
      sql`${table.type} <> 'regular' OR (${table.periodNetProfitIdr} IS NOT NULL AND ${table.periodNetProfitIdr} > 0 AND ${table.reserveIdr} >= 0 AND ${table.distributableIdr} > 0 AND ${table.periodNetProfitIdr} - ${table.reserveIdr} = ${table.distributableIdr} AND ${table.adjustsRunId} IS NULL AND ${table.adjustmentReason} IS NULL)`,
    ),
    check(
      "distribution_runs_adjustment_check",
      sql`${table.type} <> 'adjustment' OR (${table.periodNetProfitIdr} IS NULL AND ${table.reserveIdr} = 0 AND ${table.distributableIdr} <> 0 AND ${table.adjustsRunId} IS NOT NULL AND ${table.adjustsRunId} <> ${table.id} AND ${table.adjustmentReason} IS NOT NULL)`,
    ),
    check(
      "distribution_runs_totals_check",
      sql`${table.distributableIdr} = ${table.totalGrossIdr} AND ${table.totalGrossIdr} - ${table.totalTaxWithheldIdr} = ${table.totalNetIdr}`,
    ),
    check(
      "distribution_runs_unabsorbed_check",
      sql`${table.unabsorbedIdr} >= 0 AND (${table.unabsorbedIdr} = 0 OR (${table.type} = 'adjustment' AND ${table.distributableIdr} < 0))`,
    ),
    check(
      "distribution_runs_fiscal_period_version_check",
      sql`${table.fiscalPeriodVersion} >= 1`,
    ),
    check(
      "distribution_runs_tax_bp_check",
      sql`${table.taxWithholdingBp} BETWEEN 0 AND 10000`,
    ),
    check(
      "distribution_runs_approved_check",
      sql`(${table.status} IN ('approved', 'paid')) = (${table.approvedBy} IS NOT NULL AND ${table.approvedAt} IS NOT NULL)`,
    ),
    check(
      "distribution_runs_four_eyes_check",
      sql`${table.approvedBy} IS NULL OR ${table.approvedBy} <> ${table.requestedBy}`,
    ),
    check(
      "distribution_runs_paid_check",
      sql`(${table.status} = 'paid') = (${table.paidAt} IS NOT NULL)`,
    ),
    check(
      "distribution_runs_cancelled_check",
      sql`(${table.status} = 'cancelled') = (${table.cancelledBy} IS NOT NULL AND ${table.cancelledAt} IS NOT NULL)`,
    ),
    check(
      "distribution_runs_journal_check",
      sql`(${table.status} <> 'paid' AND ${table.journalEntryId} IS NULL AND ${table.reversalJournalEntryId} IS NULL) OR (${table.status} = 'paid' AND ${table.totalGrossIdr} > 0 AND ${table.journalEntryId} IS NOT NULL AND ${table.reversalJournalEntryId} IS NULL) OR (${table.status} = 'paid' AND ${table.totalGrossIdr} < 0 AND ${table.reversalJournalEntryId} IS NOT NULL AND ${table.journalEntryId} IS NULL)`,
    ),
  ],
);

/** `distribution_lines` (T): one shareholder's part of one run. */
export const distributionLines = pgTable(
  "distribution_lines",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    id: uuid("id").notNull().defaultRandom(),
    distributionRunId: uuid("distribution_run_id").notNull(),
    shareholderId: uuid("shareholder_id").notNull(),
    shareBp: integer("share_bp").notNull(),
    grossIdr: idrColumn("gross_idr").notNull(),
    taxWithheldIdr: idrColumn("tax_withheld_idr").notNull(),
    netIdr: idrColumn("net_idr").notNull(),
    paymentStatus: text("payment_status")
      .$type<"pending" | "paid">()
      .notNull()
      .default("pending"),
    paymentRef: text("payment_ref"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    paidBy: text("paid_by"),
    statementFileKey: text("statement_file_key"),
    /** Canonical allocation order (by shareholder id), as calculated. */
    position: integer("position").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    foreignKey({
      name: "distribution_lines_run_fk",
      columns: [table.tenantId, table.distributionRunId],
      foreignColumns: [distributionRuns.tenantId, distributionRuns.id],
    }),
    foreignKey({
      name: "distribution_lines_shareholder_fk",
      columns: [table.tenantId, table.shareholderId],
      foreignColumns: [shareholders.tenantId, shareholders.id],
    }),
    unique("distribution_lines_run_shareholder_key").on(
      table.tenantId,
      table.distributionRunId,
      table.shareholderId,
    ),
    unique("distribution_lines_statement_key").on(
      table.tenantId,
      table.statementFileKey,
    ),
    index("distribution_lines_shareholder_idx").on(
      table.tenantId,
      table.shareholderId,
    ),
    check(
      "distribution_lines_share_bp_check",
      sql`${table.shareBp} > 0 AND ${table.shareBp} <= 10000`,
    ),
    check(
      "distribution_lines_amounts_check",
      sql`${table.grossIdr} <> 0 AND ${table.grossIdr} - ${table.taxWithheldIdr} = ${table.netIdr} AND sign(${table.taxWithheldIdr}) * sign(${table.grossIdr}) >= 0 AND abs(${table.taxWithheldIdr}) <= abs(${table.grossIdr})`,
    ),
    check(
      "distribution_lines_payment_status_check",
      sql`${table.paymentStatus} IN ('pending', 'paid')`,
    ),
    check(
      "distribution_lines_paid_check",
      sql`(${table.paymentStatus} = 'paid') = (${table.paymentRef} IS NOT NULL AND ${table.paidAt} IS NOT NULL AND ${table.paidBy} IS NOT NULL)`,
    ),
    check(
      "distribution_lines_statement_check",
      sql`${table.statementFileKey} IS NULL OR ${table.paymentStatus} = 'paid'`,
    ),
    check("distribution_lines_position_check", sql`${table.position} >= 0`),
  ],
);

/**
 * `profit_share_commands` (T): idempotency keys of profit-share commands
 * (submit, decide, record payment). Same key + same request replays the
 * current state without a second transition; same key + another request is a
 * 409. Append-only.
 */
export const profitShareCommands = pgTable(
  "profit_share_commands",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    idempotencyKey: text("idempotency_key").notNull(),
    operation: text("operation").notNull(),
    targetId: text("target_id").notNull(),
    fingerprint: text("fingerprint").notNull(),
    actorId: text("actor_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.idempotencyKey] })],
);

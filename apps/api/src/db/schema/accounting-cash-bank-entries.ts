// Cash in/out, bank transfers and the petty cash fund (bead legend-4961, WS-07;
// PRD v1.7 §3.19 "Kas & Bank [P0]"). Wire shapes: `@starter/shared/accounting`
// banking.ts. Design: docs/briefs/ws-cash-bank-design.md.
//
// - `cash_bank_entries`: one document per row, tenant-level (`outlet_id` is an
//   optional cost tag, so there is no outlet RLS). The journal is posted in the
//   same transaction, so `journal_entry_id` is UNIQUE: one document, one
//   journal. A cash_out above the tenant approval limit is stored
//   `pending_approval` with no journal (`journal_entry_id` NULL) and posts on
//   approval (`status = 'approved'` <=> journal present). UNIQUE (tenant, idempotency_key) makes a re-sent
//   request a replay, not a second document.
// - `petty_cash_funds`: one fund per outlet; `balance_idr >= 0` is the last
//   line of defence behind the service's row lock.
// - `petty_cash_entries`: append-only ledger of the fund (top-up, return,
//   purchase). Only the journal link columns may be updated (a parked entry is
//   posted later); the fund balance changes through `petty_cash_funds`.
//
// RLS, grants and revokes live in accounting-cash-bank-entries.custom.sql
// (shipped in 0485).

import { sql } from "drizzle-orm";
import {
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
import {
  businessDate,
  idrColumn,
  outletIdColumn,
  tenantIdColumn,
} from "../columns.ts";
import { chartOfAccounts, journalEntries } from "./accounting.ts";
import { bankAccounts } from "./accounting-cash-bank.ts";
import { legalEntities, outlets, tenants } from "./platform-org.ts";
import { pettyPurchases } from "./petty-purchases.ts";

// ------------------------------------------------------- cash/bank documents

export const cashBankEntries = pgTable(
  "cash_bank_entries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    legalEntityId: uuid("legal_entity_id").notNull(),
    /** Optional cost tag; NULL = the whole legal entity. */
    outletId: outletIdColumn(() => outlets.id),
    kind: varchar("kind", { length: 20 }).notNull(),
    entryDate: businessDate("entry_date").notNull(),
    amountIdr: idrColumn("amount_idr").notNull(),
    bankAccountId: uuid("bank_account_id").notNull(),
    toBankAccountId: uuid("to_bank_account_id"),
    counterAccountId: uuid("counter_account_id"),
    description: varchar("description", { length: 255 }).notNull(),
    reference: varchar("reference", { length: 60 }),
    idempotencyKey: varchar("idempotency_key", { length: 100 }).notNull(),
    /** NULL while `pending_approval` or `rejected`: no journal until approved. */
    journalEntryId: uuid("journal_entry_id"),
    /** `approved` (default, also every legacy row), `pending_approval`, `rejected`. */
    status: varchar("status", { length: 20 }).notNull().default("approved"),
    approverId: text("approver_id"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionReason: varchar("decision_reason", { length: 500 }),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("cash_bank_entries_tenant_id_key").on(t.tenantId, t.id),
    unique("cash_bank_entries_idempotency_key").on(
      t.tenantId,
      t.idempotencyKey,
    ),
    unique("cash_bank_entries_journal_key").on(t.tenantId, t.journalEntryId),
    foreignKey({
      name: "cash_bank_entries_legal_entity_fk",
      columns: [t.tenantId, t.legalEntityId],
      foreignColumns: [legalEntities.tenantId, legalEntities.id],
    }),
    foreignKey({
      name: "cash_bank_entries_outlet_fk",
      columns: [t.tenantId, t.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    // Both bank accounts belong to the same legal entity as the document.
    foreignKey({
      name: "cash_bank_entries_bank_account_fk",
      columns: [t.tenantId, t.legalEntityId, t.bankAccountId],
      foreignColumns: [
        bankAccounts.tenantId,
        bankAccounts.legalEntityId,
        bankAccounts.id,
      ],
    }),
    foreignKey({
      name: "cash_bank_entries_to_bank_account_fk",
      columns: [t.tenantId, t.legalEntityId, t.toBankAccountId],
      foreignColumns: [
        bankAccounts.tenantId,
        bankAccounts.legalEntityId,
        bankAccounts.id,
      ],
    }),
    foreignKey({
      name: "cash_bank_entries_counter_account_fk",
      columns: [t.tenantId, t.legalEntityId, t.counterAccountId],
      foreignColumns: [
        chartOfAccounts.tenantId,
        chartOfAccounts.legalEntityId,
        chartOfAccounts.id,
      ],
    }),
    foreignKey({
      name: "cash_bank_entries_journal_fk",
      columns: [t.tenantId, t.journalEntryId],
      foreignColumns: [journalEntries.tenantId, journalEntries.id],
    }),
    index("cash_bank_entries_list_idx").on(
      t.tenantId,
      t.legalEntityId,
      t.createdAt.desc(),
      t.id.desc(),
    ),
    index("cash_bank_entries_account_idx").on(
      t.tenantId,
      t.bankAccountId,
      t.entryDate,
    ),
    check("cash_bank_entries_amount_check", sql`${t.amountIdr} > 0`),
    check(
      "cash_bank_entries_kind_check",
      sql`${t.kind} IN ('cash_in','cash_out','transfer')`,
    ),
    // A transfer names a different destination and no counter account.
    check(
      "cash_bank_entries_transfer_check",
      sql`(${t.kind} = 'transfer') = (${t.toBankAccountId} IS NOT NULL AND ${t.counterAccountId} IS NULL AND ${t.toBankAccountId} <> ${t.bankAccountId})`,
    ),
    // Cash in/out names a counter account and no destination account.
    check(
      "cash_bank_entries_cash_check",
      sql`(${t.kind} IN ('cash_in','cash_out')) = (${t.counterAccountId} IS NOT NULL AND ${t.toBankAccountId} IS NULL)`,
    ),
    // Founder Q7 (13 Nov 2026): a cash_out above the tenant limit waits for
    // approval. One document, one journal: only an approved entry has one.
    check(
      "cash_bank_entries_status_check",
      sql`${t.status} IN ('pending_approval','approved','rejected')`,
    ),
    check(
      "cash_bank_entries_status_journal_check",
      sql`(${t.status} = 'approved') = (${t.journalEntryId} IS NOT NULL)`,
    ),
    // Only a cash_out can wait for approval or be rejected.
    check(
      "cash_bank_entries_status_kind_check",
      sql`${t.status} = 'approved' OR ${t.kind} = 'cash_out'`,
    ),
    // A pending entry has no decision; a rejected one has the full decision.
    check(
      "cash_bank_entries_decision_check",
      sql`(${t.status} <> 'pending_approval' OR (${t.approverId} IS NULL AND ${t.decidedAt} IS NULL)) AND (${t.status} <> 'rejected' OR (${t.approverId} IS NOT NULL AND ${t.decidedAt} IS NOT NULL AND ${t.decisionReason} IS NOT NULL))`,
    ),
    // Nobody decides their own document (DB-level last line of defence).
    check(
      "cash_bank_entries_distinct_decider_check",
      sql`${t.approverId} IS NULL OR ${t.approverId} <> ${t.createdBy}`,
    ),
  ],
);

// -------------------------------------------------------- petty cash fund

export const pettyCashFunds = pgTable(
  "petty_cash_funds",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    legalEntityId: uuid("legal_entity_id").notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    balanceIdr: idrColumn("balance_idr")
      .notNull()
      .default(sql`0`),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("petty_cash_funds_tenant_id_key").on(t.tenantId, t.id),
    unique("petty_cash_funds_outlet_key").on(t.tenantId, t.outletId),
    // Parent key for the entries' composite FK: an entry shares its fund's outlet.
    unique("petty_cash_funds_tenant_id_outlet_key").on(
      t.tenantId,
      t.id,
      t.outletId,
    ),
    foreignKey({
      name: "petty_cash_funds_legal_entity_fk",
      columns: [t.tenantId, t.legalEntityId],
      foreignColumns: [legalEntities.tenantId, legalEntities.id],
    }),
    foreignKey({
      name: "petty_cash_funds_outlet_fk",
      columns: [t.tenantId, t.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    // A petty cash fund never goes negative.
    check("petty_cash_funds_balance_check", sql`${t.balanceIdr} >= 0`),
  ],
);

export const pettyCashEntries = pgTable(
  "petty_cash_entries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    legalEntityId: uuid("legal_entity_id").notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    fundId: uuid("fund_id").notNull(),
    kind: varchar("kind", { length: 20 }).notNull(),
    amountIdr: idrColumn("amount_idr").notNull(),
    balanceAfterIdr: idrColumn("balance_after_idr").notNull(),
    bankAccountId: uuid("bank_account_id"),
    pettyPurchaseId: uuid("petty_purchase_id"),
    /** Business date of the outlet when the money moved. */
    entryDate: businessDate("entry_date").notNull(),
    description: varchar("description", { length: 255 }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 100 }).notNull(),
    journalStatus: varchar("journal_status", { length: 20 }).notNull(),
    journalEntryId: uuid("journal_entry_id"),
    parkCode: varchar("park_code", { length: 60 }),
    parkAttempts: integer("park_attempts").notNull().default(0),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("petty_cash_entries_tenant_id_key").on(t.tenantId, t.id),
    unique("petty_cash_entries_idempotency_key").on(
      t.tenantId,
      t.idempotencyKey,
    ),
    foreignKey({
      name: "petty_cash_entries_legal_entity_fk",
      columns: [t.tenantId, t.legalEntityId],
      foreignColumns: [legalEntities.tenantId, legalEntities.id],
    }),
    foreignKey({
      name: "petty_cash_entries_outlet_fk",
      columns: [t.tenantId, t.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "petty_cash_entries_fund_fk",
      columns: [t.tenantId, t.fundId, t.outletId],
      foreignColumns: [
        pettyCashFunds.tenantId,
        pettyCashFunds.id,
        pettyCashFunds.outletId,
      ],
    }),
    foreignKey({
      name: "petty_cash_entries_bank_account_fk",
      columns: [t.tenantId, t.legalEntityId, t.bankAccountId],
      foreignColumns: [
        bankAccounts.tenantId,
        bankAccounts.legalEntityId,
        bankAccounts.id,
      ],
    }),
    foreignKey({
      name: "petty_cash_entries_purchase_fk",
      columns: [t.tenantId, t.pettyPurchaseId],
      foreignColumns: [pettyPurchases.tenantId, pettyPurchases.id],
    }),
    foreignKey({
      name: "petty_cash_entries_journal_fk",
      columns: [t.tenantId, t.journalEntryId],
      foreignColumns: [journalEntries.tenantId, journalEntries.id],
    }),
    uniqueIndex("petty_cash_entries_purchase_key")
      .on(t.tenantId, t.pettyPurchaseId)
      .where(sql`${t.pettyPurchaseId} IS NOT NULL`),
    uniqueIndex("petty_cash_entries_journal_key")
      .on(t.tenantId, t.journalEntryId)
      .where(sql`${t.journalEntryId} IS NOT NULL`),
    index("petty_cash_entries_list_idx").on(
      t.tenantId,
      t.outletId,
      t.createdAt.desc(),
      t.id.desc(),
    ),
    index("petty_cash_entries_fund_idx").on(t.tenantId, t.fundId),
    check("petty_cash_entries_amount_check", sql`${t.amountIdr} > 0`),
    check("petty_cash_entries_balance_check", sql`${t.balanceAfterIdr} >= 0`),
    check(
      "petty_cash_entries_kind_check",
      sql`${t.kind} IN ('topup','return','purchase')`,
    ),
    check(
      "petty_cash_entries_status_check",
      sql`${t.journalStatus} IN ('posted','parked','external')`,
    ),
    // A purchase points at its petty purchase, has no bank account, and its
    // journal belongs to petty_purchase.recorded ('external').
    check(
      "petty_cash_entries_purchase_check",
      sql`(${t.kind} = 'purchase') = (${t.pettyPurchaseId} IS NOT NULL AND ${t.bankAccountId} IS NULL AND ${t.journalStatus} = 'external')`,
    ),
    // A top-up/return names its bank account and is posted or parked.
    check(
      "petty_cash_entries_movement_check",
      sql`(${t.kind} IN ('topup','return')) = (${t.bankAccountId} IS NOT NULL AND ${t.journalStatus} IN ('posted','parked'))`,
    ),
    check(
      "petty_cash_entries_posted_check",
      sql`(${t.journalStatus} = 'posted') = (${t.journalEntryId} IS NOT NULL)`,
    ),
    check(
      "petty_cash_entries_parked_check",
      sql`(${t.journalStatus} = 'parked') = (${t.parkCode} IS NOT NULL)`,
    ),
    check("petty_cash_entries_attempts_check", sql`${t.parkAttempts} >= 0`),
  ],
);

export type CashBankEntryRow = typeof cashBankEntries.$inferSelect;
export type PettyCashFundRow = typeof pettyCashFunds.$inferSelect;
export type PettyCashEntryRow = typeof pettyCashEntries.$inferSelect;

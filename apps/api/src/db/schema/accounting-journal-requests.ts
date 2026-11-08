// Manual and recurring journal requests (PRD v1.7 §3.19 "Jurnal Manual &
// Berulang"; ACC-01/ACC-02; AUTH-06; bead legend-vmyg).
//
// These tables hold REQUESTS, never ledger rows. A manual journal or a
// recurring template becomes a `journal_entries` row only after approval by
// someone other than the requester (`approval_requests`, action
// `manual_journal`). The ledger itself stays append-only (accounting.ts).
//
// (T) tables: tenant_id NOT NULL, RLS FORCE via app.enforce_tenant_rls in the
// companion migration, every unique key includes tenant_id, children reach
// their parents through (tenant_id, …) composite keys. outlet_id is nullable
// (entity-level journals), so the tenant policy plus the service-layer outlet
// filter apply, like journal_entries (contracts.md "Which tables").
//
// Idempotency:
// - create: UNIQUE (tenant_id, idempotency_key) + request fingerprint;
// - recurring generation: UNIQUE (tenant_id, recurring_journal_id, period) on
//   `recurring_journal_runs`, so a re-run or a second worker never posts the
//   same template twice for one month.

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
import type {
  JournalLineInput,
  ManualJournalStatus,
  RecurringJournalStatus,
} from "@starter/shared/accounting";
import { businessDate } from "../columns";
import { journalEntries } from "./accounting";
import { legalEntities, outlets, tenants } from "./platform-org";

/** `manual_journals` (T): jurnal umum / penyesuaian awaiting approval. */
export const manualJournals = pgTable(
  "manual_journals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    legalEntityId: uuid("legal_entity_id").notNull(),
    outletId: uuid("outlet_id"),
    entryDate: businessDate("entry_date").notNull(),
    kind: varchar("kind", { length: 12 })
      .$type<"general" | "adjustment">()
      .notNull(),
    description: varchar("description", { length: 255 }).notNull(),
    /** Balanced request lines (validated by the shared contract on write). */
    lines: jsonb("lines").$type<JournalLineInput[]>().notNull(),
    status: varchar("status", { length: 20 })
      .$type<ManualJournalStatus>()
      .notNull()
      .default("draft"),
    requestedBy: text("requested_by").notNull(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    rejectionReason: varchar("rejection_reason", { length: 500 }),
    postedEntryId: uuid("posted_entry_id"),
    /** Open approval chain (approval_requests.chain_id) while pending. */
    approvalChainId: uuid("approval_chain_id"),
    idempotencyKey: varchar("idempotency_key", { length: 100 }).notNull(),
    requestFingerprint: varchar("request_fingerprint", {
      length: 64,
    }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("manual_journals_tenant_id_key").on(table.tenantId, table.id),
    unique("manual_journals_tenant_idempotency_key").on(
      table.tenantId,
      table.idempotencyKey,
    ),
    // One manual journal posts one ledger entry, at most once.
    unique("manual_journals_tenant_posted_entry_key").on(
      table.tenantId,
      table.postedEntryId,
    ),
    foreignKey({
      name: "manual_journals_legal_entity_fk",
      columns: [table.tenantId, table.legalEntityId],
      foreignColumns: [legalEntities.tenantId, legalEntities.id],
    }),
    foreignKey({
      name: "manual_journals_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "manual_journals_posted_entry_fk",
      columns: [table.tenantId, table.postedEntryId],
      foreignColumns: [journalEntries.tenantId, journalEntries.id],
    }),
    check(
      "manual_journals_status_check",
      sql`${table.status} IN ('draft', 'pending_approval', 'rejected', 'cancelled', 'posted')`,
    ),
    check(
      "manual_journals_kind_check",
      sql`${table.kind} IN ('general', 'adjustment')`,
    ),
    check(
      "manual_journals_posted_check",
      sql`(${table.status} = 'posted') = (${table.postedEntryId} IS NOT NULL)`,
    ),
    check(
      "manual_journals_rejected_check",
      sql`(${table.status} = 'rejected') = (${table.rejectionReason} IS NOT NULL)`,
    ),
    // AUTH-06: the decider is never the requester.
    check(
      "manual_journals_distinct_decider_check",
      sql`${table.decidedBy} IS NULL OR ${table.decidedBy} <> ${table.requestedBy}`,
    ),
    check(
      "manual_journals_description_check",
      sql`length(btrim(${table.description})) > 0`,
    ),
    index("manual_journals_entity_status_idx").on(
      table.tenantId,
      table.legalEntityId,
      table.status,
      table.createdAt.desc(),
      table.id.desc(),
    ),
    index("manual_journals_chain_idx").on(
      table.tenantId,
      table.approvalChainId,
    ),
  ],
);

/** `recurring_journals` (T): monthly template, approved once. */
export const recurringJournals = pgTable(
  "recurring_journals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    legalEntityId: uuid("legal_entity_id").notNull(),
    outletId: uuid("outlet_id"),
    description: varchar("description", { length: 255 }).notNull(),
    lines: jsonb("lines").$type<JournalLineInput[]>().notNull(),
    frequency: varchar("frequency", { length: 10 })
      .$type<"monthly">()
      .notNull()
      .default("monthly"),
    dayOfMonth: integer("day_of_month").notNull(),
    startPeriod: varchar("start_period", { length: 7 }).notNull(),
    endPeriod: varchar("end_period", { length: 7 }),
    status: varchar("status", { length: 20 })
      .$type<RecurringJournalStatus>()
      .notNull()
      .default("draft"),
    requestedBy: text("requested_by").notNull(),
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    rejectionReason: varchar("rejection_reason", { length: 500 }),
    lastGeneratedPeriod: varchar("last_generated_period", { length: 7 }),
    approvalChainId: uuid("approval_chain_id"),
    idempotencyKey: varchar("idempotency_key", { length: 100 }).notNull(),
    requestFingerprint: varchar("request_fingerprint", {
      length: 64,
    }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("recurring_journals_tenant_id_key").on(table.tenantId, table.id),
    unique("recurring_journals_tenant_idempotency_key").on(
      table.tenantId,
      table.idempotencyKey,
    ),
    foreignKey({
      name: "recurring_journals_legal_entity_fk",
      columns: [table.tenantId, table.legalEntityId],
      foreignColumns: [legalEntities.tenantId, legalEntities.id],
    }),
    foreignKey({
      name: "recurring_journals_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    check(
      "recurring_journals_status_check",
      sql`${table.status} IN ('draft', 'pending_approval', 'rejected', 'active', 'paused', 'ended')`,
    ),
    check(
      "recurring_journals_frequency_check",
      sql`${table.frequency} = 'monthly'`,
    ),
    check(
      "recurring_journals_day_check",
      sql`${table.dayOfMonth} BETWEEN 1 AND 31`,
    ),
    check(
      "recurring_journals_period_check",
      sql`${table.startPeriod} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' AND (${table.endPeriod} IS NULL OR (${table.endPeriod} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' AND ${table.endPeriod} >= ${table.startPeriod}))`,
    ),
    check(
      "recurring_journals_approved_check",
      sql`${table.status} NOT IN ('active', 'paused', 'ended') OR (${table.approvedBy} IS NOT NULL AND ${table.approvedAt} IS NOT NULL)`,
    ),
    // AUTH-06: the approver is never the requester.
    check(
      "recurring_journals_distinct_approver_check",
      sql`${table.approvedBy} IS NULL OR ${table.approvedBy} <> ${table.requestedBy}`,
    ),
    check(
      "recurring_journals_description_check",
      sql`length(btrim(${table.description})) > 0`,
    ),
    index("recurring_journals_entity_status_idx").on(
      table.tenantId,
      table.legalEntityId,
      table.status,
    ),
    index("recurring_journals_chain_idx").on(
      table.tenantId,
      table.approvalChainId,
    ),
  ],
);

/**
 * `recurring_journal_runs` (T): one row per template + month that was handled:
 * posted (journal_entry_id) or skipped by an operator (skipped_by + reason).
 * The UNIQUE key is the guard against double generation (re-run, two workers).
 */
export const recurringJournalRuns = pgTable(
  "recurring_journal_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    recurringJournalId: uuid("recurring_journal_id").notNull(),
    period: varchar("period", { length: 7 }).notNull(),
    // Null on an operator skip of a closed month (then skipped_by is set).
    journalEntryId: uuid("journal_entry_id"),
    skippedBy: text("skipped_by"),
    skipReason: varchar("skip_reason", { length: 500 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("recurring_journal_runs_tenant_template_period_key").on(
      table.tenantId,
      table.recurringJournalId,
      table.period,
    ),
    unique("recurring_journal_runs_tenant_entry_key").on(
      table.tenantId,
      table.journalEntryId,
    ),
    foreignKey({
      name: "recurring_journal_runs_template_fk",
      columns: [table.tenantId, table.recurringJournalId],
      foreignColumns: [recurringJournals.tenantId, recurringJournals.id],
    }),
    foreignKey({
      name: "recurring_journal_runs_entry_fk",
      columns: [table.tenantId, table.journalEntryId],
      foreignColumns: [journalEntries.tenantId, journalEntries.id],
    }),
    check(
      "recurring_journal_runs_period_check",
      sql`${table.period} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`,
    ),
    check(
      "recurring_journal_runs_posted_or_skipped_check",
      sql`(${table.journalEntryId} IS NOT NULL) <> (${table.skippedBy} IS NOT NULL)`,
    ),
  ],
);

// Payroll disbursement (founder decisions Q15-Q17, design
// docs/design/payroll-disbursement.md sections 4-6; bead legend-wnkep.1).
//
// - `payroll_payout_configs`: how one legal entity pays net pay. `duitku` is
//   stored but not usable in this slice (the adapter is legend-wnkep.3), so
//   only `manual_bank` can be enabled for a real batch.
// - `payroll_disbursement_batches` / `payroll_disbursement_items`: one batch
//   per run and channel, one item per payslip attempt. Money rules R1, R5,
//   R7, R10, R11 are enforced here in the database (partial unique indexes,
//   CHECKs, triggers); the services only choose the happy path.
//
// Every amount that shows one person's pay is sealed (lib/payroll-sealed.ts,
// bytea + pii_key_version). RLS, grants and triggers live in the migrations
// 0343-0346 (no DELETE for the app role: a disbursement row is never erased).
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { UserId } from "@starter/shared/core";
import type { PayrollRunId, PayslipId } from "@starter/shared/hris/payroll";
import { idrColumn, tenantIdColumn } from "../columns.ts";
import { bankAccounts } from "./accounting-cash-bank.ts";
import { employees } from "./hris.ts";
import { payrollRuns, payslipBankSnapshots, payslips } from "./payroll.ts";
import { tenantIntegrations } from "./platform-integrations";
import { legalEntities, tenants } from "./platform-org.ts";

/** Sealed envelope bytes (version | nonce | tag | ciphertext). */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
/** Actor reference without a foreign key: history outlives the account. */
const actor = (name: string) => text(name).$type<UserId>();

const inList = (values: readonly string[]) =>
  sql.raw(values.map((value) => `'${value}'`).join(", "));

/** `doit` is deliberately absent: the founder deferred that provider. */
export const PAYOUT_METHODS = ["duitku", "manual_bank"] as const;
export type PayoutMethod = (typeof PAYOUT_METHODS)[number];
const PAYOUT_BANK_FORMATS = [
  "generic_csv",
  "bca",
  "mandiri",
  "bni",
  "bjb",
] as const;

// ------------------------------------------------------------- configuration

export const payrollPayoutConfigs = pgTable(
  "payroll_payout_configs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    legalEntityId: uuid("legal_entity_id").notNull(),
    method: varchar("method", { length: 12 }).$type<PayoutMethod>().notNull(),
    /** Sealed Duitku disbursement credentials; set only for `duitku`. */
    integrationId: uuid("integration_id"),
    /** The company account debited by the manual bank file. */
    manualSourceBankAccountId: uuid("manual_source_bank_account_id").notNull(),
    manualBankFormat: varchar("manual_bank_format", { length: 12 })
      .notNull()
      .default("generic_csv"),
    maxPerTransferIdr: idrColumn("max_per_transfer_idr")
      .notNull()
      .default(sql`50000000`),
    dailyCapIdr: idrColumn("daily_cap_idr"),
    /** Bank fee borne by the company, never taken from net pay (Q15). */
    feePerTransferIdr: idrColumn("fee_per_transfer_idr")
      .notNull()
      .default(sql`5000`),
    enabled: boolean("enabled").notNull().default(false),
    updatedBy: actor("updated_by").notNull(),
    updatedAt: updatedAt(),
    createdAt: createdAt(),
  },
  (table) => [
    unique("payroll_payout_configs_tenant_id_key").on(table.tenantId, table.id),
    unique("payroll_payout_configs_tenant_entity_key").on(
      table.tenantId,
      table.legalEntityId,
    ),
    foreignKey({
      name: "payroll_payout_configs_legal_entity_fk",
      columns: [table.tenantId, table.legalEntityId],
      foreignColumns: [legalEntities.tenantId, legalEntities.id],
    }),
    foreignKey({
      name: "payroll_payout_configs_integration_fk",
      columns: [table.integrationId],
      foreignColumns: [tenantIntegrations.id],
    }),
    foreignKey({
      name: "payroll_payout_configs_source_account_fk",
      columns: [
        table.tenantId,
        table.legalEntityId,
        table.manualSourceBankAccountId,
      ],
      foreignColumns: [
        bankAccounts.tenantId,
        bankAccounts.legalEntityId,
        bankAccounts.id,
      ],
    }),
    check(
      "payroll_payout_configs_method_check",
      sql`${table.method} IN (${inList(PAYOUT_METHODS)})`,
    ),
    check(
      "payroll_payout_configs_integration_check",
      sql`(${table.method} = 'duitku') = (${table.integrationId} IS NOT NULL)`,
    ),
    check(
      "payroll_payout_configs_bank_format_check",
      sql`${table.manualBankFormat} IN (${inList(PAYOUT_BANK_FORMATS)})`,
    ),
    check(
      "payroll_payout_configs_max_per_transfer_check",
      sql`${table.maxPerTransferIdr} > 0 AND ${table.maxPerTransferIdr} <= 100000000`,
    ),
    check(
      "payroll_payout_configs_daily_cap_check",
      sql`${table.dailyCapIdr} IS NULL OR ${table.dailyCapIdr} > 0`,
    ),
    check(
      "payroll_payout_configs_fee_check",
      sql`${table.feePerTransferIdr} >= 0`,
    ),
  ],
);

// ------------------------------------------------------------------- batches

export const PAYOUT_CHANNELS = ["duitku", "manual_bank", "cash"] as const;
export type PayoutChannel = (typeof PAYOUT_CHANNELS)[number];
export const PAYOUT_BATCH_STATUSES = [
  "draft",
  "pending_approval",
  "approved",
  "sending",
  "exported",
  "completed",
  "partially_failed",
  "halted",
  "cancelled",
] as const;
export type PayoutBatchStatus = (typeof PAYOUT_BATCH_STATUSES)[number];
const PAYOUT_HALT_REASONS = [
  "insufficient_balance",
  "daily_cap",
  "provider_down",
  "kill_switch",
  "config_disabled",
] as const;
const SHA256_FORMAT = "'^[a-f0-9]{64}$'";

export const payrollDisbursementBatches = pgTable(
  "payroll_disbursement_batches",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    legalEntityId: uuid("legal_entity_id").notNull(),
    payrollRunId: uuid("payroll_run_id").$type<PayrollRunId>().notNull(),
    channel: varchar("channel", { length: 12 })
      .$type<PayoutChannel>()
      .notNull(),
    status: varchar("status", { length: 16 })
      .$type<PayoutBatchStatus>()
      .notNull()
      .default("draft"),
    haltReason: varchar("halt_reason", { length: 24 }),
    requestedBy: actor("requested_by").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    approvedBy: actor("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvalExpiresAt: timestamp("approval_expires_at", { withTimezone: true }),
    /** SHA-256 of the ordered items; approval stores the hash it saw. */
    contentHash: varchar("content_hash", { length: 64 }),
    itemCount: integer("item_count").notNull().default(0),
    /** Sealed batch totals (a one-person batch would show that salary). */
    totalsEncrypted: bytea("totals_encrypted").notNull(),
    piiKeyVersion: smallint("pii_key_version").notNull(),
    /** Format of the manual bank file (null for other channels). */
    bankFormat: varchar("bank_format", { length: 12 }),
    /**
     * The company bank account this batch pays from, frozen at approve (or at
     * export for a batch approved before the column existed). A later change of
     * the config never moves an old batch. Null: a legacy or cash batch.
     */
    sourceBankAccountId: uuid("source_bank_account_id"),
    exportChecksumSha256: varchar("export_checksum_sha256", { length: 64 }),
    exportedBy: actor("exported_by"),
    exportedAt: timestamp("exported_at", { withTimezone: true }),
    cancelledBy: actor("cancelled_by"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledReason: varchar("cancelled_reason", { length: 500 }),
    workerLeaseUntil: timestamp("worker_lease_until", { withTimezone: true }),
    workerId: varchar("worker_id", { length: 64 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("payroll_disbursement_batches_tenant_id_key").on(
      table.tenantId,
      table.id,
    ),
    // Lets an item prove it carries its batch's run and channel.
    unique("payroll_disbursement_batches_tenant_run_channel_id_key").on(
      table.tenantId,
      table.id,
      table.payrollRunId,
      table.channel,
    ),
    // R1/R14: one open batch per run and channel.
    uniqueIndex("payroll_disbursement_batches_one_open_per_run_channel")
      .on(table.tenantId, table.payrollRunId, table.channel)
      .where(
        sql`${table.status} NOT IN ('completed', 'partially_failed', 'cancelled')`,
      ),
    index("payroll_disbursement_batches_tenant_run_idx").on(
      table.tenantId,
      table.payrollRunId,
    ),
    index("payroll_disbursement_batches_tenant_entity_status_idx").on(
      table.tenantId,
      table.legalEntityId,
      table.status,
    ),
    foreignKey({
      name: "payroll_disbursement_batches_legal_entity_fk",
      columns: [table.tenantId, table.legalEntityId],
      foreignColumns: [legalEntities.tenantId, legalEntities.id],
    }),
    foreignKey({
      name: "payroll_disbursement_batches_run_fk",
      columns: [table.tenantId, table.payrollRunId],
      foreignColumns: [payrollRuns.tenantId, payrollRuns.id],
    }),
    foreignKey({
      name: "payroll_disbursement_batches_source_account_fk",
      columns: [table.tenantId, table.legalEntityId, table.sourceBankAccountId],
      foreignColumns: [
        bankAccounts.tenantId,
        bankAccounts.legalEntityId,
        bankAccounts.id,
      ],
    }),
    check(
      "payroll_disbursement_batches_channel_check",
      sql`${table.channel} IN (${inList(PAYOUT_CHANNELS)})`,
    ),
    check(
      "payroll_disbursement_batches_status_check",
      sql`${table.status} IN (${inList(PAYOUT_BATCH_STATUSES)})`,
    ),
    check(
      "payroll_disbursement_batches_halt_reason_check",
      sql`(${table.status} = 'halted') = (${table.haltReason} IS NOT NULL) AND (${table.haltReason} IS NULL OR ${table.haltReason} IN (${inList(PAYOUT_HALT_REASONS)}))`,
    ),
    // R5: two people. The approver is never the requester.
    check(
      "payroll_disbursement_batches_approver_check",
      sql`${table.approvedBy} IS NULL OR ${table.approvedBy} <> ${table.requestedBy}`,
    ),
    check(
      "payroll_disbursement_batches_approval_state_check",
      sql`(${table.approvedBy} IS NULL) = (${table.approvedAt} IS NULL) AND (${table.approvedBy} IS NULL) = (${table.approvalExpiresAt} IS NULL)`,
    ),
    check(
      "payroll_disbursement_batches_approved_state_check",
      sql`${table.status} NOT IN ('approved', 'sending', 'exported', 'completed', 'partially_failed') OR (${table.approvedBy} IS NOT NULL AND ${table.contentHash} IS NOT NULL)`,
    ),
    check(
      "payroll_disbursement_batches_submitted_hash_check",
      sql`${table.status} IN ('draft', 'cancelled') OR ${table.contentHash} IS NOT NULL`,
    ),
    check(
      "payroll_disbursement_batches_content_hash_check",
      sql`${table.contentHash} IS NULL OR ${table.contentHash} ~ ${sql.raw(SHA256_FORMAT)}`,
    ),
    check(
      "payroll_disbursement_batches_item_count_check",
      sql`${table.itemCount} >= 0`,
    ),
    check(
      "payroll_disbursement_batches_key_version_check",
      sql`${table.piiKeyVersion} >= 1`,
    ),
    check(
      "payroll_disbursement_batches_bank_format_check",
      sql`${table.bankFormat} IS NULL OR (${table.channel} = 'manual_bank' AND ${table.bankFormat} IN (${inList(PAYOUT_BANK_FORMATS)}))`,
    ),
    check(
      "payroll_disbursement_batches_export_state_check",
      sql`((${table.exportChecksumSha256} IS NULL) = (${table.exportedAt} IS NULL)) AND ((${table.exportedBy} IS NULL) = (${table.exportedAt} IS NULL)) AND (${table.exportChecksumSha256} IS NULL OR (${table.channel} = 'manual_bank' AND ${table.exportChecksumSha256} ~ ${sql.raw(SHA256_FORMAT)})) AND (${table.status} <> 'exported' OR ${table.exportedAt} IS NOT NULL)`,
    ),
    check(
      "payroll_disbursement_batches_cancel_state_check",
      sql`(${table.status} = 'cancelled') = (${table.cancelledAt} IS NOT NULL) AND (${table.cancelledBy} IS NULL) = (${table.cancelledAt} IS NULL) AND (${table.cancelledReason} IS NULL OR ${table.cancelledAt} IS NOT NULL)`,
    ),
  ],
);

// ------------------------------------------------------------- GL postings

export const PAYOUT_POSTING_KINDS = [
  "settle",
  "settle_pending",
  "settle_skipped",
  "return",
  "overpaid",
] as const;
export type PayoutPostingKind = (typeof PAYOUT_POSTING_KINDS)[number];

/**
 * One row per group of items settled by one journal (design 4.6, legend-658).
 * `journal_key` equals the idempotency key of the journal entry
 * (`payroll-payout:<item_set_hash>`); a `settle_skipped` row has no journal
 * (the run had no locked entry) and is kept so the same items never retry.
 * A `settle_pending` row (legend-2aspe) has no journal yet either: accounting
 * is on and the run's `payroll.locked` event is still waiting in the outbox.
 * The GL consumer resolves it when the locked journal posts (journal under the
 * same key, kind flipped to `settle`).
 * Items point at their row through `payroll_disbursement_items.gl_posting_id`.
 */
export const payrollPayoutGlPostings = pgTable(
  "payroll_payout_gl_postings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    batchId: uuid("batch_id").notNull(),
    kind: varchar("kind", { length: 14 }).$type<PayoutPostingKind>().notNull(),
    /** SHA-256 of the sorted item ids of the group. */
    itemSetHash: varchar("item_set_hash", { length: 64 }).notNull(),
    journalKey: varchar("journal_key", { length: 100 }).notNull(),
    /** Sealed `{ netIdr, feeIdr, itemCount }` of the group. */
    totalEncrypted: bytea("total_encrypted").notNull(),
    piiKeyVersion: smallint("pii_key_version").notNull(),
    postedAt: timestamp("posted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /**
     * False when the bank fee of the group was not journaled (bank charges
     * mapping or source account missing at settle). Finance re-posts it once
     * (`repostSkippedFees`); the fee journal key is `payroll-payout-fee:<hash>`.
     */
    feePosted: boolean("fee_posted").notNull().default(true),
  },
  (table) => [
    unique("payroll_payout_gl_postings_tenant_id_key").on(
      table.tenantId,
      table.id,
    ),
    unique("payroll_payout_gl_postings_tenant_batch_id_key").on(
      table.tenantId,
      table.batchId,
      table.id,
    ),
    unique("payroll_payout_gl_postings_journal_key").on(
      table.tenantId,
      table.journalKey,
    ),
    index("payroll_payout_gl_postings_tenant_batch_idx").on(
      table.tenantId,
      table.batchId,
    ),
    foreignKey({
      name: "payroll_payout_gl_postings_batch_fk",
      columns: [table.tenantId, table.batchId],
      foreignColumns: [
        payrollDisbursementBatches.tenantId,
        payrollDisbursementBatches.id,
      ],
    }),
    check(
      "payroll_payout_gl_postings_kind_check",
      sql`${table.kind} IN (${inList(PAYOUT_POSTING_KINDS)})`,
    ),
    check(
      "payroll_payout_gl_postings_hash_check",
      sql`${table.itemSetHash} ~ ${sql.raw(SHA256_FORMAT)}`,
    ),
    check(
      "payroll_payout_gl_postings_key_version_check",
      sql`${table.piiKeyVersion} >= 1`,
    ),
  ],
);

// ------------------------------------------------------------- return claims

export const PAYOUT_RETURN_CLAIM_STATUSES = ["open", "consumed"] as const;
export type PayoutReturnClaimStatus =
  (typeof PAYOUT_RETURN_CLAIM_STATUSES)[number];

/**
 * A return payment proof is bound to ONE return operation (legend-w3691): the
 * claim ties the stored proof (`evidence_key`) to the item set of the request
 * that first used it. Step one of the two-person return creates it `open`,
 * step two consumes it atomically in the same transaction that moves the items
 * to `returned`. A different item set, or a consumed claim, can never reuse the
 * key (`UNIQUE (tenant_id, evidence_key)`), so one transfer's proof cannot
 * release another person's payslip for a second payment. No amount is stored:
 * the items' own sealed amounts are frozen and the hash fixes the item set.
 */
export const payrollPayoutReturnClaims = pgTable(
  "payroll_payout_return_claims",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    batchId: uuid("batch_id").notNull(),
    evidenceKey: varchar("evidence_key", { length: 500 }).notNull(),
    /** SHA-256 of the sorted item ids of the return request. */
    itemSetHash: varchar("item_set_hash", { length: 64 }).notNull(),
    status: varchar("status", { length: 8 })
      .$type<PayoutReturnClaimStatus>()
      .notNull()
      .default("open"),
    createdBy: actor("created_by").notNull(),
    createdAt: createdAt(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (table) => [
    unique("payroll_payout_return_claims_tenant_id_key").on(
      table.tenantId,
      table.id,
    ),
    unique("payroll_payout_return_claims_tenant_batch_id_key").on(
      table.tenantId,
      table.batchId,
      table.id,
    ),
    unique("payroll_payout_return_claims_evidence_key").on(
      table.tenantId,
      table.evidenceKey,
    ),
    index("payroll_payout_return_claims_tenant_batch_idx").on(
      table.tenantId,
      table.batchId,
    ),
    foreignKey({
      name: "payroll_payout_return_claims_batch_fk",
      columns: [table.tenantId, table.batchId],
      foreignColumns: [
        payrollDisbursementBatches.tenantId,
        payrollDisbursementBatches.id,
      ],
    }),
    check(
      "payroll_payout_return_claims_status_check",
      sql`${table.status} IN (${inList(PAYOUT_RETURN_CLAIM_STATUSES)})`,
    ),
    check(
      "payroll_payout_return_claims_hash_check",
      sql`${table.itemSetHash} ~ ${sql.raw(SHA256_FORMAT)}`,
    ),
    check(
      "payroll_payout_return_claims_consumed_check",
      sql`(${table.status} = 'open' AND ${table.consumedAt} IS NULL) OR (${table.status} = 'consumed' AND ${table.consumedAt} IS NOT NULL)`,
    ),
  ],
);

// --------------------------------------------------------------------- items

export const PAYOUT_ITEM_STATUSES = [
  "prepared",
  "blocked",
  "approved",
  "sending",
  "exported",
  "unknown",
  "succeeded",
  "failed",
  "not_sent",
  "cancelled",
  "returned",
  "overpaid",
] as const;
export type PayoutItemStatus = (typeof PAYOUT_ITEM_STATUSES)[number];
/** Statuses that hold a payslip's slot (design 4.3): one live item per slip. */
export const PAYOUT_LIVE_ITEM_STATUSES = [
  "prepared",
  "blocked",
  "approved",
  "sending",
  "exported",
  "unknown",
  "succeeded",
] as const;
const PAYOUT_EXCLUDED_REASONS = [
  "inquiry_failed",
  "name_mismatch",
  "bank_code_missing",
  "bank_format_unsupported",
  "over_cap",
] as const;

export const payrollDisbursementItems = pgTable(
  "payroll_disbursement_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    batchId: uuid("batch_id").notNull(),
    payrollRunId: uuid("payroll_run_id").$type<PayrollRunId>().notNull(),
    payslipId: uuid("payslip_id").$type<PayslipId>().notNull(),
    employeeId: uuid("employee_id").notNull(),
    channel: varchar("channel", { length: 12 })
      .$type<PayoutChannel>()
      .notNull(),
    attemptNo: integer("attempt_no").notNull(),
    /** `payslip:<payslipId>:attempt:<n>`, unique per tenant (R1). */
    idempotencyKey: varchar("idempotency_key", { length: 100 }).notNull(),
    /** Net pay, whole rupiah, sealed. Never reduced by the bank fee (Q15). */
    amountEncrypted: bytea("amount_encrypted").notNull(),
    piiKeyVersion: smallint("pii_key_version").notNull(),
    /** Bank fee borne by the company, sealed (0 for cash). */
    feeIdrEncrypted: bytea("fee_idr_encrypted").notNull(),
    /** Frozen payee bank data; the account number is not copied. Null: cash. */
    bankSnapshotId: uuid("bank_snapshot_id"),
    /**
     * Payee name and masked account number (`****1234`) copied from the
     * snapshot when the item is created, so a batch view can show who is paid
     * without opening the sealed snapshot. The full number is never stored here.
     * Null: cash, and items from before these columns existed. Frozen by a
     * trigger after insert.
     */
    accountHolderName: varchar("account_holder_name", { length: 150 }),
    maskedAccountNumber: varchar("masked_account_number", { length: 20 }),
    /** BI bank code (3 digits, not secret), copied from the snapshot. */
    bankCode: varchar("bank_code", { length: 3 }),
    inquiryAccountNameEncrypted: bytea("inquiry_account_name_encrypted"),
    nameMatch: varchar("name_match", { length: 10 }),
    status: varchar("status", { length: 12 })
      .$type<PayoutItemStatus>()
      .notNull()
      .default("prepared"),
    excludedReason: varchar("excluded_reason", { length: 24 }),
    providerRef: varchar("provider_ref", { length: 100 }),
    custRefNumber: varchar("cust_ref_number", { length: 9 }),
    lastResponseCode: varchar("last_response_code", { length: 16 }),
    failureClass: varchar("failure_class", { length: 20 }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    returnedAt: timestamp("returned_at", { withTimezone: true }),
    confirmedBy: actor("confirmed_by"),
    confirmationRef: varchar("confirmation_ref", { length: 100 }),
    confirmationEvidenceKey: varchar("confirmation_evidence_key", {
      length: 500,
    }),
    resolvedBy: actor("resolved_by"),
    resolvedBy2: actor("resolved_by_2"),
    resolutionNote: varchar("resolution_note", { length: 500 }),
    /**
     * Proposed manual outcome of an exported item (`failed` or `not_sent`),
     * recorded by the first resolver; the second resolver must confirm the
     * same outcome before the item moves (H2).
     */
    resolutionOutcome: text("resolution_outcome").$type<
      "failed" | "not_sent"
    >(),
    resolutionEvidenceKey: varchar("resolution_evidence_key", { length: 500 }),
    /** Group journal link, set once when the item is settled (legend-658). */
    glPostingId: uuid("gl_posting_id"),
    /**
     * Two-person return of a paid item (funds came back, design 7.8): the
     * first person records the proposal and the evidence, the second, a
     * different non-requester, moves the item `succeeded -> returned`.
     */
    returnedBy: actor("returned_by"),
    returnedBy2: actor("returned_by_2"),
    returnEvidenceKey: varchar("return_evidence_key", { length: 500 }),
    returnNote: varchar("return_note", { length: 500 }),
    /** The return operation whose proof this return belongs to (w3691). */
    returnClaimId: uuid("return_claim_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("payroll_disbursement_items_tenant_id_key").on(
      table.tenantId,
      table.id,
    ),
    unique("payroll_disbursement_items_idempotency_key").on(
      table.tenantId,
      table.idempotencyKey,
    ),
    unique("payroll_disbursement_items_payslip_attempt_key").on(
      table.tenantId,
      table.payslipId,
      table.attemptNo,
    ),
    // R1: never two live attempts for one payslip, and no new attempt after
    // one succeeded. A new attempt needs failed/not_sent/cancelled/returned.
    uniqueIndex("payroll_disbursement_items_one_live_per_payslip")
      .on(table.tenantId, table.payslipId)
      .where(sql`${table.status} IN (${inList(PAYOUT_LIVE_ITEM_STATUSES)})`),
    index("payroll_disbursement_items_tenant_batch_idx").on(
      table.tenantId,
      table.batchId,
    ),
    index("payroll_disbursement_items_tenant_run_idx").on(
      table.tenantId,
      table.payrollRunId,
    ),
    index("payroll_disbursement_items_tenant_status_idx").on(
      table.tenantId,
      table.status,
    ),
    foreignKey({
      name: "payroll_disbursement_items_batch_fk",
      columns: [
        table.tenantId,
        table.batchId,
        table.payrollRunId,
        table.channel,
      ],
      foreignColumns: [
        payrollDisbursementBatches.tenantId,
        payrollDisbursementBatches.id,
        payrollDisbursementBatches.payrollRunId,
        payrollDisbursementBatches.channel,
      ],
    }),
    foreignKey({
      name: "payroll_disbursement_items_payslip_fk",
      columns: [table.tenantId, table.payslipId],
      foreignColumns: [payslips.tenantId, payslips.id],
    }),
    foreignKey({
      name: "payroll_disbursement_items_employee_fk",
      columns: [table.tenantId, table.employeeId],
      foreignColumns: [employees.tenantId, employees.id],
    }),
    foreignKey({
      name: "payroll_disbursement_items_gl_posting_fk",
      columns: [table.tenantId, table.batchId, table.glPostingId],
      foreignColumns: [
        payrollPayoutGlPostings.tenantId,
        payrollPayoutGlPostings.batchId,
        payrollPayoutGlPostings.id,
      ],
    }),
    foreignKey({
      name: "payroll_disbursement_items_return_claim_fk",
      columns: [table.tenantId, table.batchId, table.returnClaimId],
      foreignColumns: [
        payrollPayoutReturnClaims.tenantId,
        payrollPayoutReturnClaims.batchId,
        payrollPayoutReturnClaims.id,
      ],
    }),
    foreignKey({
      name: "payroll_disbursement_items_bank_snapshot_fk",
      columns: [table.tenantId, table.bankSnapshotId],
      foreignColumns: [payslipBankSnapshots.tenantId, payslipBankSnapshots.id],
    }),
    check(
      "payroll_disbursement_items_channel_check",
      sql`${table.channel} IN (${inList(PAYOUT_CHANNELS)})`,
    ),
    check(
      "payroll_disbursement_items_status_check",
      sql`${table.status} IN (${inList(PAYOUT_ITEM_STATUSES)})`,
    ),
    check(
      "payroll_disbursement_items_excluded_reason_check",
      sql`${table.excludedReason} IS NULL OR (${table.excludedReason} IN (${inList(PAYOUT_EXCLUDED_REASONS)}) AND ${table.status} IN ('blocked', 'cancelled'))`,
    ),
    check(
      "payroll_disbursement_items_blocked_reason_check",
      sql`${table.status} <> 'blocked' OR ${table.excludedReason} IS NOT NULL`,
    ),
    check(
      "payroll_disbursement_items_name_match_check",
      sql`${table.nameMatch} IS NULL OR ${table.nameMatch} IN ('exact', 'mismatch')`,
    ),
    check(
      "payroll_disbursement_items_failure_class_check",
      sql`${table.failureClass} IS NULL OR ${table.failureClass} IN ('definitive', 'unknown_resolved')`,
    ),
    check(
      "payroll_disbursement_items_attempt_check",
      sql`${table.attemptNo} >= 1 AND ${table.idempotencyKey} = 'payslip:' || ${table.payslipId}::text || ':attempt:' || ${table.attemptNo}::text`,
    ),
    check(
      "payroll_disbursement_items_key_version_check",
      sql`${table.piiKeyVersion} >= 1`,
    ),
    // Cash carries neither field; a masked number is exactly `maskAccountNumber`.
    check(
      "payroll_disbursement_items_payee_display_check",
      sql`(${table.channel} = 'cash' AND ${table.accountHolderName} IS NULL AND ${table.maskedAccountNumber} IS NULL) OR (${table.channel} <> 'cash' AND (${table.maskedAccountNumber} IS NULL OR ${table.maskedAccountNumber} ~ '^\\*{4}[0-9]{4}$'))`,
    ),
    check(
      "payroll_disbursement_items_bank_code_check",
      sql`${table.bankCode} IS NULL OR ${table.bankCode} ~ '^[0-9]{3}$'`,
    ),
    // Cash has no bank data; a bank channel always points at the frozen
    // snapshot, and an item past `prepared`/`blocked` carries its bank code.
    check(
      "payroll_disbursement_items_channel_bank_check",
      sql`(${table.channel} = 'cash' AND ${table.bankSnapshotId} IS NULL AND ${table.bankCode} IS NULL) OR (${table.channel} <> 'cash' AND ${table.bankSnapshotId} IS NOT NULL AND (${table.bankCode} IS NOT NULL OR ${table.status} IN ('prepared', 'blocked', 'cancelled')))`,
    ),
    check(
      "payroll_disbursement_items_succeeded_check",
      sql`${table.status} <> 'succeeded' OR (${table.settledAt} IS NOT NULL AND (${table.channel} <> 'duitku' OR ${table.providerRef} IS NOT NULL) AND (${table.channel} <> 'manual_bank' OR (${table.confirmedBy} IS NOT NULL AND ${table.confirmationRef} IS NOT NULL)) AND (${table.channel} <> 'cash' OR ${table.confirmedBy} IS NOT NULL))`,
    ),
    check(
      "payroll_disbursement_items_resolvers_check",
      sql`${table.resolvedBy2} IS NULL OR (${table.resolvedBy} IS NOT NULL AND ${table.resolvedBy2} <> ${table.resolvedBy} AND ${table.resolutionOutcome} IS NOT NULL AND ${table.resolutionEvidenceKey} IS NOT NULL)`,
    ),
    check(
      "payroll_disbursement_items_returners_check",
      sql`(${table.returnedBy} IS NULL AND ${table.returnedBy2} IS NULL AND ${table.returnEvidenceKey} IS NULL AND ${table.returnNote} IS NULL) OR (${table.status} IN ('succeeded', 'returned') AND ${table.returnedBy} IS NOT NULL AND ${table.returnEvidenceKey} IS NOT NULL AND ${table.returnNote} IS NOT NULL AND (${table.returnedBy2} IS NULL OR ${table.returnedBy2} <> ${table.returnedBy}))`,
    ),
    check(
      "payroll_disbursement_items_returned_check",
      sql`${table.status} <> 'returned' OR ${table.returnedBy} IS NULL OR ${table.returnedBy2} IS NOT NULL`,
    ),
    check(
      "payroll_disbursement_items_resolution_outcome_check",
      sql`${table.resolutionOutcome} IS NULL OR (${table.resolutionOutcome} IN ('failed', 'not_sent') AND ${table.resolvedBy} IS NOT NULL)`,
    ),
  ],
);

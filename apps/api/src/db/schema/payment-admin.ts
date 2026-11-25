// WS-05 administration (PRD v1.7 §3 F13, PAY-04, EDC-06/07).
// All money is whole rupiah; every row belongs to a tenant and is RLS protected.
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
import {
  idrColumn,
  outletIdColumn,
  tenantIdColumn,
  businessDate,
} from "../columns";
import { outlets, tenants } from "./platform-org";
import { syncTxidColumn } from "./sync-txid";
import { paymentIntents, paymentUnallocatedFunds } from "./payment";
import { orderIssues } from "./kds-issues";

export const paymentEdcTerminals = pgTable(
  "payment_edc_terminals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    bankCode: varchar("bank_code", { length: 20 }).notNull(),
    terminalId: varchar("terminal_id", { length: 100 }).notNull(),
    merchantId: varchar("merchant_id", { length: 100 }).notNull(),
    model: varchar("model", { length: 100 }).notNull(),
    connection: varchar("connection", { length: 20 }).notNull(),
    ipAddress: varchar("ip_address", { length: 45 }),
    supportedMethods: text("supported_methods").array().notNull(),
    assignedDeviceId: uuid("assigned_device_id"),
    status: varchar("status", { length: 20 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    syncTxid: syncTxidColumn(),
  },
  (t) => [
    index("payment_edc_terminals_sync_txid_idx").on(
      t.tenantId,
      t.syncTxid,
      t.id,
    ),
    unique("payment_edc_terminals_tenant_id_key").on(t.tenantId, t.id),
    unique("payment_edc_terminals_tenant_outlet_id_key").on(
      t.tenantId,
      t.outletId,
      t.id,
    ),
    unique("payment_edc_terminals_external_key").on(
      t.tenantId,
      t.bankCode,
      t.terminalId,
    ),
    foreignKey({
      name: "payment_edc_terminals_outlet_fk",
      columns: [t.tenantId, t.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    check(
      "payment_edc_terminals_bank_check",
      sql`${t.bankCode} IN ('bca','mandiri','bni','bjb')`,
    ),
    check(
      "payment_edc_terminals_connection_check",
      sql`${t.connection} IN ('lan','usb','bluetooth')`,
    ),
    check(
      "payment_edc_terminals_status_check",
      sql`${t.status} IN ('active','inactive')`,
    ),
    check(
      "payment_edc_terminals_methods_check",
      sql`cardinality(${t.supportedMethods}) > 0 AND ${t.supportedMethods} <@ ARRAY['card','qris']::text[]`,
    ),
  ],
);

export const paymentCashierDefaults = pgTable(
  "payment_cashier_defaults",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    cashierId: uuid("cashier_id").notNull(),
    terminalId: uuid("terminal_id"),
    defaultMethod: varchar("default_method", { length: 20 }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    syncTxid: syncTxidColumn(),
  },
  (t) => [
    index("payment_cashier_defaults_sync_txid_idx").on(
      t.tenantId,
      t.syncTxid,
      t.id,
    ),
    unique("payment_cashier_defaults_tenant_id_key").on(t.tenantId, t.id),
    unique("payment_cashier_defaults_cashier_key").on(
      t.tenantId,
      t.outletId,
      t.cashierId,
    ),
    foreignKey({
      name: "payment_cashier_defaults_outlet_fk",
      columns: [t.tenantId, t.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "payment_cashier_defaults_terminal_fk",
      columns: [t.tenantId, t.outletId, t.terminalId],
      foreignColumns: [
        paymentEdcTerminals.tenantId,
        paymentEdcTerminals.outletId,
        paymentEdcTerminals.id,
      ],
    }),
    check(
      "payment_cashier_defaults_method_check",
      sql`${t.defaultMethod} IN ('edc_card','edc_qris','qris_doit')`,
    ),
  ],
);

export const paymentRefunds = pgTable(
  "payment_refunds",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    paymentIntentId: uuid("payment_intent_id").notNull(),
    unallocatedFundId: uuid("unallocated_fund_id"),
    /** Failed-item recovery issue this refund pays out (ORD-09, legend-94q2l); null for every other refund. */
    orderIssueId: uuid("order_issue_id"),
    amountIdr: idrColumn("amount_idr").notNull(),
    reason: text("reason").notNull(),
    providerRef: varchar("provider_ref", { length: 100 }),
    note: text("note"),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    requestedBy: text("requested_by").notNull(),
    approvedBy: text("approved_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    /** Approval-matrix chain that decided this refund (opened lazily on first approve/reject). */
    approvalChainId: uuid("approval_chain_id"),
    /** Why a refund ended `failed`; null for legacy failed rows and every other status. */
    failureReason: varchar("failure_reason", { length: 40 }),
    /** Unknown provider outcomes only (error/timeout); a `pending` answer never counts here. */
    payoutAttempts: integer("payout_attempts").notNull().default(0),
    /** Provider answers of `pending`; drives the polling backoff, separate from payoutAttempts. */
    payoutPendingPolls: integer("payout_pending_polls").notNull().default(0),
    /** Lease for the in-flight provider call; another worker skips while it is in the future. */
    payoutClaimedUntil: timestamp("payout_claimed_until", {
      withTimezone: true,
    }),
    /** Fencing token of the current lease holder; a stale worker cannot touch the lease. */
    payoutClaimToken: uuid("payout_claim_token"),
    /** Short error code of the last unknown provider outcome (no message, no PII). */
    lastPayoutError: varchar("last_payout_error", { length: 100 }),
    /** When the refund was flagged as waiting too long; null until escalated. Never moves money state. */
    escalatedAt: timestamp("escalated_at", { withTimezone: true }),
    /** Why it was escalated (`pending_unapproved` | `provider_pending` | `payout_stalled` | `failed_holds_order`); paired with escalatedAt. */
    escalationReason: varchar("escalation_reason", { length: 30 }),
    /**
     * When an approved refund's payout was first seen stuck (no provider progress, manual or
     * quarantine flag); null when not stalled. Owned by the escalation sweep only, it starts the
     * payout_stalled clock and never moves money state.
     */
    payoutStallDetectedAt: timestamp("payout_stall_detected_at", {
      withTimezone: true,
    }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    unique("payment_refunds_tenant_id_key").on(t.tenantId, t.id),
    foreignKey({
      name: "payment_refunds_intent_fk",
      columns: [t.tenantId, t.paymentIntentId],
      foreignColumns: [paymentIntents.tenantId, paymentIntents.id],
    }),
    foreignKey({
      name: "payment_refunds_unallocated_fk",
      columns: [t.tenantId, t.unallocatedFundId],
      foreignColumns: [
        paymentUnallocatedFunds.tenantId,
        paymentUnallocatedFunds.id,
      ],
    }),
    foreignKey({
      name: "payment_refunds_outlet_fk",
      columns: [t.tenantId, t.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "payment_refunds_order_issue_fk",
      columns: [t.tenantId, t.orderIssueId],
      foreignColumns: [orderIssues.tenantId, orderIssues.id],
    }),
    index("payment_refunds_intent_idx").on(
      t.tenantId,
      t.paymentIntentId,
      t.status,
    ),
    index("payment_refunds_status_created_idx").on(
      t.tenantId,
      t.status,
      t.createdAt,
    ),
    uniqueIndex("payment_refunds_approval_chain_uq")
      .on(t.tenantId, t.approvalChainId)
      .where(sql`${t.approvalChainId} IS NOT NULL`),
    // One live refund per unallocated fund (same rule as resolveUnallocatedFund); a failed one frees the fund for a retry.
    uniqueIndex("payment_refunds_unallocated_fund_live_uq")
      .on(t.tenantId, t.unallocatedFundId)
      .where(
        sql`${t.unallocatedFundId} IS NOT NULL AND ${t.status} <> 'failed'`,
      ),
    index("payment_refunds_order_issue_idx")
      .on(t.tenantId, t.orderIssueId)
      .where(sql`${t.orderIssueId} IS NOT NULL`),
    // One live refund per recovery issue; a failed one frees the issue for a retry.
    uniqueIndex("payment_refunds_order_issue_unique")
      .on(t.tenantId, t.orderIssueId)
      .where(sql`${t.orderIssueId} IS NOT NULL AND ${t.status} <> 'failed'`),
    uniqueIndex("payment_refunds_provider_ref_idx")
      .on(t.tenantId, t.providerRef)
      .where(sql`${t.providerRef} IS NOT NULL`),
    check("payment_refunds_amount_check", sql`${t.amountIdr} > 0`),
    check(
      "payment_refunds_failure_reason_check",
      sql`${t.failureReason} IS NULL OR ${t.failureReason} IN ('rejected','approval_expired','provider_declined','cap_exceeded','source_document','approver_unauthorized')`,
    ),
    check(
      "payment_refunds_failure_reason_status_check",
      sql`${t.failureReason} IS NULL OR ${t.status} = 'failed'`,
    ),
    check(
      "payment_refunds_payout_attempts_check",
      sql`${t.payoutAttempts} >= 0`,
    ),
    check(
      "payment_refunds_payout_pending_polls_check",
      sql`${t.payoutPendingPolls} >= 0`,
    ),
    check(
      "payment_refunds_escalation_reason_check",
      sql`${t.escalationReason} IS NULL OR ${t.escalationReason} IN ('pending_unapproved','provider_pending','payout_stalled','failed_holds_order')`,
    ),
    check(
      "payment_refunds_escalation_pair_check",
      sql`(${t.escalatedAt} IS NULL) = (${t.escalationReason} IS NULL)`,
    ),
    check(
      "payment_refunds_status_check",
      sql`${t.status} IN ('pending','approved','completed','failed')`,
    ),
    check(
      "payment_refunds_distinct_approver_check",
      sql`${t.approvedBy} IS NULL OR ${t.approvedBy} <> ${t.requestedBy}`,
    ),
  ],
);

/** Per-tenant age thresholds (hours) before a waiting refund is escalated; no row means 24 / 72 / 24 (pending, provider, stalled). */
export const paymentRefundEscalationSettings = pgTable(
  "payment_refund_escalation_settings",
  {
    tenantId: tenantIdColumn(() => tenants.id)
      .notNull()
      .primaryKey(),
    pendingUnapprovedHours: integer("pending_unapproved_hours")
      .notNull()
      .default(24),
    providerPendingHours: integer("provider_pending_hours")
      .notNull()
      .default(72),
    payoutStalledHours: integer("payout_stalled_hours").notNull().default(24),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    check(
      "payment_refund_escalation_pending_hours_check",
      sql`${t.pendingUnapprovedHours} BETWEEN 1 AND 720`,
    ),
    check(
      "payment_refund_escalation_provider_hours_check",
      sql`${t.providerPendingHours} BETWEEN 1 AND 720`,
    ),
    check(
      "payment_refund_escalation_stalled_hours_check",
      sql`${t.payoutStalledHours} BETWEEN 1 AND 720`,
    ),
  ],
);

export const paymentReconciliationCases = pgTable(
  "payment_reconciliation_cases",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    settlementId: uuid("settlement_id").notNull(),
    settlementLineId: uuid("settlement_line_id"),
    source: varchar("source", { length: 20 }).notNull(),
    provider: varchar("provider", { length: 100 }).notNull(),
    reference: varchar("reference", { length: 100 }).notNull(),
    /** edc_transactions.id or payment_intents.id; set only on "missing" cases (no settlement line). */
    sourceTransactionId: uuid("source_transaction_id"),
    periodStart: businessDate("period_start").notNull(),
    periodEnd: businessDate("period_end").notNull(),
    expectedIdr: idrColumn("expected_idr").notNull(),
    receivedIdr: idrColumn("received_idr").notNull(),
    varianceIdr: idrColumn("variance_idr").notNull(),
    reason: text("reason").notNull(),
    status: varchar("status", { length: 20 }).notNull().default("open"),
    resolvedBy: text("resolved_by"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    note: text("note"),
    /** Approval-matrix chain that closes this case (`pending_approval`); null again if rejected or expired. */
    approvalChainId: uuid("approval_chain_id"),
    /** Who asked to close the case (becomes `resolved_by` once the chain is approved). */
    requestedBy: text("requested_by"),
    /** Final approver of the chain, read from the database when the case closes. */
    approvedBy: text("approved_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    unique("payment_reconciliation_cases_tenant_id_key").on(t.tenantId, t.id),
    foreignKey({
      name: "payment_reconciliation_cases_outlet_fk",
      columns: [t.tenantId, t.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    index("payment_reconciliation_cases_status_idx").on(
      t.tenantId,
      t.outletId,
      t.status,
    ),
    // A "missing" case (no settlement line) is one per sale for life.
    uniqueIndex("payment_reconciliation_cases_missing_sale_key")
      .on(t.tenantId, t.outletId, t.source, t.sourceTransactionId)
      .where(
        sql`${t.settlementLineId} IS NULL AND ${t.sourceTransactionId} IS NOT NULL`,
      ),
    check(
      "payment_reconciliation_cases_source_check",
      sql`${t.source} IN ('gateway','edc')`,
    ),
    check(
      "payment_reconciliation_cases_status_check",
      sql`${t.status} IN ('open','pending_approval','matched','resolved')`,
    ),
    check(
      "payment_reconciliation_cases_amount_check",
      sql`${t.expectedIdr} >= 0 AND ${t.receivedIdr} >= 0 AND ${t.varianceIdr} = ${t.receivedIdr} - ${t.expectedIdr}`,
    ),
    check(
      "payment_reconciliation_cases_period_check",
      sql`${t.periodStart} <= ${t.periodEnd}`,
    ),
  ],
);

/**
 * Funds of a written-off "missing" case arrived in a later settlement import
 * (legend-oan3p). Nothing is reversed automatically: finance reviews this row
 * through the approval matrix. One row per case for life.
 */
export const paymentReconciliationCorrections = pgTable(
  "payment_reconciliation_corrections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    caseId: uuid("case_id").notNull(),
    /** Report in which the funds arrived. */
    settlementId: uuid("settlement_id").notNull(),
    /** The settlement line that matched the written-off sale. */
    settlementLineId: uuid("settlement_line_id").notNull(),
    /**
     * The mismatch case opened for the same line when the late amount differs
     * from the sale; finance decides both together so the loss is never
     * booked twice. Null when the line matched exactly.
     */
    mismatchCaseId: uuid("mismatch_case_id"),
    source: varchar("source", { length: 20 }).notNull(),
    reference: varchar("reference", { length: 100 }).notNull(),
    /** abs(case.variance_idr): what was written off. */
    writtenOffIdr: idrColumn("written_off_idr").notNull(),
    /** Received amount of the matched line. */
    receivedIdr: idrColumn("received_idr").notNull(),
    status: varchar("status", { length: 20 }).notNull().default("open"),
    decision: varchar("decision", { length: 30 }),
    approvalChainId: uuid("approval_chain_id"),
    requestedBy: text("requested_by"),
    approvedBy: text("approved_by"),
    resolvedBy: text("resolved_by"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    unique("payment_reconciliation_corrections_tenant_id_key").on(
      t.tenantId,
      t.id,
    ),
    unique("payment_reconciliation_corrections_case_key").on(
      t.tenantId,
      t.caseId,
    ),
    foreignKey({
      name: "payment_reconciliation_corrections_outlet_fk",
      columns: [t.tenantId, t.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "payment_reconciliation_corrections_case_fk",
      columns: [t.tenantId, t.caseId],
      foreignColumns: [
        paymentReconciliationCases.tenantId,
        paymentReconciliationCases.id,
      ],
    }),
    foreignKey({
      name: "payment_reconciliation_corrections_mismatch_case_fk",
      columns: [t.tenantId, t.mismatchCaseId],
      foreignColumns: [
        paymentReconciliationCases.tenantId,
        paymentReconciliationCases.id,
      ],
    }),
    index("payment_reconciliation_corrections_status_idx").on(
      t.tenantId,
      t.outletId,
      t.status,
    ),
    check(
      "payment_reconciliation_corrections_source_check",
      sql`${t.source} IN ('gateway','edc')`,
    ),
    check(
      "payment_reconciliation_corrections_status_check",
      sql`${t.status} IN ('open','pending_approval','resolved')`,
    ),
    check(
      "payment_reconciliation_corrections_decision_check",
      sql`${t.decision} IS NULL OR ${t.decision} IN ('reverse_write_off','keep_write_off')`,
    ),
    check(
      "payment_reconciliation_corrections_amount_check",
      sql`${t.writtenOffIdr} >= 0 AND ${t.receivedIdr} >= 0`,
    ),
  ],
);

// The fingerprint binds each tenant-scoped mutation key to the operation and body.
export const paymentAdminIdempotency = pgTable(
  "payment_admin_idempotency",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    key: varchar("key", { length: 255 }).notNull(),
    fingerprint: varchar("fingerprint", { length: 64 }).notNull(),
    response: jsonb("response").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [unique("payment_admin_idempotency_key").on(t.tenantId, t.key)],
);

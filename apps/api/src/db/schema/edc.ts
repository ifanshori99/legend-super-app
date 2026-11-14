// EDC agent framework (bead legend-apt; PRD v1.7 §3 F13, EDC-01..EDC-04).
// One row per ECR request sent to a bank EDC terminal. The row is written
// `pending` BEFORE the terminal is called (write-ahead), so a crash or a lost
// answer leaves evidence: the outcome is then `unknown`, never `failed`, and
// the retry guard asks the terminal (inquiry) before any second charge.
//
// - (tenant_id, idempotency_key) is unique: one key, one sale.
// - (tenant_id, terminal_id, trace) is unique: the trace identifies the sale
//   on the terminal for inquiry and cancel.
// - At most one approved `sale` per (tenant_id, outlet_id, reference): EDC-03
//   backstop against a double charge even if the application guard has a bug.
//   The retry guard is outlet-scoped, so the index is too.
// - Tenant + outlet RLS: edc.custom.sql (migration 0069).
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { idrColumn, outletIdColumn, tenantIdColumn } from "../columns.ts";
import { paymentEdcTerminals } from "./payment-admin.ts";
import { paymentIntents } from "./payment.ts";
import { outlets, tenants } from "./platform-org.ts";

export const edcTransactions = pgTable(
  "edc_transactions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    terminalId: uuid("terminal_id").notNull(),
    bank: varchar("bank", { length: 20 }).notNull(),
    reference: varchar("reference", { length: 100 }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 100 }).notNull(),
    requestFingerprint: varchar("request_fingerprint", {
      length: 128,
    }).notNull(),
    amountIdr: idrColumn("amount_idr").notNull(),
    method: varchar("method", { length: 10 }).notNull(),
    status: varchar("status", { length: 20 }).notNull(),
    // PRD §6: sale, void or refund; ECR (cashier POS drives the terminal) or
    // standalone (terminal keyed by hand, reconciled later). The agent writes
    // sales in ecr mode; void and refund rows arrive with the void flow.
    type: varchar("type", { length: 10 }).notNull().default("sale"),
    mode: varchar("mode", { length: 12 }).notNull().default("ecr"),
    // The payment intent this charge settles; set by the payment service
    // once the sale is approved. Composite FK (tenant_id, payment_intent_id).
    paymentIntentId: uuid("payment_intent_id"),
    trace: varchar("trace", { length: 32 }).notNull(),
    approvalCode: varchar("approval_code", { length: 12 }),
    rrn: varchar("rrn", { length: 24 }),
    cardType: varchar("card_type", { length: 32 }),
    maskedPan: varchar("masked_pan", { length: 23 }),
    responseCode: varchar("response_code", { length: 8 }),
    message: varchar("message", { length: 200 }),
    invoiceNo: varchar("invoice_no", { length: 20 }),
    batchNo: varchar("batch_no", { length: 20 }),
    // Set (guarded UPDATE) inside the terminal lock right before the sale is
    // sent. NULL means the terminal never saw this sale.
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    // The terminal's last known batch at dispatch (batch_no of its newest row
    // that has one). NULL: unknown. An inquiry `not_found` is trusted only
    // while the terminal's open batch still equals this one.
    dispatchBatchNo: varchar("dispatch_batch_no", { length: 20 }),
    // The agent gave up waiting on this sale (timeout) but the adapter call is
    // still running on the terminal. NULL: no open wire call. Cleared when the
    // call settles or when a restarted agent takes the outlet over.
    saleWireOpenAt: timestamp("sale_wire_open_at", { withTimezone: true }),
    // A second approval for one reference was rejected by the unique index:
    // a human must void one charge and reconcile.
    needsReconciliation: boolean("needs_reconciliation")
      .notNull()
      .default(false),
    inquiryCount: integer("inquiry_count").notNull().default(0),
    lastInquiryAt: timestamp("last_inquiry_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    unique("edc_transactions_tenant_idempotency_key").on(
      t.tenantId,
      t.idempotencyKey,
    ),
    unique("edc_transactions_tenant_terminal_trace_key").on(
      t.tenantId,
      t.terminalId,
      t.trace,
    ),
    // EDC-03: never two approved charges for one POS reference. A void or
    // refund row shares the sale's reference, so only sales count.
    uniqueIndex("edc_transactions_approved_reference_key")
      .on(t.tenantId, t.outletId, t.reference)
      .where(sql`${t.status} = 'approved' AND ${t.type} = 'sale'`),
    index("edc_transactions_reference_idx").on(
      t.tenantId,
      t.outletId,
      t.reference,
    ),
    index("edc_transactions_terminal_status_idx").on(
      t.tenantId,
      t.terminalId,
      t.status,
    ),
    foreignKey({
      name: "edc_transactions_outlet_fk",
      columns: [t.tenantId, t.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "edc_transactions_terminal_fk",
      columns: [t.tenantId, t.outletId, t.terminalId],
      foreignColumns: [
        paymentEdcTerminals.tenantId,
        paymentEdcTerminals.outletId,
        paymentEdcTerminals.id,
      ],
    }),
    foreignKey({
      name: "edc_transactions_payment_intent_fk",
      columns: [t.tenantId, t.paymentIntentId],
      foreignColumns: [paymentIntents.tenantId, paymentIntents.id],
    }),
    check(
      "edc_transactions_bank_check",
      sql`${t.bank} IN ('bca','mandiri','bni','bjb')`,
    ),
    check("edc_transactions_amount_check", sql`${t.amountIdr} > 0`),
    check("edc_transactions_method_check", sql`${t.method} IN ('card','qris')`),
    check(
      "edc_transactions_status_check",
      sql`${t.status} IN ('pending','unknown','approved','declined','cancelled','failed')`,
    ),
    check(
      "edc_transactions_type_check",
      sql`${t.type} IN ('sale','void','refund')`,
    ),
    check(
      "edc_transactions_mode_check",
      sql`${t.mode} IN ('ecr','standalone')`,
    ),
    check("edc_transactions_inquiry_count_check", sql`${t.inquiryCount} >= 0`),
    // Final statuses carry completed_at; open ones (pending, unknown) never do.
    check(
      "edc_transactions_completed_check",
      sql`(${t.completedAt} IS NOT NULL) = (${t.status} IN ('approved','declined','cancelled','failed'))`,
    ),
  ],
);

export type EdcTransactionRow = typeof edcTransactions.$inferSelect;

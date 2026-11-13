// Settlement reports (EDC bank / gateway) and their lines (legend-jlqi, PRD
// v1.7 §3.13, EDC-06). Reconciliation only reads POS data and records
// differences: these tables are append-only for the application role.
// All money is whole rupiah; every row belongs to a tenant and is RLS protected.
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
  idrColumn,
  outletIdColumn,
  tenantIdColumn,
  businessDate,
} from "../columns";
import { outlets, tenants } from "./platform-org";

export const paymentSettlements = pgTable(
  "payment_settlements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    source: varchar("source", { length: 20 }).notNull(),
    provider: varchar("provider", { length: 100 }).notNull(),
    terminalId: uuid("terminal_id"),
    batchNo: varchar("batch_no", { length: 20 }),
    reference: varchar("reference", { length: 100 }).notNull(),
    periodStart: businessDate("period_start").notNull(),
    periodEnd: businessDate("period_end").notNull(),
    grossIdr: idrColumn("gross_idr").notNull(),
    feeIdr: idrColumn("fee_idr").notNull(),
    netIdr: idrColumn("net_idr").notNull(),
    lineCount: integer("line_count").notNull(),
    contentHash: varchar("content_hash", { length: 64 }).notNull(),
    importedBy: text("imported_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    unique("payment_settlements_tenant_id_key").on(t.tenantId, t.id),
    // Parent key for the lines' composite FK: a line shares its report's outlet.
    unique("payment_settlements_tenant_id_outlet_key").on(
      t.tenantId,
      t.id,
      t.outletId,
    ),
    unique("payment_settlements_report_key").on(
      t.tenantId,
      t.source,
      t.provider,
      t.outletId,
      t.reference,
    ),
    // An EDC batch is settled by one report, whatever its reference says.
    uniqueIndex("payment_settlements_edc_batch_key")
      .on(t.tenantId, t.terminalId, t.batchNo)
      .where(sql`${t.source} = 'edc'`),
    foreignKey({
      name: "payment_settlements_outlet_fk",
      columns: [t.tenantId, t.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    check(
      "payment_settlements_source_check",
      sql`${t.source} IN ('gateway','edc')`,
    ),
    check(
      "payment_settlements_period_check",
      sql`${t.periodStart} <= ${t.periodEnd}`,
    ),
    check(
      "payment_settlements_amount_check",
      sql`${t.grossIdr} >= 0 AND ${t.feeIdr} >= 0 AND ${t.netIdr} >= 0 AND ${t.netIdr} = ${t.grossIdr} - ${t.feeIdr}`,
    ),
    check("payment_settlements_line_count_check", sql`${t.lineCount} >= 0`),
  ],
);

export const paymentSettlementLines = pgTable(
  "payment_settlement_lines",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    settlementId: uuid("settlement_id").notNull(),
    lineNo: integer("line_no").notNull(),
    reference: varchar("reference", { length: 100 }).notNull(),
    amountIdr: idrColumn("amount_idr").notNull(),
    feeIdr: idrColumn("fee_idr").notNull(),
    expectedIdr: idrColumn("expected_idr"),
    matchedEdcTransactionId: uuid("matched_edc_transaction_id"),
    matchedPaymentIntentId: uuid("matched_payment_intent_id"),
    matchStatus: varchar("match_status", { length: 20 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    unique("payment_settlement_lines_tenant_id_key").on(t.tenantId, t.id),
    unique("payment_settlement_lines_reference_key").on(
      t.tenantId,
      t.settlementId,
      t.reference,
    ),
    foreignKey({
      name: "payment_settlement_lines_settlement_fk",
      columns: [t.tenantId, t.settlementId, t.outletId],
      foreignColumns: [
        paymentSettlements.tenantId,
        paymentSettlements.id,
        paymentSettlements.outletId,
      ],
    }),
    foreignKey({
      name: "payment_settlement_lines_outlet_fk",
      columns: [t.tenantId, t.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    // One POS transaction is settled once, by one settlement line.
    uniqueIndex("payment_settlement_lines_edc_txn_key")
      .on(t.tenantId, t.matchedEdcTransactionId)
      .where(sql`${t.matchedEdcTransactionId} IS NOT NULL`),
    uniqueIndex("payment_settlement_lines_intent_key")
      .on(t.tenantId, t.matchedPaymentIntentId)
      .where(sql`${t.matchedPaymentIntentId} IS NOT NULL`),
    index("payment_settlement_lines_status_idx").on(
      t.tenantId,
      t.outletId,
      t.matchStatus,
    ),
    check(
      "payment_settlement_lines_match_status_check",
      sql`${t.matchStatus} IN ('matched','mismatch','unmatched')`,
    ),
    check(
      "payment_settlement_lines_amount_check",
      sql`${t.amountIdr} > 0 AND ${t.feeIdr} >= 0`,
    ),
    // matched/mismatch link exactly one POS transaction; unmatched links none.
    check(
      "payment_settlement_lines_match_link_check",
      sql`(${t.matchStatus} = 'unmatched' AND num_nonnulls(${t.matchedEdcTransactionId}, ${t.matchedPaymentIntentId}) = 0) OR (${t.matchStatus} IN ('matched','mismatch') AND num_nonnulls(${t.matchedEdcTransactionId}, ${t.matchedPaymentIntentId}) = 1)`,
    ),
    // matched: the POS amount equals the report line; mismatch: it differs.
    check(
      "payment_settlement_lines_match_amount_check",
      sql`${t.matchStatus} = 'unmatched' OR (${t.expectedIdr} IS NOT NULL AND ((${t.matchStatus} = 'matched' AND ${t.expectedIdr} = ${t.amountIdr}) OR (${t.matchStatus} = 'mismatch' AND ${t.expectedIdr} <> ${t.amountIdr})))`,
    ),
  ],
);

// 1269 E6 (legend-osqou.27, docs/briefs/1269-e6-keputusan.md): the payout of
// a back-office refund of an edge sale the cloud ingested. The edge owns the
// drawer and never refunds after payment, so the cloud is the only refund
// ledger of that sale. One row per such refund (`pos_order_refunds`, which
// already holds the refund's room on the bill):
// - D1 the cash part is paid by Finance outside the drawer (bank transfer or
//   petty cash) and is `requested` until its payment reference is recorded;
// - D2 the card part is refunded at the outlet terminal and is `requested`
//   until its refund RRN and approval code are recorded.
// The refund counts as money (`succeeded`: the `order.refunded` event, its
// journal) only once every part is paid; `event_payload` is that event as the
// refund computed it. One refund RRN and one payment reference pay one refund.
// A recorded part and a succeeded row are final (pos-refund-payout.custom.sql).
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import {
  idrColumn,
  outletIdColumn,
  tenantIdColumn,
  ulidInUuid,
} from "../columns";
import { outlets, tenants } from "./platform-org";
import { posOrderRefunds } from "./pos-order";

export type PosRefundPayoutStatus = "requested" | "succeeded";
export type PosRefundCashChannel = "bank_transfer" | "petty_cash";

export const posRefundPayouts = pgTable(
  "pos_refund_payouts",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    posRefundId: uuid("pos_refund_id").notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    orderId: ulidInUuid("order_id").notNull(),
    status: varchar("status", { length: 10 })
      .$type<PosRefundPayoutStatus>()
      .notNull()
      .default("requested"),
    cashIdr: idrColumn("cash_idr").notNull(),
    edcIdr: idrColumn("edc_idr").notNull(),
    cashChannel: varchar("cash_channel", {
      length: 20,
    }).$type<PosRefundCashChannel>(),
    cashReference: varchar("cash_reference", { length: 100 }),
    cashSettledBy: text("cash_settled_by"),
    cashSettledAt: timestamp("cash_settled_at", { withTimezone: true }),
    /** Upper case, no dashes or spaces: one slip, one spelling. */
    edcRrn: varchar("edc_rrn", { length: 24 }),
    edcApprovalCode: varchar("edc_approval_code", { length: 12 }),
    edcSettledBy: text("edc_settled_by"),
    edcSettledAt: timestamp("edc_settled_at", { withTimezone: true }),
    /** The `order.refunded` payload, emitted when the row succeeds. */
    eventPayload: jsonb("event_payload")
      .$type<Record<string, unknown>>()
      .notNull(),
    requestedBy: text("requested_by").notNull(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.posRefundId] }),
    foreignKey({
      name: "pos_refund_payouts_refund_fk",
      columns: [table.tenantId, table.posRefundId],
      foreignColumns: [posOrderRefunds.tenantId, posOrderRefunds.id],
    }),
    index("pos_refund_payouts_order_idx").on(table.tenantId, table.orderId),
    index("pos_refund_payouts_status_idx").on(
      table.tenantId,
      table.status,
      table.createdAt,
    ),
    // D2: one refund RRN is used once.
    uniqueIndex("pos_refund_payouts_edc_rrn_key")
      .on(table.tenantId, table.edcRrn)
      .where(sql`${table.edcRrn} IS NOT NULL`),
    // D1: one payment reference pays one refund.
    uniqueIndex("pos_refund_payouts_cash_reference_key")
      .on(table.tenantId, table.cashChannel, table.cashReference)
      .where(sql`${table.cashReference} IS NOT NULL`),
    check(
      "pos_refund_payouts_status_check",
      sql`${table.status} IN ('requested', 'succeeded')`,
    ),
    check(
      "pos_refund_payouts_amount_check",
      sql`${table.cashIdr} >= 0 AND ${table.edcIdr} >= 0 AND ${table.cashIdr} + ${table.edcIdr} > 0`,
    ),
    check(
      "pos_refund_payouts_cash_channel_check",
      sql`${table.cashChannel} IS NULL OR ${table.cashChannel} IN ('bank_transfer', 'petty_cash')`,
    ),
    // A cash part is recorded whole (channel, reference, who, when) or not at
    // all, and only when the refund has one.
    check(
      "pos_refund_payouts_cash_part_check",
      sql`(${table.cashReference} IS NOT NULL) = (${table.cashChannel} IS NOT NULL)
        AND (${table.cashReference} IS NOT NULL) = (${table.cashSettledAt} IS NOT NULL)
        AND (${table.cashReference} IS NOT NULL) = (${table.cashSettledBy} IS NOT NULL)
        AND (${table.cashReference} IS NULL OR ${table.cashIdr} > 0)`,
    ),
    check(
      "pos_refund_payouts_edc_part_check",
      sql`(${table.edcRrn} IS NOT NULL) = (${table.edcApprovalCode} IS NOT NULL)
        AND (${table.edcRrn} IS NOT NULL) = (${table.edcSettledAt} IS NOT NULL)
        AND (${table.edcRrn} IS NOT NULL) = (${table.edcSettledBy} IS NOT NULL)
        AND (${table.edcRrn} IS NULL OR ${table.edcIdr} > 0)`,
    ),
    // Succeeded exactly when every part with money is recorded.
    check(
      "pos_refund_payouts_succeeded_check",
      sql`(${table.status} = 'succeeded') = (${table.settledAt} IS NOT NULL)
        AND (${table.status} = 'succeeded') = (
          (${table.cashIdr} = 0 OR ${table.cashReference} IS NOT NULL)
          AND (${table.edcIdr} = 0 OR ${table.edcRrn} IS NOT NULL))`,
    ),
  ],
);

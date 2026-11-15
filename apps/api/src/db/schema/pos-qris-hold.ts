// QRIS hold (design legend-yhia9 D-01/D-02/D-03): while a POS QRIS tender is
// collectible at the provider, the bill's money is frozen. One row per issued
// QR tender, never deleted. The partial unique index allows one active
// non-backfilled hold (open/cancelling) per bill; backfilled holds (one per
// provider code that may still be collectible, migration 0381) may be many. Transitions and the freeze of the bill, its
// tenders and the hold itself are database triggers in pos-qris-hold.custom.sql.
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
} from "drizzle-orm/pg-core";
import {
  idrColumn,
  outletIdColumn,
  tenantIdColumn,
  ulidInUuid,
} from "../columns";
import { billSplits } from "./bill-splits";
import { paymentIntents } from "./payment";
import { outlets, tenants } from "./platform-org";
import { posOrderTenders } from "./pos-order";
import { orders } from "./qr-order";
import { user } from "./user";

export const POS_QRIS_HOLD_STATES = [
  "open",
  "cancelling",
  "paid",
  "closed",
] as const;
export type PosQrisHoldState = (typeof POS_QRIS_HOLD_STATES)[number];

export const POS_QRIS_HOLD_CLOSE_REASONS = [
  "provider_paid",
  "provider_expired",
  "provider_failed",
  "provider_cancelled",
  "force_released",
] as const;
export type PosQrisHoldCloseReason =
  (typeof POS_QRIS_HOLD_CLOSE_REASONS)[number];

export const posQrisHolds = pgTable(
  "pos_qris_holds",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    id: ulidInUuid("id").notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    orderId: ulidInUuid("order_id").notNull(),
    /** NULL only for a guest QR (split part, or the whole order): no POS tender. */
    tenderId: uuid("tender_id"),
    paymentIntentId: uuid("payment_intent_id").notNull(),
    billSplitId: uuid("bill_split_id"),
    amountIdr: idrColumn("amount_idr").notNull(),
    /**
     * Bill at issue: total, DP and captured. NULL only for a backfilled hold.
     * A split-part hold stores them too, but its amount is one part, so the
     * equation below is not asked of it.
     */
    basisTotalIdr: idrColumn("basis_total_idr"),
    basisDepositIdr: idrColumn("basis_deposit_idr"),
    basisCapturedIdr: idrColumn("basis_captured_idr"),
    backfilled: boolean("backfilled").notNull().default(false),
    state: text("state").$type<PosQrisHoldState>().notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
    /** Staff who issued the QR. NULL only for a guest QR. */
    openedBy: text("opened_by").references(() => user.id),
    cancelRequestedAt: timestamp("cancel_requested_at", {
      withTimezone: true,
    }),
    cancelRequestedBy: text("cancel_requested_by").references(() => user.id),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    checkAttempts: integer("check_attempts").notNull().default(0),
    nextCheckAt: timestamp("next_check_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closeReason: text("close_reason").$type<PosQrisHoldCloseReason>(),
    closeEvidence: jsonb("close_evidence").$type<Record<string, unknown>>(),
  },
  (table) => [
    primaryKey({
      name: "pos_qris_holds_pkey",
      columns: [table.tenantId, table.id],
    }),
    unique("pos_qris_holds_intent_key").on(
      table.tenantId,
      table.paymentIntentId,
    ),
    unique("pos_qris_holds_tender_key").on(table.tenantId, table.tenderId),
    foreignKey({
      name: "pos_qris_holds_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "pos_qris_holds_order_fk",
      columns: [table.tenantId, table.orderId],
      foreignColumns: [orders.tenantId, orders.id],
    }),
    foreignKey({
      name: "pos_qris_holds_tender_fk",
      columns: [table.tenantId, table.tenderId],
      foreignColumns: [posOrderTenders.tenantId, posOrderTenders.id],
    }),
    foreignKey({
      name: "pos_qris_holds_bill_split_fk",
      columns: [table.tenantId, table.billSplitId],
      foreignColumns: [billSplits.tenantId, billSplits.id],
    }),
    foreignKey({
      name: "pos_qris_holds_intent_fk",
      columns: [table.tenantId, table.paymentIntentId],
      foreignColumns: [paymentIntents.tenantId, paymentIntents.id],
    }),
    uniqueIndex("pos_qris_holds_active_order_key")
      .on(table.tenantId, table.orderId)
      .where(
        sql`${table.state} IN ('open', 'cancelling') AND NOT ${table.backfilled}`,
      ),
    index("pos_qris_holds_due_idx")
      .on(table.state, table.nextCheckAt)
      .where(sql`${table.state} IN ('open', 'cancelling')`),
    check("pos_qris_holds_amount_check", sql`${table.amountIdr} > 0`),
    check(
      "pos_qris_holds_target_check",
      sql`${table.tenderId} IS NOT NULL OR ${table.billSplitId} IS NOT NULL OR ${table.openedBy} IS NULL`,
    ),
    check(
      "pos_qris_holds_state_check",
      sql`${table.state} IN ('open', 'cancelling', 'paid', 'closed')`,
    ),
    check(
      "pos_qris_holds_basis_check",
      sql`${table.backfilled} OR ${table.tenderId} IS NULL OR (${table.basisTotalIdr} IS NOT NULL AND ${table.basisDepositIdr} IS NOT NULL AND ${table.basisCapturedIdr} IS NOT NULL AND ${table.amountIdr} = ${table.basisTotalIdr} - ${table.basisDepositIdr} - ${table.basisCapturedIdr})`,
    ),
    check(
      "pos_qris_holds_cancel_pair_check",
      sql`(${table.cancelRequestedAt} IS NULL) = (${table.cancelRequestedBy} IS NULL)`,
    ),
    check(
      "pos_qris_holds_closed_check",
      sql`(${table.state} IN ('open', 'cancelling')) = (${table.closedAt} IS NULL)`,
    ),
    check(
      "pos_qris_holds_close_reason_check",
      sql`(${table.closeReason} IS NULL OR ${table.closeReason} IN ('provider_paid', 'provider_expired', 'provider_failed', 'provider_cancelled', 'force_released')) AND ((${table.state} IN ('paid', 'closed')) = (${table.closeReason} IS NOT NULL))`,
    ),
  ],
);

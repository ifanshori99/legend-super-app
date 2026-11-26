// POS order lifecycle tables (bead legend-kk7, WS-04; PRD v1.7 §3 F8 "POS
// Kasir & Captain Order", §6 C `orders` (#10), `order_items` (#11),
// `order_events`; POS-01, POS-04; contract @starter/shared/pos).
//
// A POS / captain / manual-ojol order is a row of the channel-general §6
// `orders` + `order_items` tables (schema/qr-order.ts). What the POS contract
// needs beyond those columns lives here, keyed by the same ids, so the KDS and
// the QR bill keep reading one `orders` table:
//
//   pos_orders           1:1 with orders: shift/device/cashier attribution,
//                        submit/complete timestamps, the void approval and the
//                        optimistic-concurrency `version` (legend-63l6).
//   pos_order_items      1:1 with order_items: fired_at, the cashier's hold
//                        flag and the void approval of one line.
//   order_events         §6 append-only per-order log with a gapless
//                        per-order `sequence` (§5 edge sync).
//   pos_order_tenders    payment panel lines (cash/QRIS/EDC/points).
//   pos_order_discounts  manual / promo / voucher discount lines; removal is
//                        a soft `removed_at`, never a delete.
//   pos_order_voids      POS-04 linked void of a completed sale.
//   pos_order_refunds    POS-04 linked refund against a paid sale.
//   pos_order_approval_uses  one approval (pos_overrides row) authorizes one
//                        action only.
//   pos_order_idempotency    request-fingerprint-bound replay ledger.
//   pos_approval_policies    POS-02 discount threshold per tenant / outlet.
//
// (T) rules: tenant_id NOT NULL everywhere, outlet_id NOT NULL on every
// operational table (enforced tenant + outlet RLS in pos-order.custom.sql),
// unique constraints include tenant_id, and children reference parents
// through composite (tenant_id, id) keys. Money is BIGINT whole rupiah.
// Immutability (POS-04) and append-only rules are DB triggers in
// pos-order.custom.sql, backed by the service guard.

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
  smallint,
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
  ulidInUuid,
} from "../columns";
import { outlets, tenants } from "./platform-org";
import { syncTxidColumn } from "./sync-txid";
import { outletFailoverWindows } from "./edge-failover";
import { posShifts } from "./pos-shift";
import { orderItems, orders } from "./qr-order";

const createdAt = timestamp("created_at", { withTimezone: true })
  .notNull()
  .defaultNow();
const updatedAt = timestamp("updated_at", { withTimezone: true })
  .notNull()
  .defaultNow();

/** One refunded tender method (contract posRefundLineSchema). */
export type PosRefundLineRow = {
  method: string;
  amountIdr: number;
  reference: string | null;
  /** legend-186: captured tender + payment intent; absent on legacy rows. */
  tenderId?: string;
  paymentIntentId?: string | null;
};

/** One refunded order item (contract posRefundItemSchema). */
export type PosRefundItemRow = { itemId: string; quantity: number };

/** `pos_orders` (T, O): the POS extension of one `orders` row. */
export const posOrders = pgTable(
  "pos_orders",
  {
    orderId: ulidInUuid("order_id").notNull(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    /** Copied from orders so the manual-ojol duplicate guard can be unique. */
    channel: varchar("channel", { length: 20 }).notNull(),
    externalRef: varchar("external_ref", { length: 100 }),
    shiftId: uuid("shift_id"),
    deviceId: uuid("device_id"),
    cashierId: text("cashier_id"),
    /** The cashier asked for every line to start held (F8 hold & fire). */
    holdItems: boolean("hold_items").notNull().default(false),
    /**
     * Training stamp (legend-2lp.8): copy of `devices.training_mode` at
     * creation. Written once by createPosOrder, never changed afterwards.
     */
    isTraining: boolean("is_training").notNull().default(false),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    voidReasonNote: varchar("void_reason_note", { length: 500 }),
    voidApprovedBy: text("void_approved_by"),
    voidApprovalRequestId: uuid("void_approval_request_id"),
    /** legend-0gy1: the `pos_overrides` row that approved the void (ULID). */
    voidOverrideId: ulidInUuid("void_override_id"),
    /**
     * 1271 F1: the failover window this order was sold in (cloud only, set at
     * creation, never changed). Null for every normal and edge order.
     */
    failoverWindowId: uuid("failover_window_id"),
    /** Optimistic concurrency (legend-63l6): bumped by every write. */
    version: integer("version").notNull().default(0),
    createdAt,
    updatedAt,
  },
  (table) => [
    primaryKey({
      name: "pos_orders_pkey",
      columns: [table.tenantId, table.orderId],
    }),
    foreignKey({
      name: "pos_orders_order_fk",
      columns: [table.tenantId, table.orderId],
      foreignColumns: [orders.tenantId, orders.id],
    }),
    foreignKey({
      name: "pos_orders_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    // A manual ojol order is injected once per platform order number.
    uniqueIndex("pos_orders_external_ref_key")
      .on(table.tenantId, table.outletId, table.channel, table.externalRef)
      .where(sql`${table.externalRef} IS NOT NULL`),
    index("pos_orders_outlet_idx").on(
      table.tenantId,
      table.outletId,
      table.createdAt,
    ),
    index("pos_orders_shift_idx").on(table.tenantId, table.shiftId),
    foreignKey({
      name: "pos_orders_failover_window_fk",
      columns: [table.tenantId, table.outletId, table.failoverWindowId],
      foreignColumns: [
        outletFailoverWindows.tenantId,
        outletFailoverWindows.outletId,
        outletFailoverWindows.id,
      ],
    }),
    index("pos_orders_failover_window_idx")
      .on(table.tenantId, table.failoverWindowId)
      .where(sql`${table.failoverWindowId} IS NOT NULL`),
    check(
      "pos_orders_channel_check",
      sql`${table.channel} IN ('pos', 'captain', 'gofood', 'grabfood', 'shopeefood', 'reservation', 'kiosk')`,
    ),
    check("pos_orders_version_check", sql`${table.version} >= 0`),
  ],
);

/** `pos_order_items` (T, O): the POS extension of one `order_items` row. */
export const posOrderItems = pgTable(
  "pos_order_items",
  {
    itemId: ulidInUuid("item_id").notNull(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    orderId: ulidInUuid("order_id").notNull(),
    /** Held by the cashier: not fired with the order, only by explicit fire. */
    heldByCashier: boolean("held_by_cashier").notNull().default(false),
    firedAt: timestamp("fired_at", { withTimezone: true }),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidReasonNote: varchar("void_reason_note", { length: 500 }),
    voidApprovalRequestId: uuid("void_approval_request_id"),
    /** legend-0gy1: the `pos_overrides` row that approved the void (ULID). */
    voidOverrideId: ulidInUuid("void_override_id"),
    createdAt,
    updatedAt,
  },
  (table) => [
    primaryKey({
      name: "pos_order_items_pkey",
      columns: [table.tenantId, table.itemId],
    }),
    foreignKey({
      name: "pos_order_items_item_fk",
      columns: [table.tenantId, table.itemId],
      foreignColumns: [orderItems.tenantId, orderItems.id],
    }),
    foreignKey({
      name: "pos_order_items_pos_order_fk",
      columns: [table.tenantId, table.orderId],
      foreignColumns: [posOrders.tenantId, posOrders.orderId],
    }),
    foreignKey({
      name: "pos_order_items_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    index("pos_order_items_order_idx").on(table.tenantId, table.orderId),
  ],
);

/**
 * `order_events` (T, E): §6 "Event append-only untuk sinkronisasi". One row
 * per state change, `sequence` gapless per order (unique), never updated or
 * deleted (trigger in pos-order.custom.sql).
 */
export const orderEvents = pgTable(
  "order_events",
  {
    id: ulidInUuid("id").primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    orderId: ulidInUuid("order_id").notNull(),
    sequence: integer("sequence").notNull(),
    type: varchar("type", { length: 40 }).notNull(),
    payload: jsonb("payload").$type<unknown>().notNull(),
    actorId: text("actor_id"),
    deviceId: uuid("device_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt,
  },
  (table) => [
    unique("order_events_tenant_id_id_key").on(table.tenantId, table.id),
    unique("order_events_order_sequence_key").on(
      table.tenantId,
      table.orderId,
      table.sequence,
    ),
    foreignKey({
      name: "order_events_order_fk",
      columns: [table.tenantId, table.orderId],
      foreignColumns: [orders.tenantId, orders.id],
    }),
    foreignKey({
      name: "order_events_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    check("order_events_sequence_check", sql`${table.sequence} > 0`),
  ],
);

/** `pos_order_tenders` (T, O): one payment line of a POS order. */
export const posOrderTenders = pgTable(
  "pos_order_tenders",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    orderId: ulidInUuid("order_id").notNull(),
    method: varchar("method", { length: 20 }).notNull(),
    provider: varchar("provider", { length: 20 }).notNull(),
    /** WS-05 payment link + intent of a gateway (QRIS) tender. */
    paymentLinkId: uuid("payment_link_id"),
    paymentLinkTokenSealed: text("payment_link_token_sealed"),
    paymentIntentId: uuid("payment_intent_id"),
    amountIdr: idrColumn("amount_idr").notNull(),
    receivedIdr: idrColumn("received_idr"),
    changeIdr: idrColumn("change_idr"),
    reference: varchar("reference", { length: 100 }),
    edcTransactionId: uuid("edc_transaction_id"),
    pointsUsed: integer("points_used"),
    status: varchar("status", { length: 20 }).notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    capturedBy: text("captured_by"),
    approvedBy: text("approved_by"),
    /** The drawer (shift) a cash tender went into; null for non-cash. */
    shiftId: uuid("shift_id"),
    createdAt,
    updatedAt,
  },
  (table) => [
    unique("pos_order_tenders_tenant_id_id_key").on(table.tenantId, table.id),
    foreignKey({
      name: "pos_order_tenders_shift_fk",
      columns: [table.tenantId, table.shiftId],
      foreignColumns: [posShifts.tenantId, posShifts.id],
    }),
    foreignKey({
      name: "pos_order_tenders_pos_order_fk",
      columns: [table.tenantId, table.orderId],
      foreignColumns: [posOrders.tenantId, posOrders.orderId],
    }),
    foreignKey({
      name: "pos_order_tenders_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    uniqueIndex("pos_order_tenders_payment_link_key")
      .on(table.tenantId, table.paymentLinkId)
      .where(sql`${table.paymentLinkId} IS NOT NULL`),
    // Refund authority finds an intent's tender by the intent id (the payment
    // link side is pos_order_tenders_payment_link_key); migration 0285.
    index("pos_order_tenders_payment_intent_idx")
      .on(table.tenantId, table.paymentIntentId)
      .where(sql`${table.paymentIntentId} IS NOT NULL`),
    // EDC-01/04: one EDC ledger row backs at most one live tender, even when
    // two requests race past the application check.
    uniqueIndex("pos_order_tenders_edc_transaction_key")
      .on(table.tenantId, table.edcTransactionId)
      .where(
        sql`${table.edcTransactionId} IS NOT NULL AND ${table.status} NOT IN ('voided', 'failed')`,
      ),
    index("pos_order_tenders_order_idx").on(
      table.tenantId,
      table.orderId,
      table.requestedAt,
    ),
    check(
      "pos_order_tenders_method_check",
      sql`${table.method} IN ('cash', 'qris', 'va', 'ewallet', 'card', 'edc_card', 'edc_qris', 'points')`,
    ),
    check(
      "pos_order_tenders_provider_check",
      sql`${table.provider} IN ('doit', 'duitku', 'edc', 'manual')`,
    ),
    check(
      "pos_order_tenders_status_check",
      sql`${table.status} IN ('authorized', 'captured', 'failed', 'voided')`,
    ),
    check("pos_order_tenders_amount_check", sql`${table.amountIdr} > 0`),
    // Contract posTenderSchema: only cash records received cash and change,
    // and change = received - applied.
    check(
      "pos_order_tenders_cash_check",
      sql`(${table.method} = 'cash') = (${table.receivedIdr} IS NOT NULL)
        AND (${table.receivedIdr} IS NULL) = (${table.changeIdr} IS NULL)
        AND (${table.receivedIdr} IS NULL OR ${table.changeIdr} = ${table.receivedIdr} - ${table.amountIdr})
        AND (${table.changeIdr} IS NULL OR ${table.changeIdr} >= 0)`,
    ),
    check(
      "pos_order_tenders_points_check",
      sql`(${table.method} = 'points') = (${table.pointsUsed} IS NOT NULL)`,
    ),
    check(
      "pos_order_tenders_resolved_check",
      sql`(${table.status} = 'authorized') = (${table.resolvedAt} IS NULL)`,
    ),
    check(
      "pos_order_tenders_link_pair_check",
      sql`(${table.paymentLinkId} IS NULL) = (${table.paymentLinkTokenSealed} IS NULL)`,
    ),
  ],
);

/** `pos_order_discounts` (T, O): one discount line (POS-02). */
export const posOrderDiscounts = pgTable(
  "pos_order_discounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    orderId: ulidInUuid("order_id").notNull(),
    source: varchar("source", { length: 20 }).notNull(),
    kind: varchar("kind", { length: 20 }).notNull(),
    percentBp: smallint("percent_bp"),
    /** Server-computed amount; recomputed while the order is live. */
    amountIdr: idrColumn("amount_idr").notNull(),
    promoCode: varchar("promo_code", { length: 40 }),
    reason: varchar("reason", { length: 30 }).notNull(),
    reasonNote: varchar("reason_note", { length: 500 }),
    appliedBy: text("applied_by").notNull(),
    approvedBy: text("approved_by"),
    /** WS-01 chain id of a phone approval; null for a supervisor PIN. */
    approvalRequestId: uuid("approval_request_id"),
    /** legend-0gy1: the `pos_overrides` row that approved this discount. */
    overrideId: ulidInUuid("override_id"),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    removedBy: text("removed_by"),
    createdAt,
    updatedAt,
  },
  (table) => [
    unique("pos_order_discounts_tenant_id_id_key").on(table.tenantId, table.id),
    foreignKey({
      name: "pos_order_discounts_pos_order_fk",
      columns: [table.tenantId, table.orderId],
      foreignColumns: [posOrders.tenantId, posOrders.orderId],
    }),
    foreignKey({
      name: "pos_order_discounts_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    // The promo engine holds one application per order (order-promo.ts).
    uniqueIndex("pos_order_discounts_one_promo_key")
      .on(table.tenantId, table.orderId)
      .where(
        sql`${table.removedAt} IS NULL AND ${table.source} IN ('promo', 'voucher')`,
      ),
    index("pos_order_discounts_order_idx").on(
      table.tenantId,
      table.orderId,
      table.createdAt,
    ),
    check(
      "pos_order_discounts_source_check",
      sql`${table.source} IN ('promo', 'voucher', 'manual')`,
    ),
    check(
      "pos_order_discounts_kind_check",
      sql`${table.kind} IN ('percent', 'amount')`,
    ),
    check(
      "pos_order_discounts_percent_check",
      sql`(${table.kind} = 'percent') = (${table.percentBp} IS NOT NULL)
        AND (${table.percentBp} IS NULL OR ${table.percentBp} BETWEEN 1 AND 10000)`,
    ),
    check("pos_order_discounts_amount_check", sql`${table.amountIdr} > 0`),
    check(
      "pos_order_discounts_manual_note_check",
      sql`${table.source} <> 'manual' OR ${table.reasonNote} IS NOT NULL`,
    ),
    check(
      "pos_order_discounts_approval_pair_check",
      sql`(${table.approvedBy} IS NULL) = (${table.approvalRequestId} IS NULL AND ${table.overrideId} IS NULL)`,
    ),
    check(
      "pos_order_discounts_removed_pair_check",
      sql`(${table.removedAt} IS NULL) = (${table.removedBy} IS NULL)`,
    ),
  ],
);

/** `pos_order_voids` (T, O): POS-04 linked void of a completed sale. */
export const posOrderVoids = pgTable(
  "pos_order_voids",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    orderId: ulidInUuid("order_id").notNull(),
    /** POS-06: the receipt number the sale was issued under is kept. */
    receiptNumber: varchar("receipt_number", { length: 30 }).notNull(),
    amountIdr: idrColumn("amount_idr").notNull(),
    reason: varchar("reason", { length: 30 }).notNull(),
    reasonNote: varchar("reason_note", { length: 500 }).notNull(),
    requestedBy: text("requested_by").notNull(),
    approvedBy: text("approved_by").notNull(),
    /** WS-01 chain id of a phone approval; null for a supervisor PIN (legend-0gy1). */
    approvalRequestId: uuid("approval_request_id"),
    /** legend-0gy1: the `pos_overrides` row that approved this action. */
    overrideId: ulidInUuid("override_id"),
    voidedAt: timestamp("voided_at", { withTimezone: true }).notNull(),
    /** The drawer (shift) a cash void paid out of; null when no cash tender. */
    shiftId: uuid("shift_id"),
    /**
     * A cash void larger than the expected drawer cash when recorded
     * (legend-utqr): "exceeded the drawer when recorded", nothing more. It is
     * accepted like any other (same response and events) and left out of the
     * drawer figures; the shift's count carries it as heldCashOutIdr and the
     * shift close books counted − (expected − held), so the cash the order
     * event already credits is not booked twice. Permanent (append-only
     * table); a later review belongs in its own table. The cashier never
     * sees it.
     */
    needsApproval: boolean("needs_approval").notNull().default(false),
    createdAt,
  },
  (table) => [
    unique("pos_order_voids_tenant_id_id_key").on(table.tenantId, table.id),
    foreignKey({
      name: "pos_order_voids_shift_fk",
      columns: [table.tenantId, table.shiftId],
      foreignColumns: [posShifts.tenantId, posShifts.id],
    }),
    // A completed sale is voided by correction at most once.
    unique("pos_order_voids_order_key").on(table.tenantId, table.orderId),
    foreignKey({
      name: "pos_order_voids_pos_order_fk",
      columns: [table.tenantId, table.orderId],
      foreignColumns: [posOrders.tenantId, posOrders.orderId],
    }),
    foreignKey({
      name: "pos_order_voids_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    check("pos_order_voids_amount_check", sql`${table.amountIdr} > 0`),
    // legend-0gy1: every correction names its approval (override row, or the
    // phone chain id on rows written before the override id was recorded).
    check(
      "pos_order_voids_approval_check",
      sql`${table.overrideId} IS NOT NULL OR ${table.approvalRequestId} IS NOT NULL`,
    ),
    check(
      "pos_order_voids_approver_check",
      sql`lower(${table.requestedBy}) <> lower(${table.approvedBy})`,
    ),
    check(
      "pos_order_voids_needs_approval_shift_check",
      sql`NOT ${table.needsApproval} OR ${table.shiftId} IS NOT NULL`,
    ),
  ],
);

/** `pos_order_refunds` (T, O): POS-04 linked refund against a paid sale. */
export const posOrderRefunds = pgTable(
  "pos_order_refunds",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    orderId: ulidInUuid("order_id").notNull(),
    amountIdr: idrColumn("amount_idr").notNull(),
    reason: varchar("reason", { length: 30 }).notNull(),
    reasonNote: varchar("reason_note", { length: 500 }).notNull(),
    lines: jsonb("lines").$type<PosRefundLineRow[]>().notNull(),
    /** Order items this refund covers; `[]` for an amount-only refund. */
    items: jsonb("items")
      .$type<PosRefundItemRow[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    requestedBy: text("requested_by").notNull(),
    approvedBy: text("approved_by").notNull(),
    /** WS-01 chain id of a phone approval; null for a supervisor PIN (legend-0gy1). */
    approvalRequestId: uuid("approval_request_id"),
    /** legend-0gy1: the `pos_overrides` row that approved this action. */
    overrideId: ulidInUuid("override_id"),
    refundedAt: timestamp("refunded_at", { withTimezone: true }).notNull(),
    /** The drawer (shift) a cash refund paid out of; null when no cash line. */
    shiftId: uuid("shift_id"),
    /**
     * A cash refund larger than the expected drawer cash when recorded
     * (legend-utqr): "exceeded the drawer when recorded", nothing more. It is
     * accepted like any other (same response and events) and left out of the
     * drawer figures; the shift's count carries it as heldCashOutIdr and the
     * shift close books counted − (expected − held), so the cash the order
     * event already credits is not booked twice. Permanent (append-only
     * table); a later review belongs in its own table. The cashier never
     * sees it.
     */
    needsApproval: boolean("needs_approval").notNull().default(false),
    createdAt,
  },
  (table) => [
    unique("pos_order_refunds_tenant_id_id_key").on(table.tenantId, table.id),
    foreignKey({
      name: "pos_order_refunds_shift_fk",
      columns: [table.tenantId, table.shiftId],
      foreignColumns: [posShifts.tenantId, posShifts.id],
    }),
    foreignKey({
      name: "pos_order_refunds_pos_order_fk",
      columns: [table.tenantId, table.orderId],
      foreignColumns: [posOrders.tenantId, posOrders.orderId],
    }),
    foreignKey({
      name: "pos_order_refunds_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    index("pos_order_refunds_order_idx").on(table.tenantId, table.orderId),
    // legend-wkl3: a Rp0 row records goods returned with nothing to pay back
    // (a returned free item, founder Q19); it must name those items.
    check(
      "pos_order_refunds_amount_check",
      sql`${table.amountIdr} > 0 OR (${table.amountIdr} = 0 AND jsonb_array_length(${table.items}) > 0)`,
    ),
    // legend-0gy1: every correction names its approval (override row, or the
    // phone chain id on rows written before the override id was recorded).
    check(
      "pos_order_refunds_approval_check",
      sql`${table.overrideId} IS NOT NULL OR ${table.approvalRequestId} IS NOT NULL`,
    ),
    check(
      "pos_order_refunds_lines_check",
      sql`jsonb_typeof(${table.lines}) = 'array' AND (jsonb_array_length(${table.lines}) > 0) = (${table.amountIdr} > 0)`,
    ),
    check(
      "pos_order_refunds_approver_check",
      sql`lower(${table.requestedBy}) <> lower(${table.approvedBy})`,
    ),
    check(
      "pos_order_refunds_needs_approval_shift_check",
      sql`NOT ${table.needsApproval} OR ${table.shiftId} IS NOT NULL`,
    ),
  ],
);

/**
 * `pos_order_approval_uses` (T, O): an approved supervisor override
 * (`pos_overrides`, legend-dxb) authorizes exactly one POS action. The unique
 * key makes a replayed approval for a second void/discount/refund impossible.
 */
export const posOrderApprovalUses = pgTable(
  "pos_order_approval_uses",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    overrideId: ulidInUuid("override_id").notNull(),
    orderId: ulidInUuid("order_id").notNull(),
    purpose: varchar("purpose", { length: 30 }).notNull(),
    createdAt,
  },
  (table) => [
    unique("pos_order_approval_uses_override_key").on(
      table.tenantId,
      table.overrideId,
    ),
    foreignKey({
      name: "pos_order_approval_uses_pos_order_fk",
      columns: [table.tenantId, table.orderId],
      foreignColumns: [posOrders.tenantId, posOrders.orderId],
    }),
    foreignKey({
      name: "pos_order_approval_uses_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    check(
      "pos_order_approval_uses_purpose_check",
      sql`${table.purpose} IN ('order_void', 'item_void', 'discount', 'correction_void', 'refund', 'edc_standalone', 'qris_release')`,
    ),
  ],
);

/**
 * `pos_order_idempotency` (T, O): one row per (outlet, key). The key is bound
 * to a fingerprint of actor + operation + target + body; a replay returns the
 * stored response, another request under the key is IDEMPOTENCY_KEY_REUSED.
 */
export const posOrderIdempotency = pgTable(
  "pos_order_idempotency",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    key: varchar("key", { length: 100 }).notNull(),
    operation: varchar("operation", { length: 40 }).notNull(),
    fingerprint: varchar("fingerprint", { length: 64 }).notNull(),
    response: jsonb("response").$type<unknown>().notNull(),
    createdAt,
  },
  (table) => [
    unique("pos_order_idempotency_tenant_id_id_key").on(
      table.tenantId,
      table.id,
    ),
    unique("pos_order_idempotency_key").on(
      table.tenantId,
      table.outletId,
      table.key,
    ),
    foreignKey({
      name: "pos_order_idempotency_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
  ],
);

/**
 * `pos_approval_policies` (T): POS-02 "diskon di atas ambang" — the tenant's
 * threshold, optionally per outlet (outlet row wins). Without a row the API
 * fails closed (every manual discount needs approval).
 */
export const posApprovalPolicies = pgTable(
  "pos_approval_policies",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id),
    discountThresholdBp: smallint("discount_threshold_bp").notNull(),
    updatedBy: text("updated_by"),
    createdAt,
    updatedAt,
    syncTxid: syncTxidColumn(),
  },
  (table) => [
    index("pos_approval_policies_sync_txid_idx").on(
      table.tenantId,
      table.syncTxid,
      table.id,
    ),
    unique("pos_approval_policies_tenant_id_id_key").on(
      table.tenantId,
      table.id,
    ),
    uniqueIndex("pos_approval_policies_outlet_key")
      .on(table.tenantId, table.outletId)
      .where(sql`${table.outletId} IS NOT NULL`),
    uniqueIndex("pos_approval_policies_tenant_key")
      .on(table.tenantId)
      .where(sql`${table.outletId} IS NULL`),
    foreignKey({
      name: "pos_approval_policies_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    check(
      "pos_approval_policies_threshold_check",
      sql`${table.discountThresholdBp} BETWEEN 1 AND 10000`,
    ),
  ],
);
